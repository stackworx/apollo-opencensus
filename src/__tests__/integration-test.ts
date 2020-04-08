import express from "express";
import request from "supertest";
import { Tracer, Context, defaultSetter } from "@opentelemetry/api";
import {
  ReadableSpan,
  BasicTracerProvider,
  BatchSpanProcessor,
  SpanProcessor,
  Span,
} from "@opentelemetry/tracing";
import { setExtractedSpanContext } from "@opentelemetry/core";
import { JaegerExporter } from "@opentelemetry/exporter-jaeger";
import { JaegerHttpTracePropagator } from "@opentelemetry/propagator-jaeger";
import { ApolloServer } from "apollo-server-express";

import ApolloOpencensus from "../";
import spanSerializer, { SpanTree } from "../test/span-serializer";

const propagator = new JaegerHttpTracePropagator();

const basicTracerProvider = new BasicTracerProvider();
basicTracerProvider.register({
  // Use Jaeger propagator
  propagator,
});

const { JAEGER_EXPORTER = false } = process.env;

expect.addSnapshotSerializer(spanSerializer);

class TestExporter implements SpanProcessor {
  public spans: ReadableSpan[] = [];

  onStart(span: Span) {
    const rs = span.toReadableSpan();
    this.spans.push(rs);
  }

  onEnd(_span: Span) {}

  forceFlush() {}

  shutdown() {}

  buildSpanTree() {
    const spans = this.spans;
    // TODO we currently assume there is only one null parent entry.
    // The root span

    let rootSpan = null;

    const spansByParentId = spans.reduce((acc, span) => {
      // Check for root
      if (span.parentSpanId) {
        if (acc.has(span.parentSpanId)) {
          acc.get(span.parentSpanId).push(span);
        } else {
          acc.set(span.parentSpanId, [span]);
        }
      } else {
        rootSpan = span;
      }

      return acc;
    }, new Map<string, ReadableSpan[]>());

    expect(rootSpan).toBeDefined();

    const tree = {
      parent: rootSpan,
      children: [],
    };

    buildTree(tree, spansByParentId);

    return tree;
  }
}

if (JAEGER_EXPORTER) {
  // TODO: this does not catch all spans
  afterAll(() => {
    basicTracerProvider.getActiveSpanProcessor().forceFlush();
    basicTracerProvider.getActiveSpanProcessor().shutdown();
  });
}

const buildTree = (
  tree: SpanTree,
  spansByParentId: Map<string, ReadableSpan[]>
) => {
  const { parent } = tree;

  if (spansByParentId.has(parent.spanContext.spanId)) {
    const spans = spansByParentId.get(parent.spanContext.spanId);
    spansByParentId.delete(parent.spanContext.spanId);

    // TODO: do we need to sort?
    for (const span of spans) {
      const subTree = {
        parent: span,
        children: [],
      };

      tree.children.push(subTree);
      buildTree(subTree, spansByParentId);
    }
  }
};

function createTracer(): {
  tracer: Tracer;
  exporter: TestExporter;
} {
  const exporter = new TestExporter();

  basicTracerProvider.addSpanProcessor(exporter);

  if (JAEGER_EXPORTER) {
    basicTracerProvider.addSpanProcessor(
      new BatchSpanProcessor(
        new JaegerExporter({
          serviceName: "apollo-opentracing",
          tags: [], // optional
          host: "localhost", // optional
          port: 6832, // optional
          maxPacketSize: 65000, // optional
        })
      )
    );
  }

  const tracer = basicTracerProvider.getTracer("default");

  return { tracer, exporter };
}

function createApp({ tracer, ...params }) {
  const app = express();

  const server = new ApolloServer({
    typeDefs: `
      type A {
        one: String
        two: String
        three: [B]
      }

      type B {
        four: String  
      }

      type Query {
        a: A
        b: B
        as: [A]
        bs: [B]
      }
    `,
    resolvers: {
      Query: {
        a() {
          return {
            one: "1",
            two: "2",
            three: [{ four: "4" }, { four: "IV" }],
          };
        },
        b() {
          return {
            four: "4",
          };
        },

        as() {
          return [
            {
              one: "1",
              two: "2",
            },
            {
              one: "I",
              two: "II",
            },
            {
              one: "eins",
              two: "zwei",
            },
          ];
        },
      },
    },
    extensions: [() => new ApolloOpencensus({ ...params, tracer })],
  });

  server.applyMiddleware({ app });

  return app;
}

describe("integration with apollo-server", () => {
  it("closes all spans", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const app = createApp({ tracer });

    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({
        query: `query {
        a {
          one
        }
      }`,
      })
      .expect(200);

    debugger;
    basicTracerProvider.getActiveSpanProcessor().forceFlush();

    expect(exporter.spans.length).toBe(3);
    expect(exporter.spans.filter((span) => span.ended).length).toBe(3);
  });

  it("correct span nesting", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const app = createApp({ tracer });
    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({
        query: `query {
        a {
          one
          two
        }
      }`,
      })
      .expect(200);

    const tree = exporter.buildSpanTree();
    expect(tree).toMatchSnapshot();
  });

  it("does not start a field resolver span if the parent field resolver was not traced", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const shouldTraceFieldResolver = (source, args, ctx, info) => {
      if (info.fieldName === "a") {
        return false;
      }
      return true;
    };

    const app = createApp({ tracer, shouldTraceFieldResolver });
    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({
        query: `query {
        a {
          one
          two
        }
        b {
          four
        }
      }`,
      })
      .expect(200);

    const tree = exporter.buildSpanTree();
    expect(tree).toMatchSnapshot();
  });

  it("implements traces for arrays", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const app = createApp({ tracer });
    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({
        query: `query {
        as {
          one
          two
        }
      }`,
      })
      .expect(200);

    const tree = exporter.buildSpanTree();
    expect(tree).toMatchSnapshot();
  });

  it("alias works", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const app = createApp({ tracer });
    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({
        query: `query {
        a {
          uno: one
          two
        }
      }`,
      })
      .expect(200);

    const tree = exporter.buildSpanTree();
    expect(tree).toMatchSnapshot();
  });

  it("alias with fragment works", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const app = createApp({ tracer });
    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .send({
        query: `
        fragment F on A {
          dos: two
        }

        query {
        a {
          ...F
        }
      }`,
      })
      .expect(200);

    const tree = exporter.buildSpanTree();
    expect(tree).toMatchSnapshot();
  });

  it.only("injected parent span", async () => {
    // const tracer = new MockTracer();
    const { tracer, exporter } = createTracer();
    const app = createApp({ tracer });

    const carrier: { [key: string]: string } = {};

    const span = tracer.startSpan("remote");

    const context = setExtractedSpanContext(
      Context.ROOT_CONTEXT,
      span.context()
    );

    propagator.inject(context, carrier, defaultSetter);

    await request(app)
      .post("/graphql")
      .set("Accept", "application/json")
      .set("uber-trace-id", carrier["uber-trace-id"])
      .send({
        query: `query {
        a {
          one
          two
        }
      }`,
      })
      .expect(200);

    const tree = exporter.buildSpanTree();
    expect(tree).toMatchSnapshot();
  });
});

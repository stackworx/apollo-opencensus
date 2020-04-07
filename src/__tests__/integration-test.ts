import express from "express";
import request from "supertest";
import { Exporter, Span, LinkType } from "@opencensus/core";
import { TracingBase } from "@opencensus/nodejs-base";
import { TraceContextFormat } from "@opencensus/propagation-tracecontext";
import { JaegerTraceExporter } from "@opencensus/exporter-jaeger";
import { ApolloServer } from "apollo-server-express";

import ApolloOpencensus from "../";
import spanSerializer, { SpanTree } from "../test/span-serializer";

const { JAEGER_EXPORTER = false } = process.env;

const traceContext = new TraceContextFormat();

expect.addSnapshotSerializer(spanSerializer);

class TestExporter implements Exporter {
  public spans: Span[] = [];
  public spansById: Map<string, Span> = new Map();

  async publish(_spans: Span[]): Promise<void> {}

  onStartSpan(span: Span): void {
    this.spans.push(span);
    this.spansById.set(span.id, span);
  }
  onEndSpan(_span: Span): void {}

  buildSpanTree() {
    const spans = this.spans;
    // TODO we currently assume there is only one null parent entry.
    // The root span

    let rootSpan = null;

    const spansByParentId = spans.reduce((acc, span) => {
      // Check for root
      if (span.links.length > 0) {
        const parentLink = span.links.find(
          // (link) => link.type == LinkType.PARENT_LINKED_SPAN
          (link) => link.type == LinkType.CHILD_LINKED_SPAN
        );

        if (parentLink) {
          const parentSpanId = parentLink.spanId;

          if (acc.has(parentSpanId)) {
            acc.get(parentSpanId).push(span);
          } else {
            acc.set(parentSpanId, [span]);
          }
        }
      } else {
        rootSpan = span;
      }

      return acc;
    }, new Map<string, Span[]>());

    expect(rootSpan).toBeDefined();

    const tree = {
      parent: rootSpan,
      children: [],
    };

    buildTree(tree, spansByParentId);

    return tree;
  }
}

const buildTree = (tree: SpanTree, spansByParentId: Map<string, Span[]>) => {
  const { parent } = tree;

  if (spansByParentId.has(parent.id)) {
    const spans = spansByParentId.get(parent.id);
    spansByParentId.delete(parent.id);

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
  tracer: TracingBase;
  exporter: TestExporter;
} {
  const exporter = new TestExporter();
  const base = new TracingBase();
  base.registerExporter(exporter);
  // Sample all requests
  const tracer = base.start({ propagation: traceContext, samplingRate: 1 });

  if (JAEGER_EXPORTER) {
    base.registerExporter(
      new JaegerTraceExporter({
        serviceName: "apollo-opentracing",
        tags: [], // optional
        host: "localhost", // optional
        port: 6832, // optional
        maxPacketSize: 65000, // optional
      })
    );
  }

  // @ts-ignore
  return { tracer: tracer.tracer, exporter };
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
  it.only("closes all spans", async () => {
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

    expect(exporter.spans.length).toBe(3);
    expect(exporter.spans.filter((span) => span.ended).length).toBe(3);
    tracer.stop();
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
    tracer.stop();
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
});

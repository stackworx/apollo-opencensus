import ApolloOpencensus from "..";
import { addContextHelpers } from "../context";
import { SpanKind } from "@opencensus/core";

describe("Apollo Tracing", () => {
  let tracer, tracingMiddleware;
  beforeEach(() => {
    const span = {
      end: jest.fn(),
      // setTag: jest.fn(),
      log: jest.fn(),
    };

    tracer = {
      span,
      startChildSpan: jest.fn(() => span),
      startRootSpan: jest.fn(() => span),
      inject: jest.fn(),
      extract: jest.fn(),
    };

    tracingMiddleware = new ApolloOpencensus({
      tracer,
    });
  });

  describe("construction", () => {
    it("fails without tracers", () => {
      expect(() => {
        new ApolloOpencensus();
      }).toThrowErrorMatchingInlineSnapshot(
        `"ApolloOpencensus needs a tracer, please provide it to the constructor. e.g. new ApolloOpencensus({ tracer })"`
      );
    });

    it("constructs with enough arguments", () => {
      new ApolloOpencensus({ tracer });
    });
  });

  describe("request spans", () => {
    it("starts and finishes a request spans if there are no errors", () => {
      const cb = tracingMiddleware.requestDidStart({ queryString: "query {}" });
      expect(tracer.startRootSpan).toHaveBeenCalled();
      // expect(tracer.startSpan).not.toHaveBeenCalled();

      cb();
      expect(tracer.span.end).toHaveBeenCalled();
    });

    it("starts and finishes a request spans if there are errors", () => {
      const cb = tracingMiddleware.requestDidStart({ queryString: "query {}" });
      expect(tracer.startRootSpan).toHaveBeenCalled();
      // expect(tracer.startSpan).not.toHaveBeenCalled();

      cb(new Error("ups"));
      expect(tracer.span.end).toHaveBeenCalled();
    });

    it("predicate gets called with same arguments as the middleware", () => {
      const shouldTraceRequest = jest.fn();
      tracingMiddleware = new ApolloOpencensus({
        tracer,
        shouldTraceRequest,
      });

      tracingMiddleware.requestDidStart({ queryString: "query {}" });
      expect(shouldTraceRequest).toHaveBeenCalledWith({
        queryString: "query {}",
      });
    });

    it("doesn't start spans when corresponding predicate returns false", () => {
      const shouldTraceRequest = jest.fn().mockReturnValue(false);
      tracingMiddleware = new ApolloOpencensus({
        tracer,
        shouldTraceRequest,
      });

      tracingMiddleware.requestDidStart({ queryString: "query {}" });
      expect(tracer.startRootSpan).not.toHaveBeenCalled();
    });

    // it("picks up the tracing headers as parent span", () => {
    //   tracer.extract.mockReturnValue({ spanId: 42 });
    //   tracingMiddleware.requestDidStart({
    //     queryString: "query {}",
    //     request: {
    //       headers: {
    //         "X-B3-ParentSpanId": "a33c27ae31f3c9e9",
    //         "X-B3-Sampled": 1,
    //         "X-B3-SpanId": "42483bbd28a757b4",
    //         "X-B3-TraceId": "a33c27ae31f3c9e9",
    //       },
    //     },
    //   });

    //   expect(tracer.extract).toHaveBeenCalled();
    //   expect(tracer.startSpan).toHaveBeenCalledWith(expect.any(String), {
    //     childOf: { spanId: 42 },
    //   });
    // });
  });

  describe("field resolver", () => {
    it("starts a new local span for the field", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      tracingMiddleware.willResolveField({}, {}, {}, {});
      // expect(tracer.startRootSpan).not.toHaveBeenCalled();
      expect(tracer.startRootSpan).toHaveBeenCalled();
    });

    it("uses the 'fieldname' as the span name if no fieldname can be found", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      tracingMiddleware.willResolveField({}, {}, {}, {});
      expect(tracer.startRootSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: SpanKind.SERVER,
          name: "field",
          spanContext: undefined,
        }),
        expect.anything()
      );
    });

    it("uses the name as the span name if no fieldname can be found", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      tracingMiddleware.willResolveField(
        {},
        {},
        {},
        {
          fieldName: "myField",
        }
      );
      expect(tracer.startRootSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: SpanKind.SERVER,
          name: "myField",
          spanContext: undefined,
        }),
        expect.anything()
      );
    });

    it.skip("starts the span as a child span of another field", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      const ctx = {};
      addContextHelpers(ctx);

      // @ts-ignore
      ctx.addSpan({ id: "42" }, { path: { key: "previous" } });

      tracingMiddleware.willResolveField({}, {}, ctx, {
        path: { key: "b", prev: { key: "previous" } },
      });

      // TODO: assert add link
      expect(tracer.startRootSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: SpanKind.SERVER,
          name: "field",
          spanContext: undefined,
        }),
        expect.anything()
      );
    });

    it("starts the span as a child span of the request", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      tracingMiddleware.willResolveField({}, {}, {}, {});
      expect(tracer.startRootSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: SpanKind.SERVER,
          name: "field",
          spanContext: undefined,
        }),
        expect.anything()
      );
    });

    it("does not start a span if there is no request span", () => {
      tracingMiddleware.willResolveField({}, {}, {}, {});
      expect(tracer.startRootSpan).not.toHaveBeenCalled();
    });

    it("does not start a span if the predicate returns false", () => {
      const shouldTraceFieldResolver = jest.fn().mockReturnValue(false);
      tracingMiddleware = new ApolloOpencensus({
        tracer,
        shouldTraceFieldResolver,
      });
      tracingMiddleware.requestSpan = { id: "23" };
      tracingMiddleware.willResolveField(
        { a: true },
        { b: true },
        { c: true },
        { d: true }
      );

      expect(tracer.startRootSpan).not.toHaveBeenCalled();
      expect(shouldTraceFieldResolver).toHaveBeenCalledWith(
        { a: true },
        { b: true },
        { c: true },
        { d: true }
      );
    });

    it.skip("adds the spancontext to the context", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      const ctx = {};
      tracingMiddleware.willResolveField({}, {}, ctx, {});
      // @ts-ignore
      expect(ctx._spans).toBeDefined();
      // @ts-ignore
      expect(ctx.getSpanByPath).toBeInstanceOf(Function);
      // @ts-ignore
      expect(ctx.addSpan).toBeInstanceOf(Function);
    });

    it("exposes the span in the info", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      const info = {};
      tracingMiddleware.willResolveField({}, {}, {}, info);
      // @ts-ignore
      expect(info.span).toBeDefined();
    });

    it("calls onFieldResolve in willResolveField", () => {
      const onFieldResolve = jest.fn();
      tracingMiddleware = new ApolloOpencensus({
        tracer,
        onFieldResolve,
      });
      tracingMiddleware.requestSpan = { id: "23" };
      const info = {};
      const context = { headers: "abc" };
      tracingMiddleware.willResolveField({}, {}, context, info);
      expect(onFieldResolve).toHaveBeenCalledWith({}, {}, context, info);
    });

    it("doesn't logs a result and calls on field resolve finish", () => {
      const onFieldResolveFinish = jest.fn();
      tracingMiddleware = new ApolloOpencensus({
        tracer,
        onFieldResolveFinish,
      });
      tracingMiddleware.requestSpan = { id: "23" };
      const result = { data: { id: "42" } };

      const cb = tracingMiddleware.willResolveField({}, {}, {}, {});
      cb(null, result);

      expect(onFieldResolveFinish).toHaveBeenCalledWith(
        null,
        result,
        tracer.span
      );
      expect(tracer.span.log).not.toHaveBeenCalledWith({
        result: JSON.stringify(result),
      });
    });

    it("finishes the span", () => {
      tracingMiddleware.requestSpan = { id: "23" };
      const cb = tracingMiddleware.willResolveField({}, {}, {}, {});
      cb();
      expect(tracer.span.end).toHaveBeenCalled();
    });
  });
});

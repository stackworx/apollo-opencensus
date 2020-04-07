import { Request } from "apollo-server-env";
import { GraphQLRequestContext } from "apollo-server-types";
import { DocumentNode, GraphQLResolveInfo } from "graphql";
import { GraphQLExtension } from "graphql-extensions";

import {
  Span,
  Tracer,
  HeaderGetter,
  TraceOptions,
  SpanKind,
  LinkType,
} from "@opencensus/core";
import { addContextHelpers, SpanContext } from "./context";

export { SpanContext, addContextHelpers };

const alwaysTrue = () => true;
const emptyFunction = () => {};

export interface InitOptions<TContext> {
  tracer?: Tracer;
  onFieldResolveFinish?: (error: Error | null, result: any, span: Span) => void;
  onFieldResolve?: (
    source: any,
    args: { [argName: string]: any },
    context: SpanContext,
    info: GraphQLResolveInfo
  ) => void;
  shouldTraceRequest?: (info: RequestStart<TContext>) => boolean;
  shouldTraceFieldResolver?: (
    source: any,
    args: { [argName: string]: any },
    context: SpanContext,
    info: GraphQLResolveInfo
  ) => boolean;
  onRequestResolve?: (span: Span, info: RequestStart<TContext>) => void;
}

export interface ExtendedGraphQLResolveInfo extends GraphQLResolveInfo {
  span?: Span;
}
export interface RequestStart<TContext> {
  request: Pick<Request, "url" | "method" | "headers">;
  queryString?: string;
  parsedQuery?: DocumentNode;
  operationName?: string;
  variables?: { [key: string]: any };
  persistedQueryHit?: boolean;
  persistedQueryRegister?: boolean;
  context: TContext;
  requestContext: GraphQLRequestContext<TContext>;
}

function getFieldName(info: GraphQLResolveInfo) {
  if (
    info.fieldNodes &&
    info.fieldNodes.length > 0 &&
    info.fieldNodes[0].alias
  ) {
    return info.fieldNodes[0].alias.value;
  }

  return info.fieldName || "field";
}

export default class OpencensusExtension<TContext extends SpanContext>
  implements GraphQLExtension<TContext> {
  private tracer: Tracer;
  private requestSpan: Span | null;
  private onFieldResolveFinish?: (
    error: Error | null,
    result: any,
    span: Span
  ) => void;
  private onFieldResolve?: (
    source: any,
    args: { [argName: string]: any },
    context: SpanContext,
    info: GraphQLResolveInfo
  ) => void;
  private shouldTraceRequest: (info: RequestStart<TContext>) => boolean;
  private shouldTraceFieldResolver: (
    source: any,
    args: { [argName: string]: any },
    context: SpanContext,
    info: GraphQLResolveInfo
  ) => boolean;
  private onRequestResolve: (span: Span, info: RequestStart<TContext>) => void;

  constructor({
    tracer,
    shouldTraceRequest,
    shouldTraceFieldResolver,
    onFieldResolveFinish,
    onFieldResolve,
    onRequestResolve,
  }: InitOptions<TContext> = {}) {
    if (!tracer) {
      throw new Error(
        "ApolloOpencensus needs a tracer, please provide it to the constructor. e.g. new ApolloOpencensus({ tracer })"
      );
    }

    this.tracer = tracer;
    this.requestSpan = null;
    this.shouldTraceRequest = shouldTraceRequest || alwaysTrue;
    this.shouldTraceFieldResolver = shouldTraceFieldResolver || alwaysTrue;
    this.onFieldResolveFinish = onFieldResolveFinish;
    this.onFieldResolve = onFieldResolve;
    this.onRequestResolve = onRequestResolve || emptyFunction;
  }

  mapToObj(inputMap: Map<string, any>) {
    let obj: { [key: string]: string } = {};

    inputMap.forEach(function (value, key) {
      obj[key] = value;
    });

    return obj;
  }

  requestDidStart(infos: RequestStart<TContext>) {
    if (!this.shouldTraceRequest(infos)) {
      return;
    }

    const getter: HeaderGetter = {
      getHeader(name: string) {
        // Fix types
        return infos.request.headers.get(name) ?? undefined;
      },
    };

    const traceOptions: TraceOptions = {
      name: "request",
      kind: SpanKind.SERVER,
    };

    const spanContext =
      infos.request && infos.request?.headers
        ? this.tracer.propagation.extract(getter)
        : undefined;

    if (spanContext) {
      traceOptions.spanContext = spanContext;
    }

    // const rootSpan = this.tracer.startChildSpan({
    //   name: "request",
    //   childOf: externalSpan ? externalSpan : undefined,
    // });

    // TODO: is this correct?
    const rootSpan = this.tracer.startRootSpan(traceOptions, (rootSpan) => {
      return rootSpan;
    });

    this.onRequestResolve(rootSpan, infos);
    this.requestSpan = rootSpan;

    return () => {
      rootSpan.end();
    };
  }

  willResolveField(
    source: any,
    args: { [argName: string]: any },
    context: TContext,
    info: ExtendedGraphQLResolveInfo
  ) {
    if (
      // we don't trace the request
      !this.requestSpan ||
      // we should not trace this resolver
      !this.shouldTraceFieldResolver(source, args, context, info) ||
      // the previous resolver was not traced
      (info.path && info.path.prev && !context.getSpanByPath(info.path.prev))
    ) {
      return;
    }

    // idempotent method to add helpers to the first context available (which will be propagated by apollo)
    addContextHelpers(context);

    const name = getFieldName(info);
    const parentSpan =
      info.path && info.path.prev
        ? context.getSpanByPath(info.path.prev)
        : this.requestSpan;

    // Falls prey to closed parent spans - https://github.com/open-telemetry/opentelemetry-node/issues/4
    // https://github.com/census-instrumentation/opencensus-node/issues/791
    // const span = this.tracer.startChildSpan({
    //   name,
    //   childOf: parentSpan || undefined,
    // });

    const traceOptions: TraceOptions = {
      name,
      kind: SpanKind.SERVER,
      spanContext: parentSpan?.spanContext,
    };

    // TODO: check parent trace state?
    const span = this.tracer.startRootSpan(traceOptions, (span) => {
      if (parentSpan) {
        span.addLink(
          parentSpan.traceId,
          parentSpan.id,
          LinkType.CHILD_LINKED_SPAN
        );
      }

      return span;
    });

    context.addSpan(span, info);
    // expose to field
    info.span = span;

    if (this.onFieldResolve) {
      this.onFieldResolve(source, args, context, info);
    }

    return (error: Error | null, result: any) => {
      if (this.onFieldResolveFinish) {
        this.onFieldResolveFinish(error, result, span);
      }
      span.end();
    };
  }
}

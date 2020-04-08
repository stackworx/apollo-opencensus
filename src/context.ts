import { Span } from "@opentelemetry/api";
import { GraphQLResolveInfo, ResponsePath } from "graphql";

function isArrayPath(path: ResponsePath) {
  return typeof path.key === "number";
}

export function buildPath(path: ResponsePath | undefined) {
  let current = path;
  const segments = [];
  while (current != null) {
    if (isArrayPath(current)) {
      segments.push(`[${current.key}]`);
    } else {
      segments.push(current.key);
    }
    current = current.prev;
  }
  return segments.reverse().join(".");
}

export interface SpanContext extends Object {
  _spans: Map<string, Span>;
  getSpanByPath(info: ResponsePath): Span | undefined;
  addSpan(span: Span, info: GraphQLResolveInfo): void;
}

function isSpanContext(obj: any): obj is SpanContext {
  return (
    obj.getSpanByPath instanceof Function && obj.addSpan instanceof Function
  );
}

const SPANS = Symbol("spans");

// TODO: think about using symbols to hide these
export function addContextHelpers(obj: any): SpanContext {
  if (isSpanContext(obj)) {
    return obj;
  }

  Object.defineProperty(obj, SPANS, {
    value: new Map<string, Span>(),
    enumerable: false,
    writable: false,
  });

  Object.defineProperty(obj, "getSpanByPath", {
    value: function (path: ResponsePath): Span | undefined {
      return obj[SPANS].get(buildPath(isArrayPath(path) ? path.prev : path));
    },
    enumerable: false,
    writable: false,
  });

  Object.defineProperty(obj, "addSpan", {
    value: function (span: Span, info: GraphQLResolveInfo): void {
      obj[SPANS].set(buildPath(info.path), span);
    },
    enumerable: true,
    writable: false,
  });

  return obj;
}

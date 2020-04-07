import "jest";
import { Span } from "@opencensus/core";
import { OldPlugin } from "pretty-format";

const TAB = "   ";

function prefix(depth: number) {
  return TAB.repeat(depth) + `+-- `;
}

function logLine(log: any, index: number, depth: number) {
  return `${TAB.repeat(depth + 1)}${index}. ${JSON.stringify(log).replace(
    /\\"/g,
    ""
  )}`;
}

export interface SpanTree {
  parent: Span;
  children: SpanTree[];
}

function logs(_span: SpanTree, _depth: number) {
  // TODO: logs?
  // if (span.parent.logs && span.parent.logs.length > 0) {
  //   return `${TAB.repeat(depth + 1)}logs:\n${span.logs
  //     .map((log, index) => logLine(log, index + 1, depth))
  //     .join("\n")}\n`;
  // }

  return "";
}

function tags(span: SpanTree, depth: number) {
  if (span.parent.attributes && span.parent.attributes.length > 0) {
    return `${TAB.repeat(depth + 1)}tags:\n${Object.entries(
      span.parent.attributes
    )
      // TODO: value
      .map(([tag]) => logLine(tag, depth + 1, depth))
      .join("\n")}\n`;
  }
  return "";
}

function tag(span: SpanTree, depth: number) {
  return `${span.parent.name}\n${TAB.repeat(depth + 1)}finished: ${
    span.parent.ended
  }\n${logs(span, depth)}\n${tags(span, depth)}`;
}

function buildSpan(span: SpanTree, depth = 0) {
  let result = "";

  result += tag(span, depth);

  if (span.children) {
    for (const child of span.children) {
      result += `${prefix(depth)}${buildSpan(child, depth + 1)}`;
    }
  }

  return result;
}

// TODO: convert to new plugin
const spanSerializer: OldPlugin = {
  test: (val: any) => {
    return !!(!!val.children && val?.parent?.id && val?.parent?.name);
  },
  print(
    val: any,
    _serialize: (val: any) => string,
    _indent: (str: string) => string
  ) {
    return buildSpan(val as SpanTree);
  },
};

export default spanSerializer;

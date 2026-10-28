import { JSDOM } from "jsdom";

export interface NodeDom {
  doc: Document;
  serialize(el: Element): string;
  close(): void;
}

/** Create an isolated, script-disabled DOM for server-side D3 rendering. */
export function createNodeDom(): NodeDom {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: undefined,
    resources: undefined,
  });
  const serializer = new dom.window.XMLSerializer();
  return {
    doc: dom.window.document,
    serialize: (el) => serializer.serializeToString(el),
    close: () => dom.window.close(),
  };
}

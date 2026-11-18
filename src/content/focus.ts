// Focus and selection lookups that see through open shadow roots, where the document alone
// reports the shadow host (focus) or a collapsed selection (text).

/** The focused element, looking inside open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let el = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

type ShadowRootWithSelection = ShadowRoot & { getSelection?: () => Selection | null };

/** The selection that describes text inside `node`: its open shadow root's own, else the document's. */
export function selectionOf(node: Node | null | undefined, doc: Document = document): Selection | null {
  const root = node?.getRootNode();
  const own = root instanceof ShadowRoot ? (root as ShadowRootWithSelection).getSelection?.() : undefined;
  return own ?? doc.getSelection();
}

/** Content types whose documents create HTML elements, which translation boxes need (style, shadow roots). */
const HTML_TYPES: ReadonlySet<string> = new Set(["text/html", "application/xhtml+xml"]);

/**
 * False for XML feeds, SVG images and plain-text views: they have no HTML body to translate in,
 * so the page is reported as unsupported instead of failing halfway.
 */
export const isTranslatableDocument = (doc: Document): boolean => HTML_TYPES.has(doc.contentType) && doc.body instanceof HTMLElement;

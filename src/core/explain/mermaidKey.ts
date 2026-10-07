/**
 * A stable key for a Mermaid diagram, derived from its source.
 *
 * Used to match a diagram in an explainer to the SVG the browser rendered for
 * it, without either side having to agree on an ordering.
 */
export function mermaidSvgKey(code: string): string {
  const normalised = code.trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalised.length; index += 1) {
    hash ^= normalised.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `m${(hash >>> 0).toString(36)}`;
}

/**
 * Remove anything executable from an SVG before it is embedded in an exported
 * file. The browser already sanitises with DOMPurify, but this endpoint accepts
 * arbitrary input, so it is checked again on the way in.
 */
export function sanitiseSvg(svg: string): string | null {
  if (typeof svg !== 'string') return null;
  const trimmed = svg.trim();
  if (!trimmed.startsWith('<svg')) return null;
  if (trimmed.length > 400_000) return null;
  if (/<script|javascript:|on[a-z]+\s*=/i.test(trimmed)) return null;
  return trimmed;
}

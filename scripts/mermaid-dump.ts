/** Dev utility: render a Mermaid diagram headlessly and print the SVG. */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
const w = dom.window as unknown as Record<string, unknown>;
for (const n of ['window', 'document', 'navigator', 'CSSStyleSheet', 'DOMParser', 'XMLSerializer', 'Element', 'Node',
  'HTMLElement', 'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'CSSRule']) {
  const v = w[n];
  if (v === undefined) continue;
  try {
    if (['document', 'navigator'].includes(n)) Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true });
    else g[n] = v;
  } catch { /* read-only */ }
}
const prototype = (w.SVGElement as { prototype: Record<string, unknown> }).prototype;
prototype.getBBox = () => ({ x: 0, y: 0, width: 80, height: 18 });
prototype.getComputedTextLength = () => 80;

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base' });

const code = process.argv[2] ? (await import('node:fs')).readFileSync(process.argv[2], 'utf8') : 'flowchart LR\n  web["web UI"]\n  api["Fastify API"]\n  web --> api';
const { svg } = await mermaid.render('dump', code);
console.log(svg);

import { beforeAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

/**
 * Mermaid renders to SVG in a browser, and it needs a DOM to do it. jsdom plus a
 * text-measurement polyfill is enough to exercise the real render path here, so
 * the two diagram shapes the prompt asks for are verified rather than assumed.
 */
let mermaid: typeof import('mermaid').default;

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  const globals = globalThis as unknown as Record<string, unknown>;
  const window = dom.window as unknown as Record<string, unknown>;

  for (const name of [
    'window', 'document', 'navigator', 'CSSStyleSheet', 'DOMParser', 'XMLSerializer', 'Element', 'Node',
    'HTMLElement', 'HTMLDivElement', 'HTMLBodyElement', 'SVGElement', 'SVGSVGElement', 'SVGGElement',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'CSSRule',
    'CSSStyleRule', 'CustomEvent', 'Event', 'Image', 'matchMedia',
  ]) {
    const value = name === 'window' ? dom.window : window[name];
    if (value === undefined) continue;
    try {
      if (['document', 'navigator'].includes(name)) {
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
      } else {
        globals[name] = value;
      }
    } catch {
      /* read-only global */
    }
  }
  // jsdom does not lay text out; mermaid needs these to size nodes.
  const prototype = (window.SVGElement as { prototype: Record<string, unknown> }).prototype;
  prototype.getBBox = () => ({ x: 0, y: 0, width: 80, height: 18 });
  prototype.getComputedTextLength = () => 80;

  mermaid = (await import('mermaid')).default;
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, theme: 'base' });
}, 60_000);

const FLOWCHART = `flowchart LR
  web["web UI (React, src/web)"]
  api["Fastify API (src/server)"]
  svc["RepoService"]
  web --> api
  api --> svc
  svc --> st["Store (~/.repo-explorer)"]`;

const SEQUENCE = `sequenceDiagram
  participant web as "web UI"
  participant api as "Fastify /api/repos/open"
  participant svc as "RepoService.open"
  participant ana as "analyzeRepo"
  web->>api: POST {"path":"/code/acme-api"}
  api->>svc: open(path)
  svc->>ana: analyzeRepo(root)
  ana-->>svc: RepoModel
  svc-->>api: RepoContext
  api-->>web: 200 OK`;

/**
 * Mermaid wraps a label across several `<tspan>` elements, so the raw markup
 * cannot be searched for a phrase. Compare the rendered text instead, which is
 * what the reader actually sees.
 */
function renderedText(svg: string): string {
  const document = new JSDOM(svg).window.document;
  return (document.querySelector('svg')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('mermaid rendering', () => {
  it('draws the shape of a system as a flowchart', async () => {
    const { svg } = await mermaid.render('shape', FLOWCHART);
    expect(svg).toContain('<svg');
    const text = renderedText(svg);
    // Real labels survive into the drawing, including punctuation-heavy ones.
    expect(text).toContain('Fastify');
    expect(text).toContain('API');
    expect(text).toContain('src/web');
    expect(text).toContain('RepoService');
  }, 60_000);

  it('draws an end-to-end job as a sequence diagram', async () => {
    const { svg } = await mermaid.render('job', SEQUENCE);
    expect(svg).toContain('<svg');
    const text = renderedText(svg);
    expect(text).toContain('RepoService.open');
    expect(text).toContain('POST');
    expect(text).toContain('RepoContext');
    // A sequence diagram is only useful if it draws arrows; count them.
    expect((svg.match(/marker-end/g) ?? []).length).toBeGreaterThan(3);
  }, 60_000);

  it('reports a clear error for source it cannot draw', async () => {
    await expect(mermaid.parse('flowchart LR\n  a --> ')).rejects.toBeTruthy();
    await expect(mermaid.parse('nonsenseDiagram\n  a --> b')).rejects.toBeTruthy();
  }, 60_000);

  it('accepts the other diagram types the contract allows', async () => {
    await expect(mermaid.parse('stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running')).resolves.toBeDefined();
    await expect(mermaid.parse('erDiagram\n  DOCUMENT ||--o{ CHUNK : has')).resolves.toBeDefined();
  }, 60_000);
});

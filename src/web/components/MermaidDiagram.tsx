import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { mermaidSvgKey } from '../../core/explain/mermaidKey';

/**
 * Renders Mermaid source to SVG.
 *
 * Mermaid is loaded on demand: it is a large library and most readers never need
 * it on first paint, so it is code-split and fetched the first time a diagram
 * appears. Rendered output is cached by source, because the same diagram is
 * re-rendered on every state change otherwise.
 *
 * A diagram that fails to parse shows its source rather than an empty box — a
 * reader can still read the structure, and the failure is visible instead of
 * silent.
 */

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string };

const cache = new Map<string, RenderState>();

let initialised: Promise<typeof import('mermaid').default> | null = null;

async function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!initialised) {
    initialised = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        // Strict sanitises labels and disables click handlers, so model-authored
        // diagram text cannot become script.
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'base',
        fontFamily: 'inherit',
        themeVariables: {
          primaryColor: '#eef4fa',
          primaryBorderColor: '#c9dcee',
          primaryTextColor: '#1c1b19',
          secondaryColor: '#f6f4f1',
          secondaryBorderColor: '#e5e1da',
          tertiaryColor: '#ffffff',
          lineColor: '#a9a49c',
          textColor: '#1c1b19',
          noteBkgColor: '#fdf3e4',
          noteBorderColor: '#eddcc0',
          noteTextColor: '#3b3833',
          actorBkg: '#eef4fa',
          actorBorder: '#c9dcee',
          actorTextColor: '#1c1b19',
          signalColor: '#3b3833',
          signalTextColor: '#3b3833',
          labelBoxBkgColor: '#f6f4f1',
          fontSize: '14px',
        },
        flowchart: { curve: 'basis', useMaxWidth: true, htmlLabels: false, padding: 12 },
        sequence: { useMaxWidth: true, mirrorActors: false, showSequenceNumbers: false, wrap: true, boxMargin: 8 },
      });
      return mermaid;
    });
  }
  return initialised;
}

export async function renderMermaid(code: string): Promise<RenderState> {
  const key = code.trim();
  const cached = cache.get(key);
  if (cached && cached.status !== 'loading') return cached;

  try {
    const mermaid = await loadMermaid();
    // Parse first: it gives a clean error instead of mermaid's error SVG.
    await mermaid.parse(key);
    const id = `mermaid-${mermaidSvgKey(key)}`;
    const { svg } = await mermaid.render(id, key);
    const state: RenderState = {
      status: 'ready',
      svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } }),
    };
    cache.set(key, state);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    const state: RenderState = { status: 'error', message };
    cache.set(key, state);
    return state;
  }
}

export interface MermaidDiagramProps {
  code: string;
  caption?: string;
  /** Position among the diagrams in this explainer, used to match SVGs on export. */
  index: number;
}

export function MermaidDiagram({ code, caption, index }: MermaidDiagramProps) {
  const [state, setState] = useState<RenderState>(() => cache.get(code.trim()) ?? { status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get(code.trim());
    if (cached && cached.status !== 'loading') {
      setState(cached);
      return;
    }
    setState({ status: 'loading' });
    void renderMermaid(code).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (state.status === 'loading') {
    return (
      <div className="diagram diagram-mermaid" data-diagram-index={index} data-diagram-state="loading">
        <p className="muted small">Drawing…</p>
        <pre className="mermaid-source">{code}</pre>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="diagram diagram-mermaid" data-diagram-index={index} data-diagram-state="error">
        <p className="caption">
          This diagram could not be drawn (<code>{state.message}</code>). Its source is shown instead.
        </p>
        <pre className="mermaid-source">{code}</pre>
      </div>
    );
  }

  return (
    <div
      className="diagram diagram-mermaid"
      data-diagram-index={index}
      data-diagram-key={mermaidSvgKey(code)}
      data-diagram-state="ready"
    >
      <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
      {caption ? <p className="caption">{caption}</p> : null}
    </div>
  );
}

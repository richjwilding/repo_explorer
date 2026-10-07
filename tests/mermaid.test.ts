import { describe, expect, it } from 'vitest';
import { normalizeExplainer } from '../src/core/explain/schema.js';
import { exportExplainer } from '../src/core/explain/exportHtml.js';
import { mermaidSvgKey, sanitiseSvg } from '../src/core/explain/mermaidKey.js';
import { structuralRepoExplainer } from '../src/core/explain/structural.js';
import { analyzeRepo } from '../src/core/analysis/analyzeRepo.js';
import { createFixtureRepo } from './helpers/fixtureRepo.js';

const target = { kind: 'repo-overview' as const, id: 'root', label: 'fixture', level: 0 };
const context = { kind: 'repo-overview' as const, target, provider: 'test', model: 'test-1', sources: [], next: [] };

function explainerWith(diagram: unknown) {
  return normalizeExplainer(
    { title: 't', tldr: 'x', sections: [{ type: 'diagram', title: 'Shape', diagram }] },
    context,
  );
}

describe('mermaid diagrams', () => {
  it('accepts the diagram shapes the prompt asks for', () => {
    const flowchart = explainerWith({
      kind: 'mermaid',
      code: 'flowchart LR\n  web["web UI"] --> api["api service"]\n  api --> db[("PostgreSQL")]',
    });
    const diagram = flowchart.sections[0];
    expect(diagram.type).toBe('diagram');
    if (diagram.type !== 'diagram' || diagram.diagram.kind !== 'mermaid') throw new Error('expected mermaid');
    expect(diagram.diagram.code).toContain('flowchart LR');

    const sequence = explainerWith({
      kind: 'mermaid',
      code: 'sequenceDiagram\n  participant api as api service\n  api->>db: insert\n  db-->>api: ok',
    });
    expect(sequence.sections[0].type).toBe('diagram');
  });

  it('rejects a diagram type it cannot draw, rather than shipping a broken one', () => {
    expect(explainerWith({ kind: 'mermaid', code: 'notARealDiagram\n  a --> b' }).sections).toHaveLength(0);
    expect(explainerWith({ kind: 'mermaid', code: '   ' }).sections).toHaveLength(0);
  });

  it('keys a diagram by its source, so the browser and server agree', () => {
    const key = mermaidSvgKey('flowchart LR\n  a --> b');
    expect(key).toBe(mermaidSvgKey('flowchart LR\n  a --> b'));
    expect(key).toBe(mermaidSvgKey('  flowchart LR\n  a --> b  '));
    expect(key).not.toBe(mermaidSvgKey('flowchart LR\n  a --> c'));
  });

  it('refuses to embed an SVG that could execute', () => {
    expect(sanitiseSvg('<svg><rect/></svg>')).toBe('<svg><rect/></svg>');
    expect(sanitiseSvg('<svg onload="alert(1)"><rect/></svg>')).toBeNull();
    expect(sanitiseSvg('<svg><script>alert(1)</script></svg>')).toBeNull();
    expect(sanitiseSvg('<svg><a href="javascript:alert(1)">x</a></svg>')).toBeNull();
    expect(sanitiseSvg('<div>not an svg</div>')).toBeNull();
    expect(sanitiseSvg('')).toBeNull();
  });

  it('embeds a supplied SVG in the export and falls back to the source without one', async () => {
    const fixture = createFixtureRepo();
    try {
      const model = await analyzeRepo(fixture.root);
      const explainer = structuralRepoExplainer(model);
      const code = 'flowchart LR\n  a["one"] --> b["two"]';
      explainer.sections.unshift({
        type: 'diagram',
        id: 'shape',
        title: 'The shape of the system',
        diagram: { kind: 'mermaid', diagramType: 'flowchart', code },
      });

      const withoutSvg = exportExplainer(explainer, model).html;
      expect(withoutSvg).toContain('mermaid-source');
      expect(withoutSvg).toContain('Open this explainer in Repo Explorer to see it drawn');

      const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
      const withSvg = exportExplainer(explainer, model, [], { [mermaidSvgKey(code)]: svg }).html;
      expect(withSvg).toContain('<rect width="10" height="10"/>');
      expect(withSvg).not.toContain('Open this explainer in Repo Explorer to see it drawn');
      // The exported file needs no JavaScript to show the diagram.
      expect(withSvg).toContain('class="mermaid-svg"');
    } finally {
      fixture.cleanup();
    }
  }, 60_000);
});

describe('diagram labels', () => {
  it('leads a node label with the responsibility, keeping the filename as detail', () => {
    // Regression: at component level a diagram node read "generate.ts", which
    // says where something lives rather than what it does. The reader asked for
    // modules, subsystems and responsibilities — not a file inventory.
    const explainer = normalizeExplainer(
      {
        title: 't',
        tldr: 'x',
        sections: [
          {
            type: 'diagram',
            title: 'Internal structure',
            diagram: {
              kind: 'layers',
              layers: [
                {
                  label: 'Orchestration',
                  items: [{ label: 'generate.ts', sub: 'decides what to build', tone: 'primary' }],
                },
              ],
            },
          },
        ],
      },
      context,
    );
    const section = explainer.sections[0];
    if (section.type !== 'diagram' || section.diagram.kind !== 'layers') throw new Error('expected layers');
    const item = section.diagram.layers[0].items[0];
    expect(item.label).toBe('generate');
    expect(item.sub).toContain('generate.ts');
    expect(item.sub).toContain('decides what to build');
  });

  it('rewrites filename labels inside Mermaid source too', () => {
    const explainer = explainerWith({
      kind: 'mermaid',
      code: 'flowchart LR\n  gen["generate.ts"] --> digest["digest.ts"]\n  gen --> agent["core/agent"]',
    });
    const section = explainer.sections[0];
    if (section.type !== 'diagram' || section.diagram.kind !== 'mermaid') throw new Error('expected mermaid');
    expect(section.diagram.code).toContain('gen["generate"]');
    expect(section.diagram.code).toContain('digest["digest"]');
    // A path that is not a filename is left alone.
    expect(section.diagram.code).toContain('agent["core/agent"]');
  });

  it('replaces only the filename when a label carries a description too', () => {
    const explainer = explainerWith({
      kind: 'mermaid',
      code: 'flowchart LR\n  gen["generate.ts\\nplan, cache, fallback"] --> out["exportHtml.ts\\nself-contained HTML"]',
    });
    const section = explainer.sections[0];
    if (section.type !== 'diagram' || section.diagram.kind !== 'mermaid') throw new Error('expected mermaid');
    expect(section.diagram.code).toContain('gen["generate\\nplan, cache, fallback"]');
    expect(section.diagram.code).toContain('out["export html\\nself-contained HTML"]');
    expect(section.diagram.code).not.toContain('.ts');
  });

  it('leaves a label that is already a concept alone', () => {
    const explainer = explainerWith({
      kind: 'flow',
      nodes: [
        { id: 'a', label: 'Request handling' },
        { id: 'b', label: 'Persistence' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    const section = explainer.sections[0];
    if (section.type !== 'diagram' || section.diagram.kind !== 'flow') throw new Error('expected flow');
    expect(section.diagram.nodes.map((node) => node.label)).toEqual(['Request handling', 'Persistence']);
  });
});

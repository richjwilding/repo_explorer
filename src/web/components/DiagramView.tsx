import type { Diagram } from '../../core/types';
import { MermaidDiagram } from './MermaidDiagram';

function toneClass(tone?: string): string {
  return tone ? ` tone-${tone}` : '';
}

export function DiagramView({ diagram, index = 0 }: { diagram: Diagram; index?: number }) {
  switch (diagram.kind) {
    case 'mermaid':
      return <MermaidDiagram code={diagram.code} caption={diagram.caption} index={index} />;
    case 'flow':
      return <FlowDiagram diagram={diagram} />;
    case 'layers':
      return (
        <div className="diagram diagram-layers">
          {diagram.layers.map((layer, index) => (
            <div className="layer" key={`${layer.label}-${index}`}>
              <div className="layer-head">
                <span className="layer-label">{layer.label}</span>
                {layer.hint ? <span className="layer-hint">{layer.hint}</span> : null}
              </div>
              <div className="layer-items">
                {layer.items.map((item, itemIndex) => (
                  <span className={`pill${toneClass(item.tone)}`} title={item.sub} key={`${item.label}-${itemIndex}`}>
                    {item.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case 'tree':
      return (
        <div className="diagram diagram-tree">
          <ul className="tree">
            <TreeNode node={diagram.root} />
          </ul>
        </div>
      );
    case 'compare':
      return (
        <div className="diagram diagram-compare">
          {[diagram.left, diagram.right].map((side, index) => (
            <div className={`compare-side${toneClass(side.tone ?? (index === 0 ? 'danger' : 'success'))}`} key={side.title}>
              <h4>{side.title}</h4>
              <ul>
                {side.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      );
    case 'sequence':
      return (
        <div className="diagram diagram-sequence">
          <div className="actors">
            {diagram.actors.map((actor) => (
              <span className={`pill${toneClass(actor.tone)}`} key={actor.id}>
                {actor.label}
              </span>
            ))}
          </div>
          <ol className="sequence-steps">
            {diagram.steps.map((step, index) => (
              <li key={index}>
                <span className="seq-route">
                  {labelFor(diagram.actors, step.from)} → {labelFor(diagram.actors, step.to)}
                </span>
                <span className="seq-label">{step.label}</span>
              </li>
            ))}
          </ol>
          {diagram.example ? (
            <p className="diagram-example">
              <strong>Example:</strong> {diagram.example}
            </p>
          ) : null}
        </div>
      );
    case 'ui':
      return (
        <div className="diagram diagram-ui">
          <div className="ui-frame">
            <div className="ui-titlebar">{diagram.title}</div>
            {diagram.regions.map((region) => (
              <div className={`ui-region${toneClass(region.tone)}`} key={region.id}>
                <strong>{region.label}</strong>
                <span>{region.detail}</span>
              </div>
            ))}
          </div>
        </div>
      );
    default:
      return null;
  }
}

function labelFor(actors: { id: string; label: string }[], id: string): string {
  return actors.find((actor) => actor.id === id)?.label ?? id;
}

type Flow = Extract<Diagram, { kind: 'flow' }>;

function FlowDiagram({ diagram }: { diagram: Flow }) {
  const edges = diagram.edges;
  const extraEdges = edges.filter(
    (edge) =>
      !diagram.nodes.some((node, index) => {
        const next = diagram.nodes[index + 1];
        if (!next) return false;
        return (node.id === edge.from && next.id === edge.to) || (node.id === edge.to && next.id === edge.from);
      }),
  );

  return (
    <div className={`diagram diagram-flow${diagram.direction === 'vertical' ? ' vertical' : ''}`}>
      {diagram.nodes.map((node, index) => {
        const next = diagram.nodes[index + 1];
        const forward = next ? edges.find((edge) => edge.from === node.id && edge.to === next.id) : undefined;
        const backward = next && !forward ? edges.find((edge) => edge.from === next.id && edge.to === node.id) : undefined;
        const arrow = forward ?? backward;
        return (
          <div className="flow-row" key={node.id}>
            <div className={`flow-node${toneClass(node.tone)}`}>
              <span className="flow-label">{node.label}</span>
              {node.sub ? <span className="flow-sub">{node.sub}</span> : null}
            </div>
            {next ? (
              <div className={`flow-arrow${arrow?.dashed ? ' dashed' : ''}`}>
                {backward ? '←' : '→'}
                {arrow?.label ? <span className="arrow-label">{arrow.label}</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {extraEdges.length > 0 ? (
        <ul className="edge-list">
          {extraEdges.map((edge, index) => (
            <li key={index}>
              <code>{labelFor(diagram.nodes, edge.from)}</code> → <code>{labelFor(diagram.nodes, edge.to)}</code>
              {edge.label ? ` — ${edge.label}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {diagram.example ? (
        <p className="diagram-example">
          <strong>Example:</strong> {diagram.example}
        </p>
      ) : null}
    </div>
  );
}

function TreeNode({ node }: { node: Extract<Diagram, { kind: 'tree' }>['root'] }) {
  return (
    <li>
      <span className={`tree-label${toneClass(node.tone)}`}>{node.label}</span>
      {node.sub ? <span className="tree-sub">{node.sub}</span> : null}
      {node.children && node.children.length > 0 ? (
        <ul>
          {node.children.map((child, index) => (
            <TreeNode node={child} key={`${child.label}-${index}`} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

import { useMemo, useState } from 'react';
import type { ClientRepoModel } from '../../core/types';
import { KIND_LABELS, formatLoc, formatNumber, kindTone, shortPath } from '../lib/format';

export interface ArchitecturePanelProps {
  model: ClientRepoModel;
  onComponent: (id: string) => void;
  onFlow: (id: string) => void;
  onOpenFile: (path: string, startLine?: number) => void;
}

export function ArchitecturePanel({ model, onComponent, onFlow, onOpenFile }: ArchitecturePanelProps) {
  const [showAncillary, setShowAncillary] = useState(false);
  const [tab, setTab] = useState<'components' | 'routes' | 'hotspots' | 'dependencies'>('components');

  const components = useMemo(
    () =>
      [...model.components]
        .filter((component) => showAncillary || !component.ancillary)
        .sort((a, b) => b.importance - a.importance),
    [model.components, showAncillary],
  );

  const hiddenCount = model.components.filter((component) => component.ancillary).length;

  return (
    <div className="architecture">
      <div className="architecture-head">
        <div className="segmented">
          <button type="button" className={tab === 'components' ? 'active' : ''} onClick={() => setTab('components')}>
            Components
          </button>
          <button type="button" className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')}>
            Endpoints <span className="count">{model.routes.length}</span>
          </button>
          <button type="button" className={tab === 'hotspots' ? 'active' : ''} onClick={() => setTab('hotspots')}>
            Hotspots <span className="count">{model.hotspots.length}</span>
          </button>
          <button type="button" className={tab === 'dependencies' ? 'active' : ''} onClick={() => setTab('dependencies')}>
            Dependencies
          </button>
        </div>
        {tab === 'components' && hiddenCount > 0 ? (
          <label className="toggle">
            <input type="checkbox" checked={showAncillary} onChange={(event) => setShowAncillary(event.target.checked)} />
            <span>
              Show supporting components <span className="muted">({hiddenCount} hidden)</span>
            </span>
          </label>
        ) : null}
      </div>

      {tab === 'components' ? (
        <>
          <p className="caption">
            Ordered by how central each component is — lines of code, entrypoints, and how much other code depends on it. Click one to have
            the agent read it and explain it.
          </p>
          <div className="component-grid">
            {components.map((component) => (
              <button type="button" className={`component-card tone-${kindTone(component.kind)}`} key={component.id} onClick={() => onComponent(component.id)}>
                <span className="component-top">
                  <span className="component-name">{component.name}</span>
                  <span className="chip">{KIND_LABELS[component.kind] ?? component.kind}</span>
                </span>
                <span className="component-oneliner">{component.oneLiner}</span>
                <span className="component-stats">
                  {formatLoc(component.loc)} lines · {formatNumber(component.fileCount)} files
                  {component.dependsOn.length > 0 ? ` · depends on ${component.dependsOn.length}` : ''}
                  {component.ancillary ? ' · supporting' : ''}
                </span>
                {component.keyFiles.length > 0 ? <span className="component-path">{shortPath(component.keyFiles[0], 3)}</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      {tab === 'routes' ? (
        <div className="card">
          <h3>Endpoints detected by static analysis</h3>
          <p className="caption">
            Extracted from framework route declarations (FastAPI, Express, Gin, Spring, Rails, file-based routing, gRPC). Handler names come
            from the definition immediately following each declaration.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Handler</th>
                  <th>Location</th>
                  <th>Framework</th>
                </tr>
              </thead>
              <tbody>
                {model.routes.slice(0, 300).map((route) => (
                  <tr key={route.id}>
                    <td>
                      <span className="method">{route.method}</span>
                    </td>
                    <td>
                      <code>{route.path}</code>
                    </td>
                    <td>{route.handler ?? <span className="muted">unknown</span>}</td>
                    <td>
                      <button type="button" className="link-button" onClick={() => onOpenFile(route.file, route.line)}>
                        {shortPath(route.file, 2)}:{route.line}
                      </button>
                    </td>
                    <td className="muted">{route.framework}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === 'hotspots' ? (
        <>
          <div className="card">
            <h3>Churn × size</h3>
            <p className="caption">
              Commits touching a file, weighted by its size. High churn plus high size is where a codebase is both hard and constantly
              changing — usually where a new leader should spend their first week.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Commits</th>
                    <th>Lines</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {model.hotspots.map((hotspot) => (
                    <tr key={hotspot.path}>
                      <td>
                        <button type="button" className="link-button" onClick={() => onOpenFile(hotspot.path, 1)}>
                          {hotspot.path}
                        </button>
                      </td>
                      <td>{hotspot.commits}</td>
                      <td>{formatNumber(hotspot.loc)}</td>
                      <td>{hotspot.score.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {model.deadCode.length > 0 ? (
            <div className="card">
              <h3>
                Possibly unreachable code <span className="count">{model.deadCode.length}</span>
              </h3>
              <p className="caption">
                No resolved call reaches these from any detected entrypoint, and nothing else calls them. This is a question to investigate,
                not proof — dynamic dispatch, reflection, and framework hooks are invisible to static analysis.
              </p>
              <ul className="mini-list">
                {model.deadCode.slice(0, 40).map((candidate) => (
                  <li key={candidate.symbolId}>
                    <button type="button" className="link-button" onClick={() => onOpenFile(candidate.path, 1)}>
                      <strong>{candidate.name}</strong>
                    </button>
                    <span className="muted">
                      {candidate.kind} · {formatLoc(candidate.loc)} lines · {shortPath(candidate.path, 2)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {tab === 'dependencies' ? (
        <>
          {model.dataFlows.length > 0 ? (
            <div className="card">
              <h3>Inferred data flows</h3>
              <p className="caption">Traced from HTTP entrypoints along the component dependency graph.</p>
              <div className="flow-list">
                {model.dataFlows.map((flow) => (
                  <button type="button" className="flow-card" key={flow.id} onClick={() => onFlow(flow.id)}>
                    <span className="flow-name">{flow.name}</span>
                    <span className="flow-summary">{flow.summary}</span>
                    <span className="flow-path">{flow.path.join(' → ')}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card">
            <h3>
              What it depends on <span className="count">{model.dependencies.length}</span>
            </h3>
            <p className="caption">
              Names are the exact identifiers found — package specifiers from imports, container images from configuration files,
              environment variable keys, and connection-string schemes. Nothing here is inferred from a product list, and nothing is
              renamed.
            </p>
            <div className="dependency-groups">
              {(['image', 'env', 'url', 'package', 'manifest'] as const).map((kind) => {
                const group = model.dependencies.filter((dependency) => dependency.kind === kind);
                if (group.length === 0) return null;
                const heading =
                  kind === 'image'
                    ? 'Container images (from config)'
                    : kind === 'env'
                      ? 'Environment variables that name a service'
                      : kind === 'url'
                        ? 'Connection-string schemes'
                        : kind === 'package'
                          ? 'Packages the code imports'
                          : 'Declared in manifests';
                return (
                  <div className="dependency-group" key={kind}>
                    <h4>
                      {heading} <span className="count">{group.length}</span>
                    </h4>
                    <ul className="dependency-list">
                      {group.slice(0, 40).map((dependency) => (
                        <li key={`${kind}-${dependency.name}`}>
                          <code>{dependency.name}</code>
                          {dependency.label ? <span className="dep-label">{dependency.label}</span> : null}
                          <span className={`chip dep-${dependency.category}`}>{dependency.category}</span>
                          {dependency.evidence[0] ? (
                            <button type="button" className="link-button dep-source" onClick={() => onOpenFile(dependency.evidence[0], 1)}>
                              {shortPath(dependency.evidence[0], 2)}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              {model.dependencies.length === 0 ? <p className="muted">Nothing detected.</p> : null}
            </div>
          </div>

          <div className="card">
            <h3>Entrypoints</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>File</th>
                    <th>Why it was detected</th>
                  </tr>
                </thead>
                <tbody>
                  {model.entrypoints.map((entrypoint, index) => (
                    <tr key={`${entrypoint.path}-${index}`}>
                      <td>
                        <span className="method">{entrypoint.kind}</span>
                      </td>
                      <td>
                        <button type="button" className="link-button" onClick={() => onOpenFile(entrypoint.path, 1)}>
                          {entrypoint.path}
                        </button>
                      </td>
                      <td className="muted">{entrypoint.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {model.concepts.length > 0 ? (
            <div className="card">
              <h3>The codebase's vocabulary</h3>
              <p className="caption">Terms that recur across definitions and documentation — worth learning first.</p>
              <div className="concept-cloud">
                {model.concepts.map((concept) => (
                  <span className="concept" key={concept.name} title={concept.reason}>
                    {concept.name}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

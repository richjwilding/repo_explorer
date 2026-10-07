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
  const [tab, setTab] = useState<'components' | 'routes' | 'hotspots' | 'dependencies' | 'tests' | 'ops' | 'conventions' | 'gaps'>('components');

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
            Contracts <span className="count">{model.routes.length + model.dataModel.summary.tables + model.dataModel.summary.apiSpecs}</span>
          </button>
          <button type="button" className={tab === 'hotspots' ? 'active' : ''} onClick={() => setTab('hotspots')}>
            History <span className="count">{model.hotspots.length}</span>
          </button>
          <button type="button" className={tab === 'dependencies' ? 'active' : ''} onClick={() => setTab('dependencies')}>
            Dependencies
          </button>
          <button type="button" className={tab === 'tests' ? 'active' : ''} onClick={() => setTab('tests')}>
            Tests <span className="count">{model.tests.summary.percentReferenced}%</span>
          </button>
          <button type="button" className={tab === 'ops' ? 'active' : ''} onClick={() => setTab('ops')}>
            Running it <span className="count">{opsItemCount(model)}</span>
          </button>
          <button type="button" className={tab === 'conventions' ? 'active' : ''} onClick={() => setTab('conventions')}>
            Conventions <span className="count">{model.conventions.summary.derived}</span>
          </button>
          <button type="button" className={tab === 'gaps' ? 'active' : ''} onClick={() => setTab('gaps')}>
            Gaps <span className="count">{model.gaps.summary.absent}</span>
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
        <>
          <DataModelSection model={model} onOpenFile={onOpenFile} />
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
        </>
      ) : null}

      {tab === 'hotspots' ? (
        <>
          <div className="card">
            <h3>Churn × complexity</h3>
            <p className="caption">
              Commits touching a file, weighted by its <em>measured</em> complexity — decision points and control-flow nesting, not line
              count. Where both are high is where a codebase is hard and constantly changing, which is usually where a new leader should
              spend their first week.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Commits</th>
                    <th>Decision points</th>
                    <th>Depth</th>
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
                      <td>
                        {hotspot.measured ? hotspot.branches : <span className="muted small">— by size</span>}
                      </td>
                      <td>{hotspot.measured ? hotspot.maxDepth : <span className="muted small">—</span>}</td>
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

          <ComplexitySection model={model} onOpenFile={onOpenFile} />

          <CouplingSection model={model} onOpenFile={onOpenFile} />
        </>
      ) : null}

      {tab === 'tests' ? (
        <TestsPanel model={model} onOpenFile={onOpenFile} />
      ) : null}

      {tab === 'ops' ? <OpsPanel model={model} onOpenFile={onOpenFile} /> : null}

      {tab === 'conventions' ? <ConventionsPanel model={model} onOpenFile={onOpenFile} /> : null}

      {tab === 'gaps' ? <GapsPanel model={model} onOpenFile={onOpenFile} /> : null}

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

/**
 * What the tests actually reach, measured rather than assumed.
 *
 * Coverage here means a test file reaches this file through the import graph or
 * the resolved call graph. It answers "does anything exercise this", which is a
 * different and weaker question than "is this correct" — the wording says so.
 */
function TestsPanel({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string) => void }) {
  const tests = model.tests;
  const summary = tests.summary;

  if (summary.testFiles === 0) {
    return (
      <div className="placeholder left">
        <h2>No test files were detected</h2>
        <p className="muted">
          Nothing in this repository declares a test case, so there is no coverage to report. Treat correctness claims
          about this code as unverified.
        </p>
      </div>
    );
  }

  return (
    <div className="tests-panel">
      <p className="caption">
        Measured from the import and call graphs: a source file counts as reached when a test imports it, calls into it, or reaches it
        within two hops. This says whether something exercises the code, not whether the code is correct.
      </p>

      <div className="coverage-summary">
        <div className="coverage-figure">
          <strong>{summary.percentReferenced}%</strong>
          <span className="muted">
            of {summary.sourceFiles} source files are reached by a test ({summary.referenced} files)
          </span>
        </div>
        <div className="coverage-meta muted">
          {summary.testFiles} test files · {summary.testLoc.toLocaleString()} lines of test code · {summary.sourceLoc.toLocaleString()} lines
          of source
        </div>
      </div>

      <h3>By component, least covered first</h3>
      <ul className="coverage-list">
        {tests.components.map((component) => (
          <li key={component.id}>
            <span className="coverage-name">{component.name}</span>
            <span className="coverage-bar" aria-hidden="true">
              <span style={{ width: `${component.percent}%` }} className={component.percent < 25 ? 'low' : component.percent < 75 ? 'mid' : 'good'} />
            </span>
            <span className="coverage-value muted">
              {component.percent}% · {component.referenced} of {component.sourceFiles}
            </span>
          </li>
        ))}
      </ul>

      {tests.riskyGaps.length > 0 ? (
        <>
          <h3>Untested and changing — the riskiest gaps</h3>
          <p className="muted small">Files no test reaches that also carry the most commit history.</p>
          <ul className="gap-list">
            {tests.riskyGaps.map((gap) => (
              <li key={gap.path}>
                <button type="button" className="link" onClick={() => onOpenFile(gap.path)}>
                  {gap.path}
                </button>
                <span className="muted">
                  {gap.churn} commits · {gap.loc.toLocaleString()} lines{gap.component ? ` · ${gap.component}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {tests.untested.length > 0 ? (
        <>
          <h3>Largest files no test reaches</h3>
          <ul className="gap-list">
            {tests.untested.slice(0, 20).map((file) => (
              <li key={file.path}>
                <button type="button" className="link" onClick={() => onOpenFile(file.path)}>
                  {file.path}
                </button>
                <span className="muted">
                  {file.loc.toLocaleString()} lines{file.symbols ? ` · ${file.symbols} definitions` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {tests.testsReachingNothing.length > 0 ? (
        <>
          <h3>Tests that reach no source file</h3>
          <p className="muted small">
            They may be exercising a library or a fixture rather than this repository's own code.
          </p>
          <ul className="gap-list">
            {tests.testsReachingNothing.map((test) => (
              <li key={test.path}>
                <button type="button" className="link" onClick={() => onOpenFile(test.path)}>
                  {test.path}
                </button>
                <span className="muted">{test.reason}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** How many things the Running it tab has to say — used as the tab's badge. */
function opsItemCount(model: ClientRepoModel): number {
  const ops = model.ops;
  return ops.ci.length + ops.containers.length + ops.compose.length + ops.infra.length;
}

/**
 * How the project is built, verified, shipped and run.
 *
 * The tab exists because this is the first question a new leader asks and the
 * one thing that cannot be answered by reading source. An absence is shown as
 * plainly as a presence: "no CI" is a finding, not an empty panel.
 */
function OpsPanel({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string) => void }) {
  const ops = model.ops;
  const { summary } = ops;
  const scripts = ops.scripts.filter((script) => script.category !== 'other');
  const envVars = ops.envVars.filter((entry) => !entry.testOnly);
  const fixtureVars = ops.envVars.filter((entry) => entry.testOnly);
  const nothing = opsItemCount(model) === 0 && scripts.length === 0 && envVars.length === 0;

  const pathLink = (path: string) => (
    <button type="button" className="link" onClick={() => onOpenFile(path)}>
      {path}
    </button>
  );

  if (nothing) {
    return (
      <div className="placeholder left">
        <h2>Nothing states how this runs</h2>
        <p className="muted">
          No CI definitions, container files, infrastructure manifests, scripts or environment variables were found. That is a finding in
          itself: there is no stated way to build, verify or deploy this, so anything you need to know has to be asked of the team.
        </p>
      </div>
    );
  }

  return (
    <div className="ops-panel">
      <div className="ops-cards">
        <div className={`ops-card ${summary.ciGate ? '' : 'ops-warn'}`}>
          <span className="ops-label">Verified by</span>
          {summary.ciGate ? (
            <>
              <span className="ops-value">{summary.ciWorkflow}</span>
              <code className="ops-command">{summary.ciGate}</code>
              {summary.ciWorkflow ? <span className="muted small">{pathLink(summary.ciWorkflow)}</span> : null}
            </>
          ) : (
            <span className="ops-value muted">No CI. Nothing runs automatically on a change.</span>
          )}
          <span className="muted small">
            {[summary.typecheck && 'typecheck', summary.test && 'tests', summary.lint && 'lint'].filter(Boolean).join(', ') ||
              'No local verification scripts'}
          </span>
        </div>

        <div className="ops-card">
          <span className="ops-label">Deployed as</span>
          <span className="ops-value">
            {summary.deployTargets.length > 0 ? summary.deployTargets.join(', ') : <span className="muted">Nothing declared</span>}
          </span>
          {summary.ports.length > 0 ? <span className="muted small">listens on {summary.ports.join(', ')}</span> : null}
          {summary.entrypoint ? <code className="ops-command">{summary.entrypoint}</code> : null}
        </div>

        <div className="ops-card">
          <span className="ops-label">Configured by</span>
          <span className="ops-value">{envVars.length > 0 ? `${envVars.length} environment variable${envVars.length === 1 ? '' : 's'}` : <span className="muted">Nothing declared</span>}</span>
          {envVars.length > 0 ? <span className="muted small">{envVars.slice(0, 6).map((entry) => entry.name).join(', ')}</span> : null}
          {fixtureVars.length > 0 ? <span className="muted small">({fixtureVars.length} more appear only in tests)</span> : null}
        </div>
      </div>

      {scripts.length > 0 ? (
        <section className="ops-section">
          <h3>Scripts declared by the project</h3>
          <ul className="script-list">
            {scripts.map((script) => (
              <li key={`${script.manifest}-${script.name}`}>
                <span className={`chip tone-${script.category === 'test' ? 'ok' : 'neutral'}`}>{script.category}</span>
                <code className="script-name">{script.name}</code>
                <code className="script-command">{script.command}</code>
                <span className="muted small">{pathLink(script.manifest)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ops.ci.length > 0 ? (
        <section className="ops-section">
          <h3>Continuous integration</h3>
          {ops.ci.map((workflow) => (
            <div className="ops-block" key={workflow.path}>
              <div className="ops-block-head">
                <span className="ops-block-title">{workflow.name}</span>
                {pathLink(workflow.path)}
                {workflow.triggers.length > 0 ? <span className="muted small">on {workflow.triggers.join(', ')}</span> : null}
              </div>
              {workflow.jobs.map((job) => (
                <div className="ops-job" key={job.id}>
                  <span className="muted small">
                    job <code>{job.id}</code>
                    {job.runner ? ` on ${job.runner}` : ''}
                    {job.needs.length > 0 ? ` · after ${job.needs.join(', ')}` : ''}
                  </span>
                  {job.commands.length > 0 ? <code className="ops-command multiline">{job.commands.join('\n')}</code> : null}
                  {job.actions.length > 0 ? <span className="muted small">uses {job.actions.join(', ')}</span> : null}
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      {ops.containers.length > 0 ? (
        <section className="ops-section">
          <h3>Containers</h3>
          {ops.containers.map((container) => (
            <div className="ops-block" key={container.path}>
              <div className="ops-block-head">
                <span className="ops-block-title">{container.multiStage ? `${container.stages.length}-stage build` : 'single stage'}</span>
                {pathLink(container.path)}
                {container.exposedPorts.length > 0 ? <span className="muted small">exposes {container.exposedPorts.join(', ')}</span> : null}
              </div>
              <ul className="stage-list">
                {container.stages.map((stage) => (
                  <li key={`${stage.name}-${stage.line}`}>
                    <code>{stage.name}</code> <span className="muted">from</span> <code>{stage.base}</code>
                  </li>
                ))}
              </ul>
              {container.entrypoint ?? container.cmd ? (
                <span className="muted small">
                  starts with <code>{container.entrypoint ?? container.cmd}</code>
                </span>
              ) : null}
              <div className="ops-flags">
                {container.runsAsRoot ? <span className="chip tone-warn">runs as root</span> : <span className="chip tone-ok">non-root user</span>}
                {!container.healthcheck ? <span className="chip tone-neutral">no healthcheck</span> : null}
                {!container.cachesDependencies ? <span className="chip tone-neutral">deps rebuilt on source change</span> : null}
                {container.buildArgs.length > 0 ? <span className="chip tone-neutral">build args: {container.buildArgs.join(', ')}</span> : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {ops.compose.length > 0 ? (
        <section className="ops-section">
          <h3>Compose</h3>
          {ops.compose.map((file) => (
            <div className="ops-block" key={file.path}>
              <div className="ops-block-head">
                <span className="ops-block-title">{file.services.length} services</span>
                {pathLink(file.path)}
              </div>
              <ul className="stage-list">
                {file.services.map((service) => (
                  <li key={service.name}>
                    <code>{service.name}</code> <span className="muted">{service.image ?? `built from ${service.build ?? '.'}`}</span>
                    {service.ports.length > 0 ? <span className="muted small"> · ports {service.ports.join(' ')}</span> : null}
                    {service.dependsOn.length > 0 ? <span className="muted small"> · after {service.dependsOn.join(', ')}</span> : null}
                    {service.environment.length > 0 ? <span className="muted small"> · env {service.environment.join(', ')}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}

      {ops.infra.length > 0 ? (
        <section className="ops-section">
          <h3>Infrastructure</h3>
          {ops.infra.map((file) => {
            const counts = new Map<string, number>();
            for (const resource of file.resources) counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
            return (
              <div className="ops-block" key={file.path}>
                <div className="ops-block-head">
                  <span className="ops-block-title">{file.format}</span>
                  {pathLink(file.path)}
                  {file.images.length > 0 ? <span className="muted small">{file.images.length} image(s)</span> : null}
                </div>
                <span className="muted small">
                  {[...counts.entries()].map(([kind, count]) => (count > 1 ? `${count}× ${kind}` : kind)).join(', ') || 'nothing parsed'}
                </span>
              </div>
            );
          })}
        </section>
      ) : null}

      {envVars.length > 0 ? (
        <section className="ops-section">
          <h3>Configuration</h3>
          <ul className="script-list">
            {envVars.map((entry) => (
              <li key={entry.name}>
                <code className="script-name">{entry.name}</code>
                <span className="muted small">{pathLink(entry.primaryFile)}</span>
                {entry.files.length > 1 ? <span className="muted small">+{entry.files.length - 1} more</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ops.warnings.length > 0 ? (
        <section className="ops-section">
          <h3>Notes</h3>
          <ul className="muted small">
            {ops.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * What history says that the code does not.
 *
 * The import graph shows the dependencies someone declared. This shows the ones
 * that exist in practice: files that have to move together, especially across a
 * component boundary, and how few people hold each component's history.
 */
function CouplingSection({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string, line?: number) => void }) {
  const coupling = model.coupling;
  if (coupling.totalCommits < 5) return null;

  const cross = coupling.pairs.filter((pair) => pair.crossComponent);
  const same = coupling.pairs.filter((pair) => !pair.crossComponent);
  const hasAnything = coupling.pairs.length > 0 || coupling.components.length > 0;
  if (!hasAnything) return null;

  return (
    <>
      {coupling.pairs.length > 0 ? (
        <div className="card">
          <h3>Files that change together</h3>
          <p className="caption">
            Derived from {coupling.totalCommits.toLocaleString()} commits. <strong>Confidence</strong> is how often one file changes when the
            other does. Pairs spanning two components are the ones the import graph does not show — usually why a small change turns out to be
            a large one.
          </p>
          {cross.length > 0 ? (
            <>
              <h4 className="subhead">Across components <span className="count">{cross.length}</span></h4>
              <ul className="coupling-list">
                {cross.slice(0, 12).map((pair) => (
                  <li key={`${pair.a}-${pair.b}`}>
                    <span className="coupling-pair">
                      <button type="button" className="link-button" onClick={() => onOpenFile(pair.a, 1)}>
                        {pair.a}
                      </button>
                      <span className="muted"> + </span>
                      <button type="button" className="link-button" onClick={() => onOpenFile(pair.b, 1)}>
                        {pair.b}
                      </button>
                    </span>
                    <span className="coupling-meter" title={`confidence ${pair.confidence}`}>
                      <span className="coupling-bar" style={{ width: `${Math.round(pair.confidence * 100)}%` }} />
                    </span>
                    <span className="muted small">
                      {Math.round(pair.confidence * 100)}% · {pair.together} commits
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {same.length > 0 ? (
            <>
              <h4 className="subhead">Within one component</h4>
              <ul className="coupling-list">
                {same.slice(0, 10).map((pair) => (
                  <li key={`${pair.a}-${pair.b}`}>
                    <span className="coupling-pair">
                      <button type="button" className="link-button" onClick={() => onOpenFile(pair.a, 1)}>
                        {shortPath(pair.a, 3)}
                      </button>
                      <span className="muted"> + </span>
                      <button type="button" className="link-button" onClick={() => onOpenFile(pair.b, 1)}>
                        {shortPath(pair.b, 3)}
                      </button>
                    </span>
                    <span className="coupling-meter">
                      <span className="coupling-bar" style={{ width: `${Math.round(pair.confidence * 100)}%` }} />
                    </span>
                    <span className="muted small">
                      {Math.round(pair.confidence * 100)}% · {pair.together} commits
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {coupling.components.length > 0 ? (
        <div className="card">
          <h3>Who owns what</h3>
          <p className="caption">
            From commit authorship. <strong>Bus factor</strong> is how many people have to leave before nobody is left who has written half of a
            component&apos;s history.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Commits</th>
                  <th>Authors</th>
                  <th>Most active</th>
                  <th>Bus factor</th>
                </tr>
              </thead>
              <tbody>
                {coupling.components.map((component) => (
                  <tr key={component.id}>
                    <td>{component.name}</td>
                    <td>{component.commits.toLocaleString()}</td>
                    <td>{component.authors}</td>
                    <td>
                      {component.topAuthor} <span className="muted small">{Math.round(component.topAuthorShare * 100)}%</span>
                    </td>
                    <td>
                      <span className={`chip ${component.busFactor <= 1 ? 'tone-warn' : 'tone-neutral'}`}>{component.busFactor}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {coupling.singleOwner.length > 0 ? (
            <p className="caption warn-text">
              Key-person risk: {coupling.singleOwner.map((component) => component.name).join(', ')} — one person wrote at least 80% of the
              history for each, over enough commits that the pattern is real rather than a young repository.
            </p>
          ) : null}
        </div>
      ) : null}

      {coupling.warnings.length > 0 ? (
        <div className="card">
          <p className="caption muted">{coupling.warnings.join(' ')}</p>
        </div>
      ) : null}
    </>
  );
}

/**
 * Where the difficulty actually is.
 *
 * Line count is the cheapest proxy for "hard" and a poor one: a table of
 * constants is long and easy, a short function with eight nested branches is
 * neither. These are measured — decision points and control-flow nesting per
 * definition — and weighted by how many callers depend on them, because
 * changing a branchy function nothing calls is cheap.
 */
function ComplexitySection({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string, line?: number) => void }) {
  const complexity = model.complexity;
  if (complexity.symbols.length === 0) return null;
  const summary = complexity.summary;

  return (
    <div className="card">
      <h3>Hardest to change safely</h3>
      <p className="caption">
        {summary.functionsAnalysed.toLocaleString()} definitions measured — mean {summary.meanBranches} decision points and nesting depth{' '}
        {summary.meanDepth}. {summary.deepFunctions} nest {4}+ levels deep and {summary.branchyFunctions} carry {10}+ decision points. Depth
        counts control-flow blocks only, so an indented object literal is not counted as complexity.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Definition</th>
              <th>Decision points</th>
              <th>Depth</th>
              <th>Callers</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {complexity.symbols.slice(0, 20).map((symbol) => (
              <tr key={symbol.id}>
                <td>
                  <button type="button" className="link-button" onClick={() => onOpenFile(symbol.path, symbol.line)}>
                    {symbol.name}
                  </button>
                  <span className="muted small"> {shortPath(symbol.path, 2)}:{symbol.line}</span>
                </td>
                <td>{symbol.branches}</td>
                <td>
                  <span className={`chip ${symbol.maxDepth >= 4 ? 'tone-warn' : 'tone-neutral'}`}>{symbol.maxDepth}</span>
                </td>
                <td>{symbol.callers}</td>
                <td>{symbol.score.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption muted">
        Score is difficulty (decision points plus twice the nesting depth) multiplied by how many callers depend on it. Depth is weighted
        more heavily because holding an outer condition while reasoning about an inner one is the expensive part.
      </p>
    </div>
  );
}

/**
 * The rules this codebase follows, and the code that does not.
 *
 * Every rule is inferred by measuring this repository's own majority behaviour,
 * so a rule is a description rather than an opinion, and an exception is a
 * question worth asking rather than a defect. Rules with exceptions are shown
 * first, because that is what a reader came for.
 */
function ConventionsPanel({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string, line?: number) => void }) {
  const report = model.conventions;
  if (report.rules.length === 0) {
    return (
      <div className="placeholder left">
        <h2>No conventions stand out</h2>
        <p className="muted">
          No pattern in this repository is followed closely enough to state as a rule. That usually means it is small, very new, or
          deliberately inconsistent — which is itself worth knowing.
        </p>
        {report.weakPatterns.length > 0 ? (
          <ul className="muted">
            {report.weakPatterns.map((pattern) => (
              <li key={pattern}>{pattern}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const withExceptions = report.rules.filter((rule) => rule.violations.length > 0);
  const clean = report.rules.filter((rule) => rule.violations.length === 0);

  const ruleCard = (rule: ClientRepoModel['conventions']['rules'][number]) => (
    <div className="convention" key={rule.id}>
      <div className="convention-head">
        <span className="convention-rule">{rule.rule}</span>
        <span className={`chip ${rule.violations.length === 0 ? 'tone-ok' : 'tone-warn'}`}>{Math.round(rule.adherence * 100)}% followed</span>
      </div>
      <p className="caption">{rule.basis}</p>
      {rule.violations.length > 0 ? (
        <ul className="violation-list">
          {rule.violations.map((violation) => (
            <li key={`${violation.path}-${violation.line ?? 0}-${violation.detail}`}>
              <button type="button" className="link-button" onClick={() => onOpenFile(violation.path, violation.line ?? 1)}>
                {violation.path}
              </button>
              <span className="muted"> — {violation.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="caption muted">No exceptions.</p>
      )}
    </div>
  );

  return (
    <div className="conventions-panel">
      <p className="caption">
        Inferred by measuring this repository&apos;s own behaviour — {report.summary.derived} conventions, {report.summary.violations}{' '}
        exception{report.summary.violations === 1 ? '' : 's'}. A rule here describes what the code does, not what is generally
        considered good practice, and an exception is a question rather than a defect.
      </p>

      {withExceptions.length > 0 ? (
        <section className="card">
          <h3>Where the code differs from its own conventions</h3>
          {withExceptions.map(ruleCard)}
        </section>
      ) : null}

      {clean.length > 0 ? (
        <section className="card">
          <h3>Conventions with no exceptions</h3>
          {clean.map(ruleCard)}
        </section>
      ) : null}

      {report.weakPatterns.length > 0 ? (
        <section className="card">
          <h3>Deliberately mixed — no rule to break</h3>
          <ul className="muted small">
            {report.weakPatterns.map((pattern) => (
              <li key={pattern}>{pattern}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The shape of the data.
 *
 * Read from the files that declare it — SQL, ORM schemas and API definitions —
 * because a schema is a claim the system makes about the world and is usually
 * the most stable thing in a repository. When a database is used but no schema
 * is found, that is said plainly rather than left as a blank panel.
 */
function DataModelSection({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string, line?: number) => void }) {
  const data = model.dataModel;
  const tables = data.schemas.filter((schema) => schema.kind === 'table' || schema.kind === 'model');
  const types = data.schemas.filter((schema) => schema.kind !== 'table' && schema.kind !== 'model' && schema.kind !== 'operation root');
  const roots = data.schemas.filter((schema) => schema.kind === 'operation root');
  const hasStores = data.summary.stores.length > 0;

  if (data.schemas.length === 0) {
    if (!hasStores && data.apiSpecs.length === 0) return null;
    return (
      <div className="card">
        <h3>Data model</h3>
        <p className="caption">
          {hasStores
            ? `${data.summary.stores.join(', ')} ${data.summary.stores.length === 1 ? 'is' : 'are'} named by the dependencies, but no table, model or API definition was found in this repository. The schema may live in a separate repository, or be managed outside the codebase — worth knowing before you reach for a migration.`
            : 'API definitions were found but no data schemas.'}
        </p>
      </div>
    );
  }

  const schemaCard = (schema: ClientRepoModel['dataModel']['schemas'][number]) => (
    <div className="schema" key={`${schema.path}-${schema.name}`}>
      <div className="schema-head">
        <span className="schema-name">{schema.name}</span>
        <span className="chip tone-neutral">{schema.kind}</span>
        <button type="button" className="link-button small" onClick={() => onOpenFile(schema.path, schema.line)}>
          {schema.path}:{schema.line}
        </button>
        {schema.primaryKey.length > 0 ? <span className="muted small">key: {schema.primaryKey.join(', ')}</span> : null}
      </div>
      {schema.fields.length > 0 ? (
        <ul className="field-list">
          {schema.fields.slice(0, 24).map((field) => (
            <li key={`${field.name}-${field.line}`}>
              <code className="field-name">{field.name}</code>
              <span className="field-type">{field.type}</span>
              {!field.optional ? <span className="chip tone-warn tiny">required</span> : null}
              {field.note ? <span className="muted small">{field.note}</span> : null}
            </li>
          ))}
          {schema.fields.length > 24 ? <li className="muted small">+{schema.fields.length - 24} more fields</li> : null}
        </ul>
      ) : null}
      {schema.foreignKeys.length > 0 ? (
        <ul className="fk-list">
          {schema.foreignKeys.map((key) => (
            <li key={`${key.column}-${key.line}`}>
              <span className="muted small">
                {key.column} → {key.references}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {schema.operations.length > 0 ? (
        <ul className="fk-list">
          {schema.operations.slice(0, 12).map((operation) => (
            <li key={`${operation.name}-${operation.line}`}>
              <span className="muted small">
                {operation.kind}: {operation.name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <div className="card">
      <h3>
        Data model <span className="count">{data.summary.tables} table(s) · {data.summary.schemas} schema(s)</span>
      </h3>
      <p className="caption">
        Read from the files that declare the shape — SQL, ORM schemas and API definitions.
        {data.summary.stores.length > 0 ? ` Storage named by the dependencies: ${data.summary.stores.join(', ')}.` : ''}
        {data.summary.foreignKeys > 0 ? ` ${data.summary.foreignKeys} foreign key(s) declared.` : ''}
        {data.summary.migrations > 0 ? ` ${data.summary.migrations} schema file(s), applied in path order.` : ''}
      </p>

      {tables.length > 0 ? (
        <>
          <h4 className="subhead">Tables and models</h4>
          {tables.map(schemaCard)}
        </>
      ) : null}

      {data.migrations.length > 0 ? (
        <>
          <h4 className="subhead">Schema files in the order they would apply</h4>
          <ul className="stage-list">
            {data.migrations.map((migration) => (
              <li key={migration.path}>
                <button type="button" className="link-button" onClick={() => onOpenFile(migration.path, 1)}>
                  {migration.path}
                </button>
                <span className="muted small">
                  {' '}
                  {migration.statements} statement(s)
                  {migration.creates.length > 0 ? ` · creates ${migration.creates.join(', ')}` : ''}
                  {migration.alters.length > 0 ? ` · alters ${migration.alters.join(', ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {types.length > 0 ? (
        <>
          <h4 className="subhead">Types, enums and messages</h4>
          {types.map(schemaCard)}
        </>
      ) : null}

      {roots.length > 0 ? (
        <>
          <h4 className="subhead">Declared operations</h4>
          {roots.map(schemaCard)}
        </>
      ) : null}
    </div>
  );
}

/**
 * What the repository does not say about itself.
 *
 * Every finding is derived from a fact the analysis measured, and every one is
 * phrased as an observation rather than a verdict: a project can have no CI, or
 * no licence, for a perfectly good reason that is not visible from here. What is
 * absent is listed beside what is present so the report reads as a balance
 * rather than a criticism.
 */
function GapsPanel({ model, onOpenFile }: { model: ClientRepoModel; onOpenFile: (path: string, line?: number) => void }) {
  const report = model.gaps;
  if (report.summary.checked === 0) {
    return (
      <div className="placeholder left">
        <h2>Nothing to conclude from</h2>
        <p className="muted">
          This repository is too small or too unusual for an absence to mean anything. Reporting one would be a guess.
        </p>
      </div>
    );
  }

  const weightLabel: Record<string, string> = { high: 'worth knowing first', medium: 'worth asking about', low: 'worth noting' };

  return (
    <div className="gaps-panel">
      <p className="caption">
        {report.summary.met} of {report.summary.checked} things a repository of this kind usually states are present; {report.summary.absent}{' '}
        are absent. Each entry below names the facts it was derived from, and an absence is an observation rather than a verdict — there may be a
        good reason that is not visible here.
      </p>

      {report.gaps.length > 0 ? (
        report.gaps.map((gap) => (
          <div className={`gap-card weight-${gap.weight}`} key={gap.id}>
            <div className="gap-head">
              <span className={`chip tone-${gap.weight === 'high' ? 'warn' : 'neutral'}`}>{weightLabel[gap.weight]}</span>
              <span className="gap-title">{gap.title}</span>
            </div>
            <p className="caption">{gap.detail}</p>
            {gap.evidence.length > 0 ? (
              <ul className="gap-evidence">
                {gap.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {gap.paths.length > 0 ? (
              <div className="gap-paths">
                {gap.paths.slice(0, 6).map((path) => (
                  <button type="button" className="link-button small" key={path} onClick={() => onOpenFile(path, 1)}>
                    {path}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ))
      ) : (
        <div className="card">
          <h3>Nothing notable is absent</h3>
          <p className="caption">Every expectation this analysis can check is met.</p>
        </div>
      )}

      {report.met.length > 0 ? (
        <div className="card">
          <h3>Present</h3>
          <ul className="met-list">
            {report.met.map((item) => (
              <li key={item.id}>
                <span className="chip tone-ok tiny">present</span> <span className="muted">{item.title}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

import { useState } from 'react';
import type { Explainer, NextRelation, StalenessReport } from '../../core/types';
import { SectionRenderer } from './SectionRenderer';
import { Markdown } from '../lib/markdown';
import { formatDate } from '../lib/format';

export interface AgentStepView {
  index: number;
  thought?: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  failed?: boolean;
}

export function AgentTrace({ steps, status, running }: { steps: AgentStepView[]; status: string | null; running: boolean }) {
  const [showSteps, setShowSteps] = useState(false);
  if (!running && steps.length === 0) return null;

  // Once a run finishes this is a record, not progress. Collapsing it stops it
  // from looking like a stuck progress panel, while keeping it one click away.
  if (!running) {
    return (
      <div className="agent-trace done">
        <div className="agent-trace-head">
          <span className="dot" />
          <strong>
            Investigated with {steps.length} tool call{steps.length === 1 ? '' : 's'}
          </strong>
          <button type="button" className="link-button" onClick={() => setShowSteps((previous) => !previous)}>
            {showSteps ? 'Hide the steps' : 'Show the steps'}
          </button>
        </div>
        {showSteps ? (
          <ol>
            {steps.map((step) => (
              <li key={step.index} className={step.failed ? 'failed' : ''}>
                <code>{step.tool}</code>
                <span className="agent-args">{summariseArgs(step.args)}</span>
                <span className="agent-summary">{step.summary}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    );
  }

  return (
    <div className="agent-trace">
      <div className="agent-trace-head">
        <span className="dot pulse" />
        <strong>Investigating the repository</strong>
        {status ? <span className="muted">{status}</span> : null}
      </div>
      <ol>
        {steps.map((step) => (
          <li key={step.index} className={step.failed ? 'failed' : ''}>
            <code>{step.tool}</code>
            <span className="agent-args">{summariseArgs(step.args)}</span>
            <span className="agent-summary">{step.summary}</span>
            {step.thought ? <p className="agent-thought">{step.thought}</p> : null}
          </li>
        ))}
        {running ? <li className="pending">…</li> : null}
      </ol>
    </div>
  );
}

/**
 * Tells the reader an explainer no longer matches the code.
 *
 * Deliberately a notice rather than an action: the explainer stays visible in
 * full, and regenerating is the reader's decision.
 */
function StalenessNotice({
  staleness,
  onRegenerate,
  generating,
  onOpenFile,
}: {
  staleness: StalenessReport;
  onRegenerate: () => void;
  generating: boolean;
  onOpenFile: (path: string, startLine?: number) => void;
}) {
  const [showFiles, setShowFiles] = useState(false);
  const changed = staleness.changedFiles;
  const removed = staleness.removedFiles;

  return (
    <div className="stale-banner">
      <div>
        <strong>Out of date — the code has changed since this was written.</strong>
        <p>
          {staleness.summary} It is still shown in full, and it is usually worth reading; regenerate when you want it
          rewritten against the current code.
        </p>
        {changed.length > 0 || removed.length > 0 ? (
          <>
            <button type="button" className="link-button" onClick={() => setShowFiles((previous) => !previous)}>
              {showFiles ? 'Hide what changed' : `Show what changed (${changed.length + removed.length})`}
            </button>
            {showFiles ? (
              <ul className="changed-files">
                {changed.map((file) => (
                  <li key={file}>
                    <button type="button" className="link-button" onClick={() => onOpenFile(file, 1)}>
                      {file}
                    </button>
                    <span className="muted small"> modified</span>
                  </li>
                ))}
                {removed.map((file) => (
                  <li key={file}>
                    <span className="muted">{file}</span>
                    <span className="muted small"> removed</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="stale-actions">
        <button type="button" className="ghost-button" onClick={onRegenerate} disabled={generating}>
          {generating ? 'Regenerating…' : 'Regenerate'}
        </button>
      </div>
    </div>
  );
}

function summariseArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

export interface ExplainerViewProps {
  explainer: Explainer;
  /** Freshness of a cached explainer. Reported, never acted on. */
  staleness?: StalenessReport | null;
  /** Titles of child explainers already written that are themselves out of date. */
  staleChildren?: Set<string>;
  /** True when the analysis itself predates the current commit. */
  analysisStale?: boolean;
  onReanalyse?: () => void;
  generating: boolean;
  steps: AgentStepView[];
  status: string | null;
  onDrill: (id: string, label: string, kind: string, relation: NextRelation) => void;
  onRegenerate: () => void;
  onExport: () => void;
  onOpenFile: (path: string, startLine?: number) => void;
}

export function ExplainerView({
  explainer,
  staleness,
  staleChildren,
  analysisStale,
  onReanalyse,
  generating,
  steps,
  status,
  onDrill,
  onRegenerate,
  onExport,
  onOpenFile,
}: ExplainerViewProps) {
  const navigationSections = explainer.sections.filter((section) => section.type !== 'quiz');

  return (
    <article className="explainer">
      <header className="explainer-head">
        <div className="explainer-title-row">
          <div>
            <p className="eyebrow">{explainer.kind.replace(/-/g, ' ')}</p>
            <h1>{explainer.title}</h1>
            {explainer.subtitle ? <p className="subtitle">{explainer.subtitle}</p> : null}
          </div>
          <div className="explainer-actions">
            <button type="button" className="ghost-button" onClick={onRegenerate} disabled={generating}>
              {generating ? 'Working…' : 'Regenerate'}
            </button>
            <button type="button" className="ghost-button" onClick={onExport}>
              Export HTML
            </button>
          </div>
        </div>

        {explainer.tldr ? (
          <div className="tldr">
            <Markdown markdown={explainer.tldr} />
          </div>
        ) : null}

        <p className="meta">
          <span className={`chip ${explainer.degraded ? 'warn' : ''}`}>
            {explainer.degraded ? 'static analysis only' : `${explainer.provider} · ${explainer.model}`}
          </span>
          <span className="muted">generated {formatDate(explainer.generatedAt)}</span>
          {explainer.tokens ? <span className="muted">{explainer.tokens.prompt + explainer.tokens.completion} tokens</span> : null}
        </p>

        {explainer.degraded && !generating ? (
          <div className="callout callout-tip">
            <h4>This is the structural outline, not a written explanation</h4>
            <p>
              It was produced by static analysis alone — either a language model was unavailable, or it did not return something usable.{' '}
              <button type="button" className="link-button" onClick={onRegenerate}>
                Try generating again
              </button>
              .
            </p>
          </div>
        ) : null}
      </header>

      {analysisStale ? (
        <div className="stale-banner">
          <div>
            <strong>The analysis predates the current commit.</strong>
            <p>
              Commits have landed since this repository was analysed, so component sizes, routes and the call graph may have
              moved on. Explanations below were written against the older analysis and are marked accordingly.
            </p>
          </div>
          <div className="stale-actions">
            {onReanalyse ? (
              <button type="button" className="ghost-button" onClick={onReanalyse}>
                Re-analyse
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {staleness?.stale ? (
        <StalenessNotice
          staleness={staleness}
          onRegenerate={onRegenerate}
          generating={generating}
          onOpenFile={onOpenFile}
        />
      ) : null}

      <AgentTrace steps={steps} status={status} running={generating} />

      {navigationSections.length > 3 ? (
        <nav className="toc">
          <h2>On this page</h2>
          <ol>
            {navigationSections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
            {explainer.sections.some((section) => section.type === 'quiz') ? (
              <li>
                <a href="#quiz">Check your understanding</a>
              </li>
            ) : null}
          </ol>
        </nav>
      ) : null}

      {(() => {
        let diagramIndex = 0;
        return explainer.sections.map((section) => (
          <SectionRenderer
            section={section}
            diagramIndex={section.type === 'diagram' ? diagramIndex++ : 0}
            key={section.id}
            onOpenFile={onOpenFile}
          />
        ));
      })()}

      {(() => {
        const children = explainer.next.filter((item) => (item.relation ?? 'child') === 'child');
        const parents = explainer.next.filter((item) => item.relation === 'parent');
        const related = explainer.next.filter((item) => item.relation === 'related');
        const card = (item: Explainer['next'][number]) => (
          <button
            type="button"
            className="drill-card"
            key={`${item.relation ?? 'child'}-${item.id}`}
            onClick={() => onDrill(item.id, item.label, item.kind, item.relation ?? 'child')}
          >
            <span className="drill-label">
              {item.label}
              {staleChildren?.has(item.label) ? <span className="chip warn">out of date</span> : null}
            </span>
            <span className="drill-kind">{item.kind.replace(/-/g, ' ')}</span>
            {item.hint ? <span className="drill-hint">{item.hint}</span> : null}
          </button>
        );
        return (
          <>
            {children.length > 0 ? (
              <section className="card">
                <h3>Go deeper</h3>
                <p className="caption">
                  Parts of what is on screen. Each generates its own explainer, grounded in this one — and “Export HTML” writes the
                  first few into the same file, so the links work offline.
                </p>
                <div className="drill-grid">{children.map(card)}</div>
              </section>
            ) : null}
            {parents.length > 0 ? (
              <section className="card">
                <h3>Part of</h3>
                <p className="caption">The scope this sits inside, if you want to zoom out.</p>
                <div className="drill-grid">{parents.map(card)}</div>
              </section>
            ) : null}
            {related.length > 0 ? (
              <section className="card">
                <h3>Where this is used</h3>
                <p className="caption">
                  Other parts of the system that depend on this one. These sit alongside it, not inside it.
                </p>
                <div className="drill-grid">{related.map(card)}</div>
              </section>
            ) : null}
          </>
        );
      })()}

      {explainer.sources.length > 0 ? (
        <section className="card">
          <h3>Sources</h3>
          <ul className="sources">
            {explainer.sources.slice(0, 40).map((source, index) => (
              <li key={`${source.path}-${index}`}>
                <button type="button" className="link-button" onClick={() => onOpenFile(source.path, source.startLine)}>
                  {source.path}
                  {source.startLine ? `:${source.startLine}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

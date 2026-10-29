import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Change, Explainer } from '../../core/types';
import { api, streamPost } from '../lib/api';
import { ExplainerView, type AgentStepView } from './ExplainerView';
import { formatNumber, relativeTime, shortPath } from '../lib/format';

interface CommitInfo {
  sha: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

interface BranchInfo {
  name: string;
  current: boolean;
  lastCommit: string;
  subject: string;
  date: string;
}

export interface ChangesViewProps {
  repoId: string;
  onOpenFile: (path: string, startLine?: number) => void;
}

type HistoryReason = 'ok' | 'not-a-repo' | 'no-commits' | 'unreadable';

/**
 * How a branch should be read. Default is the branch's own work, because that is
 * what "what is this branch about" normally means; the tip-to-tip comparison is
 * there for when the branch has already been merged and the merge-base diff is
 * empty.
 */
type BranchCompare = 'since-diverged' | 'against-tip';

export function ChangesView({ repoId, onOpenFile }: ChangesViewProps) {
  const [tab, setTab] = useState<'commits' | 'branches' | 'pr' | 'working'>('commits');
  const [prNumber, setPrNumber] = useState('');
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [reason, setReason] = useState<HistoryReason>('ok');
  const [detail, setDetail] = useState<string | null>(null);
  const [base, setBase] = useState<string>('');
  const [compare, setCompare] = useState<BranchCompare>('since-diverged');
  const [change, setChange] = useState<Change | null>(null);
  const [explainer, setExplainer] = useState<Explainer | null>(null);
  const [steps, setSteps] = useState<AgentStepView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const stream = useRef<{ cancel(): void } | null>(null);
  /** The spec behind what is on screen, so "regenerate" re-runs the same request. */
  const lastSpec = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    void api
      .get<{
        commits: CommitInfo[];
        branches: BranchInfo[];
        git: { defaultBranch: string | null };
        reason?: HistoryReason;
        detail?: string | null;
      }>(`/api/repos/${repoId}/history?limit=80`)
      .then((data) => {
        setCommits(data.commits);
        setBranches(data.branches);
        setBase(data.git.defaultBranch ?? '');
        setReason(data.reason ?? 'ok');
        setDetail(data.detail ?? null);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
    return () => stream.current?.cancel();
  }, [repoId]);

  const loadChange = useCallback(
    (spec: Record<string, unknown>) => {
      stream.current?.cancel();
      lastSpec.current = spec;
      setBusy(true);
      setError(null);
      setSteps([]);
      setExplainer(null);
      setChange(null);
      setStatus('Loading the change');

      stream.current = streamPost(`/api/repos/${repoId}/change/explain`, spec, (event) => {
        if (event.type === 'change') {
          const incoming = event.change as Change;
          setChange(incoming);
          // The server may widen the comparison (a branch that is already merged
          // has nothing of its own to show), so the selector follows what was
          // actually compared rather than what was asked for.
          if (incoming.kind === 'branch' && incoming.compare) setCompare(incoming.compare.mode);
          setActiveFile(incoming.files[0]?.path ?? null);
        } else if (event.type === 'status') {
          setStatus(String(event.message ?? ''));
        } else if (event.type === 'step') {
          setSteps((previous) => [
            ...previous,
            {
              index: Number(event.index ?? previous.length + 1),
              thought: event.thought ? String(event.thought) : undefined,
              tool: String(event.tool ?? ''),
              args: (event.args ?? {}) as Record<string, unknown>,
              summary: String(event.summary ?? ''),
              failed: Boolean(event.failed),
            },
          ]);
        } else if (event.type === 'explainer') {
          setExplainer(event.explainer as Explainer);
        } else if (event.type === 'done') {
          setBusy(false);
          setStatus(null);
        } else if (event.type === 'error') {
          setError(String(event.message ?? 'Failed to explain the change.'));
          setBusy(false);
          setStatus(null);
        }
      });
    },
    [repoId],
  );

  const patchCount = useMemo(() => change?.files.filter((file) => file.patch).length ?? 0, [change]);

  return (
    <div className="changes-layout">
      <aside className="changes-sidebar">
        <div className="segmented">
          <button type="button" className={tab === 'commits' ? 'active' : ''} onClick={() => setTab('commits')}>
            Commits
          </button>
          <button type="button" className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}>
            Branches
          </button>
          <button type="button" className={tab === 'pr' ? 'active' : ''} onClick={() => setTab('pr')}>
            Pull request
          </button>
          <button type="button" className={tab === 'working' ? 'active' : ''} onClick={() => setTab('working')}>
            Working tree
          </button>
        </div>

        {tab === 'commits' ? (
          <ul className="change-list">
            {commits.map((commit) => (
              <li key={commit.sha}>
                <button type="button" onClick={() => loadChange({ kind: 'commit', sha: commit.sha })} disabled={busy}>
                  <span className="change-subject">{commit.subject}</span>
                  <span className="change-meta">
                    <code>{commit.short}</code> {commit.author} · {relativeTime(commit.date)}
                  </span>
                </button>
              </li>
            ))}
            {commits.length === 0 ? <li className="muted pad">{emptyListMessage(reason)}</li> : null}
          </ul>
        ) : null}

        {tab === 'pr' ? (
          <form
            className="branch-panel"
            onSubmit={(event) => {
              event.preventDefault();
              const number = Number.parseInt(prNumber, 10);
              if (!Number.isInteger(number) || number <= 0) return;
              loadChange({ kind: 'pr', number });
            }}
          >
            <p className="caption">
              Read a pull request from GitHub — the whole PR, not just its commits, with its description as background. Nothing is
              fetched into your clone.
            </p>
            <label className="field">
              <span>Pull request number</span>
              <input
                type="number"
                min={1}
                value={prNumber}
                onChange={(event) => setPrNumber(event.target.value)}
                placeholder="e.g. 542"
                disabled={busy}
              />
            </label>
            <button type="submit" className="button" disabled={busy || !prNumber.trim()}>
              Explain this pull request
            </button>
            <p className="caption muted">
              Uses the <code>origin</code> remote. Private repositories need <code>GITHUB_TOKEN</code> in your <code>.env</code>; without
              one GitHub allows 60 requests an hour.
            </p>
          </form>
        ) : null}

        {tab === 'branches' ? (
          <div className="branch-panel">
            <label className="field">
              <span>Compare against</span>
              <select value={base} onChange={(event) => setBase(event.target.value)}>
                <option value="">(detect default)</option>
                {branches.map((branch) => (
                  <option value={branch.name} key={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>What to compare</span>
              <select value={compare} onChange={(event) => setCompare(event.target.value as BranchCompare)}>
                <option value="since-diverged">This branch&apos;s own commits</option>
                <option value="against-tip">Both branch tips, as they are now</option>
              </select>
            </label>
            <p className="caption">
              {compare === 'since-diverged'
                ? 'Only the commits this branch added after it left the comparison branch — the usual way to see what a branch is about.'
                : 'The two tips side by side. Also shows what the comparison branch gained since they diverged, which appears as reversals — but it still works once the branch has been merged.'}
            </p>
            <ul className="change-list">
              {branches
                // Comparing a branch with itself says nothing.
                .filter((branch) => branch.name !== base)
                .map((branch) => (
                  <li key={branch.name}>
                    <button
                      type="button"
                      onClick={() => loadChange({ kind: 'branch', branch: branch.name, base: base || undefined, compare })}
                      disabled={busy}
                    >
                      <span className="change-subject">
                        {branch.name}
                        {branch.current ? <span className="chip"> checked out</span> : null}
                      </span>
                      <span className="change-meta">
                        <code>{branch.lastCommit}</code> {relativeTime(branch.date)} · {branch.subject.slice(0, 60)}
                      </span>
                    </button>
                  </li>
                ))}
              {branches.filter((branch) => branch.name !== base).length === 0 ? (
                <li className="muted pad">No other branches to compare with{base ? ` ${base}` : ''}.</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {tab === 'working' ? (
          <div className="branch-panel">
            <p className="muted">Explain the uncommitted changes in the working tree.</p>
            <button type="button" className="primary-button" onClick={() => loadChange({ kind: 'working' })} disabled={busy}>
              Explain working tree
            </button>
          </div>
        ) : null}
      </aside>

      <div className="changes-main">
        {error ? <div className="error-banner">{error}</div> : null}

        {!change && !busy && reason !== 'ok' ? <HistoryUnavailable reason={reason} detail={detail} /> : null}

        {!change && !busy && reason === 'ok' ? (
          <div className="placeholder">
            <h2>Understand a change before you review it</h2>
            <p className="muted">
              Pick a commit, a branch, or the working tree. The agent reads the diff, follows the call graph around the changed code, checks
              the file's history, then writes an explainer with background, intuition, a code walkthrough, and a quiz.
            </p>
          </div>
        ) : null}

        {change ? (
          <div className="change-header">
            <h2>{change.title}</h2>
            <p className="meta">
              <span className="chip">{change.kind}</span>
              {change.subtitle ? <span className="muted">{change.subtitle}</span> : null}
              <span className="muted">
                {formatNumber(change.stats.files)} files · <span className="add">+{change.stats.additions}</span>{' '}
                <span className="del">-{change.stats.deletions}</span>
              </span>
              {change.author ? <span className="muted">{change.author}</span> : null}
            </p>
          </div>
        ) : null}

        {change && change.files.length === 0 ? (
          <EmptyComparison
            change={change}
            busy={busy}
            onCompare={() => {
              const spec = lastSpec.current ?? {};
              if (change.kind !== 'branch' || !spec.branch) return;
              loadChange({
                kind: 'branch',
                branch: String(spec.branch),
                base: base || change.compare?.baseRef || undefined,
                compare: 'against-tip',
              });
            }}
          />
        ) : null}

        {explainer ? (
          <ExplainerView
            explainer={explainer}
            generating={busy}
            steps={steps}
            status={status}
            onDrill={() => undefined}
            onRegenerate={() => {
              const spec = lastSpec.current;
              if (spec) loadChange({ ...spec, refresh: true });
            }}
            onExport={() => exportExplainer(repoId, 'change', explainer.target.id, setStatus, () => setStatus(null))}
            onOpenFile={onOpenFile}
          />
        ) : busy ? (
          <div className="placeholder">
            <p className="muted">{status ?? 'Working…'}</p>
          </div>
        ) : null}

        {change && change.files.length > 0 ? (
          <section className="card diff-card">
            <h3>
              Diff <span className="muted">({patchCount} file{patchCount === 1 ? '' : 's'} with hunks)</span>
            </h3>
            <div className="diff-tabs">
              {change.files.slice(0, 30).map((file) => (
                <button
                  type="button"
                  className={activeFile === file.path ? 'active' : ''}
                  key={file.path}
                  onClick={() => setActiveFile(file.path)}
                  title={file.path}
                >
                  {shortPath(file.path, 2)}
                  <span className={file.status === 'deleted' ? 'del' : 'add'}>{file.status === 'deleted' ? '−' : '+'}</span>
                </button>
              ))}
            </div>
            {activeFile ? <PatchView patch={change.files.find((file) => file.path === activeFile)?.patch ?? ''} onOpenFile={onOpenFile} /> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A comparison that came back empty.
 *
 * The explainer already says why, but the reader is standing in front of a diff
 * tab with nothing in it, so the reason and the way out belong here too.
 */
function EmptyComparison({ change, busy, onCompare }: { change: Change; busy: boolean; onCompare: () => void }) {
  const compare = change.compare;
  const baseRef = compare?.baseRef ?? change.base;
  const sameTip = change.subtitle?.startsWith('Same commit') ?? false;
  const tipToTip = compare?.mode === 'against-tip';
  const canSwitchTips = change.kind === 'branch' && !tipToTip;

  return (
    <div className="notice-warn">
      <strong>
        {sameTip ? `${change.head} and ${baseRef} are the same commit` : `Nothing differs between ${change.head} and ${baseRef}`}
      </strong>
      <p>
        {sameTip
          ? 'There is nothing to compare: both names point at the same commit.'
          : tipToTip
            ? `The two branch tips are identical, so this comparison has no files in it.`
            : `${change.head} has no commits of its own that ${baseRef} does not already contain — it is probably already merged.`}
      </p>
      {compare?.note ? <p className="muted">{compare.note}</p> : null}
      {canSwitchTips ? (
        <p>
          <button type="button" className="ghost-button attention" onClick={onCompare} disabled={busy}>
            Compare the two branch tips instead
          </button>{' '}
          <span className="muted">Shows everything that differs right now, including what {baseRef} gained after this branch left it.</span>
        </p>
      ) : null}
    </div>
  );
}

function emptyListMessage(reason: HistoryReason): string {
  if (reason === 'not-a-repo') return 'No history: this directory is not a git repository.';
  if (reason === 'no-commits') return 'No commits yet.';
  if (reason === 'unreadable') return 'git could not read the history of this repository.';
  return 'No commits found.';
}

/**
 * Explain why there is nothing here.
 *
 * An empty Changes tab with no explanation reads as a broken feature; in the
 * common case the directory simply is not under version control, and there is a
 * clear action the reader can take.
 */
function HistoryUnavailable({ reason, detail }: { reason: HistoryReason; detail: string | null }) {
  if (reason === 'not-a-repo') {
    return (
      <div className="placeholder left">
        <h2>This directory is not a git repository</h2>
        <p className="muted">
          Architecture and source explanations work on any directory, but commits, diffs and pull requests need version control, so
          there is nothing to show here.
        </p>
        <ul className="muted">
          <li>
            If this is a checkout, open the repository root instead — this folder may be inside a working copy rather than one itself.
          </li>
          <li>
            If it should be tracked, run <code>git init</code> here, make a commit, and re-analyse.
          </li>
        </ul>
      </div>
    );
  }
  if (reason === 'no-commits') {
    return (
      <div className="placeholder left">
        <h2>This repository has no commits yet</h2>
        <p className="muted">
          It is a git repository, but nothing has been committed, so there is no history or diff to explain. Make a commit and
          re-analyse.
        </p>
      </div>
    );
  }
  return (
    <div className="placeholder left">
      <h2>git could not read this repository&apos;s history</h2>
      <p className="muted">
        The directory is a git repository, but listing commits failed. This usually means a shallow clone, a missing git binary, or a
        repository in an unusual state.
      </p>
      {detail ? <pre className="code-small">{detail}</pre> : null}
    </div>
  );
}

function exportExplainer(repoId: string, kind: string, id: string, onStatus: (message: string) => void, onDone: () => void): void {
  streamPost(`/api/repos/${repoId}/explain/export`, { kind, id, children: 3 }, (event) => {
    if (event.type === 'status') onStatus(String(event.message));
    else if (event.type === 'done') {
      onDone();
      const included = (event.included ?? []) as string[];
      window.alert(`Written to:\n${String(event.path)}${included.length > 0 ? `\n\nIncludes deeper explainers:\n- ${included.join('\n- ')}` : ''}`);
    } else if (event.type === 'error') {
      onDone();
      onStatus(`Export failed: ${String(event.message)}`);
    }
  });
}

function PatchView({ patch, onOpenFile }: { patch: string; onOpenFile: (path: string, startLine?: number) => void }) {
  const [context, setContext] = useState<'full' | 'changed'>('changed');
  if (!patch) return <p className="muted pad">No textual hunks (binary or omitted).</p>;

  const lines = patch.split('\n').filter((line) => !/^(index |--- |\+\+\+ |diff --git )/.test(line));
  const visible: string[] = [];
  if (context === 'full') {
    visible.push(...lines);
  } else {
    let gapPending = false;
    lines.forEach((line, index) => {
      const isChanged = line.startsWith('+') || line.startsWith('-') || line.startsWith('@@');
      const nearChange = lines[index - 1]?.startsWith('+') || lines[index - 1]?.startsWith('-') || lines[index + 1]?.startsWith('+') || lines[index + 1]?.startsWith('-');
      if (isChanged || nearChange) {
        if (gapPending) {
          visible.push('@@ gap @@');
          gapPending = false;
        }
        visible.push(line);
      } else {
        gapPending = true;
      }
    });
  }

  return (
    <div className="patch">
      <div className="patch-toolbar">
        <div className="segmented small">
          <button type="button" className={context === 'changed' ? 'active' : ''} onClick={() => setContext('changed')}>
            Changed only
          </button>
          <button type="button" className={context === 'full' ? 'active' : ''} onClick={() => setContext('full')}>
            Full context
          </button>
        </div>
      </div>
      <pre className="patch-body">
        <code>
          {visible.map((line, index) => {
            const kind = line.startsWith('@@') || line === '@@ gap @@' ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
            const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
            return (
              <span className={`patch-line ${kind}`} key={index}>
                {fileMatch ? (
                  <button type="button" className="link-button" onClick={() => onOpenFile(fileMatch[1], 1)}>
                    {line}
                  </button>
                ) : (
                  line || ' '
                )}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

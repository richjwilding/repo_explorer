import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientRepoModel, Explainer, ExplainerSummary, NextRelation, ProviderStatus, RepoRef, StalenessReport } from '../core/types';
import { api, streamPost } from './lib/api';
import { ExplainerView, type AgentStepView } from './components/ExplainerView';
import { ArchitecturePanel } from './components/ArchitecturePanel';
import { ChatPanel } from './components/ChatPanel';
import { ChangesView } from './components/ChangesView';
import { FilesView } from './components/FilesView';
import { ModelsPanel } from './components/ModelsPanel';
import { formatLoc, formatNumber, relativeTime } from './lib/format';

interface RepoRecord {
  repo: RepoRef;
  lastOpenedAt: string;
  lastAnalyzedAt: string | null;
  commitCount: number | null;
  head: string | null;
}

type Tab = 'overview' | 'chat' | 'changes' | 'files';
type OverviewTab = 'explainer' | 'architecture';

interface DrillEntry {
  kind: Explainer['kind'];
  id: string;
  label: string;
}

export function App() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [repoRef, setRepoRef] = useState<RepoRef | null>(null);
  const [model, setModel] = useState<ClientRepoModel | null>(null);
  const [providerId, setProviderId] = useState<string>('');
  // What the user chose, which may differ from what is actually in use if the
  // chosen provider is unreachable.
  const [selectedProviderId, setSelectedProviderId] = useState<string>('auto');
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [overviewTab, setOverviewTab] = useState<OverviewTab>('explainer');
  const [explainer, setExplainer] = useState<Explainer | null>(null);
  const [staleness, setStaleness] = useState<StalenessReport | null>(null);
  const [staleChildren, setStaleChildren] = useState<Set<string>>(new Set());
  const [analysisStale, setAnalysisStale] = useState(false);
  const [steps, setSteps] = useState<AgentStepView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [drill, setDrill] = useState<DrillEntry[]>([]);
  /** The target currently being generated, so the pending view can name it. */
  const [pending, setPending] = useState<{ kind: Explainer['kind']; id: string; label: string } | null>(null);
  /** What the current view is showing, so a failure can restore it. */
  const lastTarget = useRef<{ kind: Explainer['kind']; id: string }>({ kind: 'repo-overview', id: 'root' });
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [chatSeed, setChatSeed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [progress, setProgress] = useState<{ message: string; pct: number } | null>(null);
  const stream = useRef<{ cancel(): void } | null>(null);

  /* ---------------- bootstrap ---------------- */

  const loadProviders = useCallback(async () => {
    try {
      const data = await api.get<{ providers: ProviderStatus[] }>('/api/providers');
      setProviders(data.providers);
      setProviderId((current) => current || data.providers.find((provider) => provider.available)?.id || 'mock');
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : String(providerError));
    }
    // The chosen provider is separate from the one in use, and the top bar shows
    // the choice so a saved-but-unusable selection cannot look like a no-op.
    try {
      const settings = await api.get<{ selectedProviderId?: string; activeProviderId?: string }>('/api/settings');
      if (settings.selectedProviderId) setSelectedProviderId(settings.selectedProviderId);
      if (settings.activeProviderId) setProviderId(settings.activeProviderId);
    } catch {
      /* older server, or settings unavailable: the bar falls back to the active provider */
    }
  }, []);

  const loadRepos = useCallback(async () => {
    try {
      const data = await api.get<{ repos: RepoRecord[] }>('/api/repos');
      setRepos(data.repos);
    } catch {
      /* first run: no repos yet */
    }
  }, []);

  useEffect(() => {
    void loadProviders();
    void loadRepos();
    return () => stream.current?.cancel();
  }, [loadProviders, loadRepos]);

  /* ---------------- actions ---------------- */

  const openRepo = useCallback(
    (target: { path?: string; repoId?: string; force?: boolean }) => {
      stream.current?.cancel();
      setOpening(true);
      setError(null);
      setProgress({ message: 'Reading repository', pct: 1 });
      setExplainer(null);
      setSteps([]);
      setDrill([]);

      stream.current = streamPost('/api/repos/open', target, (event) => {
        if (event.type === 'progress' || event.type === 'status') {
          setProgress({ message: String(event.message ?? ''), pct: Number(event.pct ?? 0) });
        } else if (event.type === 'model') {
          setRepoRef(event.repo as RepoRef);
          setModel(event.model as ClientRepoModel);
          setProviderId(String(event.providerId ?? ''));
          void loadRepoOverview(String((event.repo as RepoRef).id));
        } else if (event.type === 'done') {
          setOpening(false);
          setProgress(null);
          void loadRepos();
          void loadProviders();
        } else if (event.type === 'error') {
          setError(String(event.message ?? 'Failed to open the repository.'));
          setOpening(false);
          setProgress(null);
        }
      });
    },
    [loadProviders, loadRepos],
  );

  /** Show the explainer that already exists instead of asking the user to make one again. */
  const loadCachedExplainer = useCallback(async (repoId: string, kind: Explainer['kind'] = 'repo-overview', id = 'root') => {
    try {
      const data = await api.get<{ explainer: Explainer; staleness?: StalenessReport }>(
        `/api/repos/${repoId}/explainer?kind=${kind}&id=${encodeURIComponent(id)}`,
      );
      setExplainer(data.explainer);
      setStaleness(data.staleness ?? null);
      lastTarget.current = { kind, id };
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshAnalysisStaleness = useCallback(async () => {
    if (!repoRef) return;
    try {
      const data = await api.get<{ stale?: boolean }>(`/api/repos/${repoRef.id}/model`);
      setAnalysisStale(Boolean(data.stale));
    } catch {
      setAnalysisStale(false);
    }
  }, [repoRef]);

  useEffect(() => {
    void refreshAnalysisStaleness();
  }, [refreshAnalysisStaleness, model?.generatedAt]);

  const loadRepoOverview = useCallback(
    async (repoId: string) => {
      const found = await loadCachedExplainer(repoId);
      setDrill([]);
      setSteps([]);
      // No explainer yet for this repository: the call to action is right.
      if (!found) setExplainer(null);
    },
    [loadCachedExplainer],
  );

  const generate = useCallback(
    (kind: Explainer['kind'], id: string, refresh = false) => {
      if (!repoRef) return;
      stream.current?.cancel();
      setGenerating(true);
      setSteps([]);
      setStatus('Planning the investigation');
      setError(null);
      // Clear the previous explainer: leaving it on screen while a new one is
      // written made a drill-down look like nothing had happened.
      setExplainer(null);

      stream.current = streamPost(
        `/api/repos/${repoRef.id}/explain`,
        { kind, id, refresh },
        (event) => {
          if (event.type === 'status') {
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
            setStaleness((event.staleness as StalenessReport | undefined) ?? null);
          } else if (event.type === 'done') {
            setGenerating(false);
            setStatus(null);
            setPending(null);
          } else if (event.type === 'error') {
            setError(String(event.message ?? 'Failed to generate the explainer.'));
            setGenerating(false);
            setStatus(null);
            setPending(null);
            // Never leave the reader on a blank screen: restore whatever is
            // already cached for the view they were on.
            if (repoRef) {
              void loadCachedExplainer(repoRef.id, lastTarget.current.kind, lastTarget.current.id).then((found) => {
                if (!found) void loadCachedExplainer(repoRef.id);
              });
            }
          }
        },
      );
    },
    [loadCachedExplainer, repoRef],
  );

  const drillInto = useCallback(
    (kind: Explainer['kind'], id: string, label: string, relation: NextRelation = 'child') => {
      // Only a child nests under what you were reading. Going sideways or up
      // starts a new trail, so the breadcrumb never implies a hierarchy that
      // is not there.
      setDrill((previous) => (relation === 'child' ? [...previous, { kind, id, label }] : [{ kind, id, label }]));
      setOverviewTab('explainer');
      setPending({ kind, id, label });
      // Jump to the top straight away: the reader was scrolled to the bottom of
      // the previous explainer, so otherwise the new run is entirely off-screen.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      generate(kind, id);
    },
    [generate],
  );

  const goBackTo = useCallback(
    (index: number) => {
      setDrill((previous) => previous.slice(0, index + 1));
      if (index < 0) {
        generate('repo-overview', 'root');
        return;
      }
      const entry = drill[index];
      if (entry) generate(entry.kind, entry.id);
    },
    [drill, generate],
  );

  const selectProvider = useCallback(
    async (id: string) => {
      setProviderId(id);
      try {
        const data = await api.post<{ providers: ProviderStatus[] }>('/api/providers/select', { id });
        setProviders(data.providers);
      } catch (providerError) {
        setError(providerError instanceof Error ? providerError.message : String(providerError));
      }
    },
    [],
  );

  /**
   * Export writes a self-contained HTML file that also contains the *next*
   * explainers, so "Where to go next" is a real link rather than a dead end.
   * That means several model calls, so progress is streamed.
   */
  const exportExplainer = useCallback(() => {
    if (!repoRef || !explainer) return;
    stream.current?.cancel();
    setExporting(true);
    setError(null);
    setStatus('Preparing the export');

    stream.current = streamPost(
      `/api/repos/${repoRef.id}/explain/export`,
      { kind: explainer.kind, id: explainer.target.id, children: 3, svgs: collectRenderedSvgs() },
      (event) => {
        if (event.type === 'status') {
          setStatus(String(event.message));
        } else if (event.type === 'done') {
          setExporting(false);
          setStatus(null);
          const included = (event.included ?? []) as string[];
          const skipped = (event.skipped ?? []) as string[];
          window.alert(
            `Written to:\n${String(event.path)}\n\n` +
              (included.length > 0 ? `Includes deeper explainers:\n- ${included.join('\n- ')}\n` : '') +
              (skipped.length > 0 ? `\nSkipped (could not resolve): ${skipped.join(', ')}` : ''),
          );
        } else if (event.type === 'error') {
          setExporting(false);
          setStatus(null);
          setError(String(event.message ?? 'Export failed.'));
        }
      },
    );
  }, [explainer, repoRef]);

  const refreshStaleChildren = useCallback(async () => {
    if (!repoRef) return;
    try {
      const data = await api.get<{ explainers: ExplainerSummary[] }>(`/api/repos/${repoRef.id}/explainers`);
      setStaleChildren(new Set(data.explainers.filter((entry) => entry.stale).map((entry) => entry.target)));
    } catch {
      setStaleChildren(new Set());
    }
  }, [repoRef]);

  useEffect(() => {
    void refreshStaleChildren();
  }, [refreshStaleChildren, explainer?.generatedAt]);

  const activeProvider = useMemo(() => providers.find((provider) => provider.id === providerId), [providers, providerId]);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === selectedProviderId),
    [providers, selectedProviderId],
  );
  // 'auto' is not a mismatch: it means "pick the best available".
  const providerMismatch = selectedProviderId !== 'auto' && selectedProviderId !== providerId;
  const providerLabel = activeProvider ? `${activeProvider.label}${activeProvider.defaultModel ? ` · ${activeProvider.defaultModel}` : ''}` : 'no model';

  useEffect(() => {
    if (explainer) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [explainer]);

  const handleOpenFile = useCallback((path: string, startLine?: number) => {
    setOpenFile(path);
    setActiveTab('files');
    void startLine;
  }, []);

  /* ---------------- welcome ---------------- */

  if (!repoRef || !model) {
    return (
      <>
      <Welcome
        repos={repos}
        providers={providers}
        providerId={providerId}
        opening={opening}
        progress={progress}
        error={error}
        onOpen={(target) => openRepo(target)}
        onSelectProvider={selectProvider}
        onRefreshProviders={() => void loadProviders()}
        onConfigureModels={() => setShowModels(true)}
      />
      {model && !model.git.isRepo ? (
        <div className="busy-banner notice-neutral">
          <span className="dot" />
          <strong>Not a git repository</strong>
          <span className="muted">
            Architecture and source explanations work on any directory. Commits, diffs and pull requests need version control, so the
            Changes tab is empty.
          </span>
        </div>
      ) : null}
      {showModels ? (
        <ModelsPanel
          providers={providers}
          providerId={providerId}
          onClose={() => setShowModels(false)}
          onApplied={(nextProviders, nextProviderId, nextSelectedProviderId) => {
            setProviders(nextProviders);
            if (nextProviderId) setProviderId(nextProviderId);
            if (nextSelectedProviderId) setSelectedProviderId(nextSelectedProviderId);
          }}
        />
      ) : null}
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="home-button" onClick={() => { setRepoRef(null); setModel(null); setExplainer(null); }} title="Back to repositories">
            Repo Explorer
          </button>
          <div className="repo-identity">
            <span className="repo-name">{repoRef.slug ?? repoRef.name}</span>
            <span className="repo-sub">
              {model.git.branch ?? 'no branch'}
              {model.git.headShort ? ` @ ${model.git.headShort}` : ''} · {formatNumber(model.stats.fileCount)} files ·{' '}
              {formatLoc(model.stats.loc)} lines · {model.stats.componentCount} components
            </span>
          </div>
        </div>

        <nav className="tabs">
          <button type="button" className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button type="button" className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>
            Chat
          </button>
          <button type="button" className={activeTab === 'changes' ? 'active' : ''} onClick={() => setActiveTab('changes')}>
            Changes
          </button>
          <button type="button" className={activeTab === 'files' ? 'active' : ''} onClick={() => setActiveTab('files')}>
            Files
          </button>
        </nav>

        <div className="topbar-right">
          <button
            type="button"
            className={`ghost-button${providerMismatch ? ' attention' : ''}`}
            onClick={() => setShowModels(true)}
            title={
              providerMismatch
                ? `${selectedProvider?.label ?? selectedProviderId} is selected but cannot be used, so ${activeProvider?.label ?? providerId} is answering instead. Click to see why.`
                : 'Choose the language model'
            }
          >
            {selectedProvider ? selectedProvider.label : activeProvider?.label ?? 'Model'}
            {providerMismatch ? <span className="chip warn"> using {activeProvider?.label ?? providerId}</span> : null}
          </button>
          <button type="button" className="ghost-button" onClick={() => openRepo({ path: repoRef.path, force: true })} disabled={opening}>
            {opening ? 'Analysing…' : 'Re-analyse'}
          </button>
        </div>
      </header>

      {error ? (
        <div className="error-banner dismissible">
          {error}
          <button type="button" className="link-button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      ) : null}
      {model && !model.git.isRepo ? (
        <div className="busy-banner notice-neutral">
          <span className="dot" />
          <strong>Not a git repository</strong>
          <span className="muted">
            Architecture and source explanations work on any directory. Commits, diffs and pull requests need version control, so the
            Changes tab is empty.
          </span>
        </div>
      ) : null}
      {showModels ? (
        <ModelsPanel
          providers={providers}
          providerId={providerId}
          onClose={() => setShowModels(false)}
          onApplied={(nextProviders, nextProviderId, nextSelectedProviderId) => {
            setProviders(nextProviders);
            if (nextProviderId) setProviderId(nextProviderId);
            if (nextSelectedProviderId) setSelectedProviderId(nextSelectedProviderId);
          }}
        />
      ) : null}
      {exporting ? (
        <div className="busy-banner">
          <span className="dot pulse" />
          <strong>Exporting with deeper detail</strong>
          <span className="muted">{status ?? 'Working…'}</span>
          <span className="muted small">Each nested explainer is a separate model run, so this can take a few minutes.</span>
        </div>
      ) : null}
      {model && !model.git.isRepo ? (
        <div className="busy-banner notice-neutral">
          <span className="dot" />
          <strong>Not a git repository</strong>
          <span className="muted">
            Architecture and source explanations work on any directory. Commits, diffs and pull requests need version control, so the
            Changes tab is empty.
          </span>
        </div>
      ) : null}
      {showModels ? (
        <ModelsPanel
          providers={providers}
          providerId={providerId}
          onClose={() => setShowModels(false)}
          onApplied={(nextProviders, nextProviderId, nextSelectedProviderId) => {
            setProviders(nextProviders);
            if (nextProviderId) setProviderId(nextProviderId);
            if (nextSelectedProviderId) setSelectedProviderId(nextSelectedProviderId);
          }}
        />
      ) : null}
      {exporting ? (
        <div className="busy-banner">
          <span className="dot pulse" />
          <strong>Exporting with deeper detail</strong>
          <span className="muted">{status ?? 'Working…'}</span>
          <span className="muted small">Each nested explainer is a separate model run, so this can take a few minutes.</span>
        </div>
      ) : null}
      {opening && progress ? (
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${Math.max(2, progress.pct)}%` }} />
          <span className="progress-label">
            {progress.message} · {progress.pct}%
          </span>
        </div>
      ) : null}

      <main className="content">
        {activeTab === 'overview' ? (
          <div className="overview">
            <div className="overview-tabs segmented">
              <button type="button" className={overviewTab === 'explainer' ? 'active' : ''} onClick={() => setOverviewTab('explainer')}>
                Explainer
              </button>
              <button type="button" className={overviewTab === 'architecture' ? 'active' : ''} onClick={() => setOverviewTab('architecture')}>
                Architecture
              </button>
            </div>

            {overviewTab === 'explainer' ? (
              <>
                {drill.length > 0 ? (
                  <nav className="breadcrumb drill-breadcrumb">
                    <button type="button" className="link-button" onClick={() => goBackTo(-1)}>
                      {model.repo.name}
                    </button>
                    {drill.map((entry, index) => (
                      <span key={`${entry.kind}-${entry.id}`}>
                        <span className="sep">/</span>
                        <button type="button" className="link-button" onClick={() => goBackTo(index)}>
                          {entry.label}
                        </button>
                      </span>
                    ))}
                  </nav>
                ) : null}

                {!explainer && !generating ? (
                  <div className="placeholder">
                    <h2>No explainer for this repository yet</h2>
                    <p className="muted">
                      The agent will list the entrypoints, trace the call graph, check where the churn is, then write a progressive explainer:
                      what the system does, how it is shaped, and how a request moves through it.
                    </p>
                    <button type="button" className="primary-button" onClick={() => generate('repo-overview', 'root')}>
                      Generate the explainer
                    </button>
                    <p className="muted small">
                      Runs on {providerLabel}. It takes a few minutes on a local model — you will see each investigation step as it
                      happens. Nothing is written into the repository.
                    </p>
                  </div>
                ) : null}

                {explainer ? (
                  <ExplainerView
                    explainer={explainer}
                    staleness={staleness}
                    staleChildren={staleChildren}
                    analysisStale={analysisStale}
                    onReanalyse={() => openRepo({ path: repoRef.path, force: true })}
                    generating={generating}
                    steps={steps}
                    status={status}
                    onDrill={(id, label, kind, relation) => drillInto(kind as Explainer['kind'], id, label, relation)}
                    onRegenerate={() => {
                      setPending({ kind: explainer.kind, id: explainer.target.id, label: explainer.target.label });
                      generate(explainer.kind, explainer.target.id, true);
                    }}
                    onExport={() => void exportExplainer()}
                    onOpenFile={handleOpenFile}
                  />
                ) : generating ? (
                  <ExplainerView
                    explainer={placeholderExplainer(model, status, pending?.label)}
                    generating={generating}
                    steps={steps}
                    status={status}
                    onDrill={() => undefined}
                    onRegenerate={() => undefined}
                    onExport={() => undefined}
                    onOpenFile={handleOpenFile}
                  />
                ) : null}
              </>
            ) : (
              <ArchitecturePanel
                model={model}
                onComponent={(id) => drillInto('component', id, model.components.find((component) => component.id === id)?.name ?? id)}
                onFlow={(id) => drillInto('flow', id, model.dataFlows.find((flow) => flow.id === id)?.name ?? id)}
                onOpenFile={handleOpenFile}
              />
            )}
          </div>
        ) : null}

        {activeTab === 'chat' ? (
          <ChatPanel
            repoId={repoRef.id}
            providerLabel={providerLabel}
            seedQuestion={chatSeed}
            onSeedConsumed={() => setChatSeed(null)}
            onOpenFile={(path, startLine) => handleOpenFile(path, startLine)}
          />
        ) : null}

        {activeTab === 'changes' ? <ChangesView repoId={repoRef.id} onOpenFile={handleOpenFile} /> : null}

        {activeTab === 'files' ? (
          <FilesView
            repoId={repoRef.id}
            initialPath={openFile}
            onAskAbout={(question) => {
              setChatSeed(question);
              setActiveTab('chat');
            }}
          />
        ) : null}
      </main>
    </div>
  );
}

/**
 * Rendered Mermaid SVGs, keyed so the server can match them to diagrams.
 *
 * Sending them means the exported file embeds real diagrams and stays small,
 * offline, and readable without JavaScript.
 */
function collectRenderedSvgs(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const node of document.querySelectorAll('.diagram-mermaid[data-diagram-state="ready"]')) {
    const key = node.getAttribute('data-diagram-key');
    const svg = node.querySelector('svg');
    if (key && svg) result[key] = svg.outerHTML;
  }
  return result;
}

/**
 * While the agent is still investigating we have no explainer yet, but showing
 * the running trace is far better than a spinner.
 */
function placeholderExplainer(model: ClientRepoModel, status: string | null, targetLabel?: string | null): Explainer {
  return {
    id: 'pending',
    version: 1,
    kind: 'repo-overview',
    target: { kind: 'repo-overview', id: 'root', label: model.repo.name, level: 0 },
    title: targetLabel ? `Explaining ${targetLabel}` : `Explaining ${model.repo.name}`,
    subtitle: status ?? 'Working…',
    tldr: '',
    sections: [],
    next: [],
    sources: [],
    model: '',
    provider: '',
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Welcome screen
 * ------------------------------------------------------------------ */

interface WelcomeProps {
  repos: RepoRecord[];
  providers: ProviderStatus[];
  providerId: string;
  opening: boolean;
  progress: { message: string; pct: number } | null;
  error: string | null;
  onOpen: (target: { path?: string; repoId?: string; force?: boolean }) => void;
  onSelectProvider: (id: string) => void;
  onRefreshProviders: () => void;
  onConfigureModels: () => void;
}

function Welcome({
  repos,
  providers,
  providerId,
  opening,
  progress,
  error,
  onOpen,
  onSelectProvider,
  onRefreshProviders,
  onConfigureModels,
}: WelcomeProps) {
  const [path, setPath] = useState('');
  const activeProvider = providers.find((provider) => provider.id === providerId);

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <header>
          <p className="eyebrow">local-first repository onboarding</p>
          <h1>Get comfortable with a codebase you have never seen</h1>
          <p className="lede">
            Point it at a repository. It builds a call graph and dependency map, then an agent reads the code and explains the architecture,
            answers questions with file-level citations, and walks you through commits and pull requests.
          </p>
        </header>

        <form
          className="open-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) onOpen({ path: path.trim() });
          }}
        >
          <input
            value={path}
            placeholder="/absolute/path/to/repository"
            onChange={(event) => setPath(event.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="primary-button" disabled={opening || path.trim().length === 0}>
            {opening ? 'Analysing…' : 'Analyse'}
          </button>
        </form>

      {opening && progress ? (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.max(2, progress.pct)}%` }} />
            <span className="progress-label">
              {progress.message} · {progress.pct}%
            </span>
          </div>
        ) : null}

        {error ? <div className="error-banner">{error}</div> : null}

        {repos.length > 0 ? (
          <section className="recent">
            <h2>Recently opened</h2>
            <ul>
              {repos.map((record) => (
                <li key={record.repo.id}>
                  <button type="button" onClick={() => onOpen({ repoId: record.repo.id })}>
                    <span className="recent-name">{record.repo.slug ?? record.repo.name}</span>
                    <span className="recent-path">{record.repo.path}</span>
                    <span className="recent-meta">
                      {record.commitCount ? `${formatNumber(record.commitCount)} commits` : 'no git'} · {relativeTime(record.lastOpenedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="models">
          <div className="models-head">
            <h2>Language model</h2>
            <span>
              <button type="button" className="link-button" onClick={onConfigureModels}>
                use a hosted model
              </button>
              <span className="sep">·</span>
              <button type="button" className="link-button" onClick={onRefreshProviders}>
                refresh
              </button>
            </span>
          </div>
          <div className="model-grid">
            {providers.map((provider) => (
              <button
                type="button"
                className={`model-card ${provider.id === providerId ? 'active' : ''} ${provider.available ? '' : 'disabled'}`}
                key={provider.id}
                onClick={() => provider.available && onSelectProvider(provider.id)}
                disabled={!provider.available}
              >
                <span className="model-name">
                  {provider.label}
                  {provider.local ? <span className="chip">local</span> : null}
                </span>
                <span className="model-detail">{provider.detail}</span>
                {provider.defaultModel ? <span className="model-default">{provider.defaultModel}</span> : null}
              </button>
            ))}
          </div>
          {activeProvider && !activeProvider.available ? (
            <p className="muted small">
              No model is reachable. Start Ollama (<code>ollama serve</code>) or set <code>ANTHROPIC_API_KEY</code>, then refresh. Without a
              model the app still analyses the code and shows structural outlines.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

import path from 'node:path';
import fs from 'node:fs';
import { credentialSource, resolveSecrets, saveConfig, saveCredentials, shadowedSettings, type AppConfig } from './config.js';
import type { Change, RepoModel } from './types.js';
import { Store, type RepoRecord } from './store.js';
import { analyzeRepo, ANALYSIS_VERSION } from './analysis/analyzeRepo.js';
import { buildIndex, cacheIndex, emptyIndex, ensureIndex, getCachedIndex, type RepoIndex } from './index/indexer.js';
import { resolveProvider } from './llm/registry.js';
import type { LlmProvider } from './types.js';
import { log } from './logger.js';
import { buildChange, gitSummary, makeRepoRef, type ChangeSpec } from './util/git.js';
import { buildPullRequestChange } from './util/github.js';
import { repoId } from './util/id.js';

export interface RepoContext {
  cfg: AppConfig;
  store: Store;
  root: string;
  model: RepoModel;
  index: RepoIndex;
  provider: LlmProvider;
  providerId: string;
  modelName: string;
}

export interface AnalyzeOptions {
  force?: boolean;
  onProgress?: (message: string, pct: number) => void;
  /** Skip building the search index (useful for a first fast look). */
  skipIndex?: boolean;
}

/**
 * Owns the in-memory state for opened repositories and mediates all access to
 * analysis, indexing, and the language model.
 */
export class RepoService {
  private readonly contexts = new Map<string, RepoContext>();
  private readonly inFlight = new Map<string, Promise<RepoContext>>();
  private providerOverride: string | null = null;

  /** Defaults used when a setting is cleared in the UI. */
  private readonly defaults: AppConfig;

  constructor(
    private readonly cfg: AppConfig,
    private readonly store: Store,
  ) {
    this.defaults = { ...cfg };
  }

  /** Load credentials from the keychain before any provider is built. */
  async init(): Promise<void> {
    await resolveSecrets(this.cfg);
  }

  /** Where secrets are stored, for the settings UI. */
  secretStorageInfo(): { file: string; source: 'env' | 'dotenv' | 'config' | 'none' } {
    return {
      file: path.join(this.cfg.home, '.env'),
      source: credentialSource(this.cfg, 'openaiApiKey') === 'none' ? credentialSource(this.cfg, 'anthropicApiKey') : credentialSource(this.cfg, 'openaiApiKey'),
    };
  }

  listRepos(): Promise<RepoRecord[]> {
    return this.store.listRepos();
  }

  async forget(repoIdToForget: string): Promise<void> {
    this.contexts.delete(repoIdToForget);
    await this.store.forgetRepo(repoIdToForget);
  }

  context(repoId: string): RepoContext | undefined {
    return this.contexts.get(repoId);
  }

  /**
   * Resolve the provider for a context, honouring any runtime override.
   *
   * A configured-but-unreachable provider must not break the app: the setting is
   * still saved, something usable is used in the meantime, and the provider
   * status endpoint tells the user what is actually wrong.
   */
  private async providerFor(): Promise<{ provider: LlmProvider; providerId: string; modelName: string }> {
    const toResult = (resolution: Awaited<ReturnType<typeof resolveProvider>>) => ({
      provider: resolution.provider,
      providerId: resolution.provider.id,
      modelName: resolution.status.defaultModel ?? this.cfg.model ?? 'default',
    });

    try {
      return toResult(await resolveProvider(this.cfg, this.providerOverride ?? undefined));
    } catch (error) {
      log.warn(
        `configured model provider is unavailable (${error instanceof Error ? error.message : String(error)}); using the best available one instead`,
      );
      return toResult(await resolveProvider({ ...this.cfg, provider: 'auto' }, 'auto'));
    }
  }

  /** Switch provider for this process and remember the choice for next time. */
  async setProvider(providerId: string | null): Promise<void> {
    this.providerOverride = providerId;
    if (providerId) saveConfig(this.cfg.home, { provider: providerId });
    await this.applyProviderToContexts();
  }

  async applyProviderToContexts(): Promise<void> {
    const resolved = await this.providerFor();
    for (const ctx of this.contexts.values()) {
      ctx.provider = resolved.provider;
      ctx.providerId = resolved.providerId;
      ctx.modelName = resolved.modelName;
    }
  }

  /**
   * Apply settings typed into the app: persist them, rebuild the provider set,
   * and swap the new provider into every open repository.
   */
  /** The provider actually in use right now, after resolution and fallback. */
  async activeProviderId(): Promise<string> {
    return (await this.providerFor()).providerId;
  }

  /** What the user chose, which may be unreachable and therefore not in use. */
  selectedProviderId(): string {
    return this.providerOverride ?? this.cfg.provider;
  }

  async configure(
    patch: Record<string, unknown>,
  ): Promise<{
    shadowed: string[];
    activeProviderId: string;
    selectedProviderId: string;
    secretsStored: Record<string, string>;
    secretStorage: { file: string; source: 'env' | 'dotenv' | 'config' | 'none' };
  }> {
    const allowed = ['provider', 'model', 'openaiBaseUrl', 'openaiApiKey', 'anthropicApiKey', 'githubToken', 'ollamaUrl', 'ollamaNumCtx'];
    const clean: Record<string, unknown> = {};
    for (const key of allowed) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      clean[key] = key === 'ollamaNumCtx' ? Number(value) || undefined : value === null ? '' : String(value).trim();
    }
    const secrets: Partial<Record<SecretName, string>> = {};
    for (const field of ['openaiApiKey', 'anthropicApiKey', 'githubToken'] as const) {
      if (field in clean) {
        secrets[field] = String(clean[field] ?? '');
        delete clean[field];
      }
    }

    if (clean.provider !== undefined) this.providerOverride = clean.provider === 'auto' ? null : String(clean.provider);
    saveConfig(this.cfg.home, clean);

    // Apply only the changed fields: re-reading the whole file would discard
    // credentials that were resolved from the keychain rather than the file.
    for (const [key, value] of Object.entries(clean)) {
      const cleared = value === '' || value === undefined;
      const fallback = (this.defaults as unknown as Record<string, unknown>)[key];
      (this.cfg as unknown as Record<string, unknown>)[key] = cleared ? fallback : key === 'ollamaNumCtx' ? Number(value) : value;
    }

    const storedIn = await this.storeSecrets(secrets);
    await this.applyProviderToContexts();
    return {
      shadowed: shadowedSettings(),
      activeProviderId: await this.activeProviderId(),
      selectedProviderId: this.selectedProviderId(),
      secretsStored: storedIn,
      secretStorage: this.secretStorageInfo(),
    };
  }

  /**
   * Store or clear API keys in `.env`.
   *
   * One rule: model settings live in `config.json`, credentials live in `.env`.
   */
  private async storeSecrets(secrets: Partial<Record<SecretName, string>>): Promise<Record<string, string>> {
    const entries = Object.entries(secrets) as [SecretName, string][];
    if (entries.length === 0) return {};

    for (const [field, raw] of entries) {
      if (!String(raw ?? '').trim()) this.cfg[field] = null;
    }

    const { path: file, stored } = saveCredentials(this.cfg.home, Object.fromEntries(entries) as Record<SecretName, string>);
    for (const [field, where] of Object.entries(stored)) {
      this.cfg.credentialSources[field as SecretName] = where as 'dotenv' | 'none';
      if (where === 'dotenv') this.cfg[field as SecretName] = String(secrets[field as SecretName] ?? '').trim();
    }
    log.info(`credentials written to ${file} (0600)`);
    return stored;
  }
  /** The provider actually in use right now, after resolution and fallback. */
  credentialStates(): { openai: string; anthropic: string; github: string } {
    return {
      openai: credentialSource(this.cfg, 'openaiApiKey'),
      anthropic: credentialSource(this.cfg, 'anthropicApiKey'),
      // Only ever the *source* of the credential, never its value.
      github: credentialSource(this.cfg, 'githubToken'),
    };
  }

  /** Analyse a path from scratch, persist the model, and build the search index. */
  async analyze(dir: string, options: AnalyzeOptions = {}): Promise<RepoModel> {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);

    const model = await analyzeRepo(resolved, {
      maxFiles: this.cfg.maxFiles,
      maxFileBytes: this.cfg.maxFileBytes,
      onProgress: options.onProgress,
    });

    await this.store.writeModel(model.repo.id, model);

    const previous = await this.store.getRepo(model.repo.id);
    const record: RepoRecord = {
      repo: model.repo,
      addedAt: previous?.addedAt ?? new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      lastAnalyzedAt: model.generatedAt,
      commitCount: model.git.commitCount,
      head: model.git.head,
    };
    await this.store.upsertRepo(record);

    const existing = this.contexts.get(model.repo.id);
    const provider = existing ? { provider: existing.provider, providerId: existing.providerId, modelName: existing.modelName } : await this.providerFor();

    if (options.skipIndex) {
      const index = getCachedIndex(model.repo.id) ?? emptyIndex();
      const ctx: RepoContext = { cfg: this.cfg, store: this.store, root: resolved, model, index, ...provider };
      this.contexts.set(model.repo.id, ctx);
      return model;
    }

    options.onProgress?.('Building the search index', 60);
    const index = await buildIndex(resolved, model, {
      maxFiles: this.cfg.maxFiles,
      maxFileBytes: this.cfg.maxFileBytes,
      onProgress: (done, total) => options.onProgress?.(`Indexing files (${done}/${total})`, 60 + Math.round((done / Math.max(1, total)) * 35)),
    });
    await this.store.writeIndex(model.repo.id, index.toSnapshot(model.repo.id));
    cacheIndex(model.repo.id, index);

    const ctx: RepoContext = { cfg: this.cfg, store: this.store, root: resolved, model, index, ...provider };
    this.contexts.set(model.repo.id, ctx);
    log.info(`analysed ${model.repo.name}: ${model.stats.fileCount} files, ${index.chunkCount} chunks`);
    options.onProgress?.('Ready', 100);
    return model;
  }

  /** Load a previously analysed repository, re-analysing when the cache is missing or stale. */
  async open(repoIdOrPath: string, options: AnalyzeOptions = {}): Promise<RepoContext> {
    const cached = this.contexts.get(repoIdOrPath);
    if (cached && !options.force) return cached;

    const pending = this.inFlight.get(repoIdOrPath);
    if (pending && !options.force) return pending;

    const promise = (async () => {
      // The argument may be a repo id or a filesystem path. Resolve it to an id
      // first, otherwise a path is used as a directory name and the cached
      // analysis is never found — every restart would re-analyse from scratch.
      const looksLikePath = fs.existsSync(repoIdOrPath) && fs.statSync(repoIdOrPath).isDirectory();
      const resolvedId = looksLikePath ? repoIdOf(repoIdOrPath) : repoIdOrPath;
      const record = (await this.store.getRepo(resolvedId)) ?? (looksLikePath ? null : await this.findRecordByPath(repoIdOrPath));
      const dir = record?.repo.path ?? (looksLikePath ? path.resolve(repoIdOrPath) : repoIdOrPath);
      if (!fs.existsSync(dir)) throw new Error(`Repository path no longer exists: ${dir}`);

      const stored = await this.store.readModel(resolvedId);
      if (stored && !options.force && stored.version === ANALYSIS_VERSION && (await isSourceUnchanged(dir, stored))) {
        const index = await ensureIndex(this.cfg, this.store, dir, stored);
        cacheIndex(stored.repo.id, index);
        const provider = this.contexts.get(stored.repo.id) ?? (await this.providerFor());
        const ctx: RepoContext = {
          cfg: this.cfg,
          store: this.store,
          root: dir,
          model: stored,
          index,
          provider: provider.provider,
          providerId: provider.providerId,
          modelName: provider.modelName,
        };
        this.contexts.set(stored.repo.id, ctx);
        await this.store.upsertRepo({
          repo: stored.repo,
          addedAt: record?.addedAt ?? new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
          lastAnalyzedAt: stored.generatedAt,
          commitCount: stored.git.commitCount,
          head: stored.git.head,
        });
        return ctx;
      }

      await this.analyze(dir, options);
      const ctx = this.contexts.get(repoIdOf(dir));
      if (!ctx) throw new Error('Analysis did not produce a usable context.');
      return ctx;
    })();

    this.inFlight.set(repoIdOrPath, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(repoIdOrPath);
    }
  }

  /** Find a previously opened repository whose path matches, so a path can hit the cache. */
  private async findRecordByPath(dir: string): Promise<RepoRecord | null> {
    const resolved = path.resolve(dir);
    const records = await this.store.listRepos();
    return records.find((candidate) => path.resolve(candidate.repo.path) === resolved) ?? null;
  }

  /** Cheap freshness check: re-analyse when HEAD moved or the model is very old. */
  async isStale(ctx: RepoContext): Promise<boolean> {
    if (!ctx.model.git.isRepo) return false;
    const summary = await gitSummary(ctx.root);
    if (summary.head !== ctx.model.git.head) return true;
    const age = Date.now() - new Date(ctx.model.generatedAt).getTime();
    return age > 1000 * 60 * 60 * 24 * 7;
  }

  /**
   * Build (or fetch from cache) a change: a commit, a range, a branch, or the
   * working tree. Diffs are cached because they are expensive on large repos.
   *
   * Only commits are immutable enough to serve from a cache keyed by the request:
   * a branch gains commits, a range is re-read, the working tree gets edited and a
   * pull request is updated in place. Handing back the old copy in those cases
   * shows the reader a diff that no longer exists — and, for a branch, hides the
   * work that was just pushed.
   */
  async change(ctx: RepoContext, spec: ChangeSpec, options: { refresh?: boolean } = {}): Promise<Change> {
    if (!options.refresh && spec.kind === 'commit') {
      const cached = await this.store.readChange(ctx.model.repo.id, changeSpecId(spec));
      if (cached) return cached;
    }
    const change =
      spec.kind === 'pr'
        ? await buildPullRequestChange(ctx.root, { number: spec.number, owner: spec.owner, repo: spec.repo }, { token: this.cfg.githubToken })
        : await buildChange(ctx.root, spec);
    await this.store.writeChange(ctx.model.repo.id, change);
    return change;
  }

  async repoRef(dir: string) {
    return makeRepoRef(dir);
  }

  async analyzePathProgress(dir: string, onProgress: (message: string, pct: number) => void): Promise<RepoModel> {
    return this.analyze(dir, { onProgress, force: true });
  }
}

type SecretName = 'openaiApiKey' | 'anthropicApiKey' | 'githubToken';

function repoIdOf(dir: string): string {
  return repoId(path.resolve(dir));
}

export function changeSpecId(spec: ChangeSpec): string {
  switch (spec.kind) {
    case 'commit':
      return `commit-${spec.sha}`;
    case 'range':
      return `range-${spec.base}-${spec.head}`;
    case 'branch':
      return `branch-${spec.branch}-${spec.compare ?? 'since-diverged'}-${spec.base ?? 'default'}`;
    case 'pr':
      return `pr-${spec.owner ?? 'origin'}-${spec.repo ?? ''}-${spec.number}`.replace(/[^A-Za-z0-9._-]/g, '-');
    case 'working':
      return 'working-tree';
  }
}

/**
 * Compare the current HEAD (and file count) with what was analysed. This is a
 * fast heuristic — a full re-hash would be more precise but much slower.
 */
async function isSourceUnchanged(dir: string, model: RepoModel): Promise<boolean> {
  const res = await gitSummary(dir);

  // A directory can gain or lose version control between analyses — `git init`
  // on a plain folder, or a working copy being replaced by an export. Without
  // this the cached non-git analysis was reused forever, so the history, churn
  // and contributor data never appeared.
  if (res.isRepo !== model.git.isRepo) return false;

  if (!model.git.isRepo) return fs.existsSync(dir);

  if (res.head && model.git.head && res.head !== model.git.head) return false;
  return true;
}

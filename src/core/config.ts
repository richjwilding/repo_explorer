import os from 'node:os';
import { applyToEnvironment, loadDotEnv, wasInjectedByDotEnv, writeDotEnvValue } from './dotenv.js';
import { forgetSecret, registerSecret } from './util/redact.js';
import type { CredentialSource } from './types.js';
import path from 'node:path';
import fs from 'node:fs';

export interface AppConfig {
  home: string;
  dataDir: string;
  cacheDir: string;
  port: number;
  host: string;
  /** Explicit provider id, or 'auto'. */
  provider: string;
  model: string | null;
  ollamaUrl: string;
  /** Context window requested from Ollama. Its default (2048-4096) silently truncates. */
  ollamaNumCtx: number;
  openaiBaseUrl: string;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  /**
   * Optional. Without it pull requests are read from the public API, which is
   * limited to 60 requests an hour and cannot see private repositories.
   */
  githubToken: string | null;
  bedrockRegion: string | null;
  /** Where exported explainer HTML files are written. */
  exportDir: string;
  /** Max files to analyse before truncating. */
  maxFiles: number;
  /** Max bytes per file to read for analysis/indexing. */
  maxFileBytes: number;
  /** Hard ceiling on LLM context characters for any single call. */
  maxContextChars: number;

  /** Filled in by resolveSecrets(); never written to disk. */
  credentialSources: Partial<Record<CredentialField, CredentialSource>>;
  /** Directory searched for a `.env` before the app config directory. */
  cwd: string;
  llmTimeoutMs: number;
  openBrowser: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type CredentialField = 'openaiApiKey' | 'anthropicApiKey' | 'githubToken';

/** The conventional environment variable name for each credential. */
export const CREDENTIAL_ENV_NAMES: Record<CredentialField, string> = {
  openaiApiKey: 'OPENAI_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  // Both spellings are in wide use; GH_TOKEN is what `gh` sets.
  githubToken: 'GITHUB_TOKEN',
};

/** Environment names checked for each credential, in order. */
const CREDENTIAL_ENV_ALIASES: Record<CredentialField, string[]> = {
  openaiApiKey: ['OPENAI_API_KEY'],
  anthropicApiKey: ['ANTHROPIC_API_KEY'],
  githubToken: ['GITHUB_TOKEN', 'GH_TOKEN'],
};

export function configFilePath(home: string): string {
  return path.join(home, 'config.json');
}

/**
 * Persist settings to `~/.repo-explorer/config.json`.
 *
 * Environment variables still win over the file (conventional, and necessary for
 * containers and CI), so the caller is told when that is happening rather than
 * appearing to ignore what the user just typed.
 */
export function saveConfig(home: string, patch: Record<string, unknown>): Record<string, unknown> {
  const file = configFilePath(home);
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === '' || value === null) delete merged[key];
    else merged[key] = value;
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // 0600: this file may contain an API key, and a world-readable secrets file is
  // a bigger problem than the file itself.
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return merged;
}

/** The environment variable that would override a given settings key. */
export function envKeyFor(key: string): string {
  return `REPO_EXPLORER_${key.replace(/[A-Z]/g, (character) => `_${character}`).toUpperCase()}`;
}

/**
 * Where a credential came from: a real environment variable, a `.env` file, the
 * legacy config file, or nowhere. Never the secret itself.
 */
export function credentialSource(cfg: AppConfig, field: CredentialField): CredentialSource {
  const alias = CREDENTIAL_ENV_ALIASES[field].find((name) => process.env[name]);
  const dedicated = process.env[envKeyFor(field)];
  const conventional = alias ? process.env[alias] : undefined;
  if (dedicated || conventional) {
    // It may only be in the environment because we loaded a `.env` file. Report
    // that rather than claiming the shell set it — but only when the file
    // actually supplied the value in use.
    return wasInjectedByDotEnv(envKeyFor(field)) || (alias ? wasInjectedByDotEnv(alias) : false) ? 'dotenv' : 'env';
  }
  const resolved = cfg.credentialSources[field];
  if (resolved) return resolved;
  const file = readConfigFile(cfg.home);
  if (file[field]) return 'config';
  if (cfg[field]) return 'config';
  return 'none';
}

/**
 * Resolve API keys for this process.
 *
 * `.env` has already been folded into the environment by `loadConfig`, so this
 * mostly records provenance and performs a one-time migration of keys that older
 * versions wrote into `config.json`, which is not where secrets belong.
 */
export async function resolveSecrets(cfg: AppConfig): Promise<AppConfig> {
  const legacy = readConfigFile(cfg.home);
  let migrated = false;

  for (const field of ['openaiApiKey', 'anthropicApiKey', 'githubToken'] as const) {
    const fromEnv = process.env[envKeyFor(field)] ?? CREDENTIAL_ENV_ALIASES[field].map((name) => process.env[name]).find(Boolean);
    if (fromEnv) {
      cfg[field] = fromEnv;
      cfg.credentialSources[field] = 'dotenv';
      registerSecret(fromEnv);
      continue;
    }

    const legacyValue = typeof legacy[field] === 'string' ? (legacy[field] as string) : '';
    if (legacyValue) {
      // Move it out of config.json and into .env, once.
      // A .env file uses the conventional name, not our internal field name.
      writeDotEnvValue(cfg.home, CREDENTIAL_ENV_NAMES[field], legacyValue);
      delete legacy[field];
      fs.writeFileSync(configFilePath(cfg.home), `${JSON.stringify(legacy, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      cfg[field] = legacyValue;
      cfg.credentialSources[field] = 'dotenv';
      registerSecret(legacyValue);
      migrated = true;
      continue;
    }

    if (cfg[field]) {
      cfg.credentialSources[field] = 'config';
      registerSecret(cfg[field]);
    } else {
      cfg.credentialSources[field] = 'none';
    }
  }

  if (migrated) {
    // Make the moved values visible to the rest of the process.
    loadDotEnv(cfg.home, { force: true });
  }
  return cfg;
}

/**
 * Store or clear an API key in `.env`.
 *
 * Everything else about the model lives in `config.json`; credentials live in
 * `.env` and nowhere else, which is one rule rather than three code paths.
 */
export function saveCredentials(
  home: string,
  secrets: Partial<Record<CredentialField, string>>,
): { path: string; stored: Record<string, string> } {
  const stored: Record<string, string> = {};
  let file = path.join(home, '.env');

  for (const [field, raw] of Object.entries(secrets) as [CredentialField, string][]) {
    const value = String(raw ?? '').trim();
    const result = writeDotEnvValue(home, CREDENTIAL_ENV_NAMES[field], value || null);
    file = result.path;
    // Keep this process in step with the file, otherwise a cleared key would
    // still be reported (and used) until the next restart.
    applyToEnvironment(CREDENTIAL_ENV_NAMES[field], value || null);
    stored[field] = value ? 'dotenv' : 'none';
    if (value) registerSecret(value);
    else forgetSecret(raw);
  }

  return { path: file, stored };
}

/** Settings keys whose value is currently being forced by an environment variable. */
export function shadowedSettings(): string[] {
  const keys = ['provider', 'model', 'openaiBaseUrl', 'openaiApiKey', 'anthropicApiKey', 'githubToken', 'ollamaUrl', 'ollamaNumCtx'];
  const shadowed = keys.filter((key) => {
    const value = process.env[envKeyFor(key)];
    return value !== undefined && value !== '';
  });
  if (process.env.OPENAI_API_KEY) shadowed.push('openaiApiKey');
  if (process.env.ANTHROPIC_API_KEY) shadowed.push('anthropicApiKey');
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) shadowed.push('githubToken');
  return [...new Set(shadowed)];
}

function readConfigFile(home: string): Record<string, unknown> {
  const file = path.join(home, 'config.json');
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  // An explicit override must win over the environment, otherwise a caller that
  // points the app at a different home directory would still read `.env` and
  // `config.json` from the default one.
  const home = overrides.home || process.env.REPO_EXPLORER_HOME || path.join(os.homedir(), '.repo-explorer');
  const cwd = overrides.cwd || process.env.REPO_EXPLORER_CWD || process.cwd();
  // `.env` values are folded into the environment first, so they behave exactly
  // like exported variables everywhere below. Idempotent and non-overwriting.
  loadDotEnv(home, { cwd });
  const file = readConfigFile(home);
  const pick = <T>(key: string, fallback: T): T => {
    const envKey = `REPO_EXPLORER_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const fromEnv = process.env[envKey];
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv as unknown as T;
    if (file[key] !== undefined) return file[key] as T;
    return fallback;
  };

  const dataDir = path.join(home, 'data');
  const cfg: AppConfig = {
    home,
    dataDir,
    cacheDir: path.join(home, 'cache'),
    port: envInt('REPO_EXPLORER_PORT', 5178),
    host: process.env.REPO_EXPLORER_HOST || '127.0.0.1',
    provider: pick('provider', 'auto'),
    model: pick<string | null>('model', null),
    ollamaUrl: pick('ollamaUrl', process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'),
    ollamaNumCtx: envInt('REPO_EXPLORER_OLLAMA_NUM_CTX', 65536),
    openaiBaseUrl: pick('openaiBaseUrl', process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    openaiApiKey: pick<string | null>('openaiApiKey', process.env.OPENAI_API_KEY || null),
    anthropicApiKey: pick<string | null>('anthropicApiKey', process.env.ANTHROPIC_API_KEY || null),
    githubToken: pick<string | null>('githubToken', process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null),
    bedrockRegion: pick<string | null>('bedrockRegion', process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || null),
    exportDir: pick('exportDir', process.env.REPO_EXPLORER_EXPORT_DIR || path.join(os.homedir(), 'RepoExplorer')),
    maxFiles: envInt('REPO_EXPLORER_MAX_FILES', 20000),
    maxFileBytes: envInt('REPO_EXPLORER_MAX_FILE_BYTES', 400_000),
    maxContextChars: envInt('REPO_EXPLORER_MAX_CONTEXT_CHARS', 120_000),
    credentialSources: {},
    cwd,
    llmTimeoutMs: envInt('REPO_EXPLORER_LLM_TIMEOUT_MS', 900_000),
    openBrowser: pick('openBrowser', true),
  };

  return { ...cfg, ...overrides };
}

export function ensureDirs(cfg: AppConfig): void {
  for (const dir of [cfg.home, cfg.dataDir, cfg.cacheDir, cfg.exportDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The home directory holds credentials, so keep it private to this account.
  try {
    fs.chmodSync(cfg.home, 0o700);
  } catch {
    /* best effort: some filesystems do not support this */
  }
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dotEnvSourceFor, loadDotEnv, parseDotEnv, resetDotEnvTracking, writeDotEnvValue } from '../src/core/dotenv.js';
import { loadConfig, credentialSource, resolveSecrets, saveCredentials } from '../src/core/config.js';

let home: string;
let cwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetDotEnvTracking();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-env-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-explorer-cwd-'));
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'REPO_EXPLORER_OPENAI_API_KEY', 'REPO_EXPLORER_HOME', 'REPO_EXPLORER_DOTENV']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('.env parsing', () => {
  it('reads plain, exported and quoted values', () => {
    const parsed = parseDotEnv(
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED=value2',
        'SPACED = spaced value',
        'DOUBLE="quoted value"',
        "SINGLE='single quoted'",
        'INLINE=value # trailing comment',
        'HASH="keeps # this"',
        'EMPTY=',
        'not a valid line',
      ].join('\n'),
    );

    expect(parsed.PLAIN).toBe('value');
    expect(parsed.EXPORTED).toBe('value2');
    expect(parsed.SPACED).toBe('spaced value');
    expect(parsed.DOUBLE).toBe('quoted value');
    expect(parsed.SINGLE).toBe('single quoted');
    expect(parsed.INLINE).toBe('value');
    expect(parsed.HASH).toBe('keeps # this');
    expect(parsed.EMPTY).toBe('');
    expect(parsed['not a valid line']).toBeUndefined();
  });

  it('handles escapes inside double quotes and values spanning lines', () => {
    const parsed = parseDotEnv(['A="line1\\nline2"', 'B="first', 'second"', 'C=after'].join('\n'));
    expect(parsed.A).toBe('line1\nline2');
    expect(parsed.B).toBe('first\nsecond');
    expect(parsed.C).toBe('after');
  });

  it('tolerates a BOM and CRLF line endings', () => {
    expect(parseDotEnv('\uFEFFKEY=value\r\nOTHER=x\r\n').KEY).toBe('value');
    expect(parseDotEnv('\uFEFFKEY=value\r\nOTHER=x\r\n').OTHER).toBe('x');
  });

  it('keeps surrounding quotes out of the value', () => {
    // The asymmetry that matters: an unquoted value is trimmed, a quoted one is not.
    expect(parseDotEnv('A=  spaced  ').A).toBe('spaced');
    expect(parseDotEnv('A="  spaced  "').A).toBe('  spaced  ');
  });
});

describe('.env loading', () => {
  it('loads values into the environment without overwriting real variables', () => {
    fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=from-file\nOTHER=one\n');
    process.env.OPENAI_API_KEY = 'from-shell';

    const loaded = loadDotEnv(home, { cwd });

    expect(process.env.OPENAI_API_KEY).toBe('from-shell');
    expect(process.env.OTHER).toBe('one');
    expect(loaded.files).toHaveLength(1);
    expect(loaded.keys).toContain('OTHER');
    expect(loaded.keys).not.toContain('OPENAI_API_KEY');
  });

  it('prefers the working directory file over the app config directory', () => {
    fs.writeFileSync(path.join(home, '.env'), 'SHARED=from-home\nHOME_ONLY=yes\n');
    fs.writeFileSync(path.join(cwd, '.env'), 'SHARED=from-cwd\n');
    loadDotEnv(home, { cwd });
    expect(process.env.SHARED).toBe('from-cwd');
    expect(process.env.HOME_ONLY).toBe('yes');
  });

  it('can be switched off', () => {
    fs.writeFileSync(path.join(home, '.env'), 'SHOULD_NOT_LOAD=1\n');
    process.env.REPO_EXPLORER_DOTENV = '0';
    loadDotEnv(home, { cwd });
    expect(process.env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it('reports which file defines a key', () => {
    fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=from-home\n');
    expect(dotEnvSourceFor(home, ['OPENAI_API_KEY'], cwd)).toBe(path.join(home, '.env'));
    expect(dotEnvSourceFor(home, ['NOT_THERE'], cwd)).toBeNull();
  });
});

describe('.env writing', () => {
  it('creates the file privately and appends without disturbing the rest', () => {
    const file = path.join(home, '.env');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, '# keep me\nEXISTING=1\n');

    writeDotEnvValue(home, 'OPENAI_API_KEY', 'sk-new-value');

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# keep me');
    expect(text).toContain('EXISTING=1');
    expect(text).toContain('OPENAI_API_KEY=sk-new-value');
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('replaces an existing key in place and removes it cleanly', () => {
    const file = path.join(home, '.env');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, 'A=1\nOPENAI_API_KEY=old\nB=2\n');

    writeDotEnvValue(home, 'OPENAI_API_KEY', 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nOPENAI_API_KEY=new\nB=2\n');

    const result = writeDotEnvValue(home, 'OPENAI_API_KEY', null);
    expect(result.removed).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('A=1\nB=2\n');
  });

  it('quotes values that need it', () => {
    writeDotEnvValue(home, 'TRICKY', 'has space and # hash');
    const parsed = parseDotEnv(fs.readFileSync(path.join(home, '.env'), 'utf8'));
    expect(parsed.TRICKY).toBe('has space and # hash');
  });
});

describe('configuration precedence', () => {
  it('reads a key from .env and reports it as coming from .env', async () => {
    fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=sk-from-dotenv-123456\n');

    const cfg = await resolveSecrets(loadConfig({ home, dataDir: `${home}/data`, cacheDir: `${home}/cache`, exportDir: `${home}/exports`, cwd }));
    expect(cfg.openaiApiKey).toBe('sk-from-dotenv-123456');
    expect(credentialSource(cfg, 'openaiApiKey')).toBe('dotenv');
  });

  it('lets a real environment variable beat the file', async () => {
    fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=sk-from-dotenv-123456\n');
    process.env.OPENAI_API_KEY = 'sk-from-shell-abcdefgh';

    const cfg = await resolveSecrets(loadConfig({ home, dataDir: `${home}/data`, cacheDir: `${home}/cache`, exportDir: `${home}/exports`, cwd }));
    expect(cfg.openaiApiKey).toBe('sk-from-shell-abcdefgh');
    expect(credentialSource(cfg, 'openaiApiKey')).toBe('env');
  });

  it('migrates a key that an older version left in config.json', async () => {
    // config.json is not where secrets belong; the loader moves it once.
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ provider: 'ollama', openaiApiKey: 'sk-legacy-in-config' }, null, 2),
    );

    const cfg = await resolveSecrets(loadConfig({ home, dataDir: `${home}/data`, cacheDir: `${home}/cache`, exportDir: `${home}/exports`, cwd }));

    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toContain('OPENAI_API_KEY=sk-legacy-in-config');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(config.openaiApiKey).toBeUndefined();
    expect(config.provider).toBe('ollama');
    expect(cfg.openaiApiKey).toBe('sk-legacy-in-config');
    expect(credentialSource(cfg, 'openaiApiKey')).toBe('dotenv');
  });

  it('reflects a saved or cleared key immediately, without a restart', async () => {
    // Regression: clearing a key left the old value in process.env, so the app
    // kept reporting (and using) a credential it no longer had.
    const base = { home, dataDir: `${home}/data`, cacheDir: `${home}/cache`, exportDir: `${home}/exports`, cwd };

    saveCredentials(home, { openaiApiKey: 'sk-saved-value-1234567890' });
    const saved = await resolveSecrets(loadConfig(base));
    expect(saved.openaiApiKey).toBe('sk-saved-value-1234567890');
    expect(credentialSource(saved, 'openaiApiKey')).toBe('dotenv');

    saveCredentials(home, { openaiApiKey: '' });
    const cleared = await resolveSecrets(loadConfig(base));
    expect(cleared.openaiApiKey).toBeNull();
    expect(credentialSource(cleared, 'openaiApiKey')).toBe('none');
  });

  it('reports no credential when nothing provides one', async () => {
    const cfg = await resolveSecrets(loadConfig({ home, dataDir: `${home}/data`, cacheDir: `${home}/cache`, exportDir: `${home}/exports`, cwd }));
    expect(credentialSource(cfg, 'openaiApiKey')).toBe('none');
    expect(credentialSource(cfg, 'anthropicApiKey')).toBe('none');
  });
});

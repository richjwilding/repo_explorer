import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProviderPatch } from '../src/web/lib/providerPatch.js';
import { buildProviders } from '../src/core/llm/registry.js';
import { loadConfig } from '../src/core/config.js';

/**
 * Two defects behind one confusing message.
 *
 * A user selected Anthropic, typed a key, pressed the button labelled "Save and
 * test", and was told "saved, but anthropic cannot be used yet" — with the
 * terminal saying "Unknown LLM provider 'anthropic'". Both halves were wrong:
 * that button did not send the key at all, and the provider was not registered
 * unless a key existed at startup, so the error implied the app had never heard
 * of Anthropic rather than that it had no credential.
 */

describe('what the model panel saves', () => {
  it('includes the Anthropic key', () => {
    // The regression: the "Save and test" button omitted this field entirely.
    const patch = buildProviderPatch({ preset: 'anthropic', anthropicKey: 'sk-ant-api03-abc' });
    expect(patch).toEqual({ provider: 'anthropic', anthropicApiKey: 'sk-ant-api03-abc' });
  });

  it('includes the OpenAI key and base URL together', () => {
    const patch = buildProviderPatch({ preset: 'openai', apiKey: 'sk-abc', openaiBaseUrl: 'https://api.deepseek.com/v1' });
    expect(patch).toEqual({ provider: 'openai', openaiApiKey: 'sk-abc', openaiBaseUrl: 'https://api.deepseek.com/v1' });
  });

  it('never sends a key field that is empty, so saving cannot clear a stored one', () => {
    expect(buildProviderPatch({ preset: 'anthropic', anthropicKey: '' })).toEqual({ provider: 'anthropic' });
    expect(buildProviderPatch({ preset: 'anthropic', anthropicKey: '   ' })).toEqual({ provider: 'anthropic' });
    expect(buildProviderPatch({ preset: 'anthropic' })).toEqual({ provider: 'anthropic' });
  });

  it('sends only the fields that belong to the chosen preset', () => {
    const patch = buildProviderPatch({ preset: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', apiKey: 'sk-ignored', anthropicKey: 'sk-ant-ignored' });
    expect(patch).toEqual({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434' });
    expect(patch).not.toHaveProperty('openaiApiKey');
    expect(patch).not.toHaveProperty('anthropicApiKey');
  });

  it('trims a key that was pasted with whitespace', () => {
    expect(buildProviderPatch({ preset: 'anthropic', anthropicKey: '  sk-ant-abc \n' })).toEqual({
      provider: 'anthropic',
      anthropicApiKey: 'sk-ant-abc',
    });
  });

  it('carries the model when one is chosen, and omits an empty one', () => {
    expect(buildProviderPatch({ preset: 'anthropic', model: 'claude-sonnet-4-5', anthropicKey: 'k' }).model).toBe('claude-sonnet-4-5');
    expect(buildProviderPatch({ preset: 'anthropic', model: '' })).not.toHaveProperty('model');
  });
});

describe('the Anthropic provider exists before it has a key', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const config = (overrides: Record<string, unknown> = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'));
    created.push(home);
    return loadConfig({
      home,
      dataDir: `${home}/data`,
      cacheDir: `${home}/cache`,
      exportDir: `${home}/exports`,
      provider: 'auto',
      anthropicApiKey: null,
      openaiApiKey: null,
      githubToken: null,
      ...overrides,
    });
  };

  it('is registered even with no key, so "unknown provider" is never the answer', () => {
    const ids = buildProviders(config()).map((provider) => provider.id);
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('ollama');
  });

  it('reports what is actually missing rather than being absent', async () => {
    const anthropic = buildProviders(config()).find((provider) => provider.id === 'anthropic');
    const status = await anthropic!.status();
    expect(status.available).toBe(false);
    expect(status.detail).toMatch(/No API key set/);
    expect(status.credential?.present).toBe(false);
  });

  it('is available to try as soon as a key is configured', async () => {
    // A key present means the provider is considered, not that it is reachable —
    // the request decides that, which is the honest split.
    const anthropic = buildProviders(config({ anthropicApiKey: 'sk-ant-api03-abc' })).find((provider) => provider.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect((anthropic as unknown as { apiKey: string }).apiKey).toBe('sk-ant-api03-abc');
  });
});

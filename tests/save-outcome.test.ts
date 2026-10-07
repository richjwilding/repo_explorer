import { describe, expect, it } from 'vitest';
import { describeSaveOutcome } from '../src/web/lib/saveOutcome.js';
import type { ProviderStatus } from '../src/core/types.js';

const provider = (id: string, label: string, available: boolean, extras: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label,
  available,
  detail: '',
  models: [],
  local: id === 'ollama',
  ...extras,
});

const providers = [
  provider('anthropic', 'Anthropic Claude', false, {
    detail: 'HTTP 401 — authentication_error',
    credential: { present: true, source: 'dotenv' },
  }),
  provider('openai', 'Hosted OpenAI-compatible API', true, { credential: { present: true, source: 'dotenv' } }),
  provider('ollama', 'Ollama (on-device)', true),
];

describe('save outcome reporting', () => {
  it('confirms when the chosen provider is the one in use', () => {
    const outcome = describeSaveOutcome({
      selectedProviderId: 'openai',
      activeProviderId: 'openai',
      providers,
      keyStored: true,
    });
    expect(outcome.inUse).toBe(true);
    expect(outcome.tone).toBe('ok');
    expect(outcome.title).toContain('Hosted OpenAI-compatible API');
  });

  it('does not claim success when the choice could not be used', () => {
    // Regression: this said "this is now the model in use" even when the app had
    // fallen back to a local model, which made a saved choice look like a no-op.
    const outcome = describeSaveOutcome({
      selectedProviderId: 'anthropic',
      activeProviderId: 'ollama',
      providers,
      keyStored: true,
    });
    expect(outcome.inUse).toBe(false);
    expect(outcome.tone).toBe('warn');
    expect(outcome.title).toContain('cannot be used yet');
    expect(outcome.title).toContain('Ollama');
    // It says what was saved, what the provider said, and that nothing is broken.
    expect(outcome.detail).toContain('key was saved');
    expect(outcome.detail).toContain('HTTP 401');
    expect(outcome.detail).toContain('Nothing is broken');
  });

  it('points out that the key was not accepted', () => {
    const outcome = describeSaveOutcome({
      selectedProviderId: 'openai',
      activeProviderId: 'ollama',
      providers: [provider('openai', 'Hosted OpenAI-compatible API', false, { detail: 'No API key set.', credential: { present: false, source: 'none' } }), providers[2]],
      keyStored: false,
    });
    expect(outcome.inUse).toBe(false);
    expect(outcome.detail).toContain('does not appear to have been accepted');
  });

  it('treats auto as success, since there is nothing to fall back from', () => {
    const outcome = describeSaveOutcome({
      selectedProviderId: 'auto',
      activeProviderId: 'ollama',
      providers,
      keyStored: false,
    });
    expect(outcome.inUse).toBe(true);
    expect(outcome.tone).toBe('ok');
    expect(outcome.title).toContain('Ollama');
  });
});

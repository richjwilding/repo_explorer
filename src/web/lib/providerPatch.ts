/**
 * What the model panel sends when you save.
 *
 * This exists because the two save buttons used to send *different* payloads: the
 * one labelled "Save and test" omitted the API key entirely, so typing a key and
 * pressing it saved the provider choice without the credential and then reported
 * "saved, but anthropic cannot be used yet". The label promised a test of what
 * was on screen; the request did not contain it.
 *
 * Now there is one function and no way for two callers to disagree.
 */

export type ProviderPreset = 'ollama' | 'openai' | 'anthropic';

export interface ProviderPatchInput {
  preset: ProviderPreset;
  /** Only sent when non-empty, so saving never silently clears a stored key. */
  apiKey?: string;
  anthropicKey?: string;
  openaiBaseUrl?: string;
  ollamaUrl?: string;
  model?: string;
}

export function buildProviderPatch(input: ProviderPatchInput): Record<string, unknown> {
  const { preset, apiKey, anthropicKey, openaiBaseUrl, ollamaUrl, model } = input;
  const patch: Record<string, unknown> = { provider: preset };

  if (model !== undefined && model.trim() !== '') patch.model = model.trim();

  if (preset === 'openai') {
    if (openaiBaseUrl !== undefined) patch.openaiBaseUrl = openaiBaseUrl.trim();
    if (apiKey && apiKey.trim()) patch.openaiApiKey = apiKey.trim();
  }
  if (preset === 'anthropic') {
    if (anthropicKey && anthropicKey.trim()) patch.anthropicApiKey = anthropicKey.trim();
  }
  if (preset === 'ollama' && ollamaUrl !== undefined) {
    patch.ollamaUrl = ollamaUrl.trim();
  }

  return patch;
}

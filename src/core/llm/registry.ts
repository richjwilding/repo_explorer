import { credentialSource, type AppConfig } from '../config.js';
import { redact } from '../util/redact.js';
import type { LlmProvider, ProviderStatus } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiProvider } from './openai.js';

export function buildProviders(cfg: AppConfig): LlmProvider[] {
  const providers: LlmProvider[] = [];

  // Registered whether or not a key is present, like every other provider. It
  // used to be conditional, so choosing Anthropic before a key existed produced
  // "Unknown LLM provider" — which says the opposite of the truth. Its own status
  // now reports "No API key set", which is the actual situation.
  providers.push(
    new AnthropicProvider(cfg.anthropicApiKey ?? '', cfg.model, cfg.llmTimeoutMs, undefined, credentialSource(cfg, 'anthropicApiKey')),
  );
  providers.push(
    new OpenAiProvider(cfg.openaiBaseUrl, cfg.openaiApiKey, cfg.model, cfg.llmTimeoutMs, {
      id: 'openai',
      label: cfg.openaiApiKey ? 'Hosted OpenAI-compatible API' : 'Local OpenAI-compatible server',
      credentialSource: credentialSource(cfg, 'openaiApiKey'),
    }),
  );
  providers.push(new OllamaProvider(cfg.ollamaUrl, cfg.model, cfg.llmTimeoutMs, cfg.ollamaNumCtx));
  providers.push(new MockProvider());

  return providers;
}

/** Provider preference order for `provider: "auto"`. */
const AUTO_ORDER = ['anthropic', 'openai', 'ollama'];

export interface ProviderResolution {
  provider: LlmProvider;
  status: ProviderStatus;
  /** Providers that were considered but unavailable. */
  rejected: ProviderStatus[];
}

const statusCache = new Map<string, { at: number; status: ProviderStatus }>();
const STATUS_TTL_MS = 20_000;

export async function listProviderStatuses(cfg: AppConfig, options: { refresh?: boolean } = {}): Promise<ProviderStatus[]> {
  const providers = buildProviders(cfg);
  return Promise.all(
    providers.map(async (provider) => {
      const cacheKey = `${provider.id}:${cfg.model ?? ''}:${cfg.ollamaUrl}:${cfg.openaiBaseUrl}`;
      const cached = statusCache.get(cacheKey);
      if (!options.refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
      let status: ProviderStatus;
      try {
        status = await provider.status();
      } catch (error) {
        status = {
          id: provider.id,
          label: provider.label,
          available: false,
          detail: error instanceof Error ? error.message : String(error),
          models: [],
          local: provider.local,
        };
      }
      if (status.models.length === 0 && status.defaultModel) status.models = [status.defaultModel];
      // Upstream errors can quote the credential that was just sent, and this
      // string is returned to the browser.
      status.detail = redact(status.detail);
      statusCache.set(cacheKey, { at: Date.now(), status });
      return status;
    }),
  );
}

export async function resolveProvider(cfg: AppConfig, preferredId?: string): Promise<ProviderResolution> {
  const providers = buildProviders(cfg);
  const wanted = preferredId && preferredId !== 'auto' ? preferredId : cfg.provider !== 'auto' ? cfg.provider : undefined;

  if (wanted) {
    const provider = providers.find((p) => p.id === wanted);
    if (!provider) throw new Error(`Unknown LLM provider "${wanted}". Known providers: ${providers.map((p) => p.id).join(', ')}`);
    const status = await provider.status();
    if (!status.available) throw new Error(`Provider "${wanted}" is unavailable: ${status.detail}`);
    return { provider, status, rejected: [] };
  }

  const statuses = await listProviderStatuses(cfg, { refresh: true });
  const rejected: ProviderStatus[] = [];
  for (const id of AUTO_ORDER) {
    const status = statuses.find((s) => s.id === id);
    if (status?.available) {
      const provider = providers.find((p) => p.id === id) as LlmProvider;
      return { provider, status, rejected };
    }
    if (status) rejected.push(status);
  }

  const mock = providers.find((p) => p.id === 'mock') as MockProvider;
  return { provider: mock, status: await mock.status(), rejected };
}

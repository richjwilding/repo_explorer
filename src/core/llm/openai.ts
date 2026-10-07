import type { CredentialSource, LlmProvider, LlmRequest, LlmResult, LlmStreamChunk, ProviderStatus } from '../types.js';
import { describeFetchError, getJson, postJson, streamSse } from './http.js';
import { log } from '../logger.js';

interface OpenAiModels {
  data?: { id: string }[];
}

interface OpenAiChatResponse {
  model?: string;
  choices?: {
    // `reasoning_content` is DeepSeek and several other vendors; `reasoning` is
    // used by others again. Both mean "chain of thought, not the answer".
    message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

interface OpenAiStreamChunk {
  model?: string;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function isLocalBase(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local');
  } catch {
    return false;
  }
}

/**
 * Any OpenAI-compatible /chat/completions endpoint: OpenAI, Azure-style
 * gateways, Together, Groq, OpenRouter, vLLM, LM Studio, llama.cpp, and
 * Ollama's own /v1 compatibility layer.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly local: boolean;
  private readonly credentialSource?: CredentialSource;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | null,
    private readonly configuredModel: string | null,
    private readonly timeoutMs: number,
    options: { id?: string; label?: string; credentialSource?: CredentialSource } = {},
  ) {
    this.credentialSource = options.credentialSource;
    this.id = options.id ?? 'openai';
    this.local = isLocalBase(this.baseUrl);
    this.label = options.label ?? (this.local ? 'Local OpenAI-compatible server' : 'OpenAI-compatible API');
  }

  private get base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async status(): Promise<ProviderStatus> {
    const credential = this.credentialSource ? { present: Boolean(this.apiKey), source: this.credentialSource } : undefined;
    if (!this.apiKey && !this.local) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        detail: 'No API key set. Add one below, or set OPENAI_API_KEY.',
        models: [],
        local: false,
        credential,
      };
    }
    try {
      const res = await getJson<OpenAiModels>(`${this.base}/models`, { headers: this.headers(), timeoutMs: 5000 });
      if (!res.ok) {
        // Not every OpenAI-compatible endpoint implements /models, and a gateway
        // may block it. With a key and an explicit model we can still be used, so
        // report that honestly rather than declaring the provider unavailable.
        const usableWithoutListing = Boolean(this.apiKey && this.configuredModel);
        return {
          id: this.id,
          label: this.label,
          available: usableWithoutListing,
          detail: `HTTP ${res.status} listing models — ${res.text.slice(0, 200)}${
            usableWithoutListing ? `\nModel listing is unavailable, but "${this.configuredModel}" will be used directly.` : ''
          }`,
          models: this.configuredModel ? [this.configuredModel] : [],
          defaultModel: this.configuredModel ?? undefined,
          local: this.local,
          credential,
        };
      }
      const models = (res.data?.data ?? []).map((m) => m.id).sort((a, b) => a.localeCompare(b));
      return {
        id: this.id,
        label: this.label,
        available: models.length > 0,
        detail: models.length > 0 ? `${models.length} model${models.length === 1 ? '' : 's'} available` : 'No models reported by the endpoint',
        models,
        defaultModel: this.configuredModel ?? pickBestOpenAiModel(models) ?? undefined,
        local: this.local,
        credential,
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        detail: `${describeFetchError(error)}`,
        models: [],
        local: this.local,
        credential,
      };
    }
  }

  private async model(req: LlmRequest): Promise<string> {
    if (req.model) return req.model;
    if (this.configuredModel) return this.configuredModel;
    const status = await this.status();
    return status.defaultModel ?? 'gpt-4o-mini';
  }

  private body(req: LlmRequest, model: string, stream: boolean): Record<string, unknown> {
    return {
      model,
      messages: req.messages,
      stream,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const model = await this.model(req);
    let res = await postJson<OpenAiChatResponse>(`${this.base}/chat/completions`, this.body(req, model, false), {
      headers: this.headers(),
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    });
    // Some compatible servers reject `response_format`; retry without it.
    if (!res.ok && req.json && /response_format|json_object/i.test(res.text)) {
      const relaxed: LlmRequest = { ...req, json: false };
      res = await postJson<OpenAiChatResponse>(`${this.base}/chat/completions`, this.body(relaxed, model, false), {
        headers: this.headers(),
        signal: req.signal,
        timeoutMs: this.timeoutMs,
      });
    }
    if (!res.ok || res.data?.error) {
      throw new Error(`LLM error: ${res.data?.error?.message ?? `HTTP ${res.status} ${res.text.slice(0, 300)}`}`);
    }
    const message = res.data?.choices?.[0]?.message;
    const content = message?.content ?? '';
    const reasoning = message?.reasoning_content ?? message?.reasoning ?? '';
    if (!content.trim() && reasoning.trim()) {
      log.debug('the model returned only reasoning and no answer; using the reasoning text as a fallback');
    }
    return {
      text: content.trim() ? content : reasoning,
      model: res.data?.model ?? model,
      provider: this.id,
      usage: res.data?.usage
        ? { prompt: res.data.usage.prompt_tokens ?? 0, completion: res.data.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const model = await this.model(req);
    let usage: { prompt: number; completion: number } | undefined;
    let emitted = 0;
    let reasoningChars = 0;

    for await (const payload of streamSse(`${this.base}/chat/completions`, this.body(req, model, true), {
      headers: this.headers(),
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    })) {
      if (payload === '[DONE]') break;
      let parsed: OpenAiStreamChunk;
      try {
        parsed = JSON.parse(payload) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      if (parsed.error?.message) throw new Error(`LLM error: ${parsed.error.message}`);

      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) {
        emitted += delta.content.length;
        yield { delta: delta.content };
      } else {
        // Reasoning is counted, never shown: the reader wants the answer. A long
        // silent reasoning phase is what made the UI look like it had hung.
        reasoningChars += (delta?.reasoning_content ?? delta?.reasoning ?? '').length;
      }
      if (parsed.usage) usage = { prompt: parsed.usage.prompt_tokens ?? 0, completion: parsed.usage.completion_tokens ?? 0 };
    }

    if (emitted === 0 && reasoningChars > 0) {
      throw new Error(
        `The model produced ${reasoningChars} characters of reasoning but no answer. Use a non-reasoning model (for DeepSeek, deepseek-chat rather than deepseek-reasoner).`,
      );
    }
    yield { delta: '', done: true, usage };
  }
}

export function pickBestOpenAiModel(models: string[]): string | null {
  const preferred = [/^gpt-5/i, /^gpt-4\.1/i, /^o4/i, /^o3/i, /^gpt-4o$/i, /^gpt-4o-mini$/i, /^claude/i, /^qwen/i, /^llama/i, /^deepseek/i, /^mistral/i];
  for (const pattern of preferred) {
    const match = models.find((m) => pattern.test(m));
    if (match) return match;
  }
  return models.find((m) => !/embed|whisper|tts|dall-e|moderation/i.test(m)) ?? models[0] ?? null;
}

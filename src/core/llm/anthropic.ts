import { log } from '../logger.js';
import type { CredentialSource, LlmMessage, LlmProvider, LlmRequest, LlmResult, LlmStreamChunk, ProviderStatus } from '../types.js';
import { describeFetchError, getJson, postJson, streamSse } from './http.js';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicModels {
  data?: { id: string; display_name?: string }[];
}

interface AnthropicResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  message?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

const PREFERRED = [/^claude-opus-4/i, /^claude-sonnet-4/i, /^claude-3-7/i, /^claude-3-5-sonnet/i, /^claude-3-5-haiku/i];

function splitSystem(messages: LlmMessage[]): { system: string | undefined; rest: LlmMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  return { system: system || undefined, rest: rest.length > 0 ? rest : [{ role: 'user', content: 'Continue.' }] };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic Claude';
  readonly local = false;

  constructor(
    private readonly apiKey: string,
    private readonly configuredModel: string | null,
    private readonly timeoutMs: number,
    private readonly baseUrl = 'https://api.anthropic.com/v1',
    private readonly credentialSource: CredentialSource = 'none',
  ) {}

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }

  async status(): Promise<ProviderStatus> {
    if (!this.apiKey) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        detail: 'No API key set. Add one below, or set ANTHROPIC_API_KEY.',
        models: [],
        local: false,
        credential: { present: false, source: this.credentialSource },
      };
    }
    try {
      const res = await getJson<AnthropicModels>(`${this.baseUrl}/models?limit=50`, { headers: this.headers(), timeoutMs: 6000 });
      if (!res.ok) {
        return {
          id: this.id,
          label: this.label,
          available: false,
          detail: `HTTP ${res.status} — ${res.text.slice(0, 200)}`,
          models: [],
          local: false,
          credential: { present: true, source: this.credentialSource },
        };
      }
      const models = (res.data?.data ?? []).map((m) => m.id);
      let defaultModel = this.configuredModel ?? undefined;
      if (!defaultModel) {
        for (const pattern of PREFERRED) {
          const match = models.find((m) => pattern.test(m));
          if (match) {
            defaultModel = match;
            break;
          }
        }
      }
      defaultModel = defaultModel ?? models[0];
      return {
        id: this.id,
        label: this.label,
        available: models.length > 0,
        detail: `${models.length} model${models.length === 1 ? '' : 's'} available`,
        models,
        defaultModel,
        local: false,
        credential: { present: true, source: this.credentialSource },
      };
    } catch (error) {
      return { id: this.id, label: this.label, available: false, detail: describeFetchError(error), models: [], local: false };
    }
  }

  private async model(req: LlmRequest): Promise<string> {
    if (req.model) return req.model;
    if (this.configuredModel) return this.configuredModel;
    const status = await this.status();
    if (!status.defaultModel) throw new Error('No Anthropic model available.');
    return status.defaultModel;
  }

  /**
   * Models that reject `temperature`.
   *
   * Newer Claude models removed the parameter and answer "temperature is
   * deprecated for this model". Shipping a list of model names would rot, so the
   * first rejection teaches us and the parameter is dropped for that model from
   * then on. Sending it where it is supported still gives the lower-temperature
   * output the prompts are written for.
   */
  private readonly withoutTemperature = new Set<string>();

  private rejectsTemperature(message: string): boolean {
    return /temperature/i.test(message) && /(deprecat|unsupported|not support|removed|invalid|unknown)/i.test(message);
  }

  private body(req: LlmRequest, model: string, stream: boolean): Record<string, unknown> {
    const { system, rest } = splitSystem(req.messages);
    const jsonHint = req.json
      ? { role: 'user' as const, content: 'Reply with a single valid JSON object and nothing else. No markdown fences.' }
      : null;
    return {
      model,
      max_tokens: req.maxTokens ?? 8000,
      ...(req.temperature !== undefined && !this.withoutTemperature.has(model) ? { temperature: req.temperature } : {}),
      ...(system ? { system } : {}),
      messages: jsonHint ? [...rest, jsonHint] : rest,
      stream,
    };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const model = await this.model(req);
    let res = await postJson<AnthropicResponse>(`${this.baseUrl}/messages`, this.body(req, model, false), {
      headers: this.headers(),
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok || res.data?.error) {
      const message = res.data?.error?.message ?? `HTTP ${res.status} ${res.text.slice(0, 300)}`;
      // A model that has removed `temperature` should not cost the user an
      // explanation; retry once without it and remember the model.
      if (this.rejectsTemperature(message) && !this.withoutTemperature.has(model)) {
        log.warn('this model rejects temperature; retrying without it', { provider: this.id, model });
        this.withoutTemperature.add(model);
        res = await postJson<AnthropicResponse>(`${this.baseUrl}/messages`, this.body(req, model, false), {
          headers: this.headers(),
          signal: req.signal,
          timeoutMs: this.timeoutMs,
        });
      }
    }
    if (!res.ok || res.data?.error) {
      throw new Error(`Anthropic error: ${res.data?.error?.message ?? `HTTP ${res.status} ${res.text.slice(0, 300)}`}`);
    }
    return {
      text: (res.data?.content ?? []).map((c) => c.text ?? '').join(''),
      model: res.data?.model ?? model,
      provider: this.id,
      usage: res.data?.usage
        ? { prompt: res.data.usage.input_tokens ?? 0, completion: res.data.usage.output_tokens ?? 0 }
        : undefined,
    };
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const model = await this.model(req);
    let yielded = false;
    try {
      for await (const chunk of this.streamOnce(req, model)) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (error) {
      // `streamSse` throws an HttpError whose body carries the provider's message;
      // testing only `error.message` missed "temperature is deprecated".
      const message = describeFetchError(error);
      // Retrying after text has been emitted would duplicate it, so the fallback
      // is only available before the first token.
      if (yielded || !this.rejectsTemperature(message) || this.withoutTemperature.has(model)) throw error;
      log.warn('this model rejects temperature; retrying the stream without it', { provider: this.id, model });
      this.withoutTemperature.add(model);
    }
    yield* this.streamOnce(req, model);
  }

  private async *streamOnce(req: LlmRequest, model: string): AsyncGenerator<LlmStreamChunk, void, unknown> {
    let usage: { prompt: number; completion: number } | undefined;
    for await (const payload of streamSse(`${this.baseUrl}/messages`, this.body(req, model, true), {
      headers: this.headers(),
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    })) {
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(payload) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      if (event.type === 'error' && event.error?.message) throw new Error(`Anthropic error: ${event.error.message}`);
      if (event.type === 'content_block_delta' && event.delta?.text) yield { delta: event.delta.text };
      if (event.type === 'message_start' && event.message?.usage) {
        usage = { prompt: event.message.usage.input_tokens ?? 0, completion: 0 };
      }
      if (event.type === 'message_delta' && event.usage) {
        usage = { prompt: usage?.prompt ?? 0, completion: event.usage.output_tokens ?? 0 };
      }
    }
    yield { delta: '', done: true, usage };
  }
}

import type { LlmProvider, LlmRequest, LlmResult, LlmStreamChunk, ProviderStatus } from '../types.js';
import { describeFetchError, getJson, postJson, streamNdjson } from './http.js';
import { log } from '../logger.js';

interface OllamaTags {
  models?: { name: string; model?: string; size?: number; details?: { parameter_size?: string; family?: string }; capabilities?: string[] }[];
}

interface OllamaChatResponse {
  model?: string;
  message?: { role: string; content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const MODEL_PREFERENCES: { re: RegExp; score: number }[] = [
  { re: /qwen3(\.\d+)?[:\-]?.*(235b|72b|32b|30b|14b|8b)/i, score: 130 },
  { re: /qwen3/i, score: 120 },
  { re: /deepseek-r1|deepseek-v3|deepseek-coder-v2/i, score: 110 },
  { re: /gpt-oss/i, score: 105 },
  { re: /llama3\.[3-9]|llama4/i, score: 100 },
  { re: /qwen2\.5/i, score: 95 },
  { re: /llama3\.[12]/i, score: 85 },
  { re: /mistral-large|mixtral/i, score: 80 },
  { re: /gemma3|gemma2/i, score: 60 },
  { re: /phi[3-9]/i, score: 50 },
  { re: /codellama|codegemma|starcoder/i, score: 30 },
  { re: /llava|vision/i, score: 10 },
];

function parameterScore(name: string): number {
  const match = name.match(/(\d+(?:\.\d+)?)\s*b\b/i);
  if (!match) return 0;
  const size = Number.parseFloat(match[1]);
  return Math.min(size, 120) / 10;
}

/** Choose the model most likely to produce good architecture explainers. */
export function pickBestOllamaModel(models: string[]): string | null {
  // An embedding-only Ollama cannot answer questions, so report "no model"
  // rather than silently selecting something that will produce nothing useful.
  const usable = models.filter((m) => !/embed|nomic|mxbai|all-minilm|bge/i.test(m));
  if (usable.length === 0) return null;
  let best: { name: string; score: number } | null = null;
  for (const name of usable) {
    let score = parameterScore(name);
    for (const pref of MODEL_PREFERENCES) if (pref.re.test(name)) score = Math.max(score, pref.score);
    if (/latest|instruct|chat/i.test(name)) score += 2;
    if (!best || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama (on-device)';
  readonly local = true;

  constructor(
    private readonly baseUrl: string,
    private readonly configuredModel: string | null,
    private readonly timeoutMs: number,
    private readonly numCtx: number = 65536,
  ) {}

  private get base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  async status(): Promise<ProviderStatus> {
    try {
      const res = await getJson<OllamaTags>(`${this.base}/api/tags`, { timeoutMs: 3000 });
      if (!res.ok) {
        return { id: this.id, label: this.label, available: false, detail: `Ollama responded with HTTP ${res.status}`, models: [], local: true };
      }
      const models = (res.data?.models ?? []).map((m) => m.name).sort((a, b) => a.localeCompare(b));
      if (models.length === 0) {
        return {
          id: this.id,
          label: this.label,
          available: false,
          detail: 'Ollama is running but has no models. Try `ollama pull qwen3`.',
          models: [],
          local: true,
        };
      }
      const defaultModel = this.configuredModel && models.includes(this.configuredModel) ? this.configuredModel : pickBestOllamaModel(models);
      return {
        id: this.id,
        label: this.label,
        available: true,
        detail: `${models.length} local model${models.length === 1 ? '' : 's'} · nothing leaves this machine`,
        models,
        defaultModel: defaultModel ?? undefined,
        local: true,
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        detail: `Ollama not reachable at ${this.base} — ${describeFetchError(error)}`,
        models: [],
        local: true,
      };
    }
  }

  private body(req: LlmRequest, stream: boolean, model: string): Record<string, unknown> {
    const options: Record<string, unknown> = { num_ctx: this.numCtx };
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
    if (req.json) options.top_p = 0.2;
    return {
      model,
      messages: req.messages,
      stream,
      ...(req.json ? { format: 'json' } : {}),
      // Always off. Reasoning models (qwen3 and friends) put their chain of
      // thought in `message.thinking` and leave `message.content` empty while
      // they do it, which streams literally nothing to the reader.
      think: false,
      options,
    };
  }

  private async model(req: LlmRequest): Promise<string> {
    if (req.model) return req.model;
    if (this.configuredModel) return this.configuredModel;
    const status = await this.status();
    if (!status.defaultModel) throw new Error('No Ollama model available. Run `ollama pull qwen3`.');
    return status.defaultModel;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const model = await this.model(req);
    const res = await postJson<OllamaChatResponse>(`${this.base}/api/chat`, this.body(req, false, model), {
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    });
    if (!res.ok || res.data?.error) {
      throw new Error(`Ollama error: ${res.data?.error ?? `HTTP ${res.status} ${res.text.slice(0, 300)}`}`);
    }
    const content = res.data?.message?.content ?? '';
    const thinking = res.data?.message?.thinking ?? '';
    if (!content.trim() && thinking.trim()) {
      log.debug('Ollama returned only reasoning and no answer; using the reasoning text as a fallback');
    }
    if (res.data?.done_reason === 'length') {
      log.debug(
        `Ollama stopped at the token limit (num_predict=${req.maxTokens ?? 'default'}); raise REPO_EXPLORER_OLLAMA_NUM_CTX or lower the request size`,
      );
    }
    return {
      text: content.trim() ? content : thinking,
      model: res.data?.model ?? model,
      provider: this.id,
      usage:
        res.data?.prompt_eval_count !== undefined || res.data?.eval_count !== undefined
          ? { prompt: res.data?.prompt_eval_count ?? 0, completion: res.data?.eval_count ?? 0 }
          : undefined,
    };
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const model = await this.model(req);
    let thinkingChars = 0;
    let emitted = 0;
    for await (const chunk of streamNdjson<OllamaChatResponse>(`${this.base}/api/chat`, this.body(req, true, model), {
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    })) {
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
      const delta = chunk.message?.content ?? '';
      if (delta) {
        emitted += delta.length;
        yield { delta };
      } else if (chunk.message?.thinking) {
        // Counted, never shown: the reader wants the answer, not the monologue.
        thinkingChars += chunk.message.thinking.length;
      }
      if (chunk.done) {
        if (emitted === 0 && thinkingChars > 0) {
          throw new Error(
            `The model produced ${thinkingChars} characters of reasoning but no answer. Disable "thinking" in the model, or pick a different model.`,
          );
        }
        yield {
          delta: '',
          done: true,
          usage:
            chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined
              ? { prompt: chunk.prompt_eval_count ?? 0, completion: chunk.eval_count ?? 0 }
              : undefined,
        };
        return;
      }
    }
    if (emitted === 0 && thinkingChars > 0) {
      throw new Error('The model produced only reasoning and no answer.');
    }
    yield { delta: '', done: true };
  }
}

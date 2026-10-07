import type { LlmProvider, LlmRequest, LlmResult, LlmStreamChunk, ProviderStatus } from '../types.js';

export type MockResponder = (req: LlmRequest) => string;

/**
 * Deterministic provider used by tests and as the last-resort fallback.
 * It never makes a network call and never depends on a model being present.
 */
export class MockProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  readonly local = true;
  private callCount = 0;

  constructor(
    private readonly responder?: MockResponder,
    options: { id?: string; label?: string } = {},
  ) {
    this.id = options.id ?? 'mock';
    this.label = options.label ?? 'Offline (built-in)';
  }

  get calls(): number {
    return this.callCount;
  }

  async status(): Promise<ProviderStatus> {
    return {
      id: this.id,
      label: this.label,
      available: true,
      detail: 'No model required — produces deterministic text for tests and offline demos.',
      models: ['mock-1'],
      defaultModel: 'mock-1',
      local: true,
    };
  }

  private respond(req: LlmRequest): string {
    this.callCount += 1;
    if (this.responder) return this.responder(req);
    if (req.json) return '{}';
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    return `[offline] No language model is configured, so this is a placeholder answer.\n\nQuestion received: ${lastUser.slice(0, 300)}`;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    const text = this.respond(req);
    return { text, model: 'mock-1', provider: this.id, usage: { prompt: Math.ceil(JSON.stringify(req.messages).length / 4), completion: Math.ceil(text.length / 4) } };
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const text = this.respond(req);
    const parts = text.match(/[\s\S]{1,24}/g) ?? [];
    for (const part of parts) yield { delta: part };
    yield { delta: '', done: true, usage: { prompt: 0, completion: Math.ceil(text.length / 4) } };
  }
}

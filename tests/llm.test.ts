import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider, pickBestOllamaModel } from '../src/core/llm/ollama.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Server-Sent Events, as used by OpenAI-compatible endpoints. */
function ndjsonSse(chunks: unknown[]): Response {
  const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function ndjsonResponse(lines: unknown[]): Response {
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

describe('Ollama provider', () => {
  it('always disables model reasoning', async () => {
    // Regression: qwen3-class models stream their chain of thought in
    // `message.thinking` and leave `message.content` empty, so chat looked like
    // a hang and answers came back blank.
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ model: 'm', message: { content: 'a real answer', thinking: 'internal monologue' }, done: true });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider('http://localhost:11434', 'm', 5_000, 4_096);
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(captured.body?.think).toBe(false);
    expect(result.text).toBe('a real answer');
  });

  it('sends a context window and an output ceiling', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse({ model: 'm', message: { content: 'ok' }, done: true });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider('http://localhost:11434', 'm', 5_000, 32_768);
    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, temperature: 0.2 });

    expect(captured.body?.think).toBe(false);
    const options = captured.body?.options as Record<string, unknown>;
    expect(options.num_ctx).toBe(32_768);
    expect(options.num_predict).toBe(500);
    expect(options.temperature).toBe(0.2);
  });

  it('falls back to the reasoning text when no answer is produced', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ model: 'm', message: { content: '', thinking: 'only reasoning here' }, done: true })) as unknown as typeof fetch;

    const provider = new OllamaProvider('http://localhost:11434', 'm', 5_000, 4_096);
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('only reasoning here');
  });

  it('errors clearly instead of streaming nothing when the model only reasons', async () => {
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { model: 'm', message: { content: '', thinking: 'thinking…' }, done: false },
        { model: 'm', message: { content: '', thinking: 'still thinking…' }, done: false },
        { model: 'm', message: { content: '' }, done: true },
      ])) as unknown as typeof fetch;

    const provider = new OllamaProvider('http://localhost:11434', 'm', 5_000, 4_096);
    const consume = async () => {
      for await (const _chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        /* drain */
      }
    };
    await expect(consume()).rejects.toThrow(/reasoning but no answer/);
  });

  it('streams content deltas to the caller', async () => {
    globalThis.fetch = (async () =>
      ndjsonResponse([
        { model: 'm', message: { content: 'Hel' }, done: false },
        { model: 'm', message: { content: 'lo' }, done: false },
        { model: 'm', message: { content: '' }, done: true, prompt_eval_count: 10, eval_count: 2 },
      ])) as unknown as typeof fetch;

    const provider = new OllamaProvider('http://localhost:11434', 'm', 5_000, 4_096);
    let text = '';
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      text += chunk.delta;
    }
    expect(text).toBe('Hello');
  });

  it('reports credential provenance even when authentication fails', async () => {
    // This is the case where the reader most needs to know a key was sent, and
    // where the upstream error body could otherwise echo the key back.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-livekey-abcdefghijklmnop' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const { OpenAiProvider } = await import('../src/core/llm/openai.js');
    const { redact, registerSecret } = await import('../src/core/util/redact.js');
    registerSecret('sk-livekey-abcdefghijklmnop');

    const provider = new OpenAiProvider('https://api.example.com/v1', 'sk-livekey-abcdefghijklmnop', null, 5_000, {
      credentialSource: 'dotenv',
    });
    const status = await provider.status();
    expect(status.available).toBe(false);
    expect(status.credential).toEqual({ present: true, source: 'dotenv' });
    expect(redact(status.detail)).not.toContain('sk-livekey-abcdefghijklmnop');
  });

  it('handles reasoning models that leave content empty, like DeepSeek', async () => {
    // DeepSeek's deepseek-reasoner streams the chain of thought in
    // `reasoning_content` and sends `content` only afterwards. Reading just
    // `content` made the UI look like it had hung.
    const { OpenAiProvider } = await import('../src/core/llm/openai.js');

    globalThis.fetch = (async () =>
      ndjsonSse([
        { choices: [{ delta: { reasoning_content: 'Let me think about this…' } }] },
        { choices: [{ delta: { reasoning_content: 'still thinking' } }] },
        { choices: [{ delta: { content: 'The answer.' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])) as unknown as typeof fetch;

    const provider = new OpenAiProvider('https://api.deepseek.com/v1', 'sk-key-1234567890', 'deepseek-chat', 5_000);
    let text = '';
    for await (const chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      text += chunk.delta;
    }
    // Only the answer is surfaced; the monologue is counted and discarded.
    expect(text).toBe('The answer.');
  });

  it('errors clearly when a reasoning model never produces an answer', async () => {
    const { OpenAiProvider } = await import('../src/core/llm/openai.js');
    globalThis.fetch = (async () =>
      ndjsonSse([
        { choices: [{ delta: { reasoning_content: 'thinking very hard' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ])) as unknown as typeof fetch;

    const provider = new OpenAiProvider('https://api.deepseek.com/v1', 'sk-key-1234567890', 'deepseek-reasoner', 5_000);
    const consume = async () => {
      for await (const _chunk of provider.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        /* drain */
      }
    };
    await expect(consume()).rejects.toThrow(/reasoning but no answer/);
  });

  it('falls back to reasoning text when a non-streaming reply has no content', async () => {
    const { OpenAiProvider } = await import('../src/core/llm/openai.js');
    globalThis.fetch = (async () =>
      jsonResponse({ model: 'deepseek-reasoner', choices: [{ message: { content: '', reasoning_content: 'the reasoning' } }] })) as unknown as typeof fetch;

    const provider = new OpenAiProvider('https://api.deepseek.com/v1', 'sk-key-1234567890', 'deepseek-reasoner', 5_000);
    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.text).toBe('the reasoning');
  });

  it('stays usable when the endpoint does not implement /models', async () => {
    // Several gateways and self-hosted servers do not expose model listing. With
    // a key and an explicit model that is not a reason to refuse to run.
    const { OpenAiProvider } = await import('../src/core/llm/openai.js');
    globalThis.fetch = (async () =>
      new Response('{"error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

    const withModel = new OpenAiProvider('https://api.deepseek.com/v1', 'sk-key-1234567890', 'deepseek-chat', 5_000);
    const status = await withModel.status();
    expect(status.available).toBe(true);
    expect(status.defaultModel).toBe('deepseek-chat');
    expect(status.detail).toContain('used directly');

    // Without a model there is nothing to fall back to.
    const withoutModel = new OpenAiProvider('https://api.deepseek.com/v1', 'sk-key-1234567890', null, 5_000);
    expect((await withoutModel.status()).available).toBe(false);
  });

  it('picks the strongest available model and ignores embedding models', () => {
    expect(pickBestOllamaModel(['nomic-embed-text:latest', 'llama3.2:3b', 'qwen3.6:latest'])).toBe('qwen3.6:latest');
    expect(pickBestOllamaModel(['all-minilm:latest'])).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/core/llm/anthropic.js';
import { OpenAiProvider } from '../src/core/llm/openai.js';
import type { LlmRequest } from '../src/core/types.js';

/**
 * Newer models removed `temperature`.
 *
 * Claude's current models answer "temperature is deprecated for this model", and
 * OpenAI's reasoning models reject it too. The app sends a lower temperature
 * where it is supported — the prompts are written for it — but a model that no
 * longer accepts the parameter must not cost the reader an explanation.
 *
 * The fallback is learned rather than listed: a hardcoded set of model names
 * would be wrong within months, and wrong silently.
 */

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const calls: Captured[] = [];

function stubFetch(responder: (call: Captured, index: number) => Response): void {
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
    const call = { url: String(url), body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} };
    calls.push(call);
    return responder(call, calls.length - 1);
  });
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
    headers: new Map(),
  } as unknown as Response;
}

const TEMPERATURE_ERROR = 'temperature is deprecated for this model. Use the default temperature instead.';

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  messages: [{ role: 'user', content: 'explain this' }],
  temperature: 0.25,
  maxTokens: 100,
  ...overrides,
});

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

describe('anthropic', () => {
  const provider = () => new AnthropicProvider('sk-ant-test', 'claude-future', 5000);

  it('retries without temperature, then stops sending it for that model', async () => {
    stubFetch((call) =>
      call.url.includes('/messages') && calls.length === 1
        ? json({ error: { message: TEMPERATURE_ERROR } }, 400)
        : json({ model: 'claude-future', content: [{ text: 'the answer' }], usage: { input_tokens: 5, output_tokens: 7 } }),
    );

    const first = await provider().complete(request());
    expect(first.text).toBe('the answer');
    expect(calls).toHaveLength(2);
    // It tried with the parameter, then without it.
    expect(calls[0].body).toHaveProperty('temperature', 0.25);
    expect(calls[1].body).not.toHaveProperty('temperature');
  });

  it('remembers the model, so the next call does not pay the round trip', async () => {
    stubFetch(() => json({ model: 'claude-future', content: [{ text: 'ok' }] }));
    const instance = provider();
    // Teach it once.
    stubFetch((call) => (calls.length === 1 ? json({ error: { message: TEMPERATURE_ERROR } }, 400) : json({ content: [{ text: 'ok' }] })));
    await instance.complete(request());
    const afterLearning = calls.length;
    expect(afterLearning).toBe(2);

    // Second call: no temperature in the first request at all.
    await instance.complete(request());
    expect(calls[afterLearning].body).not.toHaveProperty('temperature');
  });

  it('does not retry an error that has nothing to do with temperature', async () => {
    stubFetch(() => json({ error: { message: 'max_tokens: too large for this model' } }, 400));
    await expect(provider().complete(request())).rejects.toThrow(/max_tokens/);
    expect(calls).toHaveLength(1);
  });

  it('still sends temperature when the model accepts it', async () => {
    stubFetch(() => json({ content: [{ text: 'ok' }] }));
    await provider().complete(request());
    expect(calls[0].body).toHaveProperty('temperature', 0.25);
  });

  it('omits temperature entirely when the caller did not set one', async () => {
    stubFetch(() => json({ content: [{ text: 'ok' }] }));
    await provider().complete(request({ temperature: undefined }));
    expect(calls[0].body).not.toHaveProperty('temperature');
  });
});

describe('openai-compatible', () => {
  // OpenAI's reasoning models say "Unsupported parameter: 'temperature' is not
  // supported with this model."
  const provider = () => new OpenAiProvider('https://api.example.com/v1', 'sk-test', 'o-reasoner', 5000);

  it('retries without temperature for a model that rejects it', async () => {
    stubFetch((call) =>
      calls.length === 1
        ? json({ error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } }, 400)
        : json({ model: 'o-reasoner', choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    );
    const result = await provider().complete(request());
    expect(result.text).toBe('the answer');
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toHaveProperty('temperature');
    expect(calls[1].body).not.toHaveProperty('temperature');
  });

  it('remembers the model across calls', async () => {
    const instance = provider();
    stubFetch(() => (calls.length === 1 ? json({ error: { message: "temperature is unsupported" } }, 400) : json({ choices: [{ message: { content: 'ok' } }] })));
    await instance.complete(request());
    await instance.complete(request());
    expect(calls[2].body).not.toHaveProperty('temperature');
  });

  it('leaves other errors alone', async () => {
    stubFetch(() => json({ error: { message: 'invalid api key' } }, 401));
    await expect(provider().complete(request())).rejects.toThrow(/invalid api key/);
    expect(calls).toHaveLength(1);
  });
});

describe('streaming', () => {
  /** A response whose body yields one SSE event and closes. */
  function sse(events: string[]): Response {
    const encoder = new TextEncoder();
    // A real ReadableStream: the SSE reader pulls through `getReader()`.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/event-stream']]),
      text: async () => events.join(''),
      body,
    } as unknown as Response;
  }

  it('retries the stream without temperature when nothing has been emitted yet', async () => {
    stubFetch((call) =>
      calls.length === 1
        ? ({ ok: false, status: 400, text: async () => TEMPERATURE_ERROR, body: null, headers: new Map() } as unknown as Response)
        : sse(['data: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n']),
    );

    const provider = new AnthropicProvider('sk-ant-test', 'claude-future', 5000);
    const chunks: string[] = [];
    for await (const chunk of provider.stream(request())) if (chunk.delta) chunks.push(chunk.delta);
    expect(chunks.join('')).toBe('hello');
    expect(calls[1].body).not.toHaveProperty('temperature');
  });

  it('does not retry once text has been emitted, which would duplicate it', async () => {
    stubFetch(() =>
      sse(['data: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n', 'data: {"type":"error","error":{"message":"temperature is deprecated"}}\n\n']),
    );
    const provider = new AnthropicProvider('sk-ant-test', 'claude-future', 5000);
    const seen: string[] = [];
    await expect(async () => {
      for await (const chunk of provider.stream(request())) if (chunk.delta) seen.push(chunk.delta);
    }).rejects.toThrow(/temperature/);
    expect(seen.join('')).toBe('partial');
    // One request only: re-sending would repeat "partial" to the reader.
    expect(calls).toHaveLength(1);
  });
});

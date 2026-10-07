/**
 * Minimal HTTP helpers for talking to LLM APIs.
 *
 * Node's global fetch gives us streaming bodies; these helpers add
 * timeout handling, request abortion, and line/SSE framing.
 */

export interface HttpOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function withTimeout(options: HttpOptions): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(new Error(`Request timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
    : null;
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    },
  };
}

export interface JsonResponse<T> {
  status: number;
  ok: boolean;
  data: T;
  text: string;
}

export async function postJson<T = unknown>(url: string, body: unknown, options: HttpOptions = {}): Promise<JsonResponse<T>> {
  const { signal, cleanup } = withTimeout(options);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let data: T = undefined as unknown as T;
    try {
      data = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch {
      /* leave data undefined; callers inspect `text` on failure */
    }
    return { status: response.status, ok: response.ok, data, text };
  } finally {
    cleanup();
  }
}

export async function getJson<T = unknown>(
  url: string,
  options: HttpOptions = {},
): Promise<JsonResponse<T>> {
  const { signal, cleanup } = withTimeout(options);
  try {
    const response = await fetch(url, { headers: options.headers, signal });
    const text = await response.text();
    let data: T = undefined as unknown as T;
    try {
      data = text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } catch {
      /* ignore */
    }
    return { status: response.status, ok: response.ok, data, text };
  } finally {
    cleanup();
  }
}

/** Split a web ReadableStream into decoded text chunks. */
async function* readText(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stream a newline-delimited JSON response (Ollama's native protocol).
 */
export async function* streamNdjson<T = unknown>(url: string, body: unknown, options: HttpOptions = {}): AsyncGenerator<T, void, unknown> {
  const { signal, cleanup } = withTimeout(options);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new HttpError(`HTTP ${response.status} from ${redact(url)}`, response.status, text);
    }
    let buffer = '';
    for await (const chunk of readText(response.body)) {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            yield JSON.parse(line) as T;
          } catch {
            /* skip malformed keep-alive lines */
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail) as T;
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanup();
  }
}

/**
 * Stream Server-Sent Events and yield the `data:` payloads.
 * Yields `[DONE]` as a literal payload; callers decide what to do with it.
 */
export async function* streamSse(url: string, body: unknown, options: HttpOptions = {}): AsyncGenerator<string, void, unknown> {
  const { signal, cleanup } = withTimeout(options);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(options.headers ?? {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new HttpError(`HTTP ${response.status} from ${redact(url)}`, response.status, text);
    }
    let buffer = '';
    for await (const chunk of readText(response.body)) {
      buffer += chunk.replace(/\r\n/g, '\n');
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length > 0) yield dataLines.join('\n');
        separator = buffer.indexOf('\n\n');
      }
    }
    const remaining = buffer.trim();
    if (remaining) {
      const dataLines = remaining
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length > 0) yield dataLines.join('\n');
    }
  } finally {
    cleanup();
  }
}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function describeFetchError(error: unknown): string {
  if (error instanceof HttpError) {
    const summary = error.body.slice(0, 400);
    return `${error.message}${summary ? ` — ${summary}` : ''}`;
  }
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
    return error.message;
  }
  return String(error);
}

// touched elsewhere

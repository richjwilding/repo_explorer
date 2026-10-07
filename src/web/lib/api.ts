/** Thin fetch wrapper plus an SSE-over-POST reader. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handle<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export const api = {
  get: async <T>(url: string): Promise<T> => handle<T>(await fetch(url)),
  post: async <T>(url: string, body?: unknown): Promise<T> =>
    handle<T>(
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    ),
  del: async <T>(url: string): Promise<T> => handle<T>(await fetch(url, { method: 'DELETE' })),
};

export type StreamEvent = Record<string, unknown> & { type: string };

export interface StreamHandle {
  cancel(): void;
}

/**
 * POST a JSON body and read a Server-Sent Events stream back.
 * Returns immediately; events arrive via the callback.
 */
export function streamPost(url: string, body: unknown, onEvent: (event: StreamEvent) => void): StreamHandle {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const run = async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let message = `HTTP ${response.status}`;
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? message;
        } catch {
          /* keep the default */
        }
        onEvent({ type: 'error', message });
        return;
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              onEvent(JSON.parse(payload) as StreamEvent);
            } catch {
              /* ignore malformed frames */
            }
          }
          separator = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError') {
        onEvent({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  void run();

  return {
    cancel: () => {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    },
  };
}

export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

import type { FastifyReply } from 'fastify';
import { redact } from '../core/util/redact.js';

export type SseEvent = Record<string, unknown>;

export interface SseEmitter {
  send(event: SseEvent): void;
  close(): void;
  readonly closed: boolean;
}

/**
 * Server-Sent Events over a hijacked Fastify reply.
 *
 * We use SSE rather than WebSockets because every stream in this app is
 * one-directional (progress, tokens, final payload) and SSE survives proxies.
 */
export async function withSse(reply: FastifyReply, handler: (emit: SseEmitter) => Promise<void>): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.write(': connected\n\n');

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) raw.write(': ping\n\n');
  }, 15_000);

  const emit: SseEmitter = {
    get closed() {
      return closed;
    },
    send(event) {
      if (closed) return;
      try {
        raw.write(`data: ${redact(JSON.stringify(event))}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        raw.end();
      } catch {
        /* the client may have gone away */
      }
    },
  };

  const onClose = () => {
    closed = true;
    clearInterval(heartbeat);
  };
  raw.on('close', onClose);

  try {
    await handler(emit);
  } catch (error) {
    emit.send({ type: 'error', message: redact(error instanceof Error ? error.message : String(error)) });
  } finally {
    clearInterval(heartbeat);
    raw.off('close', onClose);
    emit.close();
  }
}

/**
 * Redaction of credentials from anything a human or a browser will see.
 *
 * Secrets leak through the least obvious places: an upstream 401 body that
 * quotes the key you just sent, a provider's status string, a stack trace in a
 * log line. Everything user-visible goes through `redact` first.
 */

const known = new Set<string>();

/** Patterns for credentials that are recognisable by shape. */
const PATTERNS: { re: RegExp; replace: string | ((match: string) => string) }[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: '[redacted]' },
  { re: /\bsk-proj-[A-Za-z0-9_-]{8,}/g, replace: '[redacted]' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: '[redacted]' },
  { re: /\b(AIza|hf_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{16,}/g, replace: '[redacted]' },
  { re: /\b[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, replace: 'Bearer [redacted]' },
  { re: /\b(?:x-api-key|X-Api-Key|api[_-]?key)["'\s:=]+["']?[A-Za-z0-9._-]{8,}/gi, replace: (match) => `${match.split(/["'\s:=]/)[0]}: [redacted]` },
];

/** Remember a literal secret so it can be scrubbed even if it has no telltale shape. */
export function registerSecret(value: string | null | undefined): void {
  if (!value) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  known.add(trimmed);
}

export function forgetSecret(value: string | null | undefined): void {
  if (!value) return;
  known.delete(value.trim());
}

export function redact(text: string): string {
  if (!text) return text;
  let output = text;
  // Exact values first: this is the reliable case, and it catches keys that look
  // like ordinary text.
  for (const secret of known) {
    if (secret && output.includes(secret)) output = output.split(secret).join('[redacted]');
  }
  for (const { re, replace } of PATTERNS) {
    output = output.replace(re, replace as string);
  }
  return output;
}

/** Redact every string in a value, one level deep (enough for our API shapes). */
export function redactObject<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = typeof item === 'string' ? redact(item) : redactObject(item);
    }
    return output as T;
  }
  return value;
}

/** Test helper: no secrets are registered after this runs. */
export function clearRegisteredSecrets(): void {
  known.clear();
}

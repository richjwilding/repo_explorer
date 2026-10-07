/**
 * Robust JSON extraction for LLM output.
 *
 * Models wrap JSON in prose, markdown fences, or emit trailing commas and
 * smart quotes. We try hard to recover a parseable object before giving up.
 */

export function stripFences(text: string): string {
  const fence = text.match(/```(?:json|JSON)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return text;
}

/** Find the first balanced JSON value (object or array) in a string. */
export function findJsonSlice(text: string): string | null {
  const start = (() => {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{' || ch === '[') return i;
      if (!/\s/.test(ch) && ch !== '`') {
        // Allow leading prose only when we can still find a brace later.
        continue;
      }
    }
    return -1;
  })();
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unbalanced: return whatever we have so repairs can attempt a fix.
  return text.slice(start);
}

/**
 * Escape raw control characters that appear *inside* string literals.
 *
 * This is the single most common way a long LLM answer fails to parse: markdown
 * fields contain real newlines, and JSON forbids them. The model means `\n`; it
 * typed an actual line break. Without this, a perfectly good explainer is
 * discarded and the reader gets the static outline instead.
 */
export function escapeControlCharsInStrings(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of input) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }

  return out;
}

function repair(input: string): string {
  let out = input;
  // Normalise smart quotes that models sometimes emit.
  out = out.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // Remove trailing commas before } or ].
  out = out.replace(/,\s*([}\]])/g, '$1');
  // Remove JS-style comments.
  out = out.replace(/(^|[^:"'])\/\/[^\n]*$/gm, '$1');
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  return out;
}

/**
 * Close any unterminated structure so a truncated response still parses.
 * Delimiters must be closed in reverse order of opening, so we track a stack
 * rather than counting braces — `[{` needs `}]`, not `]}`.
 */
function closeUnbalanced(input: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of input) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = input;
  if (inString) {
    // A dangling backslash would escape the quote we are about to add, leaving
    // the string open and the repair invalid. Complete the escape first.
    if (escaped) out += '\\';
    out += '"';
  }
  out = out.replace(/,\s*$/, '');
  while (stack.length > 0) {
    out += stack.pop() === '{' ? '}' : ']';
  }
  return out;
}

export function extractJson(text: string): unknown | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fenced = stripFences(text);
  candidates.push(text, fenced);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    for (const attempt of [trimmed, findJsonSlice(trimmed)]) {
      if (!attempt) continue;
      for (const variant of [
        attempt,
        repair(attempt),
        closeUnbalanced(repair(attempt)),
        closeUnbalanced(escapeControlCharsInStrings(repair(attempt))),
        escapeControlCharsInStrings(repair(attempt)),
      ]) {
        try {
          return JSON.parse(variant);
        } catch {
          /* try the next repair */
        }
      }
    }
  }
  return null;
}

export function parseJsonLoose<T>(text: string): T | null {
  const value = extractJson(text);
  if (value === null || typeof value !== 'object') return null;
  return value as T;
}

/**
 * Pull a JSON field out of a partially-streamed response so the UI can render
 * progressive explainers before the model has finished.
 */
export function peekJsonStringField(text: string, field: string): string | null {
  // Deliberately tolerant of an unterminated string: this runs mid-stream.
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\\n])*)`);
  const match = text.match(re);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

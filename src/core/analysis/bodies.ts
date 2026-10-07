import type { LanguageFamily } from './languages.js';

/**
 * Body-extent detection shared by symbol extraction and call-graph building.
 *
 * This is deliberately heuristic rather than a real parse: brace matching for
 * C-like languages, indentation for Python, `end` matching for Ruby, with a
 * bounded fallback. It only has to be good enough to attribute calls and
 * ownership to the right definition.
 */

const C_LIKE: LanguageFamily[] = ['js', 'go', 'rust', 'jvm', 'dotnet', 'c', 'swift', 'php'];

export function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

export function findBodyEnd(lines: string[], startIndex: number, family: LanguageFamily): number {
  const maxLines = Math.min(lines.length, startIndex + 4000);
  if (family === 'python') return endByIndent(lines, startIndex, maxLines);
  if (family === 'ruby') return endByRuby(lines, startIndex, maxLines);
  if (C_LIKE.includes(family)) return endByBraces(lines, startIndex, maxLines);
  return endByIndent(lines, startIndex, maxLines);
}

function endByBraces(lines: string[], startIndex: number, maxLines: number): number {
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  /**
   * Braces seen inside parentheses belong to a parameter list, not to the body.
   *
   * A destructured parameter — `function SectionRenderer({ section, onOpenFile }) {`
   * — used to open the body at its `{` and close it at its `}`, both on the
   * declaration line. Every symbol taking an object parameter therefore had a
   * body one line long, so nothing inside it was scanned: no calls, no JSX, no
   * reachability. In a codebase of modern TypeScript that is most of the code.
   */
  let parenDepth = 0;

  for (let i = startIndex; i < maxLines; i += 1) {
    const line = lines[i];
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inLineComment = false;

    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      const next = line[c + 1];
      if (inLineComment) break;
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          c += 1;
        }
        continue;
      }
      if (inSingle) {
        if (ch === '\\') c += 1;
        else if (ch === "'") inSingle = false;
        continue;
      }
      if (inDouble) {
        if (ch === '\\') c += 1;
        else if (ch === '"') inDouble = false;
        continue;
      }
      if (inTemplate) {
        if (ch === '\\') c += 1;
        else if (ch === '`') inTemplate = false;
        continue;
      }
      if (ch === '/' && next === '/') {
        inLineComment = true;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        c += 1;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        continue;
      }
      if (ch === '`') {
        inTemplate = true;
        continue;
      }
      if (ch === '(') {
        parenDepth += 1;
      } else if (ch === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      } else if (ch === '{') {
        if (parenDepth > 0) continue;
        depth += 1;
        opened = true;
      } else if (ch === '}') {
        if (parenDepth > 0) continue;
        depth -= 1;
        if (opened && depth === 0) {
          // A return-type annotation written inline — `function f(x): { a: string } {`
          // — opens and closes before the body does, so the body would end on the
          // declaration line. If the construct continues, that brace was a type.
          const after = nextSignificantChar(lines, i, c + 1, maxLines);
          // `{ a } | null`, `Promise<{ a }>`, `{ a }[]`, `{ a } = default`.
          const continues = after !== null && ['{', '[', '=', '|', '&', '>'].includes(after.ch);
          if (continues) {
            opened = false;
            continue;
          }
          return i;
        }
      }
    }
    // A signature that opens no brace and ends in ';' is a declaration.
    if (!opened && /;\s*$/.test(line.trim()) && i > startIndex) return i;
    if (!opened && i > startIndex + 6) return i;
  }
  return Math.min(lines.length, startIndex + 80) - 1;
}

/**
 * The next non-whitespace character from a position, across lines, ignoring
 * comments. Used to tell a type annotation that has just closed from the body
 * that is about to open.
 */
function nextSignificantChar(
  lines: string[],
  fromLine: number,
  fromCol: number,
  maxLines: number,
): { ch: string; next: string } | null {
  for (let i = fromLine; i < maxLines; i += 1) {
    const line = lines[i];
    for (let c = i === fromLine ? fromCol : 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === ' ' || ch === '\t' || ch === '\r') continue;
      if (ch === '/' && line[c + 1] === '/') break;
      if (ch === '/' && line[c + 1] === '*') {
        const closes = line.indexOf('*/', c + 2);
        if (closes !== -1) {
          c = closes + 1;
          continue;
        }
        // Block comment running onto later lines: skip until it closes.
        let closed = false;
        for (let j = i + 1; j < maxLines && !closed; j += 1) {
          const end = lines[j].indexOf('*/');
          if (end !== -1) {
            i = j;
            c = end + 1;
            closed = true;
          }
        }
        if (!closed) return null;
        continue;
      }
      return { ch, next: line[c + 1] ?? '' };
    }
  }
  return null;
}

function endByIndent(lines: string[], startIndex: number, maxLines: number): number {
  const baseIndent = indentWidth(lines[startIndex]);
  let lastContent = startIndex;
  for (let i = startIndex + 1; i < maxLines; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (indentWidth(line) <= baseIndent) return lastContent;
    lastContent = i;
  }
  return lastContent;
}

function endByRuby(lines: string[], startIndex: number, maxLines: number): number {
  let depth = 0;
  const openers = /^(def|class|module|do|if|unless|case|begin|while|until|for)\b|\bdo\s*(\|[^|]*\|)?\s*$/;
  for (let i = startIndex; i < maxLines; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (openers.test(trimmed) && !/\bend\b/.test(trimmed)) depth += 1;
    if (trimmed === 'end' || /\bend\s*$/.test(trimmed)) {
      depth -= 1;
      if (depth <= 0) return i;
    }
  }
  return Math.min(lines.length, startIndex + 80) - 1;
}

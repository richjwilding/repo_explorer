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
      if (ch === '{') {
        depth += 1;
        opened = true;
      } else if (ch === '}') {
        depth -= 1;
        if (opened && depth === 0) return i;
      }
    }
    // A signature that opens no brace and ends in ';' is a declaration.
    if (!opened && /;\s*$/.test(line.trim()) && i > startIndex) return i;
    if (!opened && i > startIndex + 6) return i;
  }
  return Math.min(lines.length, startIndex + 80) - 1;
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

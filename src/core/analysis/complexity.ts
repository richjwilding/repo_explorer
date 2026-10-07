/**
 * Complexity, measured rather than inferred from size.
 *
 * Line count is the cheapest available proxy for "this is hard", and it is a
 * poor one: a 400-line table of constants is easy, and a 40-line function with
 * eight nested branches is not. Two things are measured per definition, both
 * from the body text this analysis already extracts:
 *
 * - **Decision points** — the branches a reader has to hold in their head.
 * - **Control-flow nesting** — how deep those branches are stacked, weighted
 *   more heavily because depth is what makes a function hard to follow.
 *
 * Nesting counts only control-flow blocks. A deeply indented object literal is
 * not a comprehension problem, so a brace opens a level only when the code
 * before it is a control construct or a function head.
 */
import { indentWidth } from './bodies.js';
import type { LanguageFamily } from './languages.js';

export interface SymbolComplexity {
  id: string;
  path: string;
  name: string;
  kind: string;
  line: number;
  loc: number;
  /** Decision points in the body. */
  branches: number;
  /** Deepest control-flow nesting. */
  maxDepth: number;
  callers: number;
  reachable: boolean;
  /**
   * Difficulty weighted by how much depends on it. Changing a branchy function
   * that nothing calls is cheap; changing one with thirty callers is not.
   */
  score: number;
}

export interface FileComplexity {
  path: string;
  loc: number;
  symbols: number;
  branches: number;
  maxDepth: number;
  commits: number;
  score: number;
}

export interface ComplexityReport {
  /** Hardest to change safely, hardest first. */
  symbols: SymbolComplexity[];
  /** Files ranked by complexity rather than size, hardest first. */
  files: FileComplexity[];
  summary: {
    functionsAnalysed: number;
    meanBranches: number;
    meanDepth: number;
    deepest: number;
    mostBranches: number;
    /** Functions at nesting depth 4 or more. */
    deepFunctions: number;
    /** Functions with 10 or more decision points. */
    branchyFunctions: number;
  };
  warnings: string[];
}

export interface ComplexityFileInput {
  path: string;
  language: string;
  text: string;
  /** Total lines in the file, so a file's size is not re-derived from its text. */
  entryLines?: number;
  symbols: { id: string; name: string; kind: string; line: number; endLine: number; callers: number; reachable: boolean }[];
}

export interface ComplexityInput {
  files: ComplexityFileInput[];
  /** File → commits, for the "hardest to change" ranking. */
  churn?: Map<string, number>;
}

export const EMPTY_COMPLEXITY: ComplexityReport = {
  symbols: [],
  files: [],
  summary: {
    functionsAnalysed: 0,
    meanBranches: 0,
    meanDepth: 0,
    deepest: 0,
    mostBranches: 0,
    deepFunctions: 0,
    branchyFunctions: 0,
  },
  warnings: [],
};

/** Depth at which a function stops being readable at a glance. */
const DEEP_DEPTH = 4;
/** Decision points above which a function is doing more than one job. */
const BRANCHY = 10;

/**
 * Replace comments and string contents with spaces, preserving length.
 *
 * Without this, the word "if" inside a string or an example in a comment is
 * counted as a branch — which is exactly the kind of quiet wrongness that makes
 * a metric untrustworthy.
 */
export function stripNonCode(text: string, family: LanguageFamily): string {
  const hashComments = family === 'python' || family === 'ruby' || family === 'shell';
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 1;
      } else out += ch === '\n' ? ch : ' ';
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      const closer = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === closer) {
        state = 'code';
        out += ch;
        continue;
      }
      out += ch === '\n' ? ch : ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      state = 'line';
      out += '  ';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block';
      out += '  ';
      i += 1;
      continue;
    }
    if (hashComments && ch === '#') {
      state = 'line';
      out += ' ';
      continue;
    }
    if (ch === "'") {
      state = 'single';
      out += ch;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      out += ch;
      continue;
    }
    if (ch === '`') {
      state = 'template';
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

const BRANCH_PATTERNS: Record<string, RegExp> = {
  // `else if` is one decision, not two, so `else` is not counted separately.
  c: /\bif\b|\bfor\b|\bwhile\b|\bcase\b|\bcatch\b|\bdo\b|&&|\|\||\?\?|(?<![?])\?(?![?.])/g,
  python: /\bif\b|\belif\b|\bfor\b|\bwhile\b|\bexcept\b|\band\b|\bor\b|\bassert\b/g,
  ruby: /\bif\b|\belsif\b|\bunless\b|\bwhile\b|\buntil\b|\brescue\b|\bwhen\b|&&|\|\|/g,
  shell: /\bif\b|\belif\b|\bfor\b|\bwhile\b|\bcase\b|&&|\|\|/g,
};

function familyBranches(family: LanguageFamily): RegExp {
  if (family === 'python') return BRANCH_PATTERNS.python;
  if (family === 'ruby') return BRANCH_PATTERNS.ruby;
  if (family === 'shell') return BRANCH_PATTERNS.shell;
  return BRANCH_PATTERNS.c;
}

/** Count decision points in code that has already had strings and comments removed. */
export function countBranches(code: string, family: LanguageFamily): number {
  const pattern = familyBranches(family);
  let count = 0;
  // Fresh regex: a shared /g/ pattern carries lastIndex between calls.
  for (const _match of code.matchAll(new RegExp(pattern.source, pattern.flags))) count += 1;
  return count;
}

/** A brace opens a control level only when what precedes it is a control head. */
const CONTROL_HEAD_RE =
  /(?:\b(?:if|else|for|while|switch|catch|try|finally|do|case|default)\b|=>|\bfunction\b|\b(?:match|select)\b|\)\s*$)\s*$/;

/** A brace that opens the body being measured, rather than a nested block. */
const BODY_FRAME_RE = /(?:\bfunction\b|=>|\)\s*$)/;
/** Text that begins with a control keyword, so its brace is a block. */
const CONTROL_START_RE = /^(?:if|else|for|while|switch|catch|try|do|case|default|finally)\b/;

/**
 * Deepest control-flow nesting in a body of code.
 *
 * `prefix` is the text since the last structural boundary, so `} else {` is
 * recognised as a control head while `const config = {` is not.
 */
export function measureBraceNesting(code: string): number {
  const stack: boolean[] = [];
  let depth = 0;
  let deepest = 0;
  let boundary = 0;
  // Before the body opens, braces inside parentheses are a parameter list —
  // including a destructured one — and are not blocks. Once inside the body the
  // guard must be dropped: `items.map((x) => { ... })` has an open parenthesis
  // from the call, and treating that callback body as a parameter list hid the
  // nesting of the most common shape in the language.
  let parenDepth = 0;
  let bodyOpened = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '(') {
      parenDepth += 1;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (ch === '{') {
      if (!bodyOpened && parenDepth > 0) continue;
      const prefix = code.slice(boundary, i).trim();
      // The first brace outside parentheses is the body's own frame. Counting it
      // would report every function as one level deeper than it is, and would
      // disagree with the indentation measure used for Python and Ruby.
      let counts = CONTROL_HEAD_RE.test(prefix);
      if (!bodyOpened) {
        bodyOpened = true;
        // The frame is the body's own brace — but only when what precedes it is
        // a function head. A snippet starting with `if (a) {` has no frame, and
        // treating that brace as one would under-report its nesting.
        counts = BODY_FRAME_RE.test(prefix) && !CONTROL_START_RE.test(prefix) ? false : counts;
      }
      stack.push(counts);
      if (counts) {
        depth += 1;
        if (depth > deepest) deepest = depth;
      }
      boundary = i + 1;
    } else if (ch === '}') {
      if (!bodyOpened && parenDepth > 0) continue;
      if (stack.pop()) depth = Math.max(0, depth - 1);
      boundary = i + 1;
    } else if (ch === ';') {
      boundary = i + 1;
    }
  }
  return deepest;
}

/** The same measure for indentation-delimited languages. */
export function measureIndentNesting(body: string, family: LanguageFamily): number {
  const control =
    family === 'ruby'
      ? /^(if|elsif|else|unless|while|until|case|when|begin|rescue|ensure|do)\b/
      : /^(if|elif|else|for|while|try|except|finally|with|match|case|async\s+for|async\s+with)\b/;
  const lines = body.split('\n');
  const base = indentWidth(lines[0] ?? '');
  const open: number[] = [];
  let deepest = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentWidth(line);
    while (open.length > 0 && indent <= open[open.length - 1]) open.pop();
    if (indent > base && control.test(trimmed)) {
      open.push(indent);
      if (open.length > deepest) deepest = open.length;
    }
  }
  return deepest;
}

function analyseBody(body: string, family: LanguageFamily): { branches: number; maxDepth: number } {
  const code = stripNonCode(body, family);
  const branches = countBranches(code, family);
  const maxDepth = family === 'python' || family === 'ruby' ? measureIndentNesting(code, family) : measureBraceNesting(code);
  return { branches, maxDepth };
}

/**
 * Difficulty, then difficulty weighted by blast radius.
 *
 * Depth is weighted twice: two branches in a row are two things to understand,
 * but two branches one inside the other are harder because the reader has to
 * hold the outer condition while reasoning about the inner one.
 */
export function complexityScore(branches: number, maxDepth: number, callers: number): number {
  const difficulty = branches + 2 * maxDepth;
  const reach = 1 + Math.log2(callers + 1);
  return Math.round(difficulty * reach * 100) / 100;
}

export function computeComplexity(input: ComplexityInput): ComplexityReport {
  const symbols: SymbolComplexity[] = [];
  const files: FileComplexity[] = [];
  const warnings: string[] = [];

  for (const file of input.files) {
    if (!file.text) continue;
    const family = file.language as LanguageFamily;
    const lines = file.text.split('\n');
    let fileBranches = 0;
    let fileDepth = 0;
    let counted = 0;

    for (const symbol of file.symbols) {
      // Lines are 1-based; a body beyond the end of the file means a stale record.
      const start = Math.max(0, symbol.line - 1);
      const end = Math.min(lines.length - 1, symbol.endLine - 1);
      if (end < start) continue;
      const body = lines.slice(start, end + 1).join('\n');
      if (!body.trim()) continue;
      const { branches, maxDepth } = analyseBody(body, family);
      const complexity: SymbolComplexity = {
        id: symbol.id,
        path: file.path,
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        loc: Math.max(1, end - start + 1),
        branches,
        maxDepth,
        callers: symbol.callers,
        reachable: symbol.reachable,
        score: complexityScore(branches, maxDepth, symbol.callers),
      };
      symbols.push(complexity);
      fileBranches += branches;
      fileDepth = Math.max(fileDepth, maxDepth);
      counted += 1;
    }

    // Only real definitions contribute; a file of constants has no complexity to
    // report and should not be ranked as if it did.
    if (counted === 0) continue;
    const commits = input.churn?.get(file.path) ?? 0;
    const difficulty = fileBranches + 2 * fileDepth;
    // Churn alone favours tiny files edited constantly; complexity alone favours
    // convoluted code nobody touches. Where both are high is where to look.
    const score = commits > 0 ? commits * Math.log10(difficulty + 10) : difficulty;
    files.push({
      path: file.path,
      loc: file.entryLines ?? file.text.split('\n').length,
      symbols: counted,
      branches: fileBranches,
      maxDepth: fileDepth,
      commits,
      score: Math.round(score * 100) / 100,
    });
  }

  symbols.sort((a, b) => b.score - a.score || b.branches - a.branches || a.path.localeCompare(b.path));
  files.sort((a, b) => b.score - a.score || b.branches - a.branches || a.path.localeCompare(b.path));

  const totalBranches = symbols.reduce((sum, symbol) => sum + symbol.branches, 0);
  const totalDepth = symbols.reduce((sum, symbol) => sum + symbol.maxDepth, 0);
  const summary = {
    functionsAnalysed: symbols.length,
    meanBranches: symbols.length > 0 ? Math.round((totalBranches / symbols.length) * 10) / 10 : 0,
    meanDepth: symbols.length > 0 ? Math.round((totalDepth / symbols.length) * 10) / 10 : 0,
    deepest: symbols.reduce((max, symbol) => Math.max(max, symbol.maxDepth), 0),
    mostBranches: symbols.reduce((max, symbol) => Math.max(max, symbol.branches), 0),
    deepFunctions: symbols.filter((symbol) => symbol.maxDepth >= DEEP_DEPTH).length,
    branchyFunctions: symbols.filter((symbol) => symbol.branches >= BRANCHY).length,
  };

  if (symbols.length === 0) {
    warnings.push('No function or method bodies could be measured, so complexity is not reported.');
  }

  return { symbols: symbols.slice(0, 80), files: files.slice(0, 40), summary, warnings };
}

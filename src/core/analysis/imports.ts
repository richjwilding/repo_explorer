import type { ImportEdge, SymbolInfo } from '../types.js';
import { detectLanguage } from './languages.js';
import { findBodyEnd, indentWidth } from './bodies.js';

export interface ImportBinding {
  /** Name used at the call site. `*` means a namespace/default import. */
  local: string;
  /** Name as exported by the source module. `default` and `*` are special. */
  remote: string;
}

export interface RawImport {
  specifier: string;
  kind: ImportEdge['kind'];
  line: number;
  /** Local names introduced by this import, used to resolve call targets. */
  bindings: ImportBinding[];
}

export interface FileFacts {
  imports: RawImport[];
  symbols: SymbolInfo[];
}

const MAX_SYMBOLS = 250;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function eachLine(text: string, fn: (line: string, lineNo: number, trimmed: string) => void): void {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) fn(lines[i], i + 1, lines[i].trim());
}

/* ------------------------------------------------------------------ *
 * Import extraction
 * ------------------------------------------------------------------ */

export function extractImports(text: string, filePath: string): RawImport[] {
  const lang = detectLanguage(filePath);
  const out: RawImport[] = [];
  const push = (specifier: string, kind: ImportEdge['kind'], index: number, bindings: ImportBinding[] = [], lineOverride?: number) => {
    if (!specifier) return;
    if (out.length > 1200) return;
    out.push({ specifier, kind, line: lineOverride ?? lineOf(text, index), bindings });
  };
  const bare = (specifier: string): string => specifier.split('/').filter(Boolean).pop() ?? specifier;

  switch (lang.family) {
    case 'js': {
      // import Default, { a, b as c } from 'x'  |  import * as ns from 'x'  |  import 'x'
      const importRe = /(?:^|[\s;])(?:import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(text)) !== null) {
        const clause = m[1].trim();
        const specifier = m[2];
        const bindings: ImportBinding[] = [];
        const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
        const namedMatch = clause.match(/\{([\s\S]*?)\}/);
        const defaultMatch = clause.replace(/\{[\s\S]*?\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/,/g, ' ').trim().match(/^([A-Za-z_$][\w$]*)$/);
        if (namespaceMatch) bindings.push({ local: namespaceMatch[1], remote: '*' });
        if (defaultMatch) bindings.push({ local: defaultMatch[1], remote: 'default' });
        if (namedMatch) {
          for (const part of namedMatch[1].split(',')) {
            const piece = part.trim();
            if (!piece) continue;
            const alias = piece.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
            if (alias) bindings.push({ local: alias[2], remote: alias[1] });
            else if (/^[A-Za-z_$][\w$]*$/.test(piece)) bindings.push({ local: piece, remote: piece });
          }
        }
        push(specifier, 'static', m.index, bindings);
      }
      // Side-effect import: import 'x'
      for (const sm of text.matchAll(/(?:^|[\s;])import\s+["']([^"']+)["']/g)) {
        push(sm[1], 'static', sm.index, []);
      }
      // require('x') / const x = require('x') / const { a, b: c } = require('x')
      for (const rm of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
        const target = rm[1];
        const specifier = rm[2];
        const bindings: ImportBinding[] = [];
        if (target.startsWith('{')) {
          for (const part of target.slice(1, -1).split(',')) {
            const piece = part.trim();
            if (!piece) continue;
            const alias = piece.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/);
            if (alias) bindings.push({ local: alias[2], remote: alias[1] });
            else bindings.push({ local: piece, remote: piece });
          }
        } else {
          bindings.push({ local: target, remote: 'default' });
        }
        push(specifier, 'require', rm.index, bindings);
      }
      for (const rm of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
        push(rm[1], 'require', rm.index, []);
      }
      for (const dm of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) push(dm[1], 'dynamic', dm.index, []);
      break;
    }
    case 'python': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+(.+)$/);
        if (fromMatch) {
          const specifier = fromMatch[1];
          const bindings: ImportBinding[] = [];
          const clause = fromMatch[2].split('#')[0].trim();
          if (clause === '*') bindings.push({ local: '*', remote: '*' });
          else {
            const withoutParens = clause.replace(/[()]/g, '');
            for (const part of withoutParens.split(',')) {
              const piece = part.trim();
              if (!piece) continue;
              const alias = piece.match(/^([\w.]+)\s+as\s+(\w+)$/);
              if (alias) bindings.push({ local: alias[2], remote: alias[1] });
              else bindings.push({ local: piece, remote: piece });
            }
          }
          push(specifier, 'python', 0, bindings, lineNo);
          return;
        }
        const importMatch = trimmed.match(/^import\s+(.+)$/);
        if (importMatch) {
          for (const part of importMatch[1].split(',')) {
            const piece = part.trim().split('#')[0].trim();
            if (!piece) continue;
            const alias = piece.match(/^([\w.]+)\s+as\s+(\w+)$/);
            const dotted = alias ? alias[1] : piece;
            const local = alias ? alias[2] : dotted.split('.')[0];
            push(dotted, 'python', 0, [{ local, remote: dotted }], lineNo);
          }
        }
      });
      break;
    }
    case 'go': {
      const blockRe = /import\s*\(([\s\S]*?)\)/g;
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(text)) !== null) {
        const body = m[1];
        for (const lineMatch of body.matchAll(/(?:^|\n)\s*(?:([A-Za-z_][\w]*|\.)\s+)?"([^"]+)"/g)) {
          const alias = lineMatch[1];
          const specifier = lineMatch[2];
          const local = alias === '.' || alias === '_' ? null : alias || bare(specifier);
          push(specifier, 'go', m.index + m[0].indexOf(body) + lineMatch.index, local ? [{ local, remote: local }] : []);
        }
      }
      eachLine(text, (_line, lineNo, trimmed) => {
        const single = trimmed.match(/^import\s+(?:([A-Za-z_][\w]*)\s+)?"([^"]+)"/);
        if (single) {
          const local = single[1] || bare(single[2]);
          push(single[2], 'go', 0, [{ local, remote: local }], lineNo);
        }
      });
      break;
    }
    case 'rust': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const use = trimmed.match(/^use\s+([\w:{} ,*]+);/);
        if (use) {
          const raw = use[1].replace(/^::/, '');
          const root = raw.split('::')[0];
          const bindings: ImportBinding[] = [];
          const alias = raw.match(/^([\w:]+)\s+as\s+(\w+)$/);
          if (alias) bindings.push({ local: alias[2], remote: alias[1].split('::').pop() ?? alias[1] });
          else if (raw.includes('{')) {
            const inner = raw.slice(raw.indexOf('{') + 1, raw.lastIndexOf('}'));
            for (const part of inner.split(',')) {
              const piece = part.trim();
              if (!piece) continue;
              const pieceAlias = piece.match(/^([\w:]+)\s+as\s+(\w+)$/);
              bindings.push({ local: pieceAlias ? pieceAlias[2] : (piece.split('::').pop() as string), remote: piece });
            }
          } else {
            bindings.push({ local: raw.split('::').pop() as string, remote: raw.split('::').pop() as string });
          }
          push(root, 'rust', 0, bindings, lineNo);
          return;
        }
        const mod = trimmed.match(/^(?:pub\s+)?mod\s+(\w+)\s*;/);
        if (mod) push(mod[1], 'rust', 0, [], lineNo);
      });
      break;
    }
    case 'jvm':
    case 'dotnet': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const imp = trimmed.match(/^import\s+(?:static\s+)?([\w.]+)(?:\.\*)?;/) || trimmed.match(/^using\s+(?:static\s+)?([\w.]+)\s*;/);
        if (imp) {
          const local = imp[1].split('.').pop() as string;
          push(imp[1], 'java', 0, [{ local, remote: local }], lineNo);
        }
      });
      break;
    }
    case 'ruby': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const m = trimmed.match(/^require(?:_relative)?\s+["']([^"']+)["']/);
        if (m) push(m[1], 'static', 0, [], lineNo);
      });
      break;
    }
    case 'php': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const use = trimmed.match(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/);
        if (use) {
          const local = use[2] || (use[1].split('\\').pop() as string);
          push(use[1].replace(/\\/g, '/'), 'static', 0, [{ local, remote: local }], lineNo);
          return;
        }
        const req = trimmed.match(/(?:require|include)(?:_once)?\s*[( ]?\s*["']([^"']+)["']/);
        if (req) push(req[1], 'static', 0, [], lineNo);
      });
      break;
    }
    case 'c': {
      const re = /#\s*include\s*[<"]([^>"]+)[>"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) push(m[1], 'static', m.index, []);
      break;
    }
    case 'swift': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const m = trimmed.match(/^import\s+(\w+)/);
        if (m) push(m[1], 'static', 0, [{ local: m[1], remote: m[1] }], lineNo);
      });
      break;
    }
    case 'shell': {
      eachLine(text, (_line, lineNo, trimmed) => {
        const m = trimmed.match(/^(?:source|\.)\s+["']?([^\s"']+)/);
        if (m) push(m[1], 'static', 0, [], lineNo);
      });
      break;
    }
    default:
      break;
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Symbol extraction
 * ------------------------------------------------------------------ */

export function extractSymbols(text: string, filePath: string): SymbolInfo[] {
  const lang = detectLanguage(filePath);
  const symbols: SymbolInfo[] = [];
  const add = (name: string, kind: SymbolInfo['kind'], exported: boolean, line: number) => {
    if (symbols.length >= MAX_SYMBOLS) return;
    if (!name || name.length > 120) return;
    if (symbols.some((s) => s.name === name && s.line === line)) return;
    symbols.push({ name, kind, exported, line });
  };

  switch (lang.family) {
    case 'js':
      extractJsSymbols(text, add);
      break;
    case 'python':
      eachLine(text, (_line, lineNo, trimmed) => {
        let m: RegExpMatchArray | null;
        if ((m = trimmed.match(/^(?:async\s+)?def\s+(\w+)/))) add(m[1], 'function', !m[1].startsWith('_'), lineNo);
        else if ((m = trimmed.match(/^class\s+(\w+)/))) add(m[1], 'class', !m[1].startsWith('_'), lineNo);
      });
      break;
    case 'go':
      eachLine(text, (_line, lineNo, trimmed) => {
        let m: RegExpMatchArray | null;
        if ((m = trimmed.match(/^func\s+\([^)]*\)\s*(\w+)/))) add(m[1], 'method', /^[A-Z]/.test(m[1]), lineNo);
        else if ((m = trimmed.match(/^func\s+(\w+)/))) add(m[1], 'function', /^[A-Z]/.test(m[1]), lineNo);
        else if ((m = trimmed.match(/^type\s+(\w+)\s+struct/))) add(m[1], 'struct', /^[A-Z]/.test(m[1]), lineNo);
        else if ((m = trimmed.match(/^type\s+(\w+)\s+interface/))) add(m[1], 'interface', /^[A-Z]/.test(m[1]), lineNo);
        else if ((m = trimmed.match(/^type\s+(\w+)/))) add(m[1], 'type', /^[A-Z]/.test(m[1]), lineNo);
      });
      break;
    case 'rust':
      eachLine(text, (_line, lineNo, trimmed) => {
        const isPub = /^pub(?:\([^)]*\))?\s+/.test(trimmed);
        const body = trimmed.replace(/^pub(?:\([^)]*\))?\s+/, '').replace(/^async\s+/, '');
        let m: RegExpMatchArray | null;
        if ((m = body.match(/^fn\s+(\w+)/))) add(m[1], 'function', isPub, lineNo);
        else if ((m = body.match(/^struct\s+(\w+)/))) add(m[1], 'struct', isPub, lineNo);
        else if ((m = body.match(/^enum\s+(\w+)/))) add(m[1], 'enum', isPub, lineNo);
        else if ((m = body.match(/^trait\s+(\w+)/))) add(m[1], 'trait', isPub, lineNo);
        else if ((m = body.match(/^impl(?:<[^>]*>)?\s+(\w+)/))) add(m[1], 'class', isPub, lineNo);
      });
      break;
    case 'jvm':
    case 'dotnet':
      eachLine(text, (line, lineNo, trimmed) => {
        if (/^(?:\/\/|\*|#)/.test(trimmed)) return;
        const isPublic = /^\s*(?:public|open|export)/.test(line) || /^(?:public|open)\s/.test(trimmed);
        const body = trimmed.replace(/^(?:public|private|protected|internal|open|final|abstract|sealed|static|data|export)\s+/g, '');
        let m: RegExpMatchArray | null;
        if ((m = body.match(/^(?:class|interface|enum|record|object|struct|trait)\s+(\w+)/))) {
          const kindWord = m[0].split(/\s/)[0];
          add(m[1], kindWord === 'interface' || kindWord === 'trait' ? 'interface' : kindWord === 'enum' ? 'enum' : 'class', isPublic, lineNo);
        } else if ((m = body.match(/^(?:fun|func|def|void|int|string|bool|Task<?[\w>]*>?)\s+(\w+)\s*\(/))) {
          add(m[1], 'function', isPublic, lineNo);
        }
      });
      break;
    case 'ruby':
      eachLine(text, (_line, lineNo, trimmed) => {
        let m: RegExpMatchArray | null;
        if ((m = trimmed.match(/^def\s+(?:self\.)?([\w?!=]+)/))) add(m[1], 'function', true, lineNo);
        else if ((m = trimmed.match(/^class\s+(\w+)/))) add(m[1], 'class', true, lineNo);
        else if ((m = trimmed.match(/^module\s+(\w+)/))) add(m[1], 'module', true, lineNo);
      });
      break;
    case 'php':
      eachLine(text, (_line, lineNo, trimmed) => {
        let m: RegExpMatchArray | null;
        if ((m = trimmed.match(/^(?:public|private|protected|static|\s)*function\s+(\w+)/))) add(m[1], 'function', !trimmed.startsWith('private'), lineNo);
        else if ((m = trimmed.match(/^(?:final\s+|abstract\s+)?class\s+(\w+)/))) add(m[1], 'class', true, lineNo);
        else if ((m = trimmed.match(/^interface\s+(\w+)/))) add(m[1], 'interface', true, lineNo);
        else if ((m = trimmed.match(/^trait\s+(\w+)/))) add(m[1], 'trait', true, lineNo);
      });
      break;
    case 'c':
      eachLine(text, (_line, lineNo, trimmed) => {
        let m: RegExpMatchArray | null;
        if ((m = trimmed.match(/^(?:typedef\s+)?(?:class|struct|union|enum)\s+(\w+)/))) add(m[1], trimmed.startsWith('enum') ? 'enum' : 'struct', true, lineNo);
        else if ((m = trimmed.match(/^(?:[\w:*&<>]+\s+)+(\w+)\s*\([^;]*\)\s*(?:const\s*)?\{/))) add(m[1], 'function', true, lineNo);
      });
      break;
    case 'swift':
      eachLine(text, (_line, lineNo, trimmed) => {
        const isPublic = /^(?:public|open)\s/.test(trimmed);
        const body = trimmed.replace(/^(?:public|private|internal|fileprivate|open|final|static|override|mutating|@\w+)\s*/g, '');
        let m: RegExpMatchArray | null;
        if ((m = body.match(/^(?:class|struct|enum|protocol|actor|extension)\s+(\w+)/))) {
          const kw = m[0].split(/\s/)[0];
          add(m[1], kw === 'protocol' ? 'interface' : kw === 'enum' ? 'enum' : kw === 'extension' ? 'type' : 'class', isPublic, lineNo);
        } else if ((m = body.match(/^(?:func)\s+(\w+)/))) add(m[1], 'function', isPublic, lineNo);
      });
      break;
    case 'shell':
      eachLine(text, (_line, lineNo, trimmed) => {
        const m = trimmed.match(/^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/);
        if (m) add(m[1], 'function', true, lineNo);
      });
      break;
    default:
      break;
  }

  return symbols;
}

export function extractFileFacts(text: string, filePath: string): FileFacts {
  return { imports: extractImports(text, filePath), symbols: extractSymbols(text, filePath) };
}

/* ------------------------------------------------------------------ *
 * JavaScript / TypeScript symbols
 * ------------------------------------------------------------------ */

const JS_RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'new', 'super', 'this', 'typeof',
  'function', 'class', 'const', 'let', 'var', 'await', 'yield', 'case', 'default', 'break', 'continue', 'throw',
  'delete', 'void', 'in', 'of', 'instanceof', 'constructor', 'import', 'export', 'extends', 'implements',
]);

/**
 * Extract JS/TS definitions.
 *
 * Only column-zero declarations are treated as definitions, plus their class
 * members. A `const` inside a function body is a local variable; recording it
 * as a symbol splits the enclosing function's body in half and corrupts
 * everything downstream (call attribution, ownership, dead-code detection).
 */
function extractJsSymbols(text: string, add: (name: string, kind: SymbolInfo['kind'], exported: boolean, line: number) => void): void {
  const lines = text.split('\n');
  const classes: { name: string; line: number }[] = [];

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (raw !== trimmed) return; // indented: not module scope

    const exported = /^export\s/.test(trimmed);
    const body = trimmed.replace(/^export\s+(?:default\s+)?/, '');
    let m: RegExpMatchArray | null;

    if ((m = body.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) add(m[1], 'function', exported, lineNo);
    else if ((m = body.match(/^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      add(m[1], 'class', exported, lineNo);
      classes.push({ name: m[1], line: lineNo });
    } else if ((m = body.match(/^(?:declare\s+)?(?:interface)\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'interface', exported, lineNo);
    else if ((m = body.match(/^(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'type', exported, lineNo);
    else if ((m = body.match(/^(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/))) add(m[1], 'enum', exported, lineNo);
    else if ((m = body.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/))) {
      const isFunction = /=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(body);
      add(m[1], isFunction ? 'function' : 'const', exported, lineNo);
    }
  });

  for (const klass of classes) {
    const startIndex = klass.line - 1;
    const endIndex = findBodyEnd(lines, startIndex, 'js');
    if (endIndex <= startIndex) continue;

    let memberIndent: number | null = null;
    for (let i = startIndex + 1; i <= endIndex && i < lines.length; i += 1) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      const indent = indentWidth(raw);
      if (memberIndent === null) memberIndent = indent;
      if (indent !== memberIndent) continue;

      const member = trimmed
        .replace(/^(?:public|private|protected|static|readonly|abstract|override|declare|async|get|set|accessor)\s+/g, '')
        .replace(/^\*\s*/, '');
      let m: RegExpMatchArray | null;
      if ((m = member.match(/^([A-Za-z_$][\w$]*)\s*[(<]/))) {
        if (!JS_RESERVED.has(m[1])) add(m[1], 'method', true, i + 1);
      } else if ((m = member.match(/^([A-Za-z_$][\w$]*)\s*[:=]/))) {
        if (!JS_RESERVED.has(m[1])) add(m[1], 'const', true, i + 1);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Import resolution
 * ------------------------------------------------------------------ */

export interface PackageManifest {
  name: string;
  dependencies: Set<string>;
}

function parentDir(p: string): string {
  const index = p.lastIndexOf('/');
  return index === -1 ? '' : p.slice(0, index);
}

/**
 * Resolve an import specifier to a repo-relative file path.
 * Returns null for external packages.
 */
export function resolveSpecifier(fromPath: string, specifier: string, knownPaths: Set<string>, aliasRoots: string[] = []): string | null {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';

  // Strip common query/hash suffixes.
  const clean = specifier.replace(/[?#].*$/, '');
  if (!clean) return null;

  const candidates: string[] = [];
  const tryRelative = (base: string) => {
    const stack: string[] = [base];
    while (stack.length) {
      const current = stack.pop() as string;
      for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.swift', '.h', '.hpp', '.c', '.cpp', '.sh']) {
        candidates.push(current + ext);
      }
      for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', '__init__.py', 'mod.rs', 'index.vue', 'index.svelte', 'main.go']) {
        candidates.push(`${current}/${idx}`);
      }
    }
  };

  const isRelative = clean.startsWith('./') || clean.startsWith('../') || clean.startsWith('/');
  const isPythonRelative = !isRelative && /^\.+/.test(clean);
  if (isPythonRelative) {
    // Python relative imports use dots: `.models` is a sibling module,
    // `..utils` climbs one package. The first dot means "this package".
    const dots = (clean.match(/^\.+/) as RegExpMatchArray)[0].length;
    const rest = clean.slice(dots).replace(/\./g, '/');
    let base = fromDir;
    for (let i = 1; i < dots; i += 1) base = parentDir(base);
    const target = normalizePath(rest ? `${base}/${rest}` : base);
    tryRelative(target);
  } else if (isRelative) {
    const normalized = normalizePath(fromDir ? `${fromDir}/${clean}` : clean);
    tryRelative(normalized);
  } else {
    // Try alias roots (e.g. `src/`, `@/` → `src/`) then bare repo-relative.
    for (const root of aliasRoots) {
      tryRelative(normalizePath(`${root}/${clean}`));
    }
    tryRelative(normalizePath(clean));
  }

  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const segment of p.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/** Extract the package name from a bare specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : scope;
  }
  return specifier.split('/')[0];
}

export function isExternalSpecifier(specifier: string): boolean {
  if (!specifier) return false;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('node:') || specifier.startsWith('bun:')) return true;
  return true;
}

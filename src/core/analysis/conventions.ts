/**
 * Conventions inferred from the code, and the places that break them.
 *
 * This is the step from describing a codebase to reviewing it. Every rule here
 * is derived from the repository itself — the majority behaviour, measured — and
 * is only reported when it is both well supported and closely followed. Nothing
 * is asserted from general practice: a rule that says "tests are named
 * `*.test.ts`" says so because 41 of 43 files do exactly that, not because it
 * would be sensible if they did.
 *
 * A convention is a fact about a codebase, and a violation is a question worth
 * asking rather than a defect. The output is phrased that way throughout.
 */
import { countConfiguredEnvAccesses } from './ops.js';

export interface ConventionViolation {
  path: string;
  line?: number;
  detail: string;
}

export interface Convention {
  id: string;
  /** The rule, phrased as the code actually behaves. */
  rule: string;
  /** How it was inferred, with the numbers that support it. */
  basis: string;
  /** Cases that follow the rule. */
  supporting: number;
  /** Cases that do not. */
  violations: ConventionViolation[];
  /** supporting / (supporting + violations), 0–1. */
  adherence: number;
  /** Estimated blast radius: how many files would be touched to align them. */
  summary: string;
}

export interface ConventionsReport {
  rules: Convention[];
  /** Patterns that were visible but too weakly supported to call a rule. */
  weakPatterns: string[];
  summary: { derived: number; violations: number };
  warnings: string[];
}

export interface ConventionInput {
  files: { path: string; language: string; category: string }[];
  imports: { from: string; to: string | null }[];
  components: { id: string; name: string; files: string[] }[];
  /** Only files whose text is needed for access-pattern rules. */
  sources: { path: string; text: string }[];
  /**
   * Which files actually declare test cases. A helper or fixture living under
   * `tests/` does not follow the test-naming convention because it is not a
   * test — counting it produced a false exception.
   */
  testCaseFiles?: Set<string>;
}

export const EMPTY_CONVENTIONS: ConventionsReport = {
  rules: [],
  weakPatterns: [],
  summary: { derived: 0, violations: 0 },
  warnings: [],
};

/** A rule needs this many supporting cases before it is worth calling a rule. */
const MIN_SUPPORT = 5;
/** …and this share of applicable cases before a minority counts as a deviation. */
const MIN_ADHERENCE = 0.8;

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|specs?)(\/|$)/i;

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '.' : path.slice(0, index);
}

function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, '');
}

function extension(path: string): string {
  const match = /\.([^.]+)$/.exec(basename(path));
  return match ? `.${match[1].toLowerCase()}` : '';
}

type NameStyle = 'kebab' | 'snake' | 'camel' | 'pascal' | 'other';

export function classifyNameStyle(name: string): NameStyle {
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(name)) return 'kebab';
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return 'snake';
  if (/^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name)) return 'pascal';
  if (/^[a-z][A-Za-z0-9]*$/.test(name)) return 'camel';
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return 'other';
  return 'other';
}

const STYLE_LABEL: Record<NameStyle, string> = {
  kebab: 'kebab-case',
  snake: 'snake_case',
  camel: 'camelCase',
  pascal: 'PascalCase',
  other: 'another style',
};

/**
 * File naming per directory and extension.
 *
 * Grouped by extension as well as directory, because a directory holding React
 * components genuinely uses two conventions at once — `PascalCase.tsx` for the
 * component and `camelCase.ts` for its helpers — and reporting that as a
 * deviation would be wrong.
 */
function namingRules(files: ConventionInput['files'], weak: string[]): Convention[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    if (file.category !== 'source' && file.category !== 'test') continue;
    const name = stem(file.path);
    // `index` and `main` are structural rather than named choices.
    if (/^(index|main|mod|__init__|types|constants)$/i.test(name)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) continue;
    const key = `${dirname(file.path)}\u0000${extension(file.path)}`;
    const list = groups.get(key) ?? [];
    list.push(file.path);
    groups.set(key, list);
  }

  const rules: Convention[] = [];
  for (const [key, paths] of groups) {
    if (paths.length < MIN_SUPPORT) continue;
    const [dir, ext] = key.split('\u0000');
    const byStyle = new Map<NameStyle, string[]>();
    for (const path of paths) {
      const style = classifyNameStyle(stem(path));
      const list = byStyle.get(style) ?? [];
      list.push(path);
      byStyle.set(style, list);
    }
    const ranked = [...byStyle.entries()].sort((a, b) => b[1].length - a[1].length);
    const [style, matching] = ranked[0];
    if (style === 'other') continue;
    const adherence = matching.length / paths.length;
    if (adherence < MIN_ADHERENCE) {
      if (adherence >= 0.5) {
        weak.push(`Files named \`*${ext}\` in \`${dir}\` are mixed: ${ranked.map(([s, list]) => `${STYLE_LABEL[s]} ${list.length}`).join(', ')}.`);
      }
      continue;
    }
    const violations = ranked
      .filter(([other]) => other !== style)
      .flatMap(([, list]) => list)
      .map((path) => ({ path, detail: `${STYLE_LABEL[classifyNameStyle(stem(path))]} in a ${STYLE_LABEL[style]} directory` }));
    rules.push({
      id: `naming:${dir}:${ext}`,
      rule: `Files named \`*${ext}\` in \`${dir}\` use ${STYLE_LABEL[style]}.`,
      basis: `${matching.length} of ${paths.length} files follow it.`,
      supporting: matching.length,
      violations,
      adherence,
      summary: violations.length === 0 ? 'no exceptions' : `${violations.length} exception(s)`,
    });
  }
  return rules;
}

/**
 * Test placement and naming.
 *
 * Where tests live is one of the first things to learn and one of the most
 * consistently followed conventions in any repository.
 */
function testRules(files: ConventionInput['files'], weak: string[], testCaseFiles?: Set<string>): Convention[] {
  const tests = files.filter(
    (file) => file.category === 'test' && (testCaseFiles ? testCaseFiles.has(file.path) : true),
  );
  if (tests.length < MIN_SUPPORT) return [];
  const rules: Convention[] = [];

  const placement = new Map<string, string[]>();
  for (const file of tests) {
    let kind = 'beside the source';
    if (TEST_DIR_RE.test(file.path)) {
      const match = /(^|\/)(tests?|__tests__|specs?)\//i.exec(file.path);
      kind = `under \`${match?.[2] ?? 'tests'}/\``;
    }
    const list = placement.get(kind) ?? [];
    list.push(file.path);
    placement.set(kind, list);
  }
  const rankedPlacement = [...placement.entries()].sort((a, b) => b[1].length - a[1].length);
  const [placementKind, matching] = rankedPlacement[0];
  const placementAdherence = matching.length / tests.length;
  if (placementAdherence >= MIN_ADHERENCE) {
    rules.push({
      id: 'tests:placement',
      rule: `Tests live ${placementKind}.`,
      basis: `${matching.length} of ${tests.length} test files are placed there.`,
      supporting: matching.length,
      violations: rankedPlacement
        .filter(([kind]) => kind !== placementKind)
        .flatMap(([kind, list]) => list.map((path) => ({ path, detail: `placed ${kind}` }))),
      adherence: placementAdherence,
      summary: rankedPlacement.length === 1 ? 'no exceptions' : `${tests.length - matching.length} exception(s)`,
    });
  } else if (placementAdherence >= 0.5) {
    weak.push(`Test placement is mixed: ${rankedPlacement.map(([kind, list]) => `${kind} ${list.length}`).join(', ')}.`);
  }

  const naming = new Map<string, string[]>();
  for (const file of tests) {
    const base = basename(file.path);
    let kind = 'another pattern';
    if (/\.test\.[^.]+$/.test(base)) kind = '`*.test.*`';
    else if (/\.spec\.[^.]+$/.test(base)) kind = '`*.spec.*`';
    else if (/^(test_|test-)/.test(base)) kind = 'a `test_` prefix';
    else if (/_test\.[^.]+$/.test(base)) kind = 'a `_test` suffix';
    const list = naming.get(kind) ?? [];
    list.push(file.path);
    naming.set(kind, list);
  }
  const rankedNaming = [...naming.entries()].sort((a, b) => b[1].length - a[1].length);
  const [namingKind, namingMatching] = rankedNaming[0];
  const namingAdherence = namingMatching.length / tests.length;
  if (namingKind !== 'another pattern' && namingAdherence >= MIN_ADHERENCE) {
    rules.push({
      id: 'tests:naming',
      rule: `Test files are named with ${namingKind}.`,
      basis: `${namingMatching.length} of ${tests.length} test files follow it.`,
      supporting: namingMatching.length,
      violations: rankedNaming
        .filter(([kind]) => kind !== namingKind)
        .flatMap(([kind, list]) => list.map((path) => ({ path, detail: `named with ${kind}` }))),
      adherence: namingAdherence,
      summary: rankedNaming.length === 1 ? 'no exceptions' : `${tests.length - namingMatching.length} exception(s)`,
    });
  }
  return rules;
}

/**
 * Dependency direction between components.
 *
 * The rule is not invented: it is the majority direction of a pair. If `core`
 * imports `web` in fourteen places and `web` imports `core` in one, the
 * fourteen define the convention and the one is the thing to ask about.
 */
function layeringRules(input: ConventionInput, weak: string[]): Convention[] {
  const componentOf = new Map<string, string>();
  for (const component of input.components) for (const file of component.files) componentOf.set(file, component.id);
  const nameOf = new Map(input.components.map((component) => [component.id, component.name]));

  // `from\u0000to` → the files that import in that direction, so a count and the
  // evidence behind it are the same thing.
  const edges = new Map<string, string[]>();
  for (const edge of input.imports) {
    if (!edge.to) continue;
    const from = componentOf.get(edge.from);
    const to = componentOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    const list = edges.get(key) ?? [];
    list.push(edge.from);
    edges.set(key, list);
  }
  const countOf = (from: string, to: string): number => (edges.get(`${from}\u0000${to}`) ?? []).length;

  const rules: Convention[] = [];
  const seen = new Set<string>();
  for (const key of edges.keys()) {
    const [from, to] = key.split('\u0000');
    const pairKey = [from, to].sort().join('\u0000');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const forward = countOf(from, to);
    const backward = countOf(to, from);
    const dominant = Math.max(forward, backward);
    const minority = Math.min(forward, backward);
    if (dominant < MIN_SUPPORT || minority === 0) continue;
    const adherence = dominant / (dominant + minority);
    // A pair that leans both ways is a genuine mutual dependency — a finding in
    // its own right, but not a broken convention.
    if (adherence < MIN_ADHERENCE) {
      if (adherence >= 0.5) {
        weak.push(`\`${nameOf.get(from)}\` and \`${nameOf.get(to)}\` depend on each other (${forward} one way, ${backward} the other).`);
      }
      continue;
    }
    const depends = forward >= backward ? from : to;
    const dependency = forward >= backward ? to : from;
    rules.push({
      id: `layering:${depends}:${dependency}`,
      rule: `\`${nameOf.get(depends)}\` depends on \`${nameOf.get(dependency)}\`, and not the other way round.`,
      basis: `${dominant} import${dominant === 1 ? '' : 's'} run that way; ${minority} run back.`,
      supporting: dominant,
      violations: (edges.get(`${dependency}\u0000${depends}`) ?? []).map((path) => ({
        path,
        detail: `imports \`${nameOf.get(depends)}\`, against the direction of the other ${dominant} import(s)`,
      })),
      adherence,
      summary: `${minority} import(s) run backwards`,
    });
  }
  return rules;
}

/**
 * Single-door conventions: one file owns a concern, and the exceptions read as
 * questions. Configuration access is the clearest case, because "everything
 * reads its own environment" is exactly the situation a leader wants to know
 * about before changing how the app is configured.
 */
function singleDoorRules(input: ConventionInput, weak: string[]): Convention[] {
  const rules: Convention[] = [];

  const envSites = input.sources
    .map((source) => ({ path: source.path, count: countConfiguredEnvAccesses(source.text) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const totalEnv = envSites.reduce((sum, entry) => sum + entry.count, 0);
  if (envSites.length >= MIN_SUPPORT && totalEnv > 0) {
    const top = envSites[0];
    const share = top.count / totalEnv;
    const followers = envSites.slice(1);
    if (share >= 0.5 && followers.length > 0) {
      rules.push({
        id: 'config:single-door',
        rule: `Configuration is read through \`${top.path}\`.`,
        basis: `${top.count} of ${totalEnv} environment reads happen there, across ${envSites.length} files.`,
        supporting: top.count,
        violations: followers.map((entry) => ({
          path: entry.path,
          detail: `reads the environment directly ${entry.count} time(s)`,
        })),
        adherence: share,
        summary: `${followers.length} file(s) read the environment directly`,
      });
    } else if (followers.length > 0) {
      weak.push(
        `Configuration is read from ${envSites.length} files with no single door: ${envSites.slice(0, 5).map((entry) => `\`${entry.path}\``).join(', ')}.`,
      );
    }
  }

  // Logging, when the repository has its own logger to go through.
  const loggerFiles = input.files.filter((file) => /(^|\/)(log(ger)?|logging)\.[^/]+$/i.test(file.path)).map((file) => file.path);
  if (loggerFiles.length >= 1) {
    const logger = loggerFiles[0];
    const users: string[] = [];
    const direct: string[] = [];
    for (const source of input.sources) {
      if (source.path === logger) continue;
      const usesLogger = input.imports.some((edge) => edge.from === source.path && edge.to === logger);
      const consoleSites = (source.text.match(/\bconsole\.(log|warn|error|info|debug)\s*\(/g) ?? []).length;
      if (usesLogger) users.push(source.path);
      else if (consoleSites >= 2) direct.push(source.path);
    }
    if (users.length >= MIN_SUPPORT && direct.length > 0) {
      const adherence = users.length / (users.length + direct.length);
      if (adherence >= MIN_ADHERENCE) {
        rules.push({
          id: 'logging:single-door',
          rule: `Logging goes through \`${logger}\`.`,
          basis: `${users.length} files import it; ${direct.length} log directly to the console instead.`,
          supporting: users.length,
          violations: direct.map((path) => ({ path, detail: 'writes to the console instead of the logger' })),
          adherence,
          summary: `${direct.length} file(s) bypass it`,
        });
      } else {
        weak.push(`Console logging and \`${logger}\` are both in use: ${direct.length} file(s) log directly.`);
      }
    }
  }

  // Barrel files, where a directory convention is clear.
  const dirs = new Map<string, string[]>();
  for (const file of input.files) {
    if (file.category !== 'source') continue;
    const dir = dirname(file.path);
    const list = dirs.get(dir) ?? [];
    list.push(file.path);
    dirs.set(dir, list);
  }
  const candidates = [...dirs.entries()].filter(([, list]) => list.length >= 4);
  if (candidates.length >= MIN_SUPPORT) {
    const withBarrel = candidates.filter(([, list]) => list.some((path) => /^(index|__init__|mod)\.[a-z]+$/i.test(basename(path))));
    const adherence = withBarrel.length / candidates.length;
    if (adherence >= MIN_ADHERENCE) {
      const barrelName = basename(withBarrel[0][1].find((path) => /^(index|__init__|mod)\.[a-z]+$/i.test(basename(path))) ?? 'index.ts');
      rules.push({
        id: 'structure:barrel',
        rule: `Directories with several modules re-export through \`${barrelName}\`.`,
        basis: `${withBarrel.length} of ${candidates.length} directories with four or more source files have one.`,
        supporting: withBarrel.length,
        violations: candidates
          .filter(([dir]) => !withBarrel.some(([withDir]) => withDir === dir))
          .map(([dir, list]) => ({ path: dir, detail: `${list.length} source files without a \`${barrelName}\`` })),
        adherence,
        summary: `${candidates.length - withBarrel.length} directory(ies) without one`,
      });
    } else if (adherence >= 0.5) {
      weak.push(`Barrel files are used in ${withBarrel.length} of ${candidates.length} multi-module directories, not consistently.`);
    }
  }

  return rules;
}

export function computeConventions(input: ConventionInput): ConventionsReport {
  const weakPatterns: string[] = [];
  const rules = [
    ...layeringRules(input, weakPatterns),
    ...namingRules(input.files, weakPatterns),
    ...testRules(input.files, weakPatterns, input.testCaseFiles),
    ...singleDoorRules(input, weakPatterns),
  ]
    // Most followed first: a rule with two exceptions is more useful than one
    // with a dozen, and violations are what the reader is being asked to look at.
    .sort((a, b) => b.adherence - a.adherence || b.supporting - a.supporting)
    .map((rule) => ({ ...rule, violations: rule.violations.slice(0, 20) }));

  return {
    rules,
    weakPatterns: [...new Set(weakPatterns)].slice(0, 12),
    summary: { derived: rules.length, violations: rules.reduce((sum, rule) => sum + rule.violations.length, 0) },
    warnings: [],
  };
}

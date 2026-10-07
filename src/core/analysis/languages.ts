import type { FileCategory } from '../types.js';

export interface LanguageInfo {
  id: string;
  label: string;
  family: LanguageFamily;
  color: string;
}

export type LanguageFamily =
  | 'js'
  | 'python'
  | 'go'
  | 'rust'
  | 'jvm'
  | 'dotnet'
  | 'ruby'
  | 'php'
  | 'c'
  | 'swift'
  | 'shell'
  | 'web'
  | 'data'
  | 'docs'
  | 'infra'
  | 'other';

const LANGUAGES: Record<string, LanguageInfo> = {
  ts: { id: 'typescript', label: 'TypeScript', family: 'js', color: '#3178c6' },
  tsx: { id: 'tsx', label: 'TypeScript (React)', family: 'js', color: '#3178c6' },
  mts: { id: 'typescript', label: 'TypeScript', family: 'js', color: '#3178c6' },
  cts: { id: 'typescript', label: 'TypeScript', family: 'js', color: '#3178c6' },
  js: { id: 'javascript', label: 'JavaScript', family: 'js', color: '#f1e05a' },
  jsx: { id: 'jsx', label: 'JavaScript (React)', family: 'js', color: '#f1e05a' },
  mjs: { id: 'javascript', label: 'JavaScript', family: 'js', color: '#f1e05a' },
  cjs: { id: 'javascript', label: 'JavaScript', family: 'js', color: '#f1e05a' },
  py: { id: 'python', label: 'Python', family: 'python', color: '#3572A5' },
  pyi: { id: 'python', label: 'Python', family: 'python', color: '#3572A5' },
  rb: { id: 'ruby', label: 'Ruby', family: 'ruby', color: '#701516' },
  go: { id: 'go', label: 'Go', family: 'go', color: '#00ADD8' },
  rs: { id: 'rust', label: 'Rust', family: 'rust', color: '#dea584' },
  java: { id: 'java', label: 'Java', family: 'jvm', color: '#b07219' },
  kt: { id: 'kotlin', label: 'Kotlin', family: 'jvm', color: '#A97BFF' },
  kts: { id: 'kotlin', label: 'Kotlin', family: 'jvm', color: '#A97BFF' },
  scala: { id: 'scala', label: 'Scala', family: 'jvm', color: '#c22d40' },
  groovy: { id: 'groovy', label: 'Groovy', family: 'jvm', color: '#4298b8' },
  cs: { id: 'csharp', label: 'C#', family: 'dotnet', color: '#178600' },
  fs: { id: 'fsharp', label: 'F#', family: 'dotnet', color: '#b845fc' },
  swift: { id: 'swift', label: 'Swift', family: 'swift', color: '#F05138' },
  m: { id: 'objectivec', label: 'Objective-C', family: 'c', color: '#438eff' },
  mm: { id: 'objectivec', label: 'Objective-C++', family: 'c', color: '#438eff' },
  c: { id: 'c', label: 'C', family: 'c', color: '#555555' },
  h: { id: 'c', label: 'C header', family: 'c', color: '#555555' },
  cc: { id: 'cpp', label: 'C++', family: 'c', color: '#f34b7d' },
  cpp: { id: 'cpp', label: 'C++', family: 'c', color: '#f34b7d' },
  hpp: { id: 'cpp', label: 'C++ header', family: 'c', color: '#f34b7d' },
  cxx: { id: 'cpp', label: 'C++', family: 'c', color: '#f34b7d' },
  php: { id: 'php', label: 'PHP', family: 'php', color: '#4F5D95' },
  sh: { id: 'shell', label: 'Shell', family: 'shell', color: '#89e051' },
  bash: { id: 'shell', label: 'Bash', family: 'shell', color: '#89e051' },
  zsh: { id: 'shell', label: 'Zsh', family: 'shell', color: '#89e051' },
  fish: { id: 'shell', label: 'Fish', family: 'shell', color: '#89e051' },
  ps1: { id: 'powershell', label: 'PowerShell', family: 'shell', color: '#012456' },
  sql: { id: 'sql', label: 'SQL', family: 'data', color: '#e38c00' },
  graphql: { id: 'graphql', label: 'GraphQL', family: 'data', color: '#e10098' },
  gql: { id: 'graphql', label: 'GraphQL', family: 'data', color: '#e10098' },
  proto: { id: 'protobuf', label: 'Protocol Buffers', family: 'data', color: '#6b7280' },
  html: { id: 'html', label: 'HTML', family: 'web', color: '#e34c26' },
  htm: { id: 'html', label: 'HTML', family: 'web', color: '#e34c26' },
  css: { id: 'css', label: 'CSS', family: 'web', color: '#563d7c' },
  scss: { id: 'scss', label: 'SCSS', family: 'web', color: '#c6538c' },
  sass: { id: 'sass', label: 'Sass', family: 'web', color: '#c6538c' },
  less: { id: 'less', label: 'Less', family: 'web', color: '#1d365d' },
  vue: { id: 'vue', label: 'Vue', family: 'js', color: '#41b883' },
  svelte: { id: 'svelte', label: 'Svelte', family: 'js', color: '#ff3e00' },
  astro: { id: 'astro', label: 'Astro', family: 'js', color: '#ff5a03' },
  json: { id: 'json', label: 'JSON', family: 'data', color: '#292929' },
  jsonc: { id: 'json', label: 'JSON with Comments', family: 'data', color: '#292929' },
  yaml: { id: 'yaml', label: 'YAML', family: 'infra', color: '#cb171e' },
  yml: { id: 'yaml', label: 'YAML', family: 'infra', color: '#cb171e' },
  toml: { id: 'toml', label: 'TOML', family: 'infra', color: '#9c4221' },
  ini: { id: 'ini', label: 'INI', family: 'infra', color: '#6b7280' },
  env: { id: 'dotenv', label: 'dotenv', family: 'infra', color: '#6b7280' },
  tf: { id: 'terraform', label: 'Terraform', family: 'infra', color: '#844FBA' },
  tfvars: { id: 'terraform', label: 'Terraform vars', family: 'infra', color: '#844FBA' },
  hcl: { id: 'hcl', label: 'HCL', family: 'infra', color: '#844FBA' },
  dockerfile: { id: 'dockerfile', label: 'Dockerfile', family: 'infra', color: '#384d54' },
  nix: { id: 'nix', label: 'Nix', family: 'infra', color: '#7e7eff' },
  cmake: { id: 'cmake', label: 'CMake', family: 'other', color: '#DA3434' },
  makefile: { id: 'makefile', label: 'Makefile', family: 'other', color: '#427819' },
  md: { id: 'markdown', label: 'Markdown', family: 'docs', color: '#083fa1' },
  mdx: { id: 'mdx', label: 'MDX', family: 'docs', color: '#083fa1' },
  rst: { id: 'rst', label: 'reStructuredText', family: 'docs', color: '#141414' },
  txt: { id: 'text', label: 'Text', family: 'docs', color: '#6b7280' },
  lua: { id: 'lua', label: 'Lua', family: 'other', color: '#000080' },
  r: { id: 'r', label: 'R', family: 'other', color: '#198CE7' },
  jl: { id: 'julia', label: 'Julia', family: 'other', color: '#a270ba' },
  dart: { id: 'dart', label: 'Dart', family: 'other', color: '#00B4AB' },
  ex: { id: 'elixir', label: 'Elixir', family: 'other', color: '#6e4a7e' },
  exs: { id: 'elixir', label: 'Elixir', family: 'other', color: '#6e4a7e' },
  erl: { id: 'erlang', label: 'Erlang', family: 'other', color: '#B83998' },
  hs: { id: 'haskell', label: 'Haskell', family: 'other', color: '#5e5086' },
  clj: { id: 'clojure', label: 'Clojure', family: 'other', color: '#db5855' },
  elm: { id: 'elm', label: 'Elm', family: 'other', color: '#60B5CC' },
  zig: { id: 'zig', label: 'Zig', family: 'other', color: '#ec915c' },
  nim: { id: 'nim', label: 'Nim', family: 'other', color: '#ffc200' },
  sol: { id: 'solidity', label: 'Solidity', family: 'other', color: '#AA6746' },
  pl: { id: 'perl', label: 'Perl', family: 'other', color: '#0298c3' },
  vb: { id: 'vbnet', label: 'Visual Basic', family: 'dotnet', color: '#945db7' },
  csv: { id: 'csv', label: 'CSV', family: 'data', color: '#6b7280' },
  xml: { id: 'xml', label: 'XML', family: 'data', color: '#0060ac' },
  properties: { id: 'properties', label: 'Properties', family: 'infra', color: '#6b7280' },
  ipynb: { id: 'jupyter', label: 'Jupyter Notebook', family: 'data', color: '#DA5B0B' },
  svg: { id: 'svg', label: 'SVG', family: 'web', color: '#ff9900' },
};

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  'procfile': 'text',
  'brewfile': 'ruby',
  'justfile': 'makefile',
  'go.mod': 'go',
  'go.sum': 'go',
  'cargo.toml': 'rust',
  'package.json': 'json',
  'tsconfig.json': 'json',
  '.gitignore': 'text',
  '.dockerignore': 'text',
  '.editorconfig': 'ini',
  '.env': 'dotenv',
  '.env.example': 'dotenv',
  '.npmrc': 'ini',
  'requirements.txt': 'text',
  'pyproject.toml': 'toml',
};

export function detectLanguage(filePath: string): LanguageInfo {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  const direct = FILENAME_LANGUAGES[base];
  if (direct && LANGUAGES[direct]) return LANGUAGES[direct];
  if (base.startsWith('dockerfile')) return LANGUAGES.dockerfile;
  if (base.startsWith('.env')) return LANGUAGES.env;
  const ext = base.includes('.') ? base.split('.').pop() ?? '' : '';
  if (LANGUAGES[ext]) return LANGUAGES[ext];
  return { id: 'unknown', label: 'Other', family: 'other', color: '#6b7280' };
}

export function languageForHighlight(filePath: string): string {
  const info = detectLanguage(filePath);
  const map: Record<string, string> = {
    'typescript': 'typescript',
    'tsx': 'typescript',
    'javascript': 'javascript',
    'jsx': 'javascript',
    'python': 'python',
    'ruby': 'ruby',
    'go': 'go',
    'rust': 'rust',
    'java': 'java',
    'kotlin': 'kotlin',
    'scala': 'scala',
    'groovy': 'groovy',
    'csharp': 'csharp',
    'fsharp': 'fsharp',
    'objectivec': 'objectivec',
    'c': 'c',
    'cpp': 'cpp',
    'php': 'php',
    'swift': 'swift',
    'shell': 'bash',
    'powershell': 'powershell',
    'sql': 'sql',
    'graphql': 'graphql',
    'protobuf': 'protobuf',
    'html': 'xml',
    'xml': 'xml',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'json': 'json',
    'yaml': 'yaml',
    'toml': 'ini',
    'ini': 'ini',
    'dotenv': 'bash',
    'terraform': 'hcl',
    'hcl': 'hcl',
    'nix': 'nix',
    'dockerfile': 'dockerfile',
    'markdown': 'markdown',
    'mdx': 'markdown',
    'lua': 'lua',
    'dart': 'dart',
    'elixir': 'elixir',
    'clojure': 'clojure',
    'haskell': 'haskell',
    'perl': 'perl',
    'r': 'r',
  };
  return map[info.id] ?? 'plaintext';
}

const TEST_PATTERNS = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /(^|\/)test_/,
  /_test\./,
  /\.test\./,
  /\.spec\./,
  /(^|\/)spec\//,
  /(^|\/)e2e\//,
  /(^|\/)cypress\//,
  /(^|\/)playwright\//,
  /Tests?\.(java|kt|cs|swift|rb)$/,
  /_test\.(go|py)$/,
  /(^|\/)conftest\.py$/,
];

const DOC_PATTERNS = [/(^|\/)docs?\//i, /(^|\/)documentation\//i, /\.mdx?$/i, /\.rst$/i, /(^|\/)adr\//i];

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.map$/,
  /_pb2\.py$/,
  /_pb2_grpc\.py$/,
  /\.generated\./,
  /(^|\/)generated\//,
  /(^|\/)__generated__\//,
  /\.g\.dart$/,
  /\.freezed\.dart$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)third_party\//,
  /(^|\/)\.next\//,
];

const NOISE_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'npm-shrinkwrap.json',
  'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
  'packages.lock.json', 'gradle.lockfile', 'pubspec.lock', 'mix.lock', 'flake.lock',
]);

const CONFIG_BASENAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js',
  'webpack.config.js', 'rollup.config.js', 'jest.config.js', 'jest.config.ts', 'vitest.config.ts',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile', 'tox.ini',
  'cargo.toml', 'go.mod', 'gemfile', 'composer.json', 'build.gradle', 'build.gradle.kts',
  'pom.xml', 'cmakelists.txt', 'makefile', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'tsconfig.base.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.babelrc',
  'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'svelte.config.js', 'angular.json',
  'terraform.tf', 'main.tf', 'variables.tf', 'serverless.yml', 'netlify.toml', 'vercel.json',
]);

export function isTestPath(filePath: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(filePath));
}

export function isDocPath(filePath: string): boolean {
  return DOC_PATTERNS.some((re) => re.test(filePath));
}

export function isGeneratedPath(filePath: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(filePath));
}

export function isNoiseFile(filePath: string): boolean {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (NOISE_FILES.has(base)) return true;
  if (base.endsWith('.lock') || base.endsWith('.lock.json')) return true;
  return isGeneratedPath(filePath);
}

export function isConfigPath(filePath: string): boolean {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  if (CONFIG_BASENAMES.has(base)) return true;
  if (base.startsWith('.')) {
    const ext = base.split('.').pop() ?? '';
    return ['json', 'yaml', 'yml', 'toml', 'ini', 'js', 'ts', 'cjs', 'mjs', 'rc'].includes(ext) || !base.includes('.');
  }
  const lang = detectLanguage(filePath);
  if (lang.family === 'infra' && !filePath.startsWith('.github/workflows')) return true;
  return /\.(config|conf)\.(js|ts|cjs|mjs|json|yaml|yml)$/.test(base);
}

export function classifyFile(filePath: string): FileCategory {
  if (isNoiseFile(filePath)) return 'generated';
  if (isTestPath(filePath)) return 'test';
  const lang = detectLanguage(filePath);
  if (lang.id === 'svg') return 'asset';
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|mov|pdf)$/i.test(filePath)) return 'asset';
  if (/(^|\/)dist\/|(^|\/)build\/|(^|\/)out\//.test(filePath)) return 'build';
  if (lang.family === 'docs') return isDocPath(filePath) || /\.(md|mdx|rst|txt)$/i.test(filePath) ? 'docs' : 'other';
  if (lang.family === 'infra' || isConfigPath(filePath)) return 'config';
  if (lang.family === 'data' && /\.(csv|tsv|parquet|ndjson|jsonl)$/i.test(filePath)) return 'data';
  if (lang.family === 'data' || lang.family === 'other') return lang.id === 'unknown' ? 'other' : 'config';
  return 'source';
}

/** Languages we can meaningfully parse for symbols and imports. */
export function isParsable(languageId: string): boolean {
  return PARSEABLE.has(languageId);
}

const PARSEABLE = new Set([
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin',
  'scala', 'csharp', 'fsharp', 'ruby', 'php', 'c', 'cpp', 'swift', 'shell', 'vue', 'svelte',
]);

export function languageInfo(languageId: string): LanguageInfo {
  return Object.values(LANGUAGES).find((l) => l.id === languageId) ?? { id: 'unknown', label: 'Other', family: 'other', color: '#6b7280' };
}

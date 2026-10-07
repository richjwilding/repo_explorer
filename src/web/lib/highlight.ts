import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: Record<string, unknown> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  plaintext,
  php,
  python,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition as never);
}

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  toml: 'ini',
  hcl: 'ini',
  terraform: 'ini',
  md: 'markdown',
  mdx: 'markdown',
  html: 'xml',
  svg: 'xml',
  proto: 'plaintext',
  protobuf: 'plaintext',
  graphql: 'plaintext',
  text: 'plaintext',
  dotenv: 'bash',
  h: 'c',
  hpp: 'cpp',
  scss: 'scss',
};

export function normaliseLanguage(language: string | undefined): string {
  if (!language) return 'plaintext';
  const lower = language.toLowerCase();
  const resolved = ALIASES[lower] ?? lower;
  return LANGUAGES[resolved] ? resolved : 'plaintext';
}

/** Highlight code to HTML. Falls back to escaped plaintext on any failure. */
export function highlightCode(code: string, language?: string): { html: string; language: string } {
  const resolved = normaliseLanguage(language);
  try {
    return { html: hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value, language: resolved };
  } catch {
    return { html: hljs.highlight(code, { language: 'plaintext', ignoreIllegals: true }).value, language: 'plaintext' };
  }
}

export function highlightAuto(code: string): { html: string; language: string } {
  try {
    const result = hljs.highlightAuto(code);
    return { html: result.value, language: result.language ?? 'plaintext' };
  } catch {
    return { html: hljs.highlight(code, { language: 'plaintext', ignoreIllegals: true }).value, language: 'plaintext' };
  }
}

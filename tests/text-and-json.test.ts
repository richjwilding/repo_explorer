import { describe, expect, it } from 'vitest';
import { escapeControlCharsInStrings, extractJson, parseJsonLoose, peekJsonStringField, stripFences } from '../src/core/llm/json.js';
import { countLines, firstLines, jaccard, splitIdentifier, tokenize, truncate } from '../src/core/util/text.js';

describe('tokenize', () => {
  it('splits camelCase, snake_case and dotted identifiers', () => {
    expect(splitIdentifier('getUserName')).toEqual(['get', 'user', 'name']);
    expect(splitIdentifier('HTTPRequestHandler')).toEqual(['http', 'request', 'handler']);
    expect(splitIdentifier('ingest_job_v2')).toEqual(['ingest', 'job', 'v2']);
  });

  it('drops stopwords but keeps the original compound token', () => {
    const tokens = tokenize('const reindexSweep = true');
    expect(tokens).toContain('reindex');
    expect(tokens).toContain('sweep');
    expect(tokens).toContain('reindexsweep');
    expect(tokens).not.toContain('const');
  });
});

describe('text helpers', () => {
  it('truncates on a line boundary when it can', () => {
    const text = 'a\n'.repeat(50);
    const result = truncate(text, 20);
    expect(result.length).toBeLessThanOrEqual(20 + 20);
    expect(result).toContain('truncated');
  });

  it('counts and slices lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\nc')).toBe(3);
    expect(firstLines('a\nb\nc\nd', 2)).toBe('a\nb');
  });

  it('measures similarity', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });
});

describe('JSON extraction', () => {
  it('parses fenced JSON with prose around it', () => {
    const raw = 'Here you go:\n```json\n{"title": "x", "sections": []}\n```\nHope that helps.';
    expect(parseJsonLoose<{ title: string }>(raw)?.title).toBe('x');
  });

  it('repairs trailing commas and smart quotes', () => {
    const raw = '{"title": “quoted”, "n": 1,}';
    const parsed = parseJsonLoose<{ title: string; n: number }>(raw);
    expect(parsed?.title).toBe('quoted');
    expect(parsed?.n).toBe(1);
  });

  it('closes a truncated object', () => {
    const raw = '{"title": "half", "sections": [{"type": "prose", "title": "a"';
    const parsed = parseJsonLoose<{ title: string }>(raw);
    expect(parsed?.title).toBe('half');
  });

  it('repairs real newlines inside string literals', () => {
    // Regression: long markdown fields arrive with literal line breaks, which
    // JSON forbids. A perfectly good explainer was discarded and the reader got
    // the static outline instead.
    const raw = '{"final":{"title":"x","tldr":"line one\nline two","sections":[{"type":"prose","markdown":"a\nb"}]}}';
    const parsed = parseJsonLoose<{ final: { tldr: string; sections: { markdown: string }[] } }>(raw);
    expect(parsed?.final.tldr).toBe('line one\nline two');
    expect(parsed?.final.sections[0].markdown).toBe('a\nb');
  });

  it('repairs tabs and other control characters inside strings', () => {
    const raw = '{"tldr":"a\tb\u0000c"}';
    expect(parseJsonLoose<{ tldr: string }>(raw)?.tldr).toBe('a\tb\u0000c');
  });

  it('leaves already-escaped newlines alone', () => {
    const parsed = parseJsonLoose<{ tldr: string }>('{"tldr":"line one\\nline two"}');
    expect(parsed?.tldr).toBe('line one\nline two');
  });

  it('repairs a truncated string ending in a dangling backslash', () => {
    // A dangling escape would otherwise swallow the quote added by the repair.
    const parsed = parseJsonLoose<{ final: { tldr: string } }>('{"final":{"tldr":"ends with a backslash \\');
    expect(parsed?.final.tldr).toContain('ends with a backslash');
  });

  it('handles both problems at once, which is the realistic case', () => {
    const raw = '{"title":"x","sections":[{"type":"prose","markdown":"one\ntwo","caption":"three\nfour"}';
    const parsed = parseJsonLoose<{ sections: { markdown: string }[] }>(raw);
    expect(parsed?.sections[0].markdown).toBe('one\ntwo');
  });

  it('reports control characters it escaped without touching structure', () => {
    const escaped = escapeControlCharsInStrings('{"a":"x\ny","b":1}');
    expect(escaped).toBe('{"a":"x\\ny","b":1}');
  });

  it('returns null for prose with no JSON', () => {
    expect(extractJson('there is nothing structured here')).toBeNull();
  });

  it('peeks at a streaming field', () => {
    expect(peekJsonStringField('{"title": "Partial ti', 'title')).toBe('Partial ti');
  });

  it('only strips well-formed fences', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

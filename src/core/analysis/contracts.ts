/**
 * Contracts and the data model: the shape of the data, which is often the
 * fastest route into an unfamiliar system.
 *
 * A codebase's structure tells you how it is arranged; its data tells you what
 * it is about. These are read from the files that declare the shape — SQL
 * migrations, ORM schemas, and API definitions — because a schema is a claim the
 * system makes about the world, and it is usually the most stable thing in a
 * repository.
 *
 * Every parser here is deliberately conservative: it reports what it can read
 * unambiguously and says so when a file looked like a contract but could not be
 * understood, rather than guessing at a shape.
 */
import { parse as parseYaml } from 'yaml';
import { isTestOrFixturePath } from './ops.js';

export interface FieldSpec {
  name: string;
  type: string;
  optional: boolean;
  line: number;
  note?: string;
}

export interface ForeignKey {
  column: string;
  references: string;
  line: number;
}

export interface OperationSpec {
  name: string;
  /** get/post/rpc/query/mutation/subscription. */
  kind: string;
  line: number;
}

export interface SchemaSpec {
  name: string;
  /** table, model, type, input, enum, message, service, schema. */
  kind: string;
  source: 'sql' | 'prisma' | 'graphql' | 'protobuf' | 'openapi' | 'json-schema';
  path: string;
  line: number;
  fields: FieldSpec[];
  primaryKey: string[];
  foreignKeys: ForeignKey[];
  operations: OperationSpec[];
}

export interface MigrationFile {
  path: string;
  statements: number;
  creates: string[];
  alters: string[];
}

export interface ApiSpecFile {
  path: string;
  format: 'openapi' | 'graphql' | 'protobuf' | 'json-schema';
  operations: number;
  schemas: number;
}

export interface DataModelReport {
  schemas: SchemaSpec[];
  migrations: MigrationFile[];
  apiSpecs: ApiSpecFile[];
  summary: {
    tables: number;
    schemas: number;
    apiSpecs: number;
    migrations: number;
    foreignKeys: number;
    /** Storage technologies named by code outside tests. */
    stores: string[];
    /** Named only in tests or fixtures, so not a deployment requirement. */
    testOnlyStores: string[];
  };
  warnings: string[];
}

export const EMPTY_DATA_MODEL: DataModelReport = {
  schemas: [],
  migrations: [],
  apiSpecs: [],
  summary: { tables: 0, schemas: 0, apiSpecs: 0, migrations: 0, foreignKeys: 0, stores: [], testOnlyStores: [] },
  warnings: [],
};

export interface DataModelFileInput {
  path: string;
  text: string | null;
}

export interface DataModelInput {
  files: DataModelFileInput[];
  /**
   * External dependencies, so the report can say which stores are used. Evidence
   * is used to separate a store the code talks to from one a fixture mentions.
   */
  dependencies?: { name: string; category: string; label?: string; kind?: string; evidence?: string[] }[];
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

export function isSqlFile(path: string): boolean {
  return /\.sql$/i.test(path);
}

export function isMigrationFile(path: string): boolean {
  return /\.sql$/i.test(path) && /(^|\/)(migrations?|migrate|db|sql|schema|ddl)(\/|$)/i.test(path);
}

export function isPrismaFile(path: string): boolean {
  return /\.prisma$/i.test(path);
}

export function isGraphqlFile(path: string): boolean {
  return /\.(graphql|gql)$/i.test(path);
}

export function isProtoFile(path: string): boolean {
  return /\.proto$/i.test(path);
}

/** OpenAPI and JSON Schema are JSON or YAML, so they have to be sniffed. */
function looksLikeOpenApi(text: string): boolean {
  return /^\s*["']?(openapi|swagger)["']?\s*:/m.test(text) || /"openapi"\s*:/.test(text);
}

function looksLikeJsonSchema(text: string): boolean {
  return /"\$schema"\s*:/.test(text) || /^\s*["']?\$schema["']?\s*:/m.test(text);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

/** Best-effort line for a name in a document we parsed rather than scanned. */
function lineOfName(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^[ \\t]*["']?${escaped}["']?\\s*:`, 'm').exec(text);
  return match ? countNewlines(text.slice(0, match.index)) + 1 : 1;
}

/** The body of a parenthesised block starting at `start`, honouring nesting. */
function balancedBody(text: string, start: number): { body: string; end: number } | null {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
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
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/**
 * Split on commas that are not inside parentheses or quotes, keeping each
 * part's offset so a line number can be attributed correctly.
 */
function splitTopLevel(body: string): { text: string; offset: number }[] {
  const parts: { text: string; offset: number }[] = [];
  let current = '';
  let start = 0;
  let depth = 0;
  let inSingle = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push({ text: current, offset: start });
      current = '';
      start = i + 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push({ text: current, offset: start });
  return parts;
}

const SQL_CONSTRAINT_RE = /^\s*(?:constraint\s+\S+\s+)?(primary\s+key|unique|foreign\s+key|check|key|index|exclude)\b/i;

export function parseSqlSchemas(path: string, text: string): SchemaSpec[] {
  const schemas: SchemaSpec[] = [];
  const createRe = /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\]\w.]+)\s*\(/gi;
  for (const match of text.matchAll(createRe)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    const block = balancedBody(text, openIndex);
    if (!block) continue;
    const name = match[1].replace(/["`[\]]/g, '').split('.').pop() as string;
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    const bodyStartLine = text.slice(0, openIndex).split('\n').length;
    const fields: FieldSpec[] = [];
    const primaryKey: string[] = [];
    const foreignKeys: ForeignKey[] = [];

    for (const { text: raw, offset } of splitTopLevel(block.body)) {
      const part = raw.trim();
      if (!part) continue;
      // The body's first line plus every newline before this part's first real
      // character — the leading whitespace is part of the part, and skipping it
      // put every column one line too high.
      const leading = /^\s*/.exec(raw)?.[0] ?? '';
      const partLine = bodyStartLine + countNewlines(block.body.slice(0, offset + leading.length));
      if (SQL_CONSTRAINT_RE.test(part)) {
        const pk = /^primary\s+key\s*\(([^)]*)\)/i.exec(part.replace(/^constraint\s+\S+\s+/i, ''));
        if (pk) for (const column of pk[1].split(',')) primaryKey.push(column.trim().replace(/["`]/g, ''));
        const fk = /foreign\s+key\s*\(([^)]+)\)\s*references\s+([`"[\]\w.]+)\s*(?:\(([^)]*)\))?/i.exec(part);
        if (fk) {
          foreignKeys.push({
            column: fk[1].trim().replace(/["`]/g, ''),
            references: `${fk[2].replace(/["`]/g, '')}${fk[3] ? `(${fk[3].trim().replace(/["`]/g, '')})` : ''}`,
            line: partLine,
          });
        }
        continue;
      }
      const column = /^([`"[\]]?[\w.]+[`"\]]?)\s+(.+)$/.exec(part);
      if (!column) continue;
      const columnName = column[1].replace(/["`[\]]/g, '');
      const rest = column[2];
      // A type ends where the constraints begin: `BIGSERIAL PRIMARY KEY` is a
      // BIGSERIAL, and taking the whole line as the type was plainly wrong.
      const stop = rest.search(/\b(not|null|default|primary|unique|references|check|constraint|collate|generated|auto_increment|identity|comment)\b/i);
      const type = (stop === -1 ? rest : rest.slice(0, stop)).trim() || 'unknown';
      if (/\bprimary\s+key\b/i.test(rest)) primaryKey.push(columnName);
      const inlineFk = /references\s+([`"[\]\w.]+)\s*(?:\(([^)]*)\))?/i.exec(rest);
      if (inlineFk) {
        foreignKeys.push({
          column: columnName,
          references: `${inlineFk[1].replace(/["`]/g, '')}${inlineFk[2] ? `(${inlineFk[2].trim().replace(/["`]/g, '')})` : ''}`,
          line: partLine,
        });
      }
      const note = /\bnot\s+null\b/i.test(rest) ? undefined : /\bdefault\b/i.test(rest) ? 'has a default' : 'nullable';
      fields.push({ name: columnName, type, optional: !/\bnot\s+null\b/i.test(rest), line: partLine, note });
    }

    // A primary key column cannot be null, whatever the column line omits — and
    // leaving the "nullable" note in place contradicted the flag.
    for (const field of fields) {
      if (!primaryKey.includes(field.name)) continue;
      field.optional = false;
      if (field.note === 'nullable') field.note = undefined;
    }

    // ALTER TABLE statements elsewhere in the file often carry the keys.
    schemas.push({
      name,
      kind: 'table',
      source: 'sql',
      path,
      line,
      fields,
      primaryKey: [...new Set(primaryKey)],
      foreignKeys,
      operations: [],
    });
  }

  // Keys added after the fact, which is how most migrations express them.
  for (const match of text.matchAll(/\bALTER\s+TABLE\s+(?:ONLY\s+)?([`"[\]\w.]+)[\s\S]{0,400}?ADD\s+(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([`"[\]\w.]+)\s*(?:\(([^)]*)\))?/gi)) {
    const table = match[1].replace(/["`[\]]/g, '').split('.').pop() as string;
    const target = schemas.find((schema) => schema.name === table);
    if (!target) continue;
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    target.foreignKeys.push({
      column: match[2].trim().replace(/["`]/g, ''),
      references: `${match[3].replace(/["`]/g, '')}${match[4] ? `(${match[4].trim().replace(/["`]/g, '')})` : ''}`,
      line,
    });
  }

  return schemas;
}

export function summariseMigrations(path: string, text: string, schemas: SchemaSpec[]): MigrationFile {
  return {
    path,
    statements: (text.match(/;/g) ?? []).length,
    creates: schemas.filter((schema) => schema.path === path).map((schema) => schema.name),
    alters: [...new Set([...text.matchAll(/\bALTER\s+TABLE\s+(?:ONLY\s+)?([`"[\]\w.]+)/gi)].map((match) => match[1].replace(/["`[\]]/g, '').split('.').pop() as string))],
  };
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

export function parsePrismaSchemas(path: string, text: string): SchemaSpec[] {
  const schemas: SchemaSpec[] = [];
  for (const match of text.matchAll(/^\s*model\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const name = match[1];
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    // The body capture begins with the newline after `{`, so index 0 is still
    // the declaration's own line.
    const bodyStart = text.slice(0, match.index ?? 0).split('\n').length;
    const fields: FieldSpec[] = [];
    const primaryKey: string[] = [];
    match[2].split('\n').forEach((raw, index) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) {
        // `@@id([a, b])` declares a composite key.
        const composite = /^@@id\(\s*\[([^\]]+)\]/.exec(trimmed);
        if (composite) for (const column of composite[1].split(',')) primaryKey.push(column.trim());
        return;
      }
      const field = /^(\w+)\s+([\w[\]?]+)(.*)$/.exec(trimmed);
      if (!field) return;
      if (/@id\b/.test(field[3])) primaryKey.push(field[1]);
      const isList = field[2].endsWith('[]');
      const isOptional = field[2].endsWith('?');
      const note = /@relation\b/.test(field[3])
        ? 'relation'
        : /@unique\b/.test(field[3])
          ? 'unique'
          : isList
            ? 'list'
            : undefined;
      fields.push({
        name: field[1],
        // `String?` is a nullable String, not a type called "String?".
        type: field[2].replace(/\[\]$/, '').replace(/\?$/, ''),
        optional: isOptional || isList,
        line: bodyStart + index,
        note,
      });
    });
    schemas.push({ name, kind: 'model', source: 'prisma', path, line, fields, primaryKey, foreignKeys: [], operations: [] });
  }
  for (const match of text.matchAll(/^\s*enum\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    const bodyStart = line;
    const fields = match[2]
      .split('\n')
      .map((raw, index) => ({ raw: raw.trim(), index }))
      .filter((entry) => entry.raw && !entry.raw.startsWith('//'))
      .map((entry) => ({ name: entry.raw.split(/\s+/)[0], type: 'enum value', optional: false, line: bodyStart + entry.index }));
    schemas.push({ name: match[1], kind: 'enum', source: 'prisma', path, line, fields, primaryKey: [], foreignKeys: [], operations: [] });
  }
  return schemas;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

export function parseGraphqlSchemas(path: string, text: string): SchemaSpec[] {
  const schemas: SchemaSpec[] = [];
  const re = /^\s*(type|input|interface|enum|union|scalar)\s+(\w+)[^{]*\{([\s\S]*?)^\s*\}/gm;
  for (const match of text.matchAll(re)) {
    const kind = match[1];
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    const bodyStart = line;
    const fields: FieldSpec[] = [];
    match[3].split('\n').forEach((raw, index) => {
      const trimmed = raw.replace(/#.*$/, '').trim();
      if (!trimmed) return;
      if (kind === 'enum') {
        fields.push({ name: trimmed.split(/[\s(]/)[0], type: 'enum value', optional: false, line: bodyStart + index });
        return;
      }
      const field = /^(\w+)\s*(?:\([^)]*\))?\s*:\s*(.+)$/.exec(trimmed);
      if (!field) return;
      fields.push({ name: field[1], type: field[2].trim(), optional: field[2].trim().endsWith('!') === false, line: bodyStart + index });
    });
    schemas.push({ name: match[2], kind, source: 'graphql', path, line, fields, primaryKey: [], foreignKeys: [], operations: [] });
  }

  for (const match of text.matchAll(/^\s*(type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const kind = match[2].toLowerCase();
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    const bodyStart = line;
    const operations = match[3]
      .split('\n')
      .map((raw, index) => ({ raw: raw.replace(/#.*$/, '').trim(), index }))
      .filter((entry) => entry.raw)
      .map((entry) => ({ name: entry.raw.split(/[\s(:]/)[0], kind, line: bodyStart + entry.index }));
    if (operations.length === 0) continue;
    const existing = schemas.find((schema) => schema.name === match[2]);
    if (existing) existing.operations.push(...operations);
    else schemas.push({ name: match[2], kind: 'operation root', source: 'graphql', path, line, fields: [], primaryKey: [], foreignKeys: [], operations });
  }

  return schemas;
}

// ---------------------------------------------------------------------------
// Protobuf
// ---------------------------------------------------------------------------

export function parseProtoSchemas(path: string, text: string): SchemaSpec[] {
  const schemas: SchemaSpec[] = [];
  const re = /^\s*(message|enum)\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm;
  for (const match of text.matchAll(re)) {
    const kind = match[1];
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    const bodyStart = line;
    const fields: FieldSpec[] = [];
    // `;` terminates a protobuf field, so breaking on it as well as newlines
    // means a compact single-line message or enum still reads correctly.
    match[3].replace(/;/g, ';\n').split('\n').forEach((raw, index) => {
      const trimmed = raw.replace(/\/\/.*$/, '').trim();
      if (!trimmed) return;
      if (kind === 'enum') {
        const value = /^(\w+)\s*=/.exec(trimmed);
        if (value) fields.push({ name: value[1], type: 'enum value', optional: false, line: bodyStart + index });
        return;
      }
      // `repeated string names = 1;` / `map<string, int32> counts = 2;`
      const field = /^(repeated\s+|optional\s+|required\s+)?([\w.<>, ]+?)\s+(\w+)\s*=\s*\d+/.exec(trimmed);
      if (!field) return;
      fields.push({
        name: field[3],
        type: field[2].trim(),
        optional: field[1]?.trim() === 'optional' || field[1]?.trim() === 'repeated',
        line: bodyStart + index,
      });
    });
    schemas.push({ name: match[2], kind, source: 'protobuf', path, line, fields, primaryKey: [], foreignKeys: [], operations: [] });
  }

  for (const match of text.matchAll(/^\s*service\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    const line = text.slice(0, match.index ?? 0).split('\n').length;
    const bodyStart = line;
    const operations = match[2]
      .split('\n')
      .map((raw, index) => ({ raw: raw.replace(/\/\/.*$/, '').trim(), index }))
      .map((entry) => /^rpc\s+(\w+)/.exec(entry.raw))
      .filter((entry): entry is RegExpExecArray => Boolean(entry))
      .map((entry) => ({ name: entry[1], kind: 'rpc', line: bodyStart + entry.index }));
    schemas.push({ name: match[1], kind: 'service', source: 'protobuf', path, line, fields: [], primaryKey: [], foreignKeys: [], operations });
  }

  return schemas;
}

// ---------------------------------------------------------------------------
// OpenAPI and JSON Schema
// ---------------------------------------------------------------------------

function fieldFromJsonSchema(name: string, value: unknown): FieldSpec {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const type = record.type;
  let label = typeof type === 'string' ? type : Array.isArray(type) ? type.join(' | ') : 'any';
  if (typeof record.$ref === 'string') label = record.$ref.split('/').pop() ?? 'ref';
  else if (record.items) label = `${label} of ${fieldFromJsonSchema('_', record.items).type}`;
  else if (Array.isArray(record.enum)) label = `enum(${record.enum.slice(0, 4).map(String).join(' | ')})`;
  const noteParts: string[] = [];
  if (record.format) noteParts.push(String(record.format));
  if (record.description) noteParts.push(String(record.description).slice(0, 80));
  return { name, type: label, optional: true, line: 1, note: noteParts.join(' — ') || undefined };
}

export function parseOpenApi(path: string, text: string): { schemas: SchemaSpec[]; operations: number } {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return { schemas: [], operations: 0 };
  }
  if (!doc || typeof doc !== 'object') return { schemas: [], operations: 0 };
  const root = doc as Record<string, unknown>;
  const schemas: SchemaSpec[] = [];
  let operations = 0;

  const components = root.components && typeof root.components === 'object' ? (root.components as Record<string, unknown>) : undefined;
  const rawSchemas = (components?.schemas ?? root.definitions) as Record<string, unknown> | undefined;
  if (rawSchemas && typeof rawSchemas === 'object') {
    for (const [name, value] of Object.entries(rawSchemas)) {
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const properties = record.properties && typeof record.properties === 'object' ? (record.properties as Record<string, unknown>) : {};
      const required = new Set(Array.isArray(record.required) ? record.required.map(String) : []);
      const fields = Object.entries(properties).map(([fieldName, fieldValue]) => {
        const spec = fieldFromJsonSchema(fieldName, fieldValue);
        return { ...spec, optional: !required.has(fieldName), line: lineOfName(text, fieldName) };
      });
      schemas.push({ name, kind: 'schema', source: 'openapi', path, line: lineOfName(text, name), fields, primaryKey: [], foreignKeys: [], operations: [] });
    }
  }

  const paths = root.paths && typeof root.paths === 'object' ? (root.paths as Record<string, unknown>) : undefined;
  if (paths) {
    const operationsByPath: OperationSpec[] = [];
    for (const [routePath, value] of Object.entries(paths)) {
      if (!value || typeof value !== 'object') continue;
      for (const [method, operation] of Object.entries(value as Record<string, unknown>)) {
        if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
        operations += 1;
        const opId =
          operation && typeof operation === 'object' && typeof (operation as Record<string, unknown>).operationId === 'string'
            ? ((operation as Record<string, unknown>).operationId as string)
            : routePath;
        operationsByPath.push({ name: `${method.toUpperCase()} ${opId}`, kind: method, line: 1 });
      }
    }
    if (operationsByPath.length > 0) {
      schemas.push({ name: 'paths', kind: 'operation root', source: 'openapi', path, line: 1, fields: [], primaryKey: [], foreignKeys: [], operations: operationsByPath });
    }
  }

  return { schemas, operations };
}

export function parseJsonSchema(path: string, text: string): SchemaSpec[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  if (!doc || typeof doc !== 'object') return [];
  const root = doc as Record<string, unknown>;
  const properties = root.properties && typeof root.properties === 'object' ? (root.properties as Record<string, unknown>) : undefined;
  if (!properties) return [];
  const required = new Set(Array.isArray(root.required) ? root.required.map(String) : []);
  const fields = Object.entries(properties).map(([fieldName, value]) => {
    const spec = fieldFromJsonSchema(fieldName, value);
    return { ...spec, optional: !required.has(fieldName), line: lineOfName(text, fieldName) };
  });
  const name = typeof root.title === 'string' ? root.title : (path.split('/').pop() ?? path).replace(/\.json$/, '');
  return [{ name, kind: 'schema', source: 'json-schema', path, line: 1, fields, primaryKey: [], foreignKeys: [], operations: [] }];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const MAX_CONTRACT_BYTES = 500_000;

export function computeDataModel(input: DataModelInput): DataModelReport {
  const schemas: SchemaSpec[] = [];
  const migrations: MigrationFile[] = [];
  const apiSpecs: ApiSpecFile[] = [];
  const warnings: string[] = [];

  for (const file of input.files) {
    if (file.text === null) continue;
    if (file.text.length > MAX_CONTRACT_BYTES) continue;
    const text = file.text;

    if (isPrismaFile(file.path)) {
      const found = parsePrismaSchemas(file.path, text);
      if (found.length === 0 && /model\s/.test(text)) warnings.push(`${file.path} looked like a Prisma schema but no models could be read.`);
      schemas.push(...found);
      continue;
    }
    if (isGraphqlFile(file.path)) {
      const found = parseGraphqlSchemas(file.path, text);
      if (found.length > 0) {
        apiSpecs.push({ path: file.path, format: 'graphql', operations: found.reduce((sum, schema) => sum + schema.operations.length, 0), schemas: found.length });
        schemas.push(...found);
      }
      continue;
    }
    if (isProtoFile(file.path)) {
      const found = parseProtoSchemas(file.path, text);
      if (found.length > 0) {
        apiSpecs.push({
          path: file.path,
          format: 'protobuf',
          operations: found.reduce((sum, schema) => sum + schema.operations.length, 0),
          schemas: found.filter((schema) => schema.kind === 'message').length,
        });
        schemas.push(...found);
      }
      continue;
    }
    if (isSqlFile(file.path)) {
      const found = parseSqlSchemas(file.path, text);
      // Only schema-bearing SQL counts as a migration; a query file does not.
      if (found.length > 0) {
        migrations.push(summariseMigrations(file.path, text, found));
        schemas.push(...found);
      }
      continue;
    }
    if (/\.(json|ya?ml)$/i.test(file.path)) {
      if (looksLikeOpenApi(text)) {
        const { schemas: found, operations } = parseOpenApi(file.path, text);
        if (found.length > 0 || operations > 0) {
          apiSpecs.push({ path: file.path, format: 'openapi', operations, schemas: found.filter((schema) => schema.kind === 'schema').length });
          schemas.push(...found);
        }
      } else if (looksLikeJsonSchema(text)) {
        const found = parseJsonSchema(file.path, text);
        if (found.length > 0) {
          apiSpecs.push({ path: file.path, format: 'json-schema', operations: 0, schemas: 1 });
          schemas.push(...found);
        }
      }
    }
  }

  // Migrations read in path order, since that is the order they would apply.
  migrations.sort((a, b) => a.path.localeCompare(b.path));
  schemas.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  // A store named only inside a test fixture is not something anyone deploys.
  // Without this, a repository whose tests mention `postgres://` was reported as
  // using PostgreSQL.
  const storage = (input.dependencies ?? [])
    .filter((dependency) => ['database', 'search', 'cache', 'queue', 'storage'].includes(dependency.category))
    .filter((dependency) => !('kind' in dependency && dependency.kind === 'dev'));
  const withEvidence = storage.filter((dependency) => 'evidence' in dependency);
  const real = withEvidence.length > 0 ? withEvidence.filter((dependency) => (dependency.evidence as string[]).some((file) => !isTestOrFixturePath(file))) : storage;
  const testOnly = withEvidence.filter((dependency) => !real.includes(dependency));
  const stores = [...new Set(real.map((dependency) => dependency.label ?? dependency.name))].sort();
  const testOnlyStores = [...new Set(testOnly.map((dependency) => dependency.label ?? dependency.name))]
    .filter((name) => !stores.includes(name))
    .sort();

  const tables = schemas.filter((schema) => schema.kind === 'table' || schema.kind === 'model').length;

  return {
    schemas,
    migrations,
    apiSpecs,
    summary: {
      tables,
      schemas: schemas.length,
      apiSpecs: apiSpecs.length,
      migrations: migrations.length,
      foreignKeys: schemas.reduce((sum, schema) => sum + schema.foreignKeys.length, 0),
      stores,
      testOnlyStores,
    },
    warnings,
  };
}

/** How the data model reads in a digest: dense, factual, and explicit about absence. */
export function describeDataModel(report: DataModelReport): string[] {
  const lines: string[] = [];
  const { summary } = report;
  if (summary.stores.length > 0) lines.push(`Storage named in the code: ${summary.stores.join(', ')}.`);
  if (summary.testOnlyStores.length > 0) {
    lines.push(`${summary.testOnlyStores.join(', ')} ${summary.testOnlyStores.length === 1 ? 'appears' : 'appear'} only in tests or fixtures.`);
  }
  if (summary.tables > 0) {
    const names = report.schemas
      .filter((schema) => schema.kind === 'table' || schema.kind === 'model')
      .slice(0, 12)
      .map((schema) => schema.name);
    lines.push(`${summary.tables} table(s)/model(s): ${names.join(', ')}${summary.tables > names.length ? ` (+${summary.tables - names.length} more)` : ''}.`);
  }
  if (summary.foreignKeys > 0) lines.push(`${summary.foreignKeys} foreign key(s) are declared.`);
  if (summary.migrations > 0) lines.push(`${summary.migrations} schema file(s), the first being \`${report.migrations[0].path}\`.`);
  if (summary.tables === 0 && summary.stores.length > 0) {
    lines.push('A database is used but no table definitions were found in the repository — the schema may live elsewhere.');
  }
  if (summary.apiSpecs > 0) {
    lines.push(`API definitions: ${report.apiSpecs.map((spec) => `${spec.path} (${spec.format}${spec.operations > 0 ? `, ${spec.operations} operation(s)` : ''})`).join(', ')}.`);
  }
  const enums = report.schemas.filter((schema) => schema.kind === 'enum').length;
  if (enums > 0) lines.push(`Enumerations: ${report.schemas.filter((schema) => schema.kind === 'enum').slice(0, 8).map((schema) => schema.name).join(', ')}.`);
  if (lines.length === 0) lines.push('No schema, migration or API definition was found in the repository.');
  return lines;
}

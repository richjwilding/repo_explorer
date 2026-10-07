import { describe, expect, it } from 'vitest';
import {
  computeDataModel,
  describeDataModel,
  isGraphqlFile,
  isMigrationFile,
  isPrismaFile,
  isProtoFile,
  parseGraphqlSchemas,
  parseOpenApi,
  parsePrismaSchemas,
  parseProtoSchemas,
  parseSqlSchemas,
} from '../src/core/analysis/contracts.js';

/**
 * Contracts are read from declarative files, so the parsers must be exact about
 * what they claim: a column type that swallowed its own constraints, or a
 * nullable flag that contradicted the note beside it, would make the data model
 * look authoritative while being wrong.
 */

const files = (map: Record<string, string>) => Object.entries(map).map(([path, text]) => ({ path, text }));

describe('path classification', () => {
  it('recognises each contract format', () => {
    expect(isPrismaFile('prisma/schema.prisma')).toBe(true);
    expect(isGraphqlFile('api/schema.graphql')).toBe(true);
    expect(isGraphqlFile('api/schema.gql')).toBe(true);
    expect(isProtoFile('proto/events.proto')).toBe(true);
    expect(isMigrationFile('db/migrations/001_init.sql')).toBe(true);
    expect(isMigrationFile('queries/report.sql')).toBe(false);
  });
});

describe('sql', () => {
  const sql = `CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  org_id BIGINT REFERENCES orgs(id),
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE members (
  user_id BIGINT NOT NULL,
  org_id BIGINT NOT NULL,
  role VARCHAR(20),
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);
ALTER TABLE members ADD CONSTRAINT fk_org FOREIGN KEY (org_id) REFERENCES orgs(id);
`;

  it('reads columns, separating a type from its constraints', () => {
    const schemas = parseSqlSchemas('db/migrations/001_init.sql', sql);
    const users = schemas.find((schema) => schema.name === 'users');
    expect(users?.fields.map((field) => field.name)).toEqual(['id', 'email', 'org_id', 'created_at']);
    // The regression: the type used to swallow `PRIMARY KEY`.
    expect(users?.fields[0].type).toBe('BIGSERIAL');
    expect(users?.fields[1].type).toBe('TEXT');
    expect(users?.fields[3].type).toBe('TIMESTAMP');
  });

  it('marks a primary key column as not nullable, without a contradictory note', () => {
    const schemas = parseSqlSchemas('db/migrations/001_init.sql', sql);
    const users = schemas.find((schema) => schema.name === 'users');
    expect(users?.primaryKey).toEqual(['id']);
    expect(users?.fields[0].optional).toBe(false);
    expect(users?.fields[0].note).toBeUndefined();
    expect(users?.fields[2].optional).toBe(true);
  });

  it('attributes line numbers to the right column', () => {
    const schemas = parseSqlSchemas('db/migrations/001_init.sql', sql);
    const users = schemas.find((schema) => schema.name === 'users');
    // `CREATE TABLE users (` is line 1, so `id` is line 2.
    expect(users?.line).toBe(1);
    expect(users?.fields[0].line).toBe(2);
    expect(users?.fields[1].line).toBe(3);
    expect(users?.fields[3].line).toBe(5);
  });

  it('collects inline and table-level foreign keys, including later ALTERs', () => {
    const schemas = parseSqlSchemas('db/migrations/001_init.sql', sql);
    expect(schemas.find((schema) => schema.name === 'users')?.foreignKeys).toEqual([{ column: 'org_id', references: 'orgs(id)', line: 4 }]);
    const members = schemas.find((schema) => schema.name === 'members');
    expect(members?.foreignKeys.map((key) => key.column)).toEqual(['user_id', 'org_id']);
  });

  it('keeps a composite key', () => {
    const schemas = parseSqlSchemas('a.sql', 'CREATE TABLE t (\n  a INT,\n  b INT,\n  PRIMARY KEY (a, b)\n);\n');
    expect(schemas[0].primaryKey).toEqual(['a', 'b']);
    expect(schemas[0].fields.every((field) => !field.optional)).toBe(true);
  });

  it('ignores a CREATE TABLE with no readable body', () => {
    expect(parseSqlSchemas('a.sql', 'CREATE TABLE broken (')).toEqual([]);
  });
});

describe('prisma', () => {
  const schema = `model Post {
  id       Int     @id @default(autoincrement())
  title    String
  body     String?
  tags     String[]
  author   User    @relation(fields: [authorId], references: [id])
}

enum Role {
  ADMIN
  MEMBER
}
`;

  it('separates a field type from its modifiers', () => {
    const models = parsePrismaSchemas('schema.prisma', schema);
    const post = models.find((model) => model.name === 'Post');
    const byName = new Map(post?.fields.map((field) => [field.name, field]));
    // `String?` is a nullable String, not a type called "String?".
    expect(byName.get('title')?.type).toBe('String');
    expect(byName.get('title')?.optional).toBe(false);
    expect(byName.get('body')?.type).toBe('String');
    expect(byName.get('body')?.optional).toBe(true);
    expect(byName.get('tags')?.type).toBe('String');
    expect(byName.get('tags')?.note).toBe('list');
    expect(byName.get('author')?.note).toBe('relation');
  });

  it('reads the primary key and attributes line numbers from the model line', () => {
    const models = parsePrismaSchemas('schema.prisma', schema);
    const post = models.find((model) => model.name === 'Post');
    expect(post?.primaryKey).toEqual(['id']);
    expect(post?.line).toBe(1);
    expect(post?.fields[0].line).toBe(2);
  });

  it('reads enums as schemas of their own', () => {
    const models = parsePrismaSchemas('schema.prisma', schema);
    const role = models.find((model) => model.name === 'Role');
    expect(role?.kind).toBe('enum');
    expect(role?.fields.map((field) => field.name)).toEqual(['ADMIN', 'MEMBER']);
  });
});

describe('graphql', () => {
  const sdl = `type User {
  id: ID!
  email: String!
  nickname: String
}

input PostFilter {
  tag: String
}

type Query {
  user(id: ID!): User
  users: [User!]!
}

enum Sort { ASC DESC }
`;

  it('reads types, inputs and field nullability', () => {
    const schemas = parseGraphqlSchemas('schema.graphql', sdl);
    const user = schemas.find((schema) => schema.name === 'User');
    expect(user?.fields.map((field) => field.name)).toEqual(['id', 'email', 'nickname']);
    expect(user?.fields.find((field) => field.name === 'id')?.optional).toBe(false);
    expect(user?.fields.find((field) => field.name === 'nickname')?.optional).toBe(true);
    // Line numbers come from the declaration's own line, not the line after it.
    expect(user?.line).toBe(1);
    expect(user?.fields[0].line).toBe(2);
  });

  it('collects query and mutation fields as operations', () => {
    const schemas = parseGraphqlSchemas('schema.graphql', sdl);
    const query = schemas.find((schema) => schema.name === 'Query');
    expect(query?.operations.map((operation) => operation.name)).toEqual(['user', 'users']);
    expect(query?.operations[0].kind).toBe('query');
  });
});

describe('protobuf', () => {
  it('reads messages, field labels and services', () => {
    const proto = `message UserCreated {
  string user_id = 1;
  repeated string tags = 2;
  optional int64 at = 3;
}

enum Kind { CREATED = 0; UPDATED = 1; }

service Users {
  rpc Get (UserCreated) returns (UserCreated);
}
`;
    const schemas = parseProtoSchemas('events.proto', proto);
    const message = schemas.find((schema) => schema.name === 'UserCreated');
    expect(message?.fields.map((field) => `${field.name}:${field.type}`)).toEqual(['user_id:string', 'tags:string', 'at:int64']);
    expect(message?.fields[1].optional).toBe(true);

    // A compact one-line enum body still parses, because `;` terminates a field.
    expect(schemas.find((schema) => schema.name === 'Kind')?.fields.map((field) => field.name)).toEqual(['CREATED', 'UPDATED']);

    const service = schemas.find((schema) => schema.name === 'Users');
    expect(service?.kind).toBe('service');
    expect(service?.operations.map((operation) => operation.name)).toEqual(['Get']);
  });
});

describe('openapi and json schema', () => {
  it('reads component schemas, required fields and operations', () => {
    const spec = `openapi: 3.0.0
paths:
  /users:
    get:
      operationId: listUsers
components:
  schemas:
    User:
      type: object
      required: [id]
      properties:
        id:
          type: integer
        tags:
          type: array
          items:
            type: string
`;
    const { schemas, operations } = parseOpenApi('openapi.yaml', spec);
    expect(operations).toBe(1);
    const user = schemas.find((schema) => schema.name === 'User');
    expect(user?.fields.find((field) => field.name === 'id')?.optional).toBe(false);
    expect(user?.fields.find((field) => field.name === 'tags')?.type).toBe('array of string');
    // Field lines point at the property, not at the top of the document.
    expect(user?.fields.find((field) => field.name === 'id')?.line).toBeGreaterThan(1);
  });

  it('survives a malformed spec', () => {
    expect(parseOpenApi('bad.yaml', 'openapi: [not: valid\n')).toEqual({ schemas: [], operations: 0 });
  });
});

describe('assembly', () => {
  const input = {
    files: files({
      'db/migrations/001_init.sql': 'CREATE TABLE users (\n  id INT PRIMARY KEY,\n  email TEXT NOT NULL\n);\n',
      'prisma/schema.prisma': 'model Post {\n  id Int @id\n}\n',
      'api/schema.graphql': 'type Query {\n  hello: String\n}\n',
      'openapi.yaml': 'openapi: 3.0.0\ncomponents:\n  schemas:\n    Thing:\n      type: object\n      properties:\n        id:\n          type: string\n',
    }),
    dependencies: [
      { name: 'pg', category: 'database', label: 'PostgreSQL', evidence: ['src/db.ts'] },
      { name: 'redis', category: 'cache', label: 'Redis', evidence: ['tests/helpers/fixtureRepo.ts'] },
      { name: 'express', category: 'framework', evidence: ['src/server.ts'] },
    ],
  };

  it('summarises tables, schemas, migrations and stores', () => {
    const report = computeDataModel(input);
    expect(report.summary.tables).toBe(2);
    expect(report.summary.migrations).toBe(1);
    expect(report.apiSpecs.map((spec) => spec.format).sort()).toEqual(['graphql', 'openapi']);
  });

  it('separates a store the code talks to from one only a fixture mentions', () => {
    // The regression: a repository whose tests mention `postgres://` was
    // reported as using PostgreSQL.
    const report = computeDataModel(input);
    expect(report.summary.stores).toEqual(['PostgreSQL']);
    expect(report.summary.testOnlyStores).toEqual(['Redis']);
    const described = describeDataModel(report).join(' ');
    expect(described).toContain('Redis appears only in tests or fixtures');
  });

  it('still names a store when there is no evidence to judge it by', () => {
    const report = computeDataModel({ files: [], dependencies: [{ name: 'pg', category: 'database', label: 'PostgreSQL' }] });
    expect(report.summary.stores).toEqual(['PostgreSQL']);
    expect(report.summary.testOnlyStores).toEqual([]);
  });

  it('says a schema is missing rather than showing an empty data model', () => {
    const report = computeDataModel({ files: [], dependencies: [{ name: 'pg', category: 'database', label: 'PostgreSQL' }] });
    expect(report.summary.tables).toBe(0);
    expect(describeDataModel(report).join(' ')).toContain('no table definitions were found');
  });

  it('says plainly when nothing at all was found', () => {
    const report = computeDataModel({ files: [] });
    expect(describeDataModel(report)).toEqual(['No schema, migration or API definition was found in the repository.']);
  });

  it('does not treat a query file as a migration', () => {
    const report = computeDataModel({ files: files({ 'queries/report.sql': 'SELECT * FROM users;\n' }) });
    expect(report.migrations).toEqual([]);
    expect(report.schemas).toEqual([]);
  });

  it('ignores files whose text was released', () => {
    const report = computeDataModel({ files: [{ path: 'a.sql', text: null }] });
    expect(report.schemas).toEqual([]);
  });
});

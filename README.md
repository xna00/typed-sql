# typed-sql

[![CI](https://github.com/xna00/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/xna00/typed-sql/actions/workflows/ci.yml)

A type-level SQL parser built on TypeScript template literal types. It derives parameter and return types straight from SQL template strings, so `TypedDb<S>` gives you fully typed `prepare().all/get/run` — no code generation, no runtime parsing.

## Quick start

```ts
import { TypedDb, type Schema } from './typed-sql.ts';
import { DatabaseSync } from 'node:sqlite';

// 1. Derive table types straight from your DDL
const USER_SQL = `CREATE TABLE IF NOT EXISTS user (
id INTEGER PRIMARY KEY,
name TEXT NOT NULL,
email TEXT
)`;
type Tables = Schema<typeof USER_SQL>;
//   ^? { user: { id: number; name: string; email: string | null } }

const db = new TypedDb<Tables>(new DatabaseSync(':memory:'));

// 2. Write SQL as a literal — params and result are inferred
const row = db.prepare(
  'SELECT ALL user.name AS name FROM user WHERE user.id = @id ORDER BY 1 LIMIT -1 OFFSET 0',
).get({ id: 1 });
//         ^? params: { id: number }              ^? row: { name: string } | undefined

// 3. INSERT / UPDATE / DELETE infer their params too
db.prepare('INSERT OR ABORT INTO user (id, name, email) VALUES (@id, @name, @email)')
  .run({ id: 2, name: 'alice', email: null });

// 4. Dynamic sorting via a static allowlist (see docs — ORDER BY cannot be parameterized)
const makeSql = <const C extends keyof Tables['user'], const D extends 'asc' | 'desc'>(
  col: C,
  dir: D,
) =>
  `SELECT ALL * FROM user WHERE 1=1 ORDER BY ${col} ${dir}, id ${dir} LIMIT @limit OFFSET @offset` as const;
const listSql = {
  'name.asc': makeSql('name', 'asc'),
  'name.desc': makeSql('name', 'desc'),
};
const users = db.prepare(listSql['name.asc']).all({ limit: 50, offset: 0 });
//            ^? rows: Tables['user'][]          ^? params: { limit: number; offset: number }
```

## Documentation

- [SQL conventions (English)](types-sql-conventions.md)
- [SQL conventions (中文)](types-sql-conventions.zh.md)

## Standalone usage

Clone the repo and run the tests / typecheck (Node 22.5+ required for `node:sqlite`; type stripping needs Node 22.6+, enabled by default on Node 24+):

```sh
npm i -D typescript @types/node
npx tsc --noEmit --strict --target esnext --module nodenext --moduleResolution nodenext \
  --lib esnext --types node --allowImportingTsExtensions --skipLibCheck \
  typed-sql.ts typed-sql-test.ts
node --experimental-strip-types --test typed-sql-test.ts
```

CI (`.github/workflows/ci.yml`) runs the same typecheck and test suite on Node 24 and 26.

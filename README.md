# typed-sql

[![CI](https://github.com/xna00/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/xna00/typed-sql/actions/workflows/ci.yml)

A type-level SQL parser built on TypeScript template literal types. It derives parameter and return types straight from SQL template strings, so `TypedDb<S>` gives you fully typed `prepare().all/get/run` — no code generation, no runtime parsing.

## Quick start

```ts
import { TypedDb, type ResolveFks, type Schema, type SchemaFks } from './typed-sql.ts';
import { DatabaseSync } from 'node:sqlite';

// 1. Single table: Schema derives the shape from DDL (incl. enum CHECK)
const USER_SQL = `CREATE TABLE IF NOT EXISTS user (
id   TEXT PRIMARY KEY CHECK (id IN ('a', 'b')),
name TEXT NOT NULL
)`;
type UserTables = Schema<typeof USER_SQL>;
//   ^? { user: { id: 'a' | 'b'; name: string } }

// 2. Foreign keys: SchemaFks + ResolveFks — child column inherits the parent key type
const ORDER_SQL = `CREATE TABLE IF NOT EXISTS orderItem (
id          INTEGER PRIMARY KEY AUTOINCREMENT,
userId      TEXT NOT NULL REFERENCES user(id),
amount      INTEGER NOT NULL,
confirmedAt TEXT
)`;
type Tables = ResolveFks<SchemaFks<typeof USER_SQL> & SchemaFks<typeof ORDER_SQL>>;
//   ^? { user:     { id: 'a' | 'b'; name: string }
//        orderItem: { id: number; userId: 'a' | 'b'; amount: number; confirmedAt: string | null } }

const db = new TypedDb<Tables>(new DatabaseSync(':memory:'));

// 3. Multi-table JOIN — columns and WHERE params are typed per table
const rows = db.prepare(
  'SELECT ALL user.id AS userId, orderItem.amount AS amount FROM user LEFT JOIN orderItem ON user.id = orderItem.userId WHERE user.id = @id ORDER BY 1 LIMIT -1 OFFSET 0',
).all({ id: 'a' });
//         ^? params: { id: 'a' | 'b' }        ^? rows: { userId: 'a' | 'b'; amount: number }[]

// 4. INSERT — the enum propagates into VALUES params
db.prepare('INSERT OR ABORT INTO orderItem (userId, amount) VALUES (@userId, @amount)')
  .run({ userId: 'a', amount: 5 });

// 5. Dynamic sorting via a static allowlist (ORDER BY cannot be parameterized)
const makeSql = <const C extends keyof Tables['orderItem'], const D extends 'asc' | 'desc'>(
  col: C,
  dir: D,
) =>
  `SELECT ALL * FROM orderItem WHERE 1=1 ORDER BY ${col} ${dir}, id ${dir} LIMIT @limit OFFSET @offset` as const;
const listSql = {
  'amount.asc': makeSql('amount', 'asc'),
  'amount.desc': makeSql('amount', 'desc'),
};
const sorted = db.prepare(listSql['amount.asc']).all({ limit: 50, offset: 0 });
```

## Common patterns

```ts
// Aggregates — SQL nullability is preserved (SUM/AVG/MAX/MIN → number | null)
const total = db.prepare(
  'SELECT ALL COUNT(*) AS count, SUM(orderItem.amount) AS total FROM orderItem WHERE 1=1 ORDER BY 1 LIMIT -1 OFFSET 0',
).get({});
//         ^? { count: number; total: number | null } | undefined

// RETURNING — INSERT/UPDATE/DELETE hand back typed affected rows
const inserted = db.prepare(
  'INSERT OR ABORT INTO orderItem (userId, amount) VALUES (@userId, @amount) RETURNING id',
).get({ userId: 'a', amount: 5 });
//         ^? { id: number } | undefined

// IS NOT NULL in WHERE narrows the result column (drops the null)
const paid = db.prepare(
  'SELECT ALL orderItem.confirmedAt AS confirmedAt FROM orderItem WHERE orderItem.confirmedAt IS NOT NULL ORDER BY 1 LIMIT -1 OFFSET 0',
).all({});
//         ^? rows: { confirmedAt: string }[]     // not string | null

// UPDATE — SET and WHERE params are typed
db.prepare('UPDATE OR ABORT orderItem SET confirmedAt = @confirmedAt WHERE orderItem.id = @id')
  .run({ confirmedAt: '2026-01-01', id: 1 });
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

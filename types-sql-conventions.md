# Type-level SQL conventions (typed-sql)

## Overview

- Built on native `node:sqlite`, zero third-party dependencies
- A type-level parser derives parameter and return types from SQL strings; `TypedDb<S>` provides type-safe `prepare().all/get/run`
- Table types are derived from `CREATE [TEMP] TABLE IF NOT EXISTS` statements via `Schema<T>`; sample table definitions live in the test file (typed-sql-test.ts)
- For schemas with foreign keys (`REFERENCES`), use the two-step flow: `SchemaFks<...>` (parse each DDL chunk) + `ResolveFks<...>` (intersect the referencing column with the target column type), see "Foreign key type propagation"; without foreign keys, `Schema<S>` can be used directly

## API usage

- `prepare<const T extends string>(sql)` accepts a SQL string literal and returns a type-safe statement object
  - `.all(params)` → `T[]` (full SELECT result / INSERT/UPDATE/DELETE ... RETURNING affected rows)
  - `.get(params)` → `T | undefined` (single row / a single INSERT/UPDATE/DELETE ... RETURNING row; `undefined` when no row)
  - `.run(params)` → `{ lastInsertRowid: number; changes: number }` (INSERT/UPDATE/DELETE; `TypedDb.prepare` does not enable `readBigInts`, so fields are always `number`, whereas `StatementResultingChanges` from `@types/node` is declared `number | bigint`)
- Parameters are always passed as an **object** (named parameters), natively supported by `node:sqlite` — **property order does not matter**
- `params` is required: even queries without parameters must pass `{}` (e.g. `WHERE 1=1`)

```ts
// ✓ any order
const u = db.prepare('SELECT ALL * FROM user WHERE user.id = @id ORDER BY 1 LIMIT -1 OFFSET 0').get({ id: 1 });
```

## SQL writing conventions

### Keywords and identifiers

- The parser matches keywords as **literal uppercase**; always write them uppercase: `SELECT`, `ALL`, `DISTINCT`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`, `INSERT`, `OR`, `INTO`, `VALUES`, `UPDATE`, `SET`, `DELETE`, `AND`, `AS`, `IS`, `NOT IN`, `LIKE`, `NOT LIKE`, `IN`, `BETWEEN`, `NOT NULL`, `PRIMARY KEY`, `RETURNING`
- The one exception: the `and` inside `BETWEEN` must be lowercase
- The **content of `ORDER BY` / `GROUP BY` / `HAVING` is not validated** (any case, column name, or expression)
- **Write the table name directly, never an alias**: `FROM user`, `UPDATE OR ABORT user` (`FROM user u` fails to parse)
- **INSERT / UPDATE conflict clauses are mandatory**: `INSERT OR <resolver> INTO ...`, `UPDATE OR <resolver> <table> SET ...`, where `<resolver>` is one of `ROLLBACK | ABORT | FAIL | IGNORE | REPLACE` (omitting it fails parsing and the parameter type degrades to `never`); `ABORT` is SQLite's default, write `OR ABORT` explicitly for default semantics
- WHERE clauses use `table.col`: `user.externalUserId = @externalUserId`
- **UPDATE SET clauses use bare column names** (`token = @token`) — SQLite's SET does not accept a `table.col` prefix
- SELECT columns are projected as `table.col AS name`

### Parameters: `@name` named parameters

- Do not use `?` placeholders; use `@名称` instead
- Parameter naming rules depend on the statement:
  - **SELECT** WHERE / LIMIT / OFFSET, **UPDATE** SET / WHERE, **DELETE** WHERE: names may be arbitrary (e.g. `@limit`, `@anotherId`)
  - **INSERT VALUES**: names **must be target-table column names** (non-column parameters are silently dropped, and the call site fails to compile)
- Parameter types derive from the corresponding column type: TEXT → `string`, INTEGER/REAL → `number`, nullable columns → `| null`
- Exception: parameters in `LIMIT` / `OFFSET` are always `number`
- Inside `VALUES` parentheses and `IN` lists, separate parameters with **comma + one space**: `(@a, @b)`
- Avoid literal `@` in parameter values (e.g. `'email@example.com'`) — it would be misidentified

```
✓ Fully valid examples
SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId ORDER BY 1 LIMIT -1 OFFSET 0
INSERT OR ABORT INTO user (username, passwordHash) VALUES (@username, @passwordHash)
UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId
INSERT OR REPLACE INTO kfCursor (openKfId, cursor) VALUES (@openKfId, @cursor)

✗ Counter-examples
SELECT * FROM user WHERE user.externalUserId = @externalUserId        # missing ALL, ORDER BY/LIMIT/OFFSET
SELECT ALL * FROM user WHERE externalUserId = @id ORDER BY 1 LIMIT -1 OFFSET 0   # WHERE missing user. prefix
INSERT INTO user (username) VALUES (@username)                        # missing OR conflict clause
UPDATE user SET token = @token WHERE user.externalUserId = @externalUserId  # missing OR conflict clause
FROM user u                                                          # table alias
VALUES (@a,@b)                                                       # missing space after comma
```

### Strict formatting (the parser does not normalize whitespace)

| Rule | Reason |
|------|--------|
| SQL strings must have **no leading or trailing whitespace** | The type matches `SELECT`/`INSERT`/`UPDATE` directly at the start |
| `FROM <table>` must be followed by **exactly one space** before ` WHERE`, no extra whitespace | The template `FROM ${FromClause} WHERE` extracts the table name; extra whitespace after the table name makes `_NewTables` miss the table and all columns degrade to `{}` |
| CREATE TABLE **column definitions must start at column 0** (no indentation) | `ParseCols` splits columns with `Split<Rest, ",\n">`; table-level constraints are truncated at `,\n\n` (last-column comma + blank line), see "Table-level constraints" below |
| SELECT column lists need **comma + one space**: `col1, col2` | `Split<Cols, ', '>` separates column names |
| SELECT template: `SELECT {ALL\|DISTINCT} <cols> FROM <table> WHERE <cond> ORDER BY ... LIMIT ... OFFSET ...`, **GROUP BY/HAVING optional but paired** | `_MatchSelect` matches two variants with/without GROUP BY; a GROUP BY swallowed into WHERE breaks `IS NULL` narrowing |
| Aggregates must sit **at the start of the column expression**, not wrapped in other functions (e.g. `COALESCE(SUM(x),0)`) | `ColType` only matches expressions starting with an aggregate; wrapping falls through to the `T.C` branch and yields `unknown` |
| The `AND` in `BETWEEN` is lowercase `and` | Prevents being split by the WHERE-level ` AND ` |

### Table-level constraints

- Table-level constraints (`PRIMARY KEY (a, b)` / `UNIQUE (a, b)` / table-level `CHECK (...)` / `FOREIGN KEY (a) REFERENCES parent(b)`) are written **below** the column definitions, separated from the column area by a **blank line**; the **last column line ends with a comma** (valid separator, not a trailing comma)
- `ParseCols` truncates at `,\n\n` (last-column comma + blank line) and **ignores the constraint block entirely** — table-level constraints do not change column types (in SQLite, table-level PK/UNIQUE/FK do not affect column nullability, and table-level CHECK does not participate in enum derivation), so ignoring them is correct
- The blank line must be **truly empty** (no spaces); the constraint block is ignored wholesale, so however it is formatted (multi-line, inner blank lines) does not affect column parsing
- Tables without constraints stay as before: the last column line has no comma and no blank line, ending directly with `\n)` (existing DDL needs no changes)

```sql
CREATE TABLE IF NOT EXISTS orderItem (
  orderId    INTEGER NOT NULL,
  itemId     INTEGER NOT NULL,
  quantity   INTEGER NOT NULL,

  PRIMARY KEY (orderId, itemId)
)
-- → Schema derives { orderItem: { orderId: number; itemId: number; quantity: number } }, no PRIMARY phantom column
```

### Query results

- `.all()` always returns `T[]`; use `.get()` for a single row → `T | undefined`

### Dynamic sorting (ORDER BY allowlist variants)

**Why ORDER BY cannot be parameterized / interpolated:**
- Bind parameters can only bind **values**, not **identifiers**: `ORDER BY ?` / `ORDER BY @col` does not sort (returns insertion order, verified); a direction cannot be bound at all (`ORDER BY createdAt ?` is a syntax error)
- A CASE-parameterized alternative does not work in this library: ORDER BY does not participate in parameter extraction (see "Design boundaries"), so `@sortBy`/`@dir` never enter the `SqlAllParams` type
- Interpolation is an injection risk: verified that a single-statement subquery like `ORDER BY (SELECT token FROM user ...)` executes and leaks data (`; DROP` multi-statements are blocked by node:sqlite, but a subquery is not)
- The correct approach = **column allowlist + precompiled static variants** (the industry-standard way to do dynamic sorting): enumerate all columns/directions as static SQL, and the runtime only selects a key

**Recommended pattern** (see `markListSql` in typed-sql-test.ts):

```ts
const makeSql = <const C extends keyof Tables['markRecord'], const D extends 'asc' | 'desc'>(
  col: C,
  dir: D,
) =>
  `SELECT ALL * FROM markRecord WHERE 1=1 ORDER BY ${col} ${dir}, id ${dir} LIMIT @limit OFFSET @offset` as const;

const markListSql = {
  'createdAt.asc': makeSql('createdAt', 'asc'),
  'createdAt.desc': makeSql('createdAt', 'desc'),
  'costCredits.asc': makeSql('costCredits', 'asc'),
  'costCredits.desc': makeSql('costCredits', 'desc'),
};

// Call site: keys are a literal union; a wrong key is a compile error
const rows = db.prepare(markListSql[key]).all({ limit: 50, offset: 0 });
```

- `C extends keyof Tables['markRecord']` → every column of that table is sortable automatically; a new column added in DDL needs no change to the `makeSql` signature; directions stay as `'asc' | 'desc'` literals
- Each key yields an **exact single SQL literal**, from which `prepare` derives the params/results — fully typed, zero injection
- Adding one sort combination = adding one object-literal line; an invalid key is killed at compile time
- **`as const` is a prerequisite for type safety**: `makeSql` must use generic `const C/D` and the return value must be `as const` (an explicit return type annotation also works but is not required); dropping either widens the return type to `string` and `prepare` params degrade to `never`
- Do not generate the object at runtime with `['a','b'].map` — keys would degrade to a `string` index; write the object literal directly
- The tiebreak key after the primary sort can be hardcoded (e.g. `id ASC`) to guarantee a predictable order even for inputs that cannot occur

### INSERT/UPDATE/DELETE ... RETURNING

- Append `RETURNING <cols>` at the end of the statement; `.all()` / `.get()` return the affected rows:
  - `INSERT OR ABORT INTO user (...) VALUES (...) RETURNING id` → `{ id: string }` (inserted row)
  - `UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING externalUserId` → `{ externalUserId: string }[]` (updated rows)
  - `DELETE FROM markRecord WHERE markRecord.id = @id RETURNING id` → `{ id: number }[]` (deleted rows)
- **Bare column names only**, separated by **comma + one space**: `RETURNING id, createdAt`; or `RETURNING *` for the full row
- `table.` prefixes, `AS` aliases, and expressions are unsupported — those degrade to `{}` (a warning signal)
- Params still come from the original statement (VALUES / SET / WHERE): RETURNING columns only decide which columns come back; **no `@params` inside RETURNING**
- `.run()` is unaffected by RETURNING and still returns `{ lastInsertRowid: number; changes: number }`
- With no matching rows (an `OR IGNORE` swallowed insert / an UPDATE/DELETE whose WHERE matched nothing): `.all()` returns `[]`, `.get()` returns `undefined`

### Enum columns: `CHECK (... IN (...))`

- Declare an enum with a column-level `CHECK` using the `IN` form; the type derives to a literal union:
  `status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed'))` → `'pending' | 'confirmed'`
- String values use **single quotes**, numbers are written bare (`score INTEGER CHECK (score IN (1, 2, 3))` → `1 | 2 | 3`)
- List items are separated by **comma + one space**; values must not contain single quotes
- Enum types propagate automatically: `SELECT *` result columns and WHERE / SET / INSERT VALUES params are all narrowed
- Nullable columns (no `NOT NULL`) → `| null`; NULL always passes CHECK (SQLite semantics)
- Only simple single-column `CHECK (col IN (...))` is supported; range checks (`CHECK (cost > 0)`) and multi-condition CHECKs do not participate in enum derivation, and the column falls back to its base type
- Only `CHECK (<this column name> IN (...))` participates; referencing another column (`CHECK (score IN (1,2,3))` written on `status`) or a constant expression (`CHECK (1 IN (1,2))`) likewise falls back to the base type

### Foreign key type propagation: `REFERENCES tbl(col)`

- A column-level `REFERENCES tbl(col)` **intersects** the target column type with its own:
  `pid TEXT NOT NULL REFERENCES parent(id)`, where `parent.id` is `TEXT CHECK (id IN ('a', 'b'))` → child column type `'a' | 'b'` (when the parent has no enum, `string & string` is the identity and has zero effect)
- Compose a multi-DDL full schema type: `ResolveFks<SchemaFks<A> & SchemaFks<B> & ...>`; `SchemaFks` is the raw parse (columns are internal wrappers), and only after `ResolveFks` unwraps the references do you get the final `{ table: { column: type } }`. For a single table without foreign keys, `Schema<S>` is backward-compatible and usable directly
- **Nullability comes only from the child column**: a nullable child → `| null`; a nullable parent does **not** propagate (SQLite `MATCH SIMPLE`: if any child key column is NULL the FK is satisfied without a matching parent row)
- The child's own type/enum is preserved: `child.pid CHECK (pid IN ('a', 'b')) REFERENCES parent(id)` (parent `'a'|'b'|'c'`) → `'a' | 'b'` (own enum ∩ parent type)
- Only **column-level single-column** `REFERENCES tbl(col)` is supported; table-level `FOREIGN KEY (...)`, composite foreign keys, and `REFERENCES tbl` without a column do not participate (the table-level constraint block is ignored wholesale)
- FK resolution **propagates one level only** (in an A→B→C chain, A intersects only with B, not C) — a rare scenario, deliberately simplified
- **Circular foreign keys** (mutual references / same-table two-way, legal in SQLite) do not recurse: both sides intersect their own declared types and compile fine
- The type is a compile-time contract: inserting into a child table is **not constrained by the parent's enum** (the FK only validates that the value exists among the parent's current rows, see "Design boundaries"); after the parent is force-migrated to a legacy enum value, the child column type can likewise "lie" (consistent with the parent column's own lie)

## Type derivation rules

### Parameter types: `SqlAllParams<S>` (SELECT / INSERT/UPDATE/DELETE ... RETURNING) / `RunParams<S>` (INSERT/UPDATE/DELETE)

1. Scan the SQL for all `@identifier` references
2. Extract the table name from the SQL (SELECT via `_MatchSelect`; DML via `_MatchInsert` / `_MatchUpdate` / `_MatchDelete`)
3. Look up `Tables[table][paramName]` to get each parameter's concrete type
4. Merge into `{ paramName: type }`

WHERE supports the operators: `=`, `>=`, `<=`, `!=`, `<>`, `>`, `<`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN`, `BETWEEN ... and ...`.
`LIKE`/`NOT LIKE` parameter types derive from the column type (TEXT column → `string`); the `%`/`_` wildcards go inside the parameter value, not the SQL string.
For SELECT, `@params` in `LIMIT` / `OFFSET` are additionally typed as `number`.

### Return types: `SqlAllResult<S>`

- `SELECT * FROM <table>` → `Tables[table][]`; `INSERT/UPDATE/DELETE ... RETURNING <cols>` → affected rows (`{ col: type }[]`)
- `SELECT col1, col2 FROM <table>` → `{ col1: type, col2: type }[]`
- In a multi-table JOIN, `*` returns the merge (intersection) of each table's fields
- A `Tbl.Col IS NOT NULL` / `Tbl.Col IS NULL` in WHERE narrows the corresponding column (drops null / constant `null`); both the `SELECT *` and explicit-column paths apply
- Aggregate columns follow SQL semantics (SUM/AVG/MAX/MIN return NULL on empty set / all-NULL):
  - `COUNT(*)` → `number`
  - `SUM(x)` / `AVG(x)` / `MAX(x)` / `MIN(x)` → `number | null`
  - `GROUP_CONCAT(x)` → `string | null`
- Empty-set behavior (SQLite semantics):
  - An aggregate query without GROUP BY (global aggregate) always returns 1 row: `COUNT`→`0`, `SUM/AVG/MAX/MIN`→`null`
  - An empty set with GROUP BY returns 0 rows
  - Both can be normalized with a `?? 0` fallback

## Design boundaries (intentionally unsupported)

All of the following are **deliberate implementation simplifications, not bugs**. A failed match degrading the type (`unknown` / `never` / `{}`) is itself the visible warning signal that tells the caller the pattern is out of scope.

- **SELECT four mandatory clauses**: `WHERE` / `ORDER BY` / `LIMIT` / `OFFSET` are all required, so that `_MatchSelect` only maintains fixed variants (with/without GROUP BY); a failed match is `unknown`. Omitted forms ("no WHERE", "no LIMIT/OFFSET") are not provided
  - The placeholder components are SQL-semantically equivalent (verified via `EXPLAIN QUERY PLAN`):
    - `WHERE 1=1` ≡ no WHERE (SQLite constant folding; identical query plan)
    - `LIMIT -1` ≡ no row cap (a negative LIMIT means no limit, OFFSET still applies); `OFFSET 0` ≡ start from the first row
    - **`ORDER BY 1` is NOT equivalent to no ORDER BY** — it sorts by the first column and is only a valid placeholder when it has no effect on single-row/aggregate queries; real sorting needs a real clause (e.g. `createdAt DESC, id DESC`)
- **Table aliases**: never write an alias; `FROM user u` fails to parse
- **GLOB**: SQLite-specific and case-sensitive, deliberately unsupported (`LIKE` covers the common matching needs)
- **CASE WHEN / scalar functions** (`strftime`/`ifnull`, etc.): non-aggregate column expressions cannot be parsed → `unknown` (visible signal)
- **Subqueries / UNION / INSERT SELECT / INSERT DEFAULT VALUES**
- **JOIN spellings**: only `LEFT JOIN` / `INNER JOIN`; `LEFT OUTER JOIN`, `RIGHT`/`FULL`/`CROSS`/`NATURAL` are all unsupported
- **`SELECT *, COUNT(*) AS c` mixed projection**: when the column list contains `*` but is not pure `*`, the `*` part parses to `{}` (the form has no reliable semantics; the degradation is the warning)
- **`GROUP_CONCAT(x, y)` multi-arg**: the column list is split on `", "`, so a comma inside a function is mis-split → type degrades (single-arg only)
- **HAVING / ORDER BY do not participate in parameter extraction**: params in `HAVING COUNT(*) > @min` or `ORDER BY @col` are dropped (for dynamic sorting see the "Dynamic sorting" section)
- **UPDATE/DELETE without WHERE**: the template forces a WHERE
- **INSERT/UPDATE/DELETE ... RETURNING**: only bare column-name lists or `*`; `table.` prefixes, `AS` aliases, and expressions are unsupported (degrades to `{}`)
- **UPDATE SET expressions** (e.g. `count = count + 1`): `SetParams` only recognizes `col = @param` form
- **CREATE TABLE must include `IF NOT EXISTS`**: only `CREATE [TEMP] TABLE IF NOT EXISTS <name>` is supported; omitting it makes `Schema` return `{}` (at runtime a repeated CREATE also errors with `table already exists`, matching the type-level signal)
- **Table-level constraints without a blank line**: must follow the "last-column comma + blank line" convention; if the blank line is missing (constraints directly after the column area) they get parsed as columns producing `PRIMARY`/`UNIQUE`/`CHECK`/`FOREIGN` phantom columns (warning signal)
- **FK type propagation is column-level single-column only**: table-level `FOREIGN KEY (...)`, composite FKs, and `REFERENCES tbl` without a column do not participate (the table-level constraint block is ignored wholesale); chained FKs propagate one level only; `Schema<S>` does not resolve FKs (use `SchemaFks` + `ResolveFks`)

## Code organization

| File | Responsibility |
|------|----------------|
| `typed-sql.ts` | lib — type gymnastics (Schema / SchemaFks / ResolveFks / SqlAllResult / SqlAllParams / RunParams) + TypedDb<Schema> class |
| `typed-sql-test.ts` | sample table definitions + compile-time type assertions + runtime verification |

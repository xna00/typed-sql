import {
  type Schema,
  type SchemaFks,
  type ResolveFks,
  type RunParams,
  type SqlAllResult, type SqlGetResult, type SqlRunResult, type SqlAllParams,
  TypedDb,
} from './typed-sql.ts';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Test helpers ──

type AssertTrue<T extends true> = T;

// 双向可赋值版 Equal：严格函数版会误判 & 交集类型（{a} & {b} ≠ {a; b}）
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ── Table definitions ──

const USER_SQL = `CREATE TABLE IF NOT EXISTS user (
externalUserId TEXT PRIMARY KEY,
username TEXT NOT NULL UNIQUE,
passwordHash TEXT NOT NULL,
email TEXT,
phone TEXT,
token TEXT,
createdAt TEXT NOT NULL,
updatedAt TEXT NOT NULL
)`;
const MARK_RECORD_SQL = `CREATE TABLE IF NOT EXISTS markRecord (
id INTEGER PRIMARY KEY AUTOINCREMENT,
userId TEXT NOT NULL,
costCredits REAL NOT NULL DEFAULT 1.0,
createdAt TEXT NOT NULL,
confirmedAt TEXT
)`;
const CREDIT_TX_SQL = `CREATE TABLE IF NOT EXISTS creditTransaction (
id INTEGER PRIMARY KEY AUTOINCREMENT,
userId TEXT NOT NULL,
amountMoney INTEGER NOT NULL,
amountCredits INTEGER NOT NULL,
description TEXT,
createdAt TEXT NOT NULL
)`;
const KF_CURSOR_SQL = `CREATE TABLE IF NOT EXISTS kfCursor (
openKfId TEXT PRIMARY KEY,
cursor TEXT NOT NULL
)`;

// ── CHECK 枚举列 ──

const CHECK_TBL_SQL = `CREATE TABLE IF NOT EXISTS checkTbl (
id INTEGER PRIMARY KEY,
status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
score INTEGER NOT NULL CHECK (score IN (1, 2, 3, 4, 5)),
nullable TEXT CHECK (nullable IN ('a', 'b'))
)`;
type CheckTables = Schema<typeof CHECK_TBL_SQL>;
type _CheckShape = AssertTrue<Equal<CheckTables, {
  checkTbl: {
    id: number;
    status: 'pending' | 'confirmed' | 'rejected';
    score: 1 | 2 | 3 | 4 | 5;
    nullable: 'a' | 'b' | null;
  }
}>>;
type _CheckSelectStar = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM checkTbl WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', CheckTables>[number]['status'],
  'pending' | 'confirmed' | 'rejected'
>>;
type _CheckWhereParam = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM checkTbl WHERE checkTbl.status = @status GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', CheckTables>,
  { status: 'pending' | 'confirmed' | 'rejected' }
>>;
type _CheckInsertParam = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO checkTbl (status, score) VALUES (@status, @score)', CheckTables>,
  { status: 'pending' | 'confirmed' | 'rejected'; score: 1 | 2 | 3 | 4 | 5 }
>>;
type _InsertReturningParams = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO checkTbl (status, score) VALUES (@status, @score) RETURNING id', CheckTables>,
  { status: 'pending' | 'confirmed' | 'rejected'; score: 1 | 2 | 3 | 4 | 5 }
>>;
type _CheckReturningEnumAll = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO checkTbl (status, score) VALUES (@status, @score) RETURNING status, score', CheckTables>,
  { status: 'pending' | 'confirmed' | 'rejected'; score: 1 | 2 | 3 | 4 | 5 }[]
>>;
type _CheckReturningEnumGet = AssertTrue<Equal<
  SqlGetResult<'INSERT OR ABORT INTO checkTbl (status, score) VALUES (@status, @score) RETURNING status', CheckTables>,
  { status: 'pending' | 'confirmed' | 'rejected' } | undefined
>>;
type _NegInsertReturningEmpty = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO user (id) VALUES (@id) RETURNING', Tables>, never
>>;
type _CheckUpdateParam = AssertTrue<Equal<
  RunParams<'UPDATE OR ABORT checkTbl SET status = @status WHERE checkTbl.id = @id', CheckTables>,
  { status: 'pending' | 'confirmed' | 'rejected'; id: number }
>>;
type _CheckRangeDegrades = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS r (\ncost REAL CHECK (cost > 0)\n)">,
  { r: { cost: number | null } }
>>;
type _CheckOtherCol = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\nstatus TEXT NOT NULL CHECK (score IN (1, 2, 3))\n)">,
  { t: { status: string } }
>>;
type _CheckConstExpr = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\nx INTEGER NOT NULL CHECK (1 IN (1, 2))\n)">,
  { t: { x: number } }
>>;

// ── Schema tests（表级约束：列区末列逗号 + 空行）──

type _TblConstraintPk = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS orderItem (\norderId  INTEGER NOT NULL,\nitemId   INTEGER NOT NULL,\nquantity INTEGER NOT NULL,\n\nPRIMARY KEY (orderId, itemId)\n)">,
  { orderItem: { orderId: number; itemId: number; quantity: number } }
>>;
type _TblConstraintUnique = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\na TEXT,\nb TEXT,\n\nUNIQUE (a, b)\n)">,
  { t: { a: string | null; b: string | null } }
>>;
type _TblConstraintCheck = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\na INTEGER,\nb INTEGER,\n\nCHECK (a > b)\n)">,
  { t: { a: number | null; b: number | null } }
>>;
type _TblConstraintFk = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS child (\nid   INTEGER NOT NULL,\npid  INTEGER NOT NULL,\n\nFOREIGN KEY (pid) REFERENCES parent(id)\n)">,
  { child: { id: number; pid: number } }
>>;
type _TblConstraintMixed = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\na INTEGER NOT NULL,\nb INTEGER NOT NULL,\n\nPRIMARY KEY (a, b),\nFOREIGN KEY (a) REFERENCES p(id)\n)">,
  { t: { a: number; b: number } }
>>;
type _TblConstraintMultiBlank = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\na INTEGER,\nb INTEGER,\n\nPRIMARY KEY (a, b),\n\nCHECK (a > 0)\n)">,
  { t: { a: number | null; b: number | null } }
>>;
type _TblConstraintEnumCol = AssertTrue<Equal<
  Schema<"CREATE TABLE IF NOT EXISTS t (\nstatus TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),\nscore  INTEGER CHECK (score IN (1, 2, 3)),\n\nUNIQUE (status)\n)">,
  { t: { status: 'pending' | 'confirmed'; score: 1 | 2 | 3 | null } }
>>;

// ── Schema tests（外键类型传播：SchemaFks + ResolveFks）──

type FkEnumTables =
  ResolveFks<SchemaFks<"CREATE TABLE IF NOT EXISTS parent (\nid TEXT PRIMARY KEY CHECK (id IN ('a', 'b'))\n)"> & SchemaFks<"CREATE TABLE IF NOT EXISTS child (\npid TEXT NOT NULL REFERENCES parent(id)\n)">>;
type _FkEnumShape = AssertTrue<Equal<FkEnumTables, {
  parent: { id: 'a' | 'b' };
  child: { pid: 'a' | 'b' };
}>>;
type _FkEnumInsertParam = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO child (pid) VALUES (@pid)', FkEnumTables>,
  { pid: 'a' | 'b' }
>>;
type _FkEnumSelect = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL child.pid AS pid FROM child WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', FkEnumTables>,
  { pid: 'a' | 'b' }[]
>>;
type _FkNullable = AssertTrue<Equal<
  ResolveFks<SchemaFks<"CREATE TABLE IF NOT EXISTS parent (\nid TEXT PRIMARY KEY\n)"> & SchemaFks<"CREATE TABLE IF NOT EXISTS child (\npid TEXT REFERENCES parent(id)\n)">>,
  { parent: { id: string }; child: { pid: string | null } }
>>;
type _FkEnumNullable = AssertTrue<Equal<
  ResolveFks<SchemaFks<"CREATE TABLE IF NOT EXISTS parent (\nid TEXT PRIMARY KEY CHECK (id IN ('a', 'b'))\n)"> & SchemaFks<"CREATE TABLE IF NOT EXISTS child (\npid TEXT REFERENCES parent(id)\n)">>,
  { parent: { id: 'a' | 'b' }; child: { pid: 'a' | 'b' | null } }
>>;
type _FkOwnCheck = AssertTrue<Equal<
  ResolveFks<SchemaFks<"CREATE TABLE IF NOT EXISTS parent (\nid TEXT PRIMARY KEY CHECK (id IN ('a', 'b', 'c'))\n)"> & SchemaFks<"CREATE TABLE IF NOT EXISTS child (\npid TEXT NOT NULL CHECK (pid IN ('a', 'b')) REFERENCES parent(id)\n)">>,
  { parent: { id: 'a' | 'b' | 'c' }; child: { pid: 'a' | 'b' } }
>>;
type _FkSelfRef = AssertTrue<Equal<
  ResolveFks<SchemaFks<"CREATE TABLE IF NOT EXISTS node (\nid INTEGER PRIMARY KEY,\nparentId INTEGER REFERENCES node(id)\n)">>,
  { node: { id: number; parentId: number | null } }
>>;

type Tables =
  ResolveFks<
    SchemaFks<typeof USER_SQL>
    & SchemaFks<typeof MARK_RECORD_SQL>
    & SchemaFks<typeof CREDIT_TX_SQL>
    & SchemaFks<typeof KF_CURSOR_SQL>
  >;

// ── Schema tests（完整形状断言）──

type _UserShape = AssertTrue<Equal<Tables['user'], {
  externalUserId: string;
  username: string;
  passwordHash: string;
  email: string | null;
  phone: string | null;
  token: string | null;
  createdAt: string;
  updatedAt: string;
}>>;
type _MarkRecordShape = AssertTrue<Equal<Tables['markRecord'], {
  id: number;
  userId: string;
  costCredits: number;
  createdAt: string;
  confirmedAt: string | null;
}>>;
type _CreditTxShape = AssertTrue<Equal<Tables['creditTransaction'], {
  id: number;
  userId: string;
  amountMoney: number;
  amountCredits: number;
  description: string | null;
  createdAt: string;
}>>;
type _KfCursorShape = AssertTrue<Equal<Tables['kfCursor'], {
  openKfId: string;
  cursor: string;
}>>;

// ── SqlAllResult ──

type _SrMrkStar = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  Tables['markRecord'][]
>>;

// ── SqlAllResult (LEFT JOIN) ──

type _SrLeftJoin = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL user.externalUserId AS userId, markRecord.id AS recordId FROM user LEFT JOIN markRecord ON user.externalUserId = markRecord.userId WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string; recordId: number }[]
>>;

// ── SqlAllResult (SELECT DISTINCT) ──

type _SrDistinct = AssertTrue<Equal<
  SqlAllResult<'SELECT DISTINCT user.username AS username FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { username: string }[]
>>;

// ── SqlAllResult (mixed aggregate + non-aggregate) ──

type _SrMixedAgg = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL COUNT(*) AS cnt, user.username AS name FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { cnt: number; name: string }[]
>>;

// ── SqlAllResult（标量函数 → unknown）──

type _SrScalarUnknown = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL upper(user.username) AS name FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { name: unknown }[]
>>;

// ── SqlAllResult（*, COUNT(*) 混合投影 → * 部分退化为 {}）──

type _SrStarMixed = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL *, COUNT(*) AS c FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { c: number }[]
>>;

// ── SqlAllResult (SELECT * with JOIN → intersection) ──

type _SrJoinStar = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM user LEFT JOIN kfCursor ON user.externalUserId = kfCursor.openKfId WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  (Tables['user'] & Tables['kfCursor'])[]
>>;

// ── SqlAllResult (INNER JOIN) ──

type _SrInnerJoin = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL user.externalUserId AS userId, markRecord.id AS recordId FROM user INNER JOIN markRecord ON user.externalUserId = markRecord.userId WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string; recordId: number }[]
>>;

// ── WhereParams ──

type _WpUser = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { externalUserId: string }
>>;
type _WpNoWhere = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, {}
>>;
type _WpBoth = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id = @id AND markRecord.userId = @userId GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number; userId: string }
>>;

// ── WhereParams (INSERT) ──

type _IpUser = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO user (externalUserId, username, passwordHash, email, phone, token, createdAt, updatedAt) VALUES (@externalUserId, @username, @passwordHash, @email, @phone, @token, @createdAt, @updatedAt)', Tables>,
  {
    externalUserId: string;
    username: string;
    passwordHash: string;
    email: string | null;
    phone: string | null;
    token: string | null;
    createdAt: string;
    updatedAt: string;
  }
>>;
type _IpMrk = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO markRecord (userId, createdAt, costCredits) VALUES (@userId, @createdAt, @costCredits)', Tables>,
  { userId: string; createdAt: string; costCredits: number }
>>;
type _IpCt = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO creditTransaction (userId, amountMoney, amountCredits, description, createdAt) VALUES (@userId, @amountMoney, @amountCredits, @description, @createdAt)', Tables>,
  { userId: string; amountMoney: number; amountCredits: number; description: string | null; createdAt: string }
>>;

// ── WhereParams (UPDATE) ──

type _UpFull = AssertTrue<Equal<
  RunParams<'UPDATE OR ABORT user SET token = @token, updatedAt = @updatedAt WHERE user.externalUserId = @externalUserId', Tables>,
  { token: string | null; updatedAt: string; externalUserId: string }
>>;

// ── WhereParams (DELETE) ──

type _WpDelete = AssertTrue<Equal<
  RunParams<'DELETE FROM markRecord WHERE markRecord.id = @id', Tables>,
  { id: number }
>>;
 
// ── INSERT OR REPLACE ──

type _IorParams = AssertTrue<Equal<
  RunParams<'INSERT OR REPLACE INTO kfCursor (openKfId, cursor) VALUES (@openKfId, @cursor)', Tables>,
  { openKfId: string; cursor: string }
>>;

// ── SqlAllResult ──

type _SarStar = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM user WHERE user.id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  Tables['user'][]
>>;
type _SarCol = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL user.email AS email, user.phone AS phone FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { email: string | null; phone: string | null }[]
>>;
type _SarAggCount = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL COUNT(*) AS count FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { count: number }[]
>>;
type _SarAggTotal = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL SUM(markRecord.costCredits) AS total FROM markRecord WHERE markRecord.userId = @userId GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { total: number | null }[]
>>;
type _SarAggAvg = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL AVG(markRecord.costCredits) AS avg FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { avg: number | null }[]
>>;
type _SarAggMax = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL MAX(markRecord.costCredits) AS max FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { max: number | null }[]
>>;
type _SarAggMin = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL MIN(markRecord.costCredits) AS min FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { min: number | null }[]
>>;
type _SarAggConcat = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL GROUP_CONCAT(markRecord.userId) AS names FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { names: string | null }[]
>>;
type _SarDmlNever = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO user (id) VALUES (@id)', Tables>, never
>>;
type _SarUpdateNever = AssertTrue<Equal<
  SqlAllResult<'UPDATE OR ABORT user SET email = @email', Tables>, never
>>;
type _SarInsertReturning = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO user (externalUserId) VALUES (@externalUserId) RETURNING externalUserId, createdAt', Tables>,
  { externalUserId: string; createdAt: string }[]
>>;
type _SarInsertReturningStar = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO user (id) VALUES (@id) RETURNING *', Tables>,
  Tables['user'][]
>>;
type _SarInsertReturningUnknownCol = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO user (id) VALUES (@id) RETURNING ghost', Tables>,
  {}[]
>>;
type _SarInsertReturningPrefix = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO user (id) VALUES (@id) RETURNING user.id', Tables>,
  {}[]
>>;
type _SarInsertReturningAs = AssertTrue<Equal<
  SqlAllResult<'INSERT OR ABORT INTO user (id) VALUES (@id) RETURNING createdAt AS c', Tables>,
  {}[]
>>;
type _SarUpdateReturning = AssertTrue<Equal<
  SqlAllResult<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING externalUserId, updatedAt', Tables>,
  { externalUserId: string; updatedAt: string }[]
>>;
type _SarUpdateReturningStar = AssertTrue<Equal<
  SqlAllResult<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING *', Tables>,
  Tables['user'][]
>>;
type _SarUpdateReturningUnknownCol = AssertTrue<Equal<
  SqlAllResult<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING ghost', Tables>,
  {}[]
>>;
type _SarDeleteReturning = AssertTrue<Equal<
  SqlAllResult<'DELETE FROM markRecord WHERE markRecord.id = @id RETURNING id, costCredits', Tables>,
  { id: number; costCredits: number }[]
>>;
type _SarDeleteReturningStar = AssertTrue<Equal<
  SqlAllResult<'DELETE FROM markRecord WHERE markRecord.id = @id RETURNING *', Tables>,
  Tables['markRecord'][]
>>;

// ── SqlGetResult ──

type _SgrStar = AssertTrue<Equal<
  SqlGetResult<'SELECT ALL * FROM user WHERE user.id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  Tables['user'] | undefined
>>;
type _SgrCol = AssertTrue<Equal<
  SqlGetResult<'SELECT ALL user.username AS username FROM user WHERE user.username = @username GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { username: string } | undefined
>>;
type _SgrColMulti = AssertTrue<Equal<
  SqlGetResult<'SELECT ALL user.email AS email, user.phone AS phone FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { email: string | null; phone: string | null } | undefined
>>;
type _SgrAggCount = AssertTrue<Equal<
  SqlGetResult<'SELECT ALL COUNT(*) AS count FROM markRecord WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { count: number } | undefined
>>;
type _SgrInsertReturning = AssertTrue<Equal<
  SqlGetResult<'INSERT OR ABORT INTO user (externalUserId) VALUES (@externalUserId) RETURNING externalUserId', Tables>,
  { externalUserId: string } | undefined
>>;
type _SgrUpdateReturning = AssertTrue<Equal<
  SqlGetResult<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING externalUserId', Tables>,
  { externalUserId: string } | undefined
>>;
type _SgrDeleteReturning = AssertTrue<Equal<
  SqlGetResult<'DELETE FROM markRecord WHERE markRecord.id = @id RETURNING id', Tables>,
  { id: number } | undefined
>>;

// ── SqlRunResult ──

type _SrrInsert = AssertTrue<Equal<
  SqlRunResult<'INSERT OR ABORT INTO user (id) VALUES (@id)', Tables>,
  { lastInsertRowid: number; changes: number }
>>;
type _SrrUpdate = AssertTrue<Equal<
  SqlRunResult<'UPDATE OR ABORT user SET user.email = @email WHERE user.id = @id', Tables>,
  { lastInsertRowid: number; changes: number }
>>;
type _SrrDelete = AssertTrue<Equal<
  SqlRunResult<'DELETE FROM user WHERE user.id = @id', Tables>,
  { lastInsertRowid: number; changes: number }
>>;
type _SrrSelectNever = AssertTrue<Equal<
  SqlRunResult<'SELECT ALL * FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, never
>>;
type _SrrInsertReturning = AssertTrue<Equal<
  SqlRunResult<'INSERT OR ABORT INTO user (id) VALUES (@id) RETURNING id', Tables>,
  { lastInsertRowid: number; changes: number }
>>;
type _SrrUpdateReturning = AssertTrue<Equal<
  SqlRunResult<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING externalUserId', Tables>,
  { lastInsertRowid: number; changes: number }
>>;
type _SrrDeleteReturning = AssertTrue<Equal<
  SqlRunResult<'DELETE FROM markRecord WHERE markRecord.id = @id RETURNING id', Tables>,
  { lastInsertRowid: number; changes: number }
>>;

// ── SqlAllParams ──

type _SapSelect = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.username = @username GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { username: string }
>>;
type _SapInsertReturning = AssertTrue<Equal<
  SqlAllParams<'INSERT OR ABORT INTO user (externalUserId) VALUES (@externalUserId) RETURNING externalUserId', Tables>,
  { externalUserId: string }
>>;
type _SapInsertReturningStar = AssertTrue<Equal<
  SqlAllParams<'INSERT OR ABORT INTO user (externalUserId) VALUES (@externalUserId) RETURNING *', Tables>,
  { externalUserId: string }
>>;
type _SapUpdateNever = AssertTrue<Equal<
  SqlAllParams<'UPDATE OR ABORT user SET email = @email', Tables>, never
>>;
type _SapDeleteNever = AssertTrue<Equal<
  SqlAllParams<'DELETE FROM user WHERE user.externalUserId = @externalUserId', Tables>, never
>>;
type _SapUpdateReturning = AssertTrue<Equal<
  SqlAllParams<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING externalUserId', Tables>,
  { token: string | null; externalUserId: string }
>>;
type _SapUpdateReturningStar = AssertTrue<Equal<
  SqlAllParams<'UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING *', Tables>,
  { token: string | null; externalUserId: string }
>>;
type _SapDeleteReturning = AssertTrue<Equal<
  SqlAllParams<'DELETE FROM markRecord WHERE markRecord.id = @id RETURNING id', Tables>,
  { id: number }
>>;
type _SapDeleteReturningStar = AssertTrue<Equal<
  SqlAllParams<'DELETE FROM markRecord WHERE markRecord.id = @id RETURNING *', Tables>,
  { id: number }
>>;

// ── TEMP TABLE ──

const TEMP_TABLE_SQL = `CREATE TEMP TABLE IF NOT EXISTS tempLog (
id INTEGER,
msg TEXT
)`;
type TempTables = Schema<typeof TEMP_TABLE_SQL>;
type _TempShape = AssertTrue<Equal<TempTables, { tempLog: { id: number | null; msg: string | null } }>>;

// ── IF NOT EXISTS ──

const IFNOTEXISTS_SQL = `CREATE TABLE IF NOT EXISTS config (
key TEXT PRIMARY KEY,
value TEXT
)`;
type ConfigTable = Schema<typeof IFNOTEXISTS_SQL>;
type _ConfigShape = AssertTrue<Equal<ConfigTable, { config: { key: string; value: string | null } }>>;
type _NegSchemaPlainTable = AssertTrue<Equal<
  Schema<"CREATE TABLE plainTbl (\nid INTEGER\n)">, {}
>>;

// ── 列类型映射（BLOB / FLOAT）──

const BLOB_TBL_SQL = `CREATE TABLE IF NOT EXISTS blobTbl (
data BLOB,
ratio FLOAT NOT NULL
)`;
type _BlobShape = AssertTrue<Equal<
  Schema<typeof BLOB_TBL_SQL>, { blobTbl: { data: Uint8Array | null; ratio: number } }
>>;

// ── 真实 db.ts DDL 镜像（REFERENCES / UNIQUE / AUTOINCREMENT / DEFAULT / 对齐空格）──

const REAL_KF_CURSOR_SQL = `CREATE TABLE IF NOT EXISTS kfCursor (
openKfId   TEXT PRIMARY KEY,
cursor     TEXT NOT NULL
)`;
const REAL_USER_SQL = `CREATE TABLE IF NOT EXISTS user (
externalUserId TEXT PRIMARY KEY,
username       TEXT NOT NULL UNIQUE,
passwordHash   TEXT NOT NULL,
email          TEXT,
phone          TEXT,
token          TEXT,
createdAt      TEXT NOT NULL,
updatedAt      TEXT NOT NULL
)`;
const REAL_MARK_RECORD_SQL = `CREATE TABLE IF NOT EXISTS markRecord (
id          INTEGER PRIMARY KEY AUTOINCREMENT,
userId      TEXT NOT NULL REFERENCES user(externalUserId),
costCredits REAL NOT NULL DEFAULT 1.0,
createdAt   TEXT NOT NULL,
confirmedAt TEXT
)`;
const REAL_CREDIT_TX_SQL = `CREATE TABLE IF NOT EXISTS creditTransaction (
id             INTEGER PRIMARY KEY AUTOINCREMENT,
userId         TEXT NOT NULL REFERENCES user(externalUserId),
amountMoney    INTEGER NOT NULL,
amountCredits  INTEGER NOT NULL,
description    TEXT,
orderNo        TEXT,
payMethod      TEXT,
createdAt      TEXT NOT NULL
)`;
const REAL_MARK_LOG_SQL = `CREATE TABLE IF NOT EXISTS markLog (
id             INTEGER PRIMARY KEY AUTOINCREMENT,
markRecordId   INTEGER NOT NULL,
userId         TEXT NOT NULL,
model          TEXT NOT NULL,
criteriaConfig TEXT NOT NULL,
imageFilename  TEXT NOT NULL,
result         TEXT NOT NULL,
createdAt      TEXT NOT NULL
)`;
type RealMarkingDb = ResolveFks<
  SchemaFks<typeof REAL_KF_CURSOR_SQL>
  & SchemaFks<typeof REAL_USER_SQL>
  & SchemaFks<typeof REAL_MARK_RECORD_SQL>
  & SchemaFks<typeof REAL_CREDIT_TX_SQL>
  & SchemaFks<typeof REAL_MARK_LOG_SQL>
>;
type _RealDbShape = AssertTrue<Equal<RealMarkingDb, {
  kfCursor: { openKfId: string; cursor: string };
  user: {
    externalUserId: string; username: string; passwordHash: string;
    email: string | null; phone: string | null; token: string | null;
    createdAt: string; updatedAt: string;
  };
  markRecord: { id: number; userId: string; costCredits: number; createdAt: string; confirmedAt: string | null };
  creditTransaction: {
    id: number; userId: string; amountMoney: number; amountCredits: number;
    description: string | null; orderNo: string | null; payMethod: string | null; createdAt: string;
  };
  markLog: {
    id: number; markRecordId: number; userId: string; model: string; criteriaConfig: string;
    imageFilename: string; result: string; createdAt: string;
  };
}>>;

// ── Negative tests: invalid SQL → never ──

type _NegSelectNoFrom = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, never
>>;
type _NegDeleteNoWhere = AssertTrue<Equal<RunParams<'DELETE FROM user', Tables>, never>>;
type _NegInsertNoValues = AssertTrue<Equal<RunParams<'INSERT OR ABORT INTO user (x) VALUES', Tables>, never>>;
type _NegUpdateNoSet = AssertTrue<Equal<RunParams<'UPDATE OR ABORT user WHERE id = @id', Tables>, never>>;
type _NegInsertMultiline = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO user (externalUserId, username) VALUES\n(@externalUserId, @username)', Tables>, never
>>;
type _NegInsertNonColParam = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO user (username) VALUES (@foo)', Tables>, {}
>>;
type _NegUpdateSetPrefixed = AssertTrue<Equal<
  RunParams<'UPDATE OR ABORT user SET user.token = @token WHERE user.externalUserId = @externalUserId', Tables>,
  { token: never; externalUserId: string }
>>;
type _PosUpdateArbitraryName = AssertTrue<Equal<
  RunParams<'UPDATE OR ABORT user SET token = @tok WHERE user.externalUserId = @uid', Tables>,
  { tok: string | null; uid: string }
>>;
type _NegUpdateNoWhere = AssertTrue<Equal<
  RunParams<'UPDATE OR ABORT user SET token = @token', Tables>, never
>>;
type _NegInsertNoCols = AssertTrue<Equal<
  RunParams<'INSERT OR ABORT INTO user VALUES (@a)', Tables>, never
>>;
type _NegSelectLowercase = AssertTrue<Equal<
  SqlAllResult<'select all * from user where 1=1 group by 1 having 1=1 order by 1 limit -1 offset 0', Tables>, never
>>;
type _NegSelectAlias = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM user u WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, {}[]
>>;
type _NegDeleteNoPrefix = AssertTrue<Equal<
  RunParams<'DELETE FROM markRecord WHERE id = @id', Tables>, {}
>>;

// ── IN / NOT IN ──

type _WpIn = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.userId IN (@userId, @anotherId) GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string; anotherId: string }
>>;
type _WpNotIn = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id NOT IN (@id1, @id2) GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id1: number; id2: number }
>>;
type _WpInMixedAnd = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.userId = @userId AND markRecord.id IN (@id1, @id2) GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string; id1: number; id2: number }
>>;

// ── BETWEEN ──

type _WpBetween = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id BETWEEN @a and @b GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { a: number; b: number }
>>;
type _WpBetweenStr = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.username BETWEEN @a and @b GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { a: string; b: string }
>>;
type _WpBetweenMixedAnd = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.userId = @userId AND markRecord.id BETWEEN @a and @b GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string; a: number; b: number }
>>;

// ── IS NULL / IS NOT NULL ──

type _WpIsNotNull = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.confirmedAt IS NOT NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, {}
>>;
type _WpIsNull = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.confirmedAt IS NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, {}
>>;
type _WpMixedIsNotNull = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.userId = @userId AND markRecord.confirmedAt IS NOT NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string }
>>;
type _WpMixedIsNull = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.userId = @userId AND markRecord.confirmedAt IS NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { userId: string }
>>;

// ── SqlAllResult（WHERE IS NULL / IS NOT NULL 收窄）──

type _SrStarIsNotNull = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM markRecord WHERE markRecord.confirmedAt IS NOT NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>[number]['confirmedAt'], string
>>;
type _SrStarIsNull = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM markRecord WHERE markRecord.confirmedAt IS NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>[number]['confirmedAt'], null
>>;
type _SrColIsNotNull = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL markRecord.confirmedAt AS confirmedAt FROM markRecord WHERE markRecord.confirmedAt IS NOT NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>[number]['confirmedAt'], string
>>;
type _SrColIsNull = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL markRecord.confirmedAt AS confirmedAt FROM markRecord WHERE markRecord.confirmedAt IS NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>[number]['confirmedAt'], null
>>;
type _SrColOtherRefined = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL markRecord.id AS id, markRecord.confirmedAt AS confirmedAt FROM markRecord WHERE markRecord.userId = @userId AND markRecord.confirmedAt IS NOT NULL GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>[number]['confirmedAt'], string
>>;

// ── SqlAllParams (SELECT 参数推导) ──

type _PrNoParams = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, {}
>>;
type _PrWhereEq = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrWhereNullable = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.email = @email GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { email: string | null }
>>;
type _PrWhereAnd = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id = @id AND markRecord.userId = @userId GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number; userId: string }
>>;
type _PrWhereMixed = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT @limit OFFSET @offset', Tables>,
  { externalUserId: string; limit: number; offset: number }
>>;
type _PrWhereOr = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId OR user.username = @username GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { externalUserId: string; username: string }
>>;
type _PrWhereGte = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id >= @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrWhereLte = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id <= @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrWhereGt = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id > @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrWhereLt = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id < @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrWhereNe = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id != @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrWhereNe2 = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM markRecord WHERE markRecord.id <> @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { id: number }
>>;
type _PrLike = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.username LIKE @pattern GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { pattern: string }
>>;
type _PrNotLike = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.username NOT LIKE @pattern GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { pattern: string }
>>;
type _PrLikeAnd = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId AND user.username LIKE @pattern GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { externalUserId: string; pattern: string }
>>;

// ── SqlAllParams（HAVING 参数被丢弃）──

type _WpHavingDropped = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL COUNT(*) AS c FROM markRecord WHERE 1=1 GROUP BY 1 HAVING COUNT(*) > @min ORDER BY 1 LIMIT -1 OFFSET 0', Tables>, {}
>>;

// ── 短形式（无 GROUP BY/HAVING）──

type _SfStar = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  Tables['user'][]
>>;
type _SfStarParams = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { externalUserId: string }
>>;
type _SfAggCount = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL COUNT(*) AS count FROM markRecord WHERE 1=1 ORDER BY 1 LIMIT -1 OFFSET 0', Tables>,
  { count: number }[]
>>;
type _SfIsNotNull = AssertTrue<Equal<
  SqlAllResult<'SELECT ALL * FROM markRecord WHERE markRecord.confirmedAt IS NOT NULL ORDER BY 1 LIMIT -1 OFFSET 0', Tables>[number]['confirmedAt'],
  string
>>;
type _SfLimitOffset = AssertTrue<Equal<
  SqlAllParams<'SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId ORDER BY 1 LIMIT @limit OFFSET @offset', Tables>,
  { externalUserId: string; limit: number; offset: number }
>>;

// ── 第 0 路：makeSql 返回具体 SQL 字面量 + 对象字面量写死排序变体 ──

const SORT_COLS = ["createdAt", "costCredits"] as const;
const SORT_DIRS = ["asc", "desc"] as const;
type SortCol = (typeof SORT_COLS)[number];
type SortDir = (typeof SORT_DIRS)[number];

type MapGenSql =
  `SELECT ALL * FROM markRecord WHERE 1=1 ORDER BY ${SortCol} ${SortDir}, id ${SortDir} LIMIT @limit OFFSET @offset`;

const makeSql = <const C extends keyof Tables['markRecord'], const D extends SortDir>(
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

type _SqlsValue = AssertTrue<Equal<
  typeof markListSql['createdAt.asc'],
  `SELECT ALL * FROM markRecord WHERE 1=1 ORDER BY createdAt asc, id asc LIMIT @limit OFFSET @offset`
>>;

type _MapGenParams = AssertTrue<Equal<
  SqlAllParams<MapGenSql, Tables>,
  { limit: number; offset: number }
>>;
type _MapGenResult = AssertTrue<Equal<
  SqlAllResult<MapGenSql, Tables>,
  Tables['markRecord'][]
>>;

// ── Runtime tests ──

const TEST_TBL_SQL = `CREATE TABLE IF NOT EXISTS testTbl (
id INTEGER PRIMARY KEY,
label TEXT NOT NULL,
val INTEGER
)`;
type TestTables = Schema<typeof TEST_TBL_SQL>;

describe('TypedDb', () => {
  let db: DatabaseSync;
  let typedDb: TypedDb<TestTables>;

  before(() => {
    db = new DatabaseSync(':memory:');
    db.exec(TEST_TBL_SQL);
    typedDb = new TypedDb<TestTables>(db);
  });

  describe('INSERT', () => {
    beforeEach(() => { db.exec("DELETE FROM testTbl"); });

    it('returns lastInsertRowid and changes', () => {
      const r = typedDb.prepare("INSERT OR ABORT INTO testTbl (label, val) VALUES (@label, @val)").run({ label: 'a', val: 1 });
      assert.equal(typeof r.lastInsertRowid, 'number');
      assert.equal(r.changes, 1);
    });

    it('INSERT OR REPLACE replaces existing row', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const r = typedDb.prepare("INSERT OR REPLACE INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'b', val: 2 });
      assert.equal(r.changes, 1);
    });
  });

  describe('INSERT ... RETURNING', () => {
    beforeEach(() => { db.exec("DELETE FROM testTbl"); });

    it('all returns inserted rows', () => {
      const rows = typedDb.prepare("INSERT OR ABORT INTO testTbl (label, val) VALUES (@label, @val) RETURNING id, label").all({ label: 'a', val: 7 });
      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0].id, 'number');
      assert.equal(rows[0].label, 'a');
    });

    it('all RETURNING * returns full row', () => {
      const rows = typedDb.prepare("INSERT OR ABORT INTO testTbl (label, val) VALUES (@label, @val) RETURNING *").all({ label: 'b', val: 8 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, 'b');
      assert.equal(rows[0].val, 8);
    });

    it('get returns single inserted row', () => {
      const row = typedDb.prepare("INSERT OR ABORT INTO testTbl (label, val) VALUES (@label, @val) RETURNING id").get({ label: 'c', val: 9 })!;
      assert.equal(typeof row.id, 'number');
    });

    it('run still returns changes', () => {
      const r = typedDb.prepare("INSERT OR ABORT INTO testTbl (label, val) VALUES (@label, @val) RETURNING id").run({ label: 'd', val: 10 });
      assert.equal(r.changes, 1);
    });

    it('OR IGNORE conflict returns no rows', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 1 });
      const rows = typedDb.prepare("INSERT OR IGNORE INTO testTbl (id, label, val) VALUES (@id, @label, @val) RETURNING id").all({ id: 1, label: 'y', val: 2 });
      assert.equal(rows.length, 0);
    });

    it('OR IGNORE conflict get returns undefined', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 1 });
      const row = typedDb.prepare("INSERT OR IGNORE INTO testTbl (id, label, val) VALUES (@id, @label, @val) RETURNING id").get({ id: 1, label: 'y', val: 2 });
      assert.equal(row, undefined);
    });
  });

  describe('UPDATE ... RETURNING', () => {
    beforeEach(() => { db.exec("DELETE FROM testTbl"); });

    it('all returns updated rows', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const rows = typedDb.prepare("UPDATE OR ABORT testTbl SET label = @label, val = @val WHERE testTbl.id = @id RETURNING id, label, val").all({ label: 'b', val: 20, id: 1 });
      assert.equal(rows.length, 1);
      assert.deepEqual({ ...rows[0] }, { id: 1, label: 'b', val: 20 });
    });

    it('all RETURNING * returns full row', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const rows = typedDb.prepare("UPDATE OR ABORT testTbl SET label = @label WHERE testTbl.id = @id RETURNING *").all({ label: 'c', id: 1 });
      assert.deepEqual({ ...rows[0] }, { id: 1, label: 'c', val: 10 });
    });

    it('get returns single updated row', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const row = typedDb.prepare("UPDATE OR ABORT testTbl SET label = @label WHERE testTbl.id = @id RETURNING id").get({ label: 'd', id: 1 })!;
      assert.equal(row.id, 1);
    });

    it('run still returns changes', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const r = typedDb.prepare("UPDATE OR ABORT testTbl SET label = @label WHERE testTbl.id = @id RETURNING id").run({ label: 'e', id: 1 });
      assert.equal(r.changes, 1);
    });
  });

  describe('DELETE ... RETURNING', () => {
    beforeEach(() => { db.exec("DELETE FROM testTbl"); });

    it('all returns deleted rows', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const rows = typedDb.prepare("DELETE FROM testTbl WHERE id = @id RETURNING id, label").all({ id: 1 });
      assert.equal(rows.length, 1);
      assert.deepEqual({ ...rows[0] }, { id: 1, label: 'x' });
    });

    it('get returns single deleted row', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const row = typedDb.prepare("DELETE FROM testTbl WHERE id = @id RETURNING id").get({ id: 1 })!;
      assert.equal(row.id, 1);
    });

    it('run still returns changes', () => {
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
      const r = typedDb.prepare("DELETE FROM testTbl WHERE id = @id RETURNING id").run({ id: 1 });
      assert.equal(r.changes, 1);
    });
  });

  describe('UPDATE', () => {
    beforeEach(() => {
      db.exec("DELETE FROM testTbl");
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
    });

    it('returns changes', () => {
      const r = typedDb.prepare("UPDATE OR ABORT testTbl SET label = @label WHERE testTbl.id = @id").run({ label: 'c', id: 1 });
      assert.equal(r.changes, 1);
    });
  });

  describe('DELETE', () => {
    beforeEach(() => {
      db.exec("DELETE FROM testTbl");
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'x', val: 10 });
    });

    it('returns changes', () => {
      const r = typedDb.prepare("DELETE FROM testTbl WHERE id = @id").run({ id: 1 });
      assert.equal(r.changes, 1);
    });
  });

  describe('SELECT', () => {
    before(() => {
      db.exec("DELETE FROM testTbl");
      typedDb.prepare("INSERT OR ABORT INTO testTbl (id, label, val) VALUES (@id, @label, @val)").run({ id: 1, label: 'hello', val: 42 });
    });

    it('all returns correct rows', () => {
      const rows = typedDb.prepare("SELECT ALL * FROM testTbl WHERE id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0").all({ id: 1 });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 1);
      assert.equal(rows[0].label, 'hello');
      assert.equal(rows[0].val, 42);
    });

    it('all returns empty for no match', () => {
      const rows = typedDb.prepare("SELECT ALL * FROM testTbl WHERE id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0").all({ id: 999 });
      assert.equal(rows.length, 0);
    });

    it('get returns single row', () => {
      const row = typedDb.prepare("SELECT ALL * FROM testTbl WHERE id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0").get({ id: 1 })!;
      assert.equal(row.id, 1);
      assert.equal(row.label, 'hello');
      assert.equal(row.val, 42);
    });

    it('get returns undefined for no match', () => {
      const row = typedDb.prepare("SELECT ALL * FROM testTbl WHERE id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0").get({ id: 999 });
      assert.equal(row, undefined);
    });

    it('all with column select returns subset', () => {
      const rows = typedDb.prepare("SELECT ALL label AS label, val AS val FROM testTbl WHERE 1=1 GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0").all({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, 'hello');
      assert.equal(rows[0].val, 42);
    });

    it('get with column select returns subset', () => {
      const row = typedDb.prepare("SELECT ALL label AS label FROM testTbl WHERE id = @id GROUP BY 1 HAVING 1=1 ORDER BY 1 LIMIT -1 OFFSET 0").get({ id: 1 })!;
      assert.equal(row.label, 'hello');
    });
  });
});

describe('TypedDb 排序变体（第 0 路：对象字面量）', () => {
  type MarkTables = Pick<Tables, 'markRecord'>;

  let mdb: DatabaseSync;
  let mTypedDb: TypedDb<MarkTables>;

  before(() => {
    mdb = new DatabaseSync(':memory:');
    mdb.exec(MARK_RECORD_SQL);
    mTypedDb = new TypedDb<MarkTables>(mdb);
  });

  it('4 个写死变体均可 prepare 且按列/方向正确排序', () => {
    mdb.exec("DELETE FROM markRecord");
    const seed = mTypedDb.prepare("INSERT OR ABORT INTO markRecord (userId, costCredits, createdAt) VALUES (@userId, @costCredits, @createdAt)");
    seed.run({ userId: 'u1', costCredits: 1.0, createdAt: '2024-01-01' });
    seed.run({ userId: 'u3', costCredits: 2.0, createdAt: '2024-01-02' });
    seed.run({ userId: 'u2', costCredits: 3.0, createdAt: '2024-01-03' });

    const rows = (key: keyof typeof markListSql) =>
      mTypedDb.prepare(markListSql[key]).all({ limit: -1, offset: 0 }).map(r => r.userId);

    assert.deepEqual(rows('createdAt.asc'), ['u1', 'u3', 'u2']);
    assert.deepEqual(rows('createdAt.desc'), ['u2', 'u3', 'u1']);
    assert.deepEqual(rows('costCredits.asc'), ['u1', 'u3', 'u2']);
    assert.deepEqual(rows('costCredits.desc'), ['u2', 'u3', 'u1']);
  });
});

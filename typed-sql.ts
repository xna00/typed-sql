import { DatabaseSync } from "node:sqlite";

// 类型级 SQL 解析器。SQL 书写约定见 types-sql-conventions.md。

// ── Column type mapping ──

/**
 * ColItem<"1"> → 1；ColItem<"'pending'"> → "pending"
 */
type ColItem<S extends string> =
  S extends `'${infer V}'` ? V
  : S extends `${infer N extends number}` ? N
  : never;

/**
 * SqlType<"status", "TEXT NOT NULL CHECK (status IN ('pending', 'confirmed'))"> → "pending" | "confirmed"
 *
 * 仅 `CHECK (<本列名> IN (...))` 参与枚举推导；引用他列、常量表达式或范围式
 * CHECK 不匹配，回落基础类型。字符串值单引号，数值裸写。
 */
type SqlType<Col extends string, T extends string> =
  T extends `${string}CHECK (${Col} IN (${infer Items}))${string}`
  ? ColItem<Split<Items, ", ">[number]>
  : T extends `INTEGER${string}` ? number
  : T extends `INT${string}` ? number
  : T extends `REAL${string}` ? number
  : T extends `FLOAT${string}` ? number
  : T extends `TEXT${string}` ? string
  : T extends `BLOB${string}` ? Uint8Array
  : never;

type TrimStart<S extends string> = S extends ` ${infer SS}` ? TrimStart<SS> : S;

/**
 * ColNameType<"name TEXT NOT NULL"> → ["name", "TEXT NOT NULL"]
 */
type ColNameType<S extends string> =
  S extends `${infer Name} ${infer Rest}`
  ? [Name, TrimStart<Rest>]
  : never;

type Split<S extends string, Sep extends string, Acc extends string[] = []> =
  S extends `${infer Head}${Sep}${infer Tail}`
  ? Split<Tail, Sep, [...Acc, Head]>
  : S extends '' ? Acc : [...Acc, S];

/**
 * ColNullable<"name TEXT NOT NULL"> → never
 *
 * ColNullable<"name TEXT"> → null
 */
type ColNullable<S extends string> =
  S extends `${string}NOT NULL${string}` ? never
  : S extends `${string}PRIMARY KEY${string}` ? never
  : null;

/**
 * ColToField<"name TEXT NOT NULL"> → { name: string }
 *
 * ColToField<"email TEXT"> → { email: string | null }
 */
type ColToField<S extends string> =
  ColNameType<S> extends [infer N extends string, infer T extends string]
  ? {[K in N]: T extends  `${string} REFERENCES ${infer Rt}(${infer Rc})${string}` ? {
    def: SqlType<N, T> | ColNullable<S>,
    ref: [Rt, Rc]
  } : {
    def: SqlType<N, T> | ColNullable<S>
  }}
  : {};

/**
 * ParseCols<"\nid INTEGER PRIMARY KEY,\nname TEXT NOT NULL"> → { id: number; name: string }
 *
 * 先按 `,\n\n`（列区末列逗号 + 空行）截断出列区，空行后的表级约束块整体忽略；
 * 再按 `,\n` 拆分每列并折叠成一条记录。
 */
type ParseCols<S extends string> =
  ParseColsList<Split<Split<S, ',\n\n'>[0] & string, `,\n`>>;

type ParseColsList<Parts extends string[], Acc extends Record<string, unknown> = {}> =
  Parts extends [infer P extends string, ...infer Rest extends string[]]
  ? ParseColsList<Rest, Acc & ColToField<P>>
  : Acc;

/**
 * SchemaFks<"CREATE TABLE IF NOT EXISTS user (id INTEGER PRIMARY KEY, name TEXT NOT NULL)">
 *   → { user: { id: { def: number }, name: { def: string } } }   // 列是内部 wrapper
 *
 * SchemaFks<"CREATE TEMP TABLE IF NOT EXISTS log (msg TEXT)">
 *   → { log: { msg: { def: string | null } } }
 *
 * 解析 `CREATE [TEMP] TABLE IF NOT EXISTS <name>` 的列定义，含列级 `REFERENCES` 时
 * wrapper 带 `ref: [表, 列]`。只支持带 IF NOT EXISTS；漏写时返回 {}
 */
export type SchemaFks<S extends string> =
  S extends `CREATE${string}TABLE IF NOT EXISTS ${infer Name} (\n${infer Cols}\n)`
  ? {[K in Name]: ParseCols<Cols>}
  : {};

/**
 * ResolveFks<SchemaFks<A> & SchemaFks<B>>  →  把带 `ref` 的列与目标列类型取交集。
 *
 * 子列类型 = (自身 def & 目标 def) | (自身可空 ? null : never)：
 * - 自身类型/枚举保留；父列可空不传导（`string & (string | null)` = `string`）
 * - 只传导一层（A→B→C 链时 A 不含 C）；环形外键无递归，两侧取各自 def 交集
 */
export type ResolveFks<D extends Record<string, Record<string, {def: unknown} | {def: unknown, ref: [string, string]}>>> = {
  [K in keyof D]: {
    [KK in keyof D[K]]: D[K][KK] extends infer V extends {def: unknown}
      ? V extends {ref: [infer Rt, infer Rc]}
        ? (V['def'] & TblsPick<D, Rt, Rc>['def']) | (null & V['def'])
        : V['def']
      : never
  }
}

/**
 * Schema<"CREATE TABLE IF NOT EXISTS user (id INTEGER PRIMARY KEY, name TEXT NOT NULL)">
 *   → { user: { id: number; name: string } }
 *
 * 无外键的单表 DDL 直接用；含 REFERENCES 的库类型用 `ResolveFks<SchemaFks<...> & ...>`。
 * 这里只解包 wrapper 的 def，不做外键解析（向后兼容旧 Schema 输出）。
 */
export type Schema<S extends string> =
  SchemaFks<S> extends infer D extends Record<string, Record<string, {def: unknown}>>
  ? { [K in keyof D]: { [KK in keyof D[K]]: D[K][KK]['def'] } }
  : never
// ── @name parameter scanner ──

// ── SELECT pattern match ──

type _MatchSelect<S extends string> =
  S extends `SELECT ${'ALL' | 'DISTINCT'} ${infer Cols} FROM ${infer FromClause} WHERE ${infer WhereClause} GROUP BY ${infer _GroupBy} HAVING ${infer Having} ORDER BY ${infer _OrderBy} LIMIT ${infer Limit} OFFSET ${infer Offset}`
  ? { cols: Cols; from: FromClause; where: WhereClause; limit: Limit; offset: Offset }
  : S extends `SELECT ${'ALL' | 'DISTINCT'} ${infer Cols} FROM ${infer FromClause} WHERE ${infer WhereClause} ORDER BY ${infer _OrderBy} LIMIT ${infer Limit} OFFSET ${infer Offset}`
  ? { cols: Cols; from: FromClause; where: WhereClause; limit: Limit; offset: Offset }
  : unknown;

// ── DML pattern match ──

type SqlConflict = 'ROLLBACK' | 'ABORT' | 'FAIL' | 'IGNORE' | 'REPLACE';

type _MatchInsert<S extends string> =
  S extends `INSERT OR ${SqlConflict} INTO ${infer Tbl} (${infer Cols}) VALUES (${infer Values}) RETURNING ${infer Returning}`
  ? { table: Tbl; cols: Cols; values: Values; returning: Returning }
  : S extends `INSERT OR ${SqlConflict} INTO ${infer Tbl} (${infer Cols}) VALUES (${infer Values})`
    ? { table: Tbl; cols: Cols; values: Values }
    : unknown;

type _MatchUpdate<S extends string> =
  S extends `UPDATE OR ${SqlConflict} ${infer Tbl} SET ${infer SetClause} WHERE ${infer WhereClause} RETURNING ${infer Returning}`
  ? { table: Tbl; set: SetClause; where: WhereClause; returning: Returning }
  : S extends `UPDATE OR ${SqlConflict} ${infer Tbl} SET ${infer SetClause} WHERE ${infer WhereClause}`
    ? { table: Tbl; set: SetClause; where: WhereClause }
    : unknown;

type _MatchDelete<S extends string> =
  S extends `DELETE FROM ${infer Tbl} WHERE ${infer WhereClause} RETURNING ${infer Returning}`
  ? { table: Tbl; where: WhereClause; returning: Returning }
  : S extends `DELETE FROM ${infer Tbl} WHERE ${infer WhereClause}`
    ? { table: Tbl; where: WhereClause }
    : unknown;

// ── Column resolution ──

type FlatSplit<SS extends string[], Sep extends string, R extends string[] = []> =
  SS extends [infer First extends string, ...infer Rest extends string[]]
  ? FlatSplit<Rest, Sep, [...R, ...Split<First, Sep>]>
  : R;

type _ExtractTableName<T extends string> =
  T extends `${infer Tbl} ON ${string}` ? Tbl : T;

type _NewTables<FromClause extends string, Tables extends {}> =
  Pick<Tables,
    _ExtractTableName<
      FlatSplit<FlatSplit<[FromClause], " LEFT JOIN ">, " INNER JOIN ">[number]
    > & keyof Tables
  >;

type _AggCount = 'COUNT';
type _AggNumeric = 'SUM' | 'AVG' | 'MAX' | 'MIN';
type _AggString = 'GROUP_CONCAT';

/**
 * ColType<"user.id", { user: Tables['user'] }, "WHERE user.id = @id"> → Tables['user']['id']
 *
 * ColType<"COUNT(*)", ...> → number
 *
 * ColType<"SUM(markRecord.costCredits)", ...> → number | null
 *
 * ColType<"GROUP_CONCAT(x)", ...> → string | null
 *
 * ColType<"u.age + 10", ...> → unknown
 *
 * 若 WHERE 含 `T.C IS NOT NULL` → 去掉 nullable；含 `T.C IS NULL` → 恒为 null
 *
 * 聚合必须位于列表达式开头（不得包在 COALESCE 等其他函数内），否则落入
 * T.C 分支得 unknown，杜绝"聚合藏在函数内部被意外命中"的误判。
 */
type ColType<Expr extends string, Aliases extends {}, WhereClause extends string> =
  Expr extends `${_AggCount}(${string}` ? number
  : Expr extends `${_AggNumeric}(${string}` ? number | null
  : Expr extends `${_AggString}(${string}` ? string | null
  : Expr extends `${infer T}.${infer C}`
    ? (
      T extends keyof Aliases
        ? (
          WhereClause extends `${string}${T}.${C} IS NOT NULL${string}` ? NonNullable<TblsPick<Aliases, T, C>>
          : WhereClause extends `${string}${T}.${C} IS NULL${string}` ? null
          : TblsPick<Aliases, T, C>
        )
        : unknown
    )
    : unknown;

type _Col<S extends string, Aliases extends {}, WhereClause extends string> =
  S extends `${infer Expr} AS ${infer Name}`
  ? { [K in Name]: ColType<Expr, Aliases, WhereClause> }
  : {};

type _Cols<Parts extends string[], Aliases extends {}, WhereClause extends string, Acc = {}> =
  Parts extends [infer F extends string, ...infer R extends string[]]
  ? _Cols<R, Aliases, WhereClause, Acc & _Col<F, Aliases, WhereClause>>
  : Acc;

type _UnionToIntersection<U> =
  (U extends unknown ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

/**
 * WhereNullCol<["markRecord.userId = @userId", "markRecord.confirmedAt IS NOT NULL"], Tables>
 *   → { confirmedAt: string }
 *
 * 从 WHERE 条件片段（按 OR / AND 切分）中收集 `Tbl.Col IS NULL` / `Tbl.Col IS NOT NULL`
 * 对 `SELECT *` 结果列的空值收窄。
 */
type WhereNullCol<SS extends string[], Tbls extends {}, R = {}> =
  SS extends [infer F extends string, ...infer Rest extends string[]]
  ? (
    F extends `${infer Tbl}.${infer Col} IS NOT NULL` ? WhereNullCol<Rest, Tbls, R & { [K in Col]: NonNullable<TblsPick<Tbls, Tbl, Col>> }>
    : F extends `${infer Tbl}.${infer Col} IS NULL` ? WhereNullCol<Rest, Tbls, R & { [K in Col]: null }>
    : WhereNullCol<Rest, Tbls, R>
  )
  : R;

/**
 * 纯积木：由 SqlAllResult 传入 _MatchSelect 拆出的 列列表 / FROM / WHERE。
 *
 * RawCols='*' → 各表字段合并（交集）类型，额外用 WHERE 的 IS NULL / IS NOT NULL 收窄对应列
 * RawCols='tbl.col AS name,...' → { name: 列类型 }[]
 */
type _SelectResult<RawCols extends string, FromClause extends string, WhereClause extends string, Tbls extends {}> =
  _NewTables<FromClause, Tbls> extends infer AliasMap extends {}
  ? RawCols extends '*'
    ? (_UnionToIntersection<AliasMap[keyof AliasMap]> & WhereNullCol<FlatSplit<FlatSplit<[WhereClause], ' OR '>, ' AND '>, Tbls>)[]
    : _Cols<Split<RawCols, ', '>, AliasMap, WhereClause>[]
  : never;

// ── Param type resolution ──

type AtParamName<N extends string> = N extends `@${infer M extends string}` ? M : never;

type ValueParams<SS extends string[], Tbl extends {}> =
  { [K in AtParamName<SS[number]> & keyof Tbl]: Tbl[K] };

type SetParams<SS extends string[], Tbl extends {}, R = {}> =
  SS extends [`${infer Col} = @${infer Name}`, ...infer Rest extends string[]]
  ? SetParams<Rest, Tbl, R & { [K in Name]: Tbl[Col & keyof Tbl] }>
  : R;
export type RunParams<S extends string, Tbls extends {}> =
  _MatchInsert<S> extends infer M extends { table: keyof Tbls, values: string }
  ? ValueParams<Split<M['values'], ", ">, Tbls[M['table']] & {}>
  : _MatchUpdate<S> extends infer M extends { table: keyof Tbls, set: string, where: string }
    ? SetParams<Split<M["set"], ", ">, Tbls[M['table']] & {}> & WhereParams<M['where'], Tbls>
    : _MatchDelete<S> extends infer M extends { where: string }
      ? WhereParams<M['where'], Tbls>
      : never;

type WhereParams<W extends string, Tbls extends {}> =
  Condition<FlatSplit<FlatSplit<[W], ' OR '>, ' AND '>, Tbls>;

// ── Condition（WHERE 条件参数提取）──

type TblsPick<Tbls extends {}, Tbl, Column> =
  Tbls[Tbl & keyof Tbls][Column & keyof Tbls[Tbl & keyof Tbls]];

type Condition<SS extends string[], Tbls extends {}, R extends {} = {}> =
  SS extends [infer First extends string, ...infer Rest extends string[]]
  ? (
    First extends `${infer Table}.${infer Column} NOT IN (${infer Name})`
      ? Condition<Rest, Tbls, R & { [K in AtParamName<Split<Name, ", ">[number]>]: TblsPick<Tbls, Table, Column> }>
    : First extends `${infer Table}.${infer Column} IN (${infer Name})`
      ? Condition<Rest, Tbls, R & { [K in AtParamName<Split<Name, ", ">[number]>]: TblsPick<Tbls, Table, Column> }>
    : First extends `${infer Table}.${infer Column} BETWEEN ${infer A} and ${infer B}`
      ? Condition<Rest, Tbls, R & { [K in AtParamName<A | B>]: TblsPick<Tbls, Table, Column> }>
    : First extends `${infer Table}.${infer Column} ${infer Op} @${infer Name}`
      ? Condition<Rest, Tbls, R & (
          Op extends ("=" | ">=" | "<=" | "!=" | "<>" | ">" | "<" | "LIKE" | "NOT LIKE")
          ? { [K in Name]: TblsPick<Tbls, Table, Column> }
          : {}
        )>
    : Condition<Rest, Tbls, R>
  )
  : R;

// ── SQL method result types ──

type ReturningResult<R extends string, Tbl extends {}> =
  R extends '*' ? Tbl
  : { [K in Split<R, ', '>[number] & keyof Tbl]: Tbl[K] };

export type SqlAllResult<S extends string, Tbls extends {}> =
  _MatchSelect<S> extends infer M extends { cols: string; from: string; where: string }
  ? _SelectResult<M['cols'], M['from'], M['where'], Tbls>
  : _MatchInsert<S> extends infer M extends { table: keyof Tbls; values: string; returning: string }
    ? ReturningResult<M['returning'], Tbls[M['table']] & {}>[]
    : _MatchUpdate<S> extends infer M extends { table: keyof Tbls; set: string; where: string; returning: string }
      ? ReturningResult<M['returning'], Tbls[M['table']] & {}>[]
      : _MatchDelete<S> extends infer M extends { table: keyof Tbls; where: string; returning: string }
        ? ReturningResult<M['returning'], Tbls[M['table']] & {}>[]
        : never;

export type SqlGetResult<S extends string, Tbls extends {}> =
  SqlAllResult<S, Tbls>[number] | undefined;

export type SqlRunResult<S extends string, Tbls extends {}> =
  S extends `${'INSERT' | 'UPDATE' | 'DELETE'}${string}`
  ? { lastInsertRowid: number; changes: number }
  : never;

export type SqlAllParams<S extends string, Tbls extends {}> =
  _MatchSelect<S> extends infer W extends { where: string; limit: string; offset: string }
  ? WhereParams<W['where'], Tbls> & { [K in AtParamName<W['limit'] | W['offset']>]: number }
  : _MatchInsert<S> extends infer M extends { table: keyof Tbls, values: string, returning: string }
    ? ValueParams<Split<M['values'], ", ">, Tbls[M['table']] & {}>
    : _MatchUpdate<S> extends infer M extends { table: keyof Tbls, set: string, where: string, returning: string }
      ? SetParams<Split<M['set'], ", ">, Tbls[M['table']] & {}> & WhereParams<M['where'], Tbls>
      : _MatchDelete<S> extends infer M extends { table: keyof Tbls, where: string, returning: string }
        ? WhereParams<M['where'], Tbls>
        : never;

// ── TypedDb ──

export class TypedDb<S extends {}> {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare<const T extends string>(sql: T) {
    const stmt = this.#db.prepare(sql);
    return {
      all: (params: SqlAllParams<T, S>): SqlAllResult<T, S> =>
        stmt.all(params as any) as SqlAllResult<T, S>,
      get: (params: SqlAllParams<T, S>): SqlGetResult<T, S> =>
        stmt.get(params as any) as SqlGetResult<T, S>,
      run: (params: RunParams<T, S>): SqlRunResult<T, S> =>
        stmt.run(params as any) as SqlRunResult<T, S>,
    };
  }
}

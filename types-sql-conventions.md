# 类型级 SQL 约定（typed-sql 库）

## 概览

- 原生 `node:sqlite`，零第三方依赖
- 类型级解析器从 SQL 字符串推导参数与返回值类型，`TypedDb<S>` 提供类型安全的 `prepare().all/get/run`
- 表类型由 `Schema<T>` 从 `CREATE [TEMP] TABLE IF NOT EXISTS` 语句推导；示例表定义在测试文件（typed-sql-test.ts）中
- 含外键（`REFERENCES`）的库类型用两段式：`SchemaFks<...>`（解析每段 DDL）+ `ResolveFks<...>`（把引用列与目标列类型取交集），见「外键类型传播」；无外键时 `Schema<S>` 可直接用

## API 使用

- `prepare<const T extends string>(sql)` 接受字面量 SQL，返回类型安全的语句对象
  - `.all(params)` → `T[]`（SELECT 全量结果 / INSERT/UPDATE/DELETE ... RETURNING 操作行）
  - `.get(params)` → `T | undefined`（取单行 / INSERT/UPDATE/DELETE ... RETURNING 单行，无行返回 `undefined`）
  - `.run(params)` → `{ lastInsertRowid: number; changes: number }`（INSERT/UPDATE/DELETE；`TypedDb.prepare` 不启用 `readBigInts`，字段恒为 `number`，而 `@types/node` 的 `StatementResultingChanges` 声明为 `number | bigint`）
- 参数一律传 **object**（命名参数），`node:sqlite` 原生支持，**无需关心属性顺序**
- `params` 必填：无参数的查询也要传 `{}`（如 `WHERE 1=1`）

```ts
// ✓ 任意顺序
const u = db.prepare('SELECT ALL * FROM user WHERE user.id = @id ORDER BY 1 LIMIT -1 OFFSET 0').get({ id: 1 });
```

## SQL 书写约定

### 关键字与标识符

- 解析器按**大写字面**匹配关键字，一律大写：`SELECT`, `ALL`, `DISTINCT`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`, `OFFSET`, `INSERT`, `OR`, `INTO`, `VALUES`, `UPDATE`, `SET`, `DELETE`, `AND`, `AS`, `IS`, `NOT IN`, `LIKE`, `NOT LIKE`, `IN`, `BETWEEN`, `NOT NULL`, `PRIMARY KEY`, `RETURNING`
- 唯一例外：`BETWEEN` 中的 `and` 用小写
- `ORDER BY` / `GROUP BY` / `HAVING` 的**内容不被校验**（大小写、列名、表达式任意）
- **表名直接写，必须不写别名**：`FROM user`, `UPDATE OR ABORT user`（`FROM user u` 会解析失败）
- **INSERT / UPDATE 的冲突处理子句必填**：`INSERT OR <处理> INTO ...`、`UPDATE OR <处理> 表名 SET ...`，`<处理>` 为 `ROLLBACK | ABORT | FAIL | IGNORE | REPLACE` 之一（缺写则解析失败、参数类型退化为 `never`）；`ABORT` 是 SQLite 默认行为，需要默认语义就显式写 `OR ABORT`
- WHERE 子句用 `table.col`：`user.externalUserId = @externalUserId`
- **UPDATE 的 SET 子句用裸列名**（`token = @token`）——SQLite 的 SET 不接受 `table.col` 前缀
- SELECT 列用 `table.col AS name` 投影

### 参数：`@name` 命名参数

- 不用 `?` 占位符，改用 `@名称`
- 参数名规则按语句区分：
  - **SELECT** 的 WHERE / LIMIT / OFFSET、**UPDATE** 的 SET / WHERE、**DELETE** 的 WHERE：参数名可任意（如 `@limit`、`@anotherId`）
  - **INSERT VALUES**：参数名**必须是目标表列名**（非列名参数会被静默丢弃，调用处编译错）
- 参数类型从对应列类型推导：TEXT → `string`，INTEGER/REAL → `number`，可空列 → `| null`
- 例外：`LIMIT` / `OFFSET` 的参数恒为 `number`
- `VALUES` 括号内、`IN` 列表内用「逗号 + 一个空格」分隔参数：`(@a, @b)`
- 参数值里避免出现字面量 `@`（如 `'email@example.com'`），会被误识别

```
✓ 完整合法示例
SELECT ALL * FROM user WHERE user.externalUserId = @externalUserId ORDER BY 1 LIMIT -1 OFFSET 0
INSERT OR ABORT INTO user (username, passwordHash) VALUES (@username, @passwordHash)
UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId
INSERT OR REPLACE INTO kfCursor (openKfId, cursor) VALUES (@openKfId, @cursor)

✗ 反例
SELECT * FROM user WHERE user.externalUserId = @externalUserId        # 缺 ALL、缺 ORDER BY/LIMIT/OFFSET
SELECT ALL * FROM user WHERE externalUserId = @id ORDER BY 1 LIMIT -1 OFFSET 0   # WHERE 缺 user. 前缀
INSERT INTO user (username) VALUES (@username)                        # 缺 OR 冲突子句
UPDATE user SET token = @token WHERE user.externalUserId = @externalUserId  # 缺 OR 冲突子句
FROM user u                                                          # 表别名
VALUES (@a,@b)                                                       # 逗号后缺空格
```

### 严格格式（解析器不做空白归一化）

| 规则 | 原因 |
|------|------|
| SQL 字符串 **无前导或尾随空白** | 类型以 `SELECT`/`INSERT`/`UPDATE` 开头直接匹配 |
| `FROM 表名` 后必须**恰好一个空格**再接 ` WHERE`，无多余空白 | 模板用 `FROM ${FromClause} WHERE` 取表名；表名后多余空格会让 `_NewTables` 查不到表，列全部退化为 `{}` |
| CREATE TABLE **列定义顶格写**（每行 column 0 开始，无缩进） | `ParseCols` 用 `Split<Rest, ",\n">` 拆分列；表级约束用 `,\n\n`（末列逗号 + 空行）截断，见下方「表级约束」 |
| SELECT 列列表 **逗号后跟一个空格**：`col1, col2` | `Split<Cols, ', '>` 分隔列名 |
| SELECT 模板：`SELECT {ALL\|DISTINCT} <cols> FROM <table> WHERE <cond> ORDER BY ... LIMIT ... OFFSET ...`，**GROUP BY/HAVING 可选且成对出现** | `_MatchSelect` 按带/不带 GROUP BY 两个变体匹配；GROUP BY 若被吞进 WHERE 会破坏 `IS NULL` 收窄 |
| 聚合必须位于**列表达式开头**，不得包在其他函数内（如 `COALESCE(SUM(x),0)`） | `ColType` 只匹配以聚合开头的表达式，包裹后落入 T.C 分支得 `unknown` |
| `BETWEEN` 中的 `AND` 用小写 `and` | 避免被 WHERE-level ` AND ` 误拆分 |

### 表级约束

- 表级约束（`PRIMARY KEY (a, b)` / `UNIQUE (a, b)` / 表级 `CHECK (...)` / `FOREIGN KEY (a) REFERENCES parent(b)`）写在列定义**下方**，用**空行**与列区隔开；**列区最后一行以逗号结尾**（合法分隔符，不是尾逗号）
- `ParseCols` 按 `,\n\n`（末列逗号 + 空行）截断，约束块**整体忽略**——表级约束不改变列类型（SQLite 中表级 PK/UNIQUE/FK 不影响列可空性，表级 CHECK 不参与枚举推导），忽略即正确
- 空行必须**真空白**（无空格）；约束块内容整体忽略，内部怎么写（多行、内部再空行）都不影响列区解析
- 无约束的表照旧：列区最后一行无逗号、无空行，直接 `\n)`（现有 DDL 无需改动）

```sql
CREATE TABLE IF NOT EXISTS orderItem (
  orderId    INTEGER NOT NULL,
  itemId     INTEGER NOT NULL,
  quantity   INTEGER NOT NULL,

  PRIMARY KEY (orderId, itemId)
)
-- → Schema 推导为 { orderItem: { orderId: number; itemId: number; quantity: number } }，无 PRIMARY 幽灵列
```

### 查询结果

- `.all()` 统一返回 `T[]`；取单行用 `.get()` → `T | undefined`

### 动态排序（ORDER BY 白名单变体）

**为什么 ORDER BY 不能参数化 / 插值：**
- 绑定参数只能绑**值**，不能绑**标识符**：`ORDER BY ?` / `ORDER BY @col` 实测不排序（返回插入序）；方向更绑不了（`ORDER BY createdAt ?` 是语法错误）
- CASE 参数化替代在本库不可行：ORDER BY 不参与参数提取（见「设计边界」），`@sortBy`/`@dir` 不会进入 `SqlAllParams` 类型
- 插值有注入风险：实测 `ORDER BY (SELECT token FROM user ...)` 这种单语句子查询可执行并泄露数据（`; DROP` 多语句被 node:sqlite 挡，但子查询挡不住）
- 正确做法 = **列白名单 + 预编译静态变体**（业界对动态排序的标准做法）：列/方向全部枚举成静态 SQL，运行时只做键选择

**推荐写法**（参考 typed-sql-test.ts 的 `markListSql`）：

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

// 调用侧：键是字面量联合，写错键编译报错
const rows = db.prepare(markListSql[key]).all({ limit: 50, offset: 0 });
```

- `C extends keyof Tables['markRecord']` → 该表所有列自动可排，DDL 新增列无需改 makeSql 签名；方向保持 `'asc' | 'desc'` 字面量
- 每个键得到**精确的单条 SQL 字面量**，`prepare` 据此推导参数/返回值，全类型、零注入
- 每加一个排序组合 = 加一行对象字面量；非法键在编译期被掐死
- **`as const` 是类型安全的前提**：`makeSql` 必须用泛型 `const C/D` 且返回值 `as const`（显式返回类型注解也可，但非必需），缺一会把返回类型宽化成 `string`，`prepare` 参数退化 `never`
- 不要用 `['a','b'].map` 运行时生成对象——键会退化成 `string` 索引；对象字面量直接写
- 主排序后的次级排序键（tiebreak）写死即可（如 `id ASC`），保证非法输入也有可预测顺序

### INSERT/UPDATE/DELETE ... RETURNING

- 在语句末尾追加 `RETURNING <列>`，`.all()` / `.get()` 返回受影响的行：
  - `INSERT OR ABORT INTO user (...) VALUES (...) RETURNING id` → `{ id: string }`（插入行）
  - `UPDATE OR ABORT user SET token = @token WHERE user.externalUserId = @externalUserId RETURNING externalUserId` → `{ externalUserId: string }[]`（更新行）
  - `DELETE FROM markRecord WHERE markRecord.id = @id RETURNING id` → `{ id: number }[]`（删除行）
- **只写裸列名**，「逗号 + 一个空格」分隔：`RETURNING id, createdAt`；或 `RETURNING *` 返回整行
- 不支持 `表名.` 前缀、不支持 `AS` 别名、不支持表达式——这类写法类型退化为 `{}`（警示信号）
- 参数仍来自原语句（VALUES / SET / WHERE）：RETURNING 列只决定返回的列，RETURNING 内禁止 `@参数`
- `.run()` 不因 RETURNING 改变，仍返回 `{ lastInsertRowid: number; changes: number }`
- 无匹配行时（`OR IGNORE` 吞掉插入 / UPDATE/DELETE 无匹配 WHERE）：`.all()` 返回 `[]`，`.get()` 返回 `undefined`

### 枚举列：`CHECK (... IN (...))`

- 用列级 `CHECK` 的 `IN` 形式声明枚举，类型层推导为字面量联合：
  `status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed'))` → `'pending' | 'confirmed'`
- 字符串值用**单引号**，数值裸写（`score INTEGER CHECK (score IN (1, 2, 3))` → `1 | 2 | 3`）
- 列表用「逗号 + 一个空格」分隔；值内不得含单引号
- 枚举类型自动传播：`SELECT *` 结果列、WHERE / SET / INSERT VALUES 参数全部收窄
- 可空列（无 `NOT NULL`）→ `| null`；NULL 恒通过 CHECK（SQLite 语义）
- 仅支持简单单列 `CHECK (col IN (...))`；范围式（`CHECK (cost > 0)`）、多条件 CHECK 不参与枚举推导，列回落到对应基础类型
- 只有 `CHECK (本列名 IN (...))` 参与推导；引用其他列（`CHECK (score IN (1,2,3))` 写在 status 上）或常量表达式（`CHECK (1 IN (1,2))`）同样回落基础类型

### 外键类型传播：`REFERENCES tbl(col)`

- 列级 `REFERENCES tbl(col)` 把目标列类型与自身类型**取交集**传给本列：
  `pid TEXT NOT NULL REFERENCES parent(id)`，而 `parent.id` 是 `TEXT CHECK (id IN ('a', 'b'))` → 子列类型 `'a' | 'b'`（父表无枚举时 `string & string` 恒等，零影响）
- 多段 DDL 拼成完整库类型：`ResolveFks<SchemaFks<A> & SchemaFks<B> & ...>`；`SchemaFks` 是 raw 解析（列是内部 wrapper），`ResolveFks` 解引用后才是最终 `{ 表: { 列: 类型 } }`。单表无外键时 `Schema<S>` 向后兼容、直接可用
- **可空性只来自子列自己**：子列可空 → `| null`；父列可空**不传导**（SQLite `MATCH SIMPLE`：子键任一列为 NULL 即满足外键，不需要父表有对应行）
- 子列自身的类型/枚举保留：`child.pid CHECK (pid IN ('a', 'b')) REFERENCES parent(id)`（父为 `'a'|'b'|'c'`）→ `'a' | 'b'`（自身枚举 ∩ 父类型）
- 只支持**列级单列** `REFERENCES tbl(col)`；表级 `FOREIGN KEY (...)`、复合外键、`REFERENCES tbl` 省略列不参与类型传播（表级约束块整体忽略）
- 外键解析**只传导一层**（A→B→C 链时 A 只与 B 取交集，不含 C）——罕见场景，刻意简化
- **环形外键**（互引用/同表双向，SQLite 合法）不递归：两侧列取各自定义类型的交集，可正常编译
- 类型是编译期契约：子表插入**不受父表枚举约束**（外键只校验「值在父表现有行中」，见「设计边界」）；父表强迁遗留枚举外值后，子列类型同样可能「说谎」（与父列自身枚举的谎言一致）

## 类型推导规则

### 参数类型：`SqlAllParams<S>`（SELECT / INSERT/UPDATE/DELETE ... RETURNING）/ `RunParams<S>`（INSERT/UPDATE/DELETE）

1. 扫描 SQL 中所有 `@identifier` 引用
2. 从 SQL 提取表名（SELECT 用 `_MatchSelect`，DML 用 `_MatchInsert` / `_MatchUpdate` / `_MatchDelete` 匹配）
3. 查 `Tables[表名][参数名]` 得到每个参数的具体类型
4. 合并为 `{ 参数名: 类型 }`

WHERE 支持的操作符：`=`, `>=`, `<=`, `!=`, `<>`, `>`, `<`, `LIKE`, `NOT LIKE`, `IN`, `NOT IN`, `BETWEEN ... and ...`。
`LIKE`/`NOT LIKE` 的参数类型按列类型推导（TEXT 列 → `string`）；LIKE 的 `%`/`_` 通配符写在参数值里，不进入 SQL 字符串。
SELECT 额外把 `LIMIT` / `OFFSET` 中的 `@参数` 类型定为 `number`。

### 返回值类型：`SqlAllResult<S>`

- `SELECT * FROM 表名` → `Tables[表名][]`；`INSERT/UPDATE/DELETE ... RETURNING 列` → 操作行（`{ 列: 类型 }[]`）
- `SELECT 列1,列2 FROM 表名` → `{ 列1: 类型, 列2: 类型 }[]`
- 多表 JOIN 时 `*` 返回各表字段的合并（交集）类型
- WHERE 中的 `Tbl.Col IS NOT NULL` / `Tbl.Col IS NULL` 会进一步收窄对应列（去空 / 恒 `null`），
  `SELECT *` 与显式列两条路径都生效
- 聚合列按 SQL 语义建模（空集/全 NULL 时 SUM/AVG/MAX/MIN 返回 NULL）：
  - `COUNT(*)` → `number`
  - `SUM(x)` / `AVG(x)` / `MAX(x)` / `MIN(x)` → `number | null`
  - `GROUP_CONCAT(x)` → `string | null`
- 空集行为（SQLite 语义）：
  - 省略 GROUP BY 的聚合查询（全局聚合）恒返回 1 行：`COUNT`→`0`、`SUM/AVG/MAX/MIN`→`null`
  - 带 GROUP BY 的空集返回 0 行
  - 两者都可用 `?? 0` 等兜底归一

## 设计边界（刻意不做）

以下均为**刻意的实现简化**，不是缺陷。匹配失败时类型退化（`unknown` / `never` / `{}`）本身就是可见的警示信号，提醒调用方该写法不在支持范围内。

- **SELECT 四要件强制**：`WHERE` / `ORDER BY` / `LIMIT` / `OFFSET` 缺一不可，是为了让 `_MatchSelect` 只维护固定变体（带/不带 GROUP BY），匹配失败即 `unknown`。不提供"无 WHERE"、"无 LIMIT/OFFSET"的省略写法
  - 占位成分与 SQL 语义等效（实测 `EXPLAIN QUERY PLAN` 一致）：
    - `WHERE 1=1` ≡ 不写 WHERE（SQLite 常量折叠，查询计划不变）
    - `LIMIT -1` ≡ 无行数上限（负 LIMIT 即无上限，OFFSET 仍照常生效）；`OFFSET 0` ≡ 从第一行起
    - **`ORDER BY 1` 不等价于无 ORDER BY**——它按第一列排序，对单行/聚合查询无影响才可作占位；真实排序需求必须写实际子句（如 `createdAt DESC, id DESC`）
- **表别名**：必须不写别名，`FROM user u` 解析失败
- **GLOB**：SQLite 特有、大小写敏感，刻意不支持（`LIKE` 已覆盖常见匹配需求）
- **CASE WHEN / 标量函数**（`strftime`/`ifnull` 等）：非聚合列表达式解析不了 → `unknown`（可见信号）
- **子查询 / UNION / INSERT SELECT / INSERT DEFAULT VALUES**
- **JOIN 拼写**：仅 `LEFT JOIN` / `INNER JOIN`；`LEFT OUTER JOIN`、`RIGHT`/`FULL`/`CROSS`/`NATURAL` 均不支持
- **`SELECT *, COUNT(*) AS c` 混合投影**：列列表含 `*` 且非纯 `*` 时，`*` 部分解析为 `{}`（该写法本身无可靠语义，退化即警示）
- **`GROUP_CONCAT(x, y)` 多参数**：列列表按 `", "` 切分，函数内逗号会被误拆 → 类型退化（仅支持单参）
- **HAVING / ORDER BY 不参与参数提取**：`HAVING COUNT(*) > @min`、`ORDER BY @col` 中的参数会被丢弃（动态排序的替代方案见「动态排序」小节）
- **UPDATE/DELETE 无 WHERE**：模板强制 WHERE
- **INSERT/UPDATE/DELETE ... RETURNING**：只支持裸列名列表或 `*`；`表名.列` 前缀、`AS` 别名、表达式均不支持（类型退化为 `{}`）
- **UPDATE SET 表达式**（如 `count = count + 1`）：`SetParams` 只认 `列名 = @参数` 形式
- **CREATE TABLE 必须带 `IF NOT EXISTS`**：只支持 `CREATE [TEMP] TABLE IF NOT EXISTS <name>`，漏写时 `Schema` 返回 `{}`（运行时重复建表也会报 `table already exists`，类型层信号与之一致）
- **表级约束不写空行**：必须按「列区末列逗号 + 空行」约定书写；漏写空行（约束直接接在列区后）会被当列解析出 `PRIMARY`/`UNIQUE`/`CHECK`/`FOREIGN` 等幽灵列（警示信号）
- **外键类型传播仅列级单列**：表级 `FOREIGN KEY (...)`、复合外键、`REFERENCES tbl` 省略列不参与（表级约束块整体忽略）；链式外键只传导一层；`Schema<S>` 不解析外键（用 `SchemaFks` + `ResolveFks`）

## 代码组织

| 文件 | 职责 |
|------|------|
| `typed-sql.ts` | lib——类型体操（Schema / SchemaFks / ResolveFks / SqlAllResult / SqlAllParams / RunParams）+ TypedDb<Schema> class |
| `typed-sql-test.ts` | 示例表定义 + 编译期类型断言 + 运行时验证 |

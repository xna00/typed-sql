# typed-sql

[![CI](https://github.com/xna00/typed-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/xna00/typed-sql/actions/workflows/ci.yml)

类型级 SQL 解析器：从 SQL 模板字符串推导参数与返回值类型，`TypedDb<S>` 提供类型安全的
`prepare().all/get/run`。SQL 书写约定见 `types-sql-conventions.md`。

## 独立运行（单独 checkout 后）

```sh
npm i -D typescript @types/node
npx tsc --noEmit --strict --target esnext --module nodenext --moduleResolution nodenext \
  --lib esnext --types node --allowImportingTsExtensions --skipLibCheck \
  typed-sql.ts typed-sql-test.ts
node --experimental-strip-types --test typed-sql-test.ts
```

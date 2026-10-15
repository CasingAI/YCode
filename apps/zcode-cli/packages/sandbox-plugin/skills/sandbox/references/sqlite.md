# Sandbox SQLite (read-only queries)

Read-only queries against workspace SQLite files. There is no SQLite engine in the guest — `require("node:sqlite")` returns host functions backed by a worker thread. Ask / Plan / Agent can all query.

## How to load

```js
const { query, tables } = require("node:sqlite");
// same object:
// require("sqlite") === require("node:sqlite")
// import { query } from "node:sqlite" / await import("node:sqlite")
```

No new globals. Other ids still fail with `SANDBOX_NO_MODULE`.

## Methods (all async)

- `query(dbPath, sql, params?)` — run one read-only SQL statement, returns an array of rows (objects keyed by column name)
- `tables(dbPath)` — list table names in that database

Paths are relative to the session working directory (same cwd as Bash) and follow the repo-wide path policy — paths outside the workspace root are allowed, same boundary as `fs.promises` (see `path-policy.ts`).

```js
const { query, tables } = require("node:sqlite");
const names = await tables("data/app.db");
const rows = await query("data/app.db", "SELECT name, age FROM users WHERE age > ?", [26]);
return rows.length;
```

## Read-only enforcement

Writes fail — `INSERT` / `UPDATE` / `DELETE`, DDL (`CREATE` / `DROP` / `ALTER`), and `ATTACH` all throw `code: "SANDBOX_SQLITE_READ_ONLY"`. There are no write methods on the port (read-only is guaranteed at the type level too).

## Limits (fail, not truncated)

- 10,000 rows max → `SANDBOX_SQLITE_TOO_MANY_ROWS`
- 4MiB result max → `SANDBOX_SQLITE_TOO_LARGE`
- 10s per query (slow queries are killed, not left running)

A missing file throws `SANDBOX_SQLITE_NOT_FOUND`; a file that is not a database throws `SANDBOX_SQLITE_NOT_A_DATABASE`. A malformed `params` argument (not an array of bindable scalars) throws `SANDBOX_SQLITE_INVALID_PARAM` — fix the argument shape, not the result size.

## Value shapes

- `NULL` → `null`; BLOB → `Uint8Array` (no `Buffer`)
- Integers within the safe range come back as numbers; integers beyond 2^53 come back as strings (lossless)

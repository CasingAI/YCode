# Sandbox filesystem (`fs` / `path`)

Node-shaped host APIs on the live instance. Paths are relative to the session working directory (same cwd as Bash) and follow the repo-wide path policy — paths outside the workspace root are allowed (same as the Read tool; see `path-policy.ts`). Sandbox does not ask the user; Ask / Plan refuse writes.

## How to load

```js
const fs = require("fs").promises;
const path = require("path");
// same objects:
// require("node:fs").promises === fs
// require("fs/promises") === fs
// import fs from "fs" / await import("fs") / import("path")
```

Globals `fs` and `path` also exist.

`import` and `import()` resolve the same ids as `require`. Other ids fail with `SANDBOX_NO_MODULE` (the sandbox has no general Node module loader). Relative files are not loaded.

## Implemented async APIs

The following operations are available as Promise APIs under `fs.promises` and as Node-style callback APIs under the root `fs` object. Both forms use the same permission-checked FileSystemPort operations.

```js
const fs = require("node:fs");
fs.readFile("notes.txt", "utf8", (error, content) => {
  if (error) throw error;
  console.log(content);
});
```

### Promise APIs (`fs.promises`)

- `readFile(path[, options])` — utf8 string if `encoding: "utf8"` (or `"utf8"` string); otherwise `Uint8Array` (no `Buffer`)
- `writeFile(path, data)` — string or `Uint8Array`; does not create parent directories
- `appendFile(path, data)`
- `readdir(path[, { withFileTypes }])`
- `stat(path)` / `lstat(path)` — `isFile()`, `isDirectory()`, `isSymbolicLink()`, `size`, `mtimeMs`
- `access(path)` — exists check only (`ENOENT` if missing); ignores Unix mode bits
- `mkdir(path[, { recursive }])`
- `unlink(path)` / `rmdir(path)` / `rm(path[, { recursive, force }])`
- `rename(oldPath, newPath)` / `copyFile(src, dest)` — single file copy; not recursive `cp`

`path.join` / `path.dirname` / `path.basename` / `path.extname` work.
`fs.constants.F_OK` / `R_OK` / `W_OK` exist. Do not use `O_*` flags; `open` is not implemented.

Single-file reads above 16MiB fail (not truncated). Keep large data on globals and `return` a summary.

## Implemented sync APIs

```js
const fs = require("node:fs");
const text = fs.readFileSync("notes.txt", "utf8");
const bytes = fs.readFileSync("data.bin"); // Uint8Array, not Buffer
```

Supported `*Sync` methods share the same path resolution, mode gate, error mapping, and FileSystemPort as the async forms:

- `readFileSync(path[, options])` — same encoding rule as `readFile`
- `writeFileSync(path, data)` / `appendFileSync(path, data)`
- `readdirSync(path[, { withFileTypes }])` — `{ recursive: true }` is refused
- `statSync(path)` / `lstatSync(path)` — number options only; `{ bigint: true }` and `{ throwIfNoEntry: false }` are refused
- `accessSync(path[, mode])`
- `mkdirSync(path[, { recursive }])`
- `unlinkSync(path)` / `rmdirSync(path)` / `rmSync(path[, { recursive, force }])` — `rmdirSync({ recursive: true })` is refused; use `rmSync`
- `renameSync(oldPath, newPath)` / `copyFileSync(src, dest)`
- `realpathSync(path)` — returns the FileSystemPort-resolved path; `realpathSync.native` and `{ encoding: "buffer" }` are refused
- `existsSync(path)` — returns a boolean; a missing path (or any resolve/stat failure) returns `false` instead of throwing. It is not an alias of `accessSync`.

A sync call blocks that session's sandbox JS until the host finishes; the main thread and other sessions keep running. Timers and unsettled promises on the same live instance do not advance while the sync call is waiting.

## Mode gate (writes)

Ask / Plan: async and sync `writeFile`, `appendFile`, `mkdir`, `unlink`, `rmdir`, `rm`, `rename`, `copyFile` throw `code: "SANDBOX_FS_READONLY"`.
Agent: those writes are allowed inside the workspace.
Read methods work in every Sandbox-capable mode.

## Callable but refused

- Unsupported `*Sync` names throw `SANDBOX_FS_UNSUPPORTED` and do not create file descriptors, handles, streams, or watchers. The message names a real alternative when one exists:
  - `openSync` / `closeSync` / `readSync` / `writeSync` / file-descriptor ops: fd-based I/O is not implemented async or sync; use `readFileSync` / `writeFileSync` / `appendFileSync`, or slice/write whole files.
  - `truncateSync` / `ftruncateSync`: truncate is not implemented; overwrite with `writeFileSync`.
  - `globSync` / `cpSync`: not implemented; use `readdirSync` + `copyFileSync`.
  - `linkSync` / `symlinkSync` / `readlinkSync`: links are not implemented.
  - `chmodSync` / `chownSync` / `utimesSync` and variants: permissions, ownership, and timestamps are not implemented.
  - `statfsSync`, `mkdtempSync`, `opendirSync`: filesystem stats, temp dirs, and directory handles are not implemented; use `mkdirSync` with an explicit path or `readdirSync`.
- Callback-only operations without a supported FileSystemPort equivalent remain refused with `SANDBOX_FS_CALLBACK`; they do not create file descriptors, streams, or watchers.
- Not implemented → `SANDBOX_FS_UNSUPPORTED` (async): `open` and file handles, streaming, `watch`, `cp`, `glob`, links, async `realpath`, `chmod` / `chown` / `utimes`, `statfs`, `mkdtemp`, `openAsBlob`, `opendir`. Sync `realpathSync` is available; the async `fs.promises.realpath` is not.

Reads of files outside the workspace (`../` or a symlink out, including under `~/.zcode`) succeed — same as the Read tool.

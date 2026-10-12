# Sandbox filesystem (`fs` / `path`)

Node-shaped host APIs on the live instance. Paths are relative to the session working directory (same cwd as Bash) and must stay inside the workspace root. Sandbox does not ask the user; Ask / Plan refuse writes.

## How to load

```js
const fs = require("fs").promises;
const path = require("path");
// same objects:
// require("node:fs").promises === fs
// require("fs/promises") === fs
```

Globals `fs` and `path` also exist.

There is no ESM `import "fs"`. Other `require(...)` ids fail: the sandbox has no Node module loader.

## Implemented (`fs.promises`)

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

## Mode gate (writes)

Ask / Plan: `writeFile`, `appendFile`, `mkdir`, `unlink`, `rmdir`, `rm`, `rename`, `copyFile` throw `code: "SANDBOX_FS_READONLY"`.
Agent: those writes are allowed inside the workspace.
Read methods work in every Sandbox-capable mode.

## Callable but refused

- Any `*Sync` (`readFileSync`, …) → `SANDBOX_FS_SYNC` (even in Agent). Use `fs.promises`.
- Callback style (`fs.readFile(path, cb)`) → `SANDBOX_FS_CALLBACK`. Use `fs.promises`.
- Not implemented → `SANDBOX_FS_UNSUPPORTED`: `open` and file handles, streaming, `watch`, `cp`, `glob`, links, `realpath`, `chmod` / `chown` / `utimes`, `statfs`, `mkdtemp`, `openAsBlob`, `opendir`.

Leaving the workspace (`../` or a symlink out) → `SANDBOX_FS_OUTSIDE_WORKSPACE`, not a mode error.

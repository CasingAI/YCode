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

## Mode gate (writes)

Ask / Plan: `writeFile`, `appendFile`, `mkdir`, `unlink`, `rmdir`, `rm`, `rename`, `copyFile` throw `code: "SANDBOX_FS_READONLY"`.
Agent: those writes are allowed inside the workspace.
Read methods work in every Sandbox-capable mode.

## Callable but refused

- Any `*Sync` filesystem I/O (`readFileSync`, …) → `SANDBOX_FS_SYNC` with `JSVM_FS_SYNC_DISABLED` in the message (even in Agent). Use an asynchronous filesystem API.
- Callback-only operations without a supported FileSystemPort equivalent remain refused with `SANDBOX_FS_CALLBACK`; they do not create file descriptors, streams, or watchers.
- Not implemented → `SANDBOX_FS_UNSUPPORTED`: `open` and file handles, streaming, `watch`, `cp`, `glob`, links, `realpath`, `chmod` / `chown` / `utimes`, `statfs`, `mkdtemp`, `openAsBlob`, `opendir`.

Reads of files outside the workspace (`../` or a symlink out, including under `~/.zcode`) succeed — same as the Read tool.

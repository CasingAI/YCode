---
name: sandbox
title: Sandbox (session QuickJS)
description: Use in Ask or Plan for JavaScript computation and session-local investigation. In those modes Bash only allows a small command allowlist (a refusal does not mean the command had side effects). JSVM stays available. Workspace files go through controlled fs APIs (read-only in Ask/Plan, writable in Agent), including a supported `*Sync` subset. Talk to servers with global fetch (never asks). Not for shell or child processes. Load this skill before non-trivial JSVM use.
---

# Sandbox (session QuickJS)

This file is the Index. Load it, then Read only the chapters you need. Paths below are relative to this skill's base directory (also expanded from `${ZCODE_SKILL_DIR}`).

If this skill is listed, treat it as required reading before non-trivial Sandbox work.

## When to use

- **Ask / Plan:** prefer `JSVM` over Bash for computation and JS investigation. JSVM is allowed in these modes even though it is not a workspace read-only tool. `fs.promises` reads and supported `*Sync` reads are allowed; writes throw a mode error. `fetch` is allowed (including POST). Bash only allows a small command allowlist — being refused does not mean the command had side effects or was written wrong; it is often simply not on the list.
- **Agent:** use whichever tool fits. Bash can do more on disk. JSVM is the isolated JS world (live instance + LocalStorage + `fs` async/callback/sync + `fetch`).
- **Bare:** JSVM is refused. Do not load this skill to work around that.

## What exists today

JavaScript itself, `console`, timers, LocalStorage (5MB, survives restart), `return` to hand a value back, Node-shaped `fs` / `path` on the live instance (`require` / `import` / `import()` / globals for the same id set), read-only SQLite queries (`require("node:sqlite")` → `{ query, tables }`, all async, Ask/Plan/Agent can query), and global `fetch`.

`fs.promises` implements whole-file read/write, append, readdir, stat/lstat, access, mkdir, unlink/rmdir/rm, rename, realpath, and single-file copy. The matching root `fs.*` methods also accept Node-style callbacks. The same 15 operations are available synchronously as `readFileSync`, `writeFileSync`, `appendFileSync`, `readdirSync`, `statSync`, `lstatSync`, `accessSync`, `mkdirSync`, `unlinkSync`, `rmdirSync`, `rmSync`, `renameSync`, `copyFileSync`, `realpathSync`, plus `existsSync`. All three forms share one permission check, path resolution, mode gate, and FileSystemPort. Ask/Plan refuse writes in every form. `fetch` talks to servers in every JSVM-capable mode and never asks. There is no `Buffer` (unencoded `readFile` and `fetch` bodies use `Uint8Array` / `ArrayBuffer`), no general Node module loader, and no child-process or shell API.

One public page that should become readable text and an answered prompt still goes through WebFetch. Pagination, JSON, and keeping the response in the live world go through sandbox `fetch`.

Do not invent methods that are not in this handbook. Unimplemented `fs` names still exist so a call fails with a clear code.

## Call shape

Tool name: `JSVM` (the skill and history also refer to it as Sandbox).

- Required: one-sentence `description` in the user's language (the chat card shows only this when folded).
- Required: inline JavaScript `code`; `filePath` is not a supported tool parameter.
- Optional: `timeout` (default 120s, max 600s), `runInBackground`, `reset` (destroy the live instance first; LocalStorage remains).

Cross-call values must sit on globals of the live instance. The first result after a new instance includes a reminder that heap is gone and LocalStorage remains.

## Chapters

Read only what you need:

- `references/runtime.md` — live instance, `return` / console window, LocalStorage, reset
- `references/background.md` — background IDs, TaskOutput, stop (never kills JS)
- `references/fs.md` — supported Promise, callback, and sync FS methods, mode gate, refused unimplemented names
- `references/sqlite.md` — read-only `require("node:sqlite")` queries, limits, value shapes
- `references/fetch.md` — global `fetch`, headers/request/response/abort, egress hard blocks, vs WebFetch

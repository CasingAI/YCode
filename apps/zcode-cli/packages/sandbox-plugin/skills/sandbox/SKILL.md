---
name: sandbox
description: Use in Ask or Plan for JavaScript computation and session-local investigation. In those modes Bash only allows a small command allowlist (a refusal does not mean the command had side effects). Sandbox stays available. Workspace files go through fs.promises (read-only in Ask/Plan, writable in Agent). Not for network or shell. Load this skill before non-trivial Sandbox use.
---

# Sandbox (session QuickJS)

This file is the Index. Load it, then Read only the chapters you need. Paths below are relative to this skill's base directory (also expanded from `${ZCODE_SKILL_DIR}`).

If this skill is listed, treat it as required reading before non-trivial Sandbox work.

## When to use

- **Ask / Plan:** prefer `Sandbox` over Bash for computation and JS investigation. Sandbox is allowed in these modes even though it is not a workspace read-only tool. `fs.promises` reads are allowed; writes throw a mode error. Bash only allows a small command allowlist — being refused does not mean the command had side effects or was written wrong; it is often simply not on the list.
- **Agent:** use whichever tool fits. Bash can do more on disk. Sandbox is the isolated JS world (live instance + LocalStorage + `fs.promises`).
- **Bare:** Sandbox is refused. Do not load this skill to work around that.

## What exists today

JavaScript itself, `console`, timers, LocalStorage (5MB, survives restart), `return` to hand a value back, and Node-shaped `fs` / `path` on the live instance (`require("fs")` / `require("path")` / globals).

`fs.promises` implements whole-file read/write, append, readdir, stat/lstat, access, mkdir, unlink/rmdir/rm, rename, and single-file copy. Ask/Plan refuse writes. There is no `Buffer` (unencoded `readFile` returns `Uint8Array`), no sync fs, no callback fs, no network, no general Node module loader.

A `filePath` argument only reads that one file as source to evaluate; it does not import anything else the file mentions.

Do not invent methods that are not in this handbook. Unimplemented `fs` names still exist so a call fails with a clear code.

## Call shape

Tool name: `Sandbox`.

- Required: one-sentence `description` in the user's language (the chat card shows only this when folded).
- Source: inline `code` **or** `filePath`, never both, never neither.
- Optional: `timeout` (default 120s, max 600s), `runInBackground`, `reset` (destroy the live instance first; LocalStorage remains).

Cross-call values must sit on globals of the live instance. The first result after a new instance includes a reminder that heap is gone and LocalStorage remains.

## Chapters

Read only what you need:

- `references/runtime.md` — live instance, `return` / console window, LocalStorage, reset
- `references/background.md` — background IDs, TaskOutput, stop (never kills JS)
- `references/fs.md` — `fs.promises` whitelist, mode gate, refused sync/callback/unimplemented names

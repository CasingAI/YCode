---
name: sandbox
description: Use in Ask or Plan for JavaScript computation and session-local investigation. In those modes Bash only allows a small command allowlist (a refusal does not mean the command had side effects). Sandbox stays available and does not change the workspace. Also use in Agent when you want an isolated JS world without touching disk. Not for file writes, network, or shell. Load this skill before non-trivial Sandbox use.
---

# Sandbox (session QuickJS)

This file is the Index. Load it, then Read only the chapters you need. Paths below are relative to this skill's base directory (also expanded from `${ZCODE_SKILL_DIR}`).

If this skill is listed, treat it as required reading before non-trivial Sandbox work.

## When to use

- **Ask / Plan:** prefer `Sandbox` over Bash for computation and JS investigation. Sandbox is allowed in these modes even though it is not a workspace read-only tool; it does not change the workspace. Bash only allows a small command allowlist — being refused does not mean the command had side effects or was written wrong; it is often simply not on the list.
- **Agent:** use whichever tool fits. Bash can do more on disk. Sandbox is the isolated JS world (live instance + LocalStorage).
- **Bare:** Sandbox is refused. Do not load this skill to work around that.

## What exists today

JavaScript itself, `console`, timers, LocalStorage (5MB, survives restart), and `return` to hand a value back to the tool result.

No network, no file writes, no module loading. A `filePath` argument only reads that one file as source to evaluate; it does not import anything else the file mentions.

Host APIs will be added later and gated by session mode (Ask/Plan read-only, Agent may write). Do not invent methods that are not in this handbook.

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

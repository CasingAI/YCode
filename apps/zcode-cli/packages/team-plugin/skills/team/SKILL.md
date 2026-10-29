---
name: team
title: Team dispatch handbook
description: Team-mode dispatch handbook. Only load when the current <mode> tag is Team. Make good use of subagents; you own the quality of the result.
---

# Team (dispatch, then verify)

Load this skill only when the current tag is `<mode>Team</mode>`. In Plan, Ask, or Agent, leave it unread. This is the whole handbook — there are no chapters.

## Role

You run an expensive model. Your job is to break the task down, dispatch subagents, review the evidence they bring back (diffs, command output, key excerpts), adjudicate quality, and summarize. Investigation, implementation, testing, and evidence gathering belong to subagents. A small task, repeated failures, or thin context is never a reason to take the work over yourself.

## Dispatching

- A task line that will end in edits starts with a `general-purpose` subagent — it can read and write, so investigation and changes stay in one session. Pure investigation can go to `Explore` (read-only).
- Prefer continuing an existing agent with `SendMessage` (`to` = its `agentId`) for the same thread of work; start a fresh agent only for an independent or parallel task.
- Ask subagents to report with evidence, not just conclusions, so your verification rests on something concrete. When a report is thin or a run looks interrupted, read the child's transcript with `HistoryRead` (`sessionId` = its `childSessionId`) before deciding what happened.
- Each agent return ends with `context_remaining_percent` in the trailing usage block — the remaining capacity of that child's context window. Comfortable (window has ample room left) → continue the same agent; low (window nearly full) → start a new one for the next slice.
- For a conclusion important enough to double-check, you may dispatch a second subagent to independently verify the first one's findings. Optional, not the default.
- Stay in Team while a task is running: design and break down work here as text and todos rather than switching into Plan mode.

## Failure stop

- A failed attempt is a run that failed or returned no usable deliverable: tool error, interruption, empty output, or no evidence, findings, or diff.
- Count consecutive failures per task or work slice, across subagents. Switching agents does not reset the count; any attempt with a usable deliverable resets it to zero. A handoff after delivering work because the context window is nearly full is not a failure.
- On the first failure, retry the same agent once. If the creation call itself failed and no `agentId` came back, retry that creation call once.
- On the second consecutive failure, stop retrying that agent and start a replacement subagent. Hand over the goal, the failure reason, and the evidence so far; the replacement gets one attempt, which counts as the third.
- Stop the task only after the third consecutive failure: no fourth attempt, and do not do the work yourself.
- Before counting, check a thin report against the child's transcript with `HistoryRead` (`sessionId` = its `childSessionId`); count each failure once.
- When stopping, report who ran each of the three attempts, why each failed, what work exists, and what blocks progress. Do not report a failure as success.
- Sequence: A fails → retry A fails → new agent B fails → stop. Two failures on A plus one on B stop the task; any successful attempt resets the count.

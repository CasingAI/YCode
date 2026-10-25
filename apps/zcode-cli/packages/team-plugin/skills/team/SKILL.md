---
name: team
description: Team-mode dispatch handbook. Only load when the current <mode> tag is Team. Make good use of subagents; you own the quality of the result.
---

# Team (dispatch, then verify)

Load this skill only when the current tag is `<mode>Team</mode>`. In Plan, Ask, or Agent, leave it unread. This is the whole handbook — there are no chapters.

## Role

You run an expensive model. Make good use of subagents and keep the quality gate yourself: send investigation, changes, and evidence gathering to subagents, then review the evidence they bring back (diffs, command output, key excerpts) and decide. Doing a quick check yourself is fine when dispatching would clearly cost more than it saves; the default is to delegate.

## Dispatching

- A task line that will end in edits starts with a `general-purpose` subagent — it can read and write, so investigation and changes stay in one session. Pure investigation can go to `Explore` (read-only).
- Continue an existing agent with `SendMessage` (`to` = its `agentId`) instead of starting a fresh one for the same thread of work. Spawn new agents for independent or parallel slices.
- Ask subagents to report with evidence, not just conclusions, so your verification rests on something concrete. When a report is thin or a run looks interrupted, read the child's transcript with `HistoryRead` (`sessionId` = its `childSessionId`) before deciding what happened.
- Each agent return ends with `context_remaining_percent` in the trailing usage block — remaining capacity of that child's window. Comfortable → continue the same agent; low → start a new one for the next slice.
- For a conclusion important enough to double-check, you may dispatch a second subagent to independently verify the first one's findings. Optional, not the default.
- Stay in Team while a task is running: design and break down work here as text and todos rather than switching into Plan mode.

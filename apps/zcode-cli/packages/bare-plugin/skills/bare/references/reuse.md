# Reuse existing subagents

`agentId` on an Agent or SendMessage result is the stable handle. Pass it as SendMessage `to`. `childSessionId` on the same result is the observation handle. Pass it as HistoryRead `sessionId`.

- Terminal statuses still accept SendMessage when `canContinue` is true.
- `contextReset: true` means continuation starts a fresh child context; treat it like a new spawn for memory, not like a warm resume.
- Before deciding continue vs spawn, judge the child's end state when the report is thin or the run looks interrupted: first `HistoryRead` the child's transcript (`sessionId` = its `childSessionId`) for `completed` / `failed` / `cancelled` / `contextReset`, then pick `SendMessage` (same thread continues) or a new Agent (fresh start). Order is observe-then-decide, not spawn-to-check.
- Independent work: launch multiple Agent calls in one message so they run concurrently. Do not serialize independent jobs through one child.
- Same job, next instruction: SendMessage. Do not open a second child, of any type, to "finish" what the first already knows.
- Upward replies arrive on their own: the child answers with `RespondToCoordinator` or its final report, never with `SendMessage` (children hold no parent `agentId`, and `SendMessage` is not registered in child runtimes).

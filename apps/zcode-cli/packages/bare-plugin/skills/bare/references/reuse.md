# Reuse existing subagents

`agentId` on an Agent or SendMessage result is the stable handle. Pass it as SendMessage `to`.

- Terminal statuses still accept SendMessage when `canContinue` is true.
- `contextReset: true` means continuation starts a fresh child context; treat it like a new spawn for memory, not like a warm resume.
- Independent work: launch multiple Agent calls in one message so they run concurrently. Do not serialize independent jobs through one child.
- Same job, next instruction: SendMessage. Do not open a second general-purpose child to "finish" what the first already knows.

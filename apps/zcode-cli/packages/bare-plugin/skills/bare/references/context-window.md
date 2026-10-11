# Child context remaining percent

`context_remaining_percent` is the child's remaining effective-window capacity after that return. It is not `subagent_tokens` (this-run spend) and not the parent window.

Use it only as a reuse signal: continue when the percent is comfortable; spawn a new child when it is low. If the line is absent, the snapshot was unavailable — unknown, not zero.

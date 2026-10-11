# Sandbox background and stop

Stop never interrupts running JavaScript. The only way to halt the whole world is to destroy the instance (see `references/runtime.md`).

## Going background

- Set `runInBackground` to start immediately and get a task ID (`sandbox_` prefix).
- A foreground call that runs too long (default 120s) also backgrounds, same ID shape. The JS keeps running.

## Reading a background task

Use the existing `TaskOutput` tool with that ID. Do not expect a separate Sandbox-output tool.

- Before `return`: status is still running. You get the console window from that call's start until now. There is no return value yet.
- Optional `consoleFilter`: only console lines that contain that substring. Omit it to get the whole window.
- Concurrent evals share one console. The window is time-based, not "this call's logs only." Filter is substring match, not a tag protocol.
- After reset or instance death, old IDs fail (instance gone).

## User stop

If the user stops a foreground Sandbox, that call is **moved to background**. The chat card becomes backgrounded (with ID). JS keeps running. Later status is in the sidebar console or via `TaskOutput`, not on that card.

There is no "stop this one background JS." Reset the instance if you need the world gone.

# Sandbox runtime (live instance)

One live QuickJS instance per session (subagents each have their own; they cannot see each other).

## Persistence

- Assign to globals to keep values across `JSVM` calls. Locals from a previous call are gone.
- Timers and unsettled promises keep running after a call returns. The next eval shares that event loop; new code does not wait for the previous call to finish.
- A supported sync filesystem call (for example `fs.readFileSync`) blocks this live instance until the host returns. The main thread, other sessions, and the user's other work keep running; timers and promises on this same instance do not advance while it waits.
- LocalStorage behaves like browser LocalStorage, 5MB per session, on disk. Restart keeps it. Reset and instance death keep it. Storage cleanup (or deleting the session's sandbox files) clears it.
- Writing past 5MB throws a quota error for that write; existing keys stay. If the script does not catch it, the tool call fails and the instance remains.
- Heap above 128MB destroys the instance. LocalStorage still remains.

## Result

- The value you `return` is the tool result. Values that cannot serialize become a text preview or a type label; the call still succeeds.
- The tool also returns console lines produced from the start of this call until it hands back. That is a time window, not a private log for this call.
- Missing required `code`, invalid input, syntax errors, or an uncaught throw fail this call. The instance stays (a syntax error may not have run).

## Reset

Set `reset` on a `JSVM` call, or the user may reset from the sidebar console. That destroys the instance. In-flight calls fail, including a call blocked in a sync filesystem operation. Background IDs become invalid. LocalStorage remains. The next call is a new instance.

Do not use reset to "stop one script" while keeping others. There is no per-script stop.

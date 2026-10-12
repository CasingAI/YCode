export const WORKER_AGENT_TYPE = "Worker" as const;

export function buildWorkerCoordinatorNotes(): string {
  return [
    "You report to a coordinator, not directly to the user. The parent session is what the user sees.",
    "Put findings, decisions, and deliverables in your final assistant message so the coordinator can relay them. Do not write report files unless asked.",
    "Your current Ask or Agent mode is the `<mode>` tag on this request. The coordinator switches it between runs; do not try to change it yourself.",
  ].join("\n");
}

export function buildWorkerCollaborationModesBody(): string {
  return [
    "# Collaboration modes",
    "",
    "Every request carries a `<mode>` tag naming this worker's current mode: `<mode>Ask</mode>` or `<mode>Agent</mode>`. The tag always reflects the mode active for this request — when it changes, switch behavior immediately, even if earlier messages were handled in a different mode. You cannot enter Plan or Bare.",
    "",
    "- `<mode>Ask</mode>` — Ask mode. Read-only Q&A: answering and searching are unrestricted, but edits and state-changing tools are refused by the engine. Investigate and report findings to the coordinator. Do not call EnterPlanMode.",
    "- `<mode>Agent</mode>` — Agent mode. Permission prompts are disabled for this session, so edits and commands run without confirmation. Proceed directly, staying within what the coordinator actually asked for.",
    "",
    "Sandbox routing: in Ask, prefer the `Sandbox` tool for JavaScript computation and session-local investigation. Bash only allows a small command allowlist — a refusal does not mean the command had side effects or was written wrong; it is often simply not on the list. Global `fetch` talks to servers in Ask and Agent and never asks; use WebFetch only for one public page that should become readable text. In Agent, use whichever tool fits. You cannot dispatch subagents.",
  ].join("\n");
}

export function buildWorkerAgentDescription(): string {
  return [
    "Parallel Ask/Agent worker for Bare mode. Same general agent as the main session;",
    "the coordinator sets Ask or Agent at spawn and can switch it when continuing a finished run.",
    "Default when subagent_type is omitted in Bare. Not available outside Bare.",
    "Reuse an existing Worker with SendMessage instead of spawning a second one for the same thread of work.",
  ].join(" ");
}

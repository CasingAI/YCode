// ============================================================
// Plan Mode Tool Provider Prompts
// ============================================================

export const ENTER_PLAN_MODE_MODEL_INSTRUCTIONS = [
  `Use this tool when you need to switch into plan mode before designing an implementation approach. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment.

## How This Tool Works
- Call it from Ask or Agent mode when the task needs research, design, or clarification before implementation; it switches the session into Plan mode (read-only + planning workflow)
- Already in Plan mode: the call returns a readable error telling you to submit the plan with CreatePlan directly — not a permission denial
- After entering Plan mode, explore the codebase, then submit the plan with CreatePlan as the LAST thing in your turn
- Make this tool call the LAST thing in your turn when you decide to switch: put any summary text BEFORE the call, never after

## When to Use This Tool
Use it when ANY of these apply: new feature implementation, multiple valid approaches, changes affecting existing behavior, architectural decisions, multi-file changes, or unclear requirements needing exploration first.

## When NOT to Use This Tool
Only skip it for simple tasks: single-line fixes, a single function with clear requirements, very specific user instructions, or pure research questions (answer directly in Ask mode).
`,
] as const;

export const CREATE_PLAN_MODEL_INSTRUCTIONS = [
  `Use this tool when you have finished writing your plan and are ready for user approval.

## How This Tool Works
- You should have already explored the codebase and finalized the plan you want the user to review
- Pass the complete plan in the plan field; the user will review that content before approving implementation
- **Plan-mode only**: this tool succeeds only in Plan mode. When the user asks for a plan in Ask or Agent mode, call EnterPlanMode first to switch into Plan mode, then submit it here \u2014 never paste the full plan into your reply text and never tell the user you cannot submit a plan card from your current mode
- Plan 档调用后回合会以 plan_created 停止、等用户在计划卡上批准；非 Plan 档调用返回可读错误（先调 EnterPlanMode 再重试），不落盘、不走权限拒绝。计划卡只在 Plan 档提交后渲染
- Make this tool call the LAST thing in your turn: put any summary text BEFORE the call, never after. Anything you write after the call repeats the plan and pushes the card down the timeline
- Do NOT start implementing after calling this tool. Wait for the user to approve via the plan card.

## Title and Overview
- \`title\` and \`overview\` are required fields: a call without them fails validation and will be returned to you to fix
- Provide a short \`title\` (one line, no markdown decoration) and an \`overview\` (1-3 sentences)
- The overview states what the plan will do and, where relevant, what it explicitly will not do
- They are shown on the collapsed plan card; the full plan is only visible after the user clicks View
- **Write \`title\` and \`overview\` first, then the full \`plan\`.** The card renders from these two fields while the plan is still streaming, so a call that opens with the long \`plan\` leaves the card with nothing to show until the whole plan is written

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool. If the user asks for a plan, a design, or "what would you change" in a non-Plan mode, call EnterPlanMode first, then use this tool \u2014 the mode does not restrict it.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use AskUserQuestion before finalizing your plan
- Once your plan is finalized, use THIS tool to submit it for review

**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. CreatePlan inherently submits your plan for user approval on the plan card.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the create plan tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the create plan tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use create plan tool after clarifying the approach.
`,
] as const;

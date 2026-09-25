import assert from "node:assert/strict";
import test from "node:test";
import {
  ReadSessionContextInputJsonSchema,
  type WorkflowGraphNode,
  type WorkflowPhaseDefinition,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";
import { buildCliPrefixSection } from "../src/context/sections/cli-prefix.js";
import { buildDesktopContextSection } from "../src/context/sections/desktop.js";
import { buildIdentitySection } from "../src/context/sections/identity.js";
import { buildExploreAgentPrompt } from "../src/subagent/explore.js";
import { buildGeneralPurposeSystemPrompt } from "../src/subagent/general-purpose.js";
import { buildDefaultNodePrompt } from "../src/workflow/scheduler/prompts.js";
import { buildPhasePrompt, buildScheduledNodePrompt } from "../src/workflow/expert/prompts.js";
import { formatIncomingMessage } from "../src/system-reminder/incoming-message.js";
import { buildReferencedSessionContextReminderBody } from "../src/session-context/references.js";
import { readSessionContextToolEntry } from "../src/tool/handlers/read-session-context.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { createTaskToolEntry } from "../src/tool/handlers/agent.js";
import { EXIT_PLAN_MODE_MODEL_INSTRUCTIONS } from "../src/tool/handlers/plan-mode-prompts.js";

function assertYCodeText(text: string): void {
  assert.match(text, /Y Code/);
  assert.doesNotMatch(text, /\bZCode\b/);
}

function workflowSnapshot(): WorkflowRunSnapshot {
  return {
    artifacts: [],
    runId: "run-1",
    cwd: "/workspace",
    task: "Inspect the repository",
    strategy: {
      clarify: { confidenceThreshold: 0.8, maxRounds: 2, minRounds: 1 },
      executor: {
        drainingChangeHours: 24,
        frontierTarget: 1,
        maxConcurrentLoops: 1,
        maxConsecutiveErrors: 1,
        maxPlannerRuns: 1,
      },
      finalCritic: { maxIterations: 1 },
      reactLoop: { maxRounds: 1 },
    },
  } as unknown as WorkflowRunSnapshot;
}

function workflowNode(): WorkflowGraphNode {
  return {
    id: "node-1",
    title: "Inspect",
    description: "Inspect the repository",
    kind: "task",
    status: "pending",
    dependsOn: [],
  };
}

function workflowPhase(): WorkflowPhaseDefinition {
  return {
    phase: "exec",
    title: "Execution",
    description: "Execute the bounded task",
    behavior: "agent",
  };
}

test("主 Agent system sections use Y Code without changing section metadata", () => {
  const prefix = buildCliPrefixSection();
  const identity = buildIdentitySection();
  const outputStyleIdentity = buildIdentitySection({ name: "Concise", prompt: "Be concise." });
  const desktop = buildDesktopContextSection();

  assert.equal(prefix.content, "You are Y Code, an interactive coding agent");
  assertYCodeText(identity.content);
  assert.match(identity.content, /You are an interactive Y Code agent/);
  assertYCodeText(outputStyleIdentity.content);
  assert.match(outputStyleIdentity.content, /Y Code's tools and instructions/);
  assertYCodeText(desktop.content);
  assert.equal(desktop.name, "ZCode Desktop Context");
  assert.equal(desktop.source, "desktop_context");
  assert.equal(desktop.injectionTarget, "system");
  assert.equal(desktop.cacheHint, "stable");
});

test("subagent and workflow prompts use Y Code", () => {
  const snapshot = workflowSnapshot();
  const node = workflowNode();
  const phase = workflowPhase();

  assertYCodeText(buildExploreAgentPrompt({ embeddedSearchEnabled: false }));
  assertYCodeText(buildGeneralPurposeSystemPrompt());
  assertYCodeText(buildDefaultNodePrompt(snapshot, node, phase.phase));
  assertYCodeText(buildPhasePrompt(snapshot, phase));
  assertYCodeText(buildScheduledNodePrompt(snapshot, phase, node));
});

test("runtime reminders and tool-facing descriptions use Y Code", () => {
  const readSessionContextText = [
    readSessionContextToolEntry.capability,
    readSessionContextToolEntry.metadata.description,
    ...(readSessionContextToolEntry.metadata.modelInstructions ?? []),
    readSessionContextToolEntry.permission?.reason,
  ]
    .filter(Boolean)
    .join("\n");
  const taskEntry = createTaskToolEntry();
  const taskText = [taskEntry.capability, taskEntry.metadata.description]
    .filter(Boolean)
    .join("\n");
  const sessionIdSchema = ReadSessionContextInputJsonSchema.properties?.sessionId as
    | { description?: string }
    | undefined;

  assertYCodeText(formatIncomingMessage("body", "user_steer"));
  assertYCodeText(formatIncomingMessage("body", "subagent_reply"));
  assertYCodeText(buildReferencedSessionContextReminderBody("See #sess_abc") ?? "");
  assertYCodeText(readSessionContextText);
  assertYCodeText(readToolEntry.metadata.description ?? "");
  assertYCodeText(taskText);
  assertYCodeText(sessionIdSchema?.description ?? "");
  assertYCodeText(EXIT_PLAN_MODE_MODEL_INSTRUCTIONS.join("\n"));
  assert.equal(readToolEntry.metadata.name, "Read");
  assert.equal(taskEntry.metadata.name, "Task");
  assert.equal(readSessionContextToolEntry.inputSchema, ReadSessionContextInputJsonSchema);
});

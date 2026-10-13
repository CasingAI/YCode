import { CoreErrorType, createCoreError } from "@zcode/contracts";
import type { CollaborationMode } from "@zcode/contracts";
import { EXPLORE_AGENT_TYPE } from "./explore.js";
import { GENERAL_PURPOSE_AGENT_TYPE } from "./general-purpose.js";
import type { AgentProfile } from "./profile.js";
import { WORKER_AGENT_TYPE } from "./worker.js";

export const WORKER_PARENT_REQUIRED_RULE_ID = "mode.bare.workerParentRequired";
export const BARE_BUILTIN_REPLACED_RULE_ID = "mode.bare.builtinReplacedByWorker";
export const WORKER_MODE_SWITCH_UNSUPPORTED_RULE_ID = "mode.worker.modeSwitchUnsupported";
export const WORKER_MODE_SWITCH_WHILE_RUNNING_RULE_ID = "mode.worker.modeSwitchWhileRunning";

export type SubagentSpawnModeLabel = "Ask" | "Agent";

export function isBuiltInWorkerAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  return profile.name === WORKER_AGENT_TYPE && profile.source === "built-in";
}

export function isBuiltInGeneralPurposeAgentProfile(
  profile: Pick<AgentProfile, "name" | "source">,
): boolean {
  return profile.name === GENERAL_PURPOSE_AGENT_TYPE && profile.source === "built-in";
}

export function isBuiltInWorkerAgentType(agentType: string): boolean {
  return agentType === WORKER_AGENT_TYPE;
}

export function defaultSubagentTypeForParentMode(
  parentMode: CollaborationMode | undefined,
): string {
  return parentMode === "bare" ? WORKER_AGENT_TYPE : GENERAL_PURPOSE_AGENT_TYPE;
}

export function filterAgentProfilesForParentMode(
  profiles: readonly AgentProfile[],
  parentMode: CollaborationMode | undefined,
  options?: { botSession?: boolean },
): AgentProfile[] {
  if (parentMode === "bare" || options?.botSession) {
    return profiles.filter(
      (profile) =>
        !isBuiltInExploreName(profile) && !isBuiltInGeneralPurposeAgentProfile(profile),
    );
  }
  if (parentMode === undefined) {
    return [...profiles];
  }
  return profiles.filter((profile) => !isBuiltInWorkerAgentProfile(profile));
}

export function canDispatchWorkerFromParent(params: {
  parentMode: CollaborationMode | undefined;
  botSession?: boolean;
}): boolean {
  return params.botSession === true || params.parentMode === "bare";
}

export function denySubagentTypeForParentMode(
  parentMode: CollaborationMode | undefined,
  profile: Pick<AgentProfile, "name" | "source">,
  options?: { botSession?: boolean },
): void {
  if (
    isBuiltInWorkerAgentProfile(profile) &&
    !canDispatchWorkerFromParent({ parentMode, botSession: options?.botSession })
  ) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      "Worker subagents can only be dispatched from Bare or Bot sessions",
      {
        context: { ruleId: WORKER_PARENT_REQUIRED_RULE_ID },
        recoverable: true,
      },
    );
  }
  if (
    parentMode === "bare" &&
    (isBuiltInExploreName(profile) || isBuiltInGeneralPurposeAgentProfile(profile))
  ) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      "Bare sessions dispatch Worker instead of Explore or general-purpose",
      {
        context: { ruleId: BARE_BUILTIN_REPLACED_RULE_ID },
        recoverable: true,
      },
    );
  }
}

export function denyWorkerModeSwitchOnSend(input: {
  permissionMode: "readonly" | "yolo" | undefined;
  running: boolean;
  agentType: string;
}): void {
  if (input.permissionMode === undefined) return;
  if (input.running) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      "Cannot switch Ask/Agent on a running Worker; wait until it finishes",
      {
        context: { ruleId: WORKER_MODE_SWITCH_WHILE_RUNNING_RULE_ID },
        recoverable: true,
      },
    );
  }
  if (!isBuiltInWorkerAgentType(input.agentType)) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      "Ask/Agent switching is only available on Worker subagents",
      {
        context: { ruleId: WORKER_MODE_SWITCH_UNSUPPORTED_RULE_ID },
        recoverable: true,
      },
    );
  }
}

export function parseSubagentSpawnModeLabel(
  value: string | undefined,
): "readonly" | "yolo" | undefined {
  if (value === "Ask") return "readonly";
  if (value === "Agent") return "yolo";
  return undefined;
}

export function formatSubagentSpawnModeLabel(
  mode: string | undefined,
): SubagentSpawnModeLabel | undefined {
  if (mode === "readonly") return "Ask";
  if (mode === "yolo") return "Agent";
  return undefined;
}

function isBuiltInExploreName(profile: Pick<AgentProfile, "name" | "source">): boolean {
  return profile.name === EXPLORE_AGENT_TYPE && profile.source === "built-in";
}

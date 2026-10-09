// 命令中心一次性 AI 历史搜索：startAiHistorySearch / cancelAiHistorySearch。
// 由 Host/CLI 内部创建隐藏 ai_history_search 会话、跑一轮 History 工具回合、
// 对外只流式回答与引用（docs/specs/command-center-ai-history-search.md）。
// 浮层禁止自己拼「创建会话 → 发文本 → 再删」——那条路径容易漏进侧栏。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX } from "@zcode/shared/zcode-protocol-v4";
import type { V4CommandCoreHost } from "../types.js";

declare module "../types.js" {
  interface V4CommandCoreHost {
    /**
     * 一次性 AI 历史搜索宿主能力（过渡钩子，归宿：v4 自持会话注册表）。
     * 实现负责：创建隐藏 ai_history_search 会话（sess_ai_search_ 前缀）、
     * 以 History 三件套白名单跑一轮、删除会话。缺席时命令明确失败，
     * UI 不降级成关键词搜索冒充 AI。
     */
    startAiHistorySearch?(input: {
      workspaceId: string;
      query: string;
      language?: CommandPayloadMap["startAiHistorySearch"]["language"];
      sourceCommandId: string;
    }): Promise<{ searchSessionId: string }>;
    /** 中止一次性搜索运行并删除隐藏会话；幂等，会话已回收时 noop 成功。 */
    cancelAiHistorySearch?(searchSessionId: string): Promise<void>;
  }
}

/** startAiHistorySearch 能力缺席时的失败码：UI 据此前缀显示「运行时不可用」。 */
export { AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX };

class V4AiHistorySearchUnsupportedError extends Error {
  readonly reasonCode: string;
  constructor() {
    super("current host does not support one-shot AI history search");
    this.name = "V4AiHistorySearchUnsupportedError";
    this.reasonCode = `${AI_HISTORY_SEARCH_UNSUPPORTED_FAULT_PREFIX}unsupported`;
  }
}

async function startAiHistorySearch(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const payload = envelope.payload as CommandPayloadMap["startAiHistorySearch"];
  if (!host.startAiHistorySearch) {
    throw new V4AiHistorySearchUnsupportedError();
  }
  const result = await host.startAiHistorySearch({
    workspaceId: payload.workspaceId,
    query: payload.query,
    ...(payload.language === undefined ? {} : { language: payload.language }),
    sourceCommandId: envelope.commandId,
  });
  return { type: "startAiHistorySearch", sessionId: result.searchSessionId };
}

async function cancelAiHistorySearch(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelAiHistorySearch"];
  // 取消是回收语义：宿主无能力 = 无隐藏会话可回收，幂等成功。
  if (!host.cancelAiHistorySearch) return undefined;
  await host.cancelAiHistorySearch(payload.searchSessionId);
  return undefined;
}

/** 隐藏搜索会话上的写命令守卫：与 selection_side_chat 同例，禁止改会话语义的命令。 */
export function assertNotAiHistorySearchSession(
  host: V4CommandCoreHost,
  sessionId: string | null,
  command: CommandEnvelope["type"],
): void {
  if (!sessionId) return;
  if (host.getRecord(sessionId)?.taskType === "ai_history_search") {
    throw new V4AiHistorySearchSessionRestrictedCommandError(command);
  }
}

class V4AiHistorySearchSessionRestrictedCommandError extends Error {
  readonly reasonCode = "guard.aiHistorySearchRestrictedCommand";

  constructor(command: CommandEnvelope["type"]) {
    super(`ai_history_search 不允许执行 ${command}`);
    this.name = "V4AiHistorySearchSessionRestrictedCommandError";
  }
}

export { V4AiHistorySearchSessionRestrictedCommandError };

export const aiHistorySearchHandlers = {
  startAiHistorySearch,
  cancelAiHistorySearch,
};

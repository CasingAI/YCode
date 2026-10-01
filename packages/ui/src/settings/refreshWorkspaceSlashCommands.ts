// 命令绑定写盘后的斜杠目录刷新（docs/specs/command-model-binding.md）。
// 设置写入只刷设置列表（commandsStore）；输入框插入读的是 zcodeSessionStore.slashCommands，
// 且目录水合成功后不会再来。绑定改完必须现拉一次 readWorkspacePresentation——CLI 侧
// 目录每次装配都现读配置与文件头——并整表写回，否则同一会话再插入仍用旧绑定。
import type { IZCodeSessionService } from "@zcode/services";
import { ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/workspacePrepareRpc.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export async function refreshWorkspaceSlashCommandsAfterBindingChange(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  zcodeSessionService: IZCodeSessionService;
  provider?: ZCodeProvider;
}): Promise<void> {
  const { workspacePath, workspaceIdentity, zcodeSessionService } = params;
  try {
    const presentation = await prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      // 目录装配不依赖 provider；prepare 只把它透传进结果，传 Agent 常量即可。
      provider: params.provider ?? ZCODE_AGENT_PROVIDER,
      zcodeSessionService,
    });
    const slashCommands = presentation.slashCommands;
    if (!slashCommands) {
      // 旧 CLI 的 presentation 可能不带目录字段：保留现状整表不写，
      // 不能把空目录当成「无命令」清掉输入框现有目录。
      return;
    }
    useZCodeSessionStore
      .getState()
      .setSlashCommands(workspacePath, slashCommands, workspaceIdentity);
  } catch (error) {
    // 刷新失败只降级为「本会话内继续用旧绑定」；设置写入本身已成功，不能因刷新失败报错。
    logger.warn("[command-model-binding] 斜杠目录刷新失败，保留旧目录", {
      error: error instanceof Error ? error.message : String(error),
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? null,
    });
  }
}

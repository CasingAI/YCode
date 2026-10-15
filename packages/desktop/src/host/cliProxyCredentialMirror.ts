/**
 * CLI Proxy 凭据镜像的 Host 执行器：把 services 的镜像引擎接到窗口级服务集合上。
 *
 * 决策与状态机都在 @zcode/services/node 的 cliProxyMirror（纯函数 + 注入端口，有单测）；
 * 这里只做三件事：读 auth 目录文件名、在 IProviderSettingsService 上执行动作、
 * 读写 mirror-state.json 账本。触发时机见 host/index.ts（startup 在按需启动判定前、
 * running 在状态转 running 的边沿）——无文件 watcher，不轮询。
 */
import type { IProviderSettingsService } from "@zcode/services";
import {
  createServiceLogger,
  listCliProxyAuthFiles,
  readCliProxyMirrorState,
  resolveCliProxyCredentialChannels,
  resolveCliProxyLayout,
  runCliProxyCredentialMirror,
  writeCliProxyMirrorState,
} from "@zcode/services/node";
import type { CliProxyCredentialMirrorPorts } from "@zcode/services/node";
import { cliProxyChannelFromTemplateId } from "@zcode/shared";

const logger = createServiceLogger("cliProxyCredentialMirror");

export interface CliProxyCredentialMirrorDeps {
  /** 窗口级服务集合的惰性取用；未初始化（null）时本次镜像跳过。 */
  getProviderSettings: () => IProviderSettingsService | null;
  /** Host CLI Proxy 服务的统一模型同步命令。 */
  syncModels: CliProxyCredentialMirrorPorts["syncModels"];
  /** 刷新所有可见 Provider 的能力，不补名单。 */
  refreshVisibleProviderCapabilities: NonNullable<
    CliProxyCredentialMirrorPorts["refreshVisibleProviderCapabilities"]
  >;
}

export function createCliProxyCredentialMirror(deps: CliProxyCredentialMirrorDeps): {
  run(phase: "startup" | "running"): Promise<void>;
} {
  const run = async (phase: "startup" | "running"): Promise<void> => {
    const providerSettings = deps.getProviderSettings();
    if (!providerSettings) return;
    const layout = resolveCliProxyLayout();
    const channels = resolveCliProxyCredentialChannels(await listCliProxyAuthFiles(layout.authDir));
    const state = await readCliProxyMirrorState(layout);
    const view = await providerSettings.getView();
    // 只有存在 cliproxy-* 模板的渠道参与镜像；后续渠道模板上线即自动加入。
    const channelTemplates = view.providerTemplates.flatMap((template) => {
      const channel = cliProxyChannelFromTemplateId(template.templateId);
      return channel ? [{ channel, templateId: template.templateId }] : [];
    });
    const { nextState } = await runCliProxyCredentialMirror({
      phase,
      channels,
      channelTemplates,
      providers: view.providers.map((provider) => ({
        providerId: provider.providerId,
        templateId: provider.templateId ?? null,
      })),
      state,
      ports: {
        createProviderFromTemplate: (templateId) =>
          providerSettings.createPersonalProvider({ templateId }),
        saveProviderVisibility: (providerId, visibility) =>
          providerSettings.savePersonalProviderOverlay(providerId, { visibility }),
        syncModels: deps.syncModels,
        refreshVisibleProviderCapabilities: deps.refreshVisibleProviderCapabilities,
      },
    });
    await writeCliProxyMirrorState(layout, nextState);
    logger.info("cli-proxy credential mirror ran", { phase, channels });
  };
  return {
    run: (phase) =>
      run(phase).catch((error) => {
        // 镜像失败不挡启动/运行：下次触发时机重试（spec「凭据镜像」事件顺序）。
        logger.warn("cli-proxy credential mirror failed", {
          phase,
          message: error instanceof Error ? error.message : String(error),
        });
      }),
  };
}

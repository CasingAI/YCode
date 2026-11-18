/**
 * CLI Proxy 凭据镜像的 Host 执行器：把 services 的镜像引擎接到窗口级服务集合上。
 *
 * 决策与状态机都在 @zcode/services/node 的 cliProxyMirror（纯函数 + 注入端口，有单测）；
 * 这里只做四件事：读 auth 目录文件名并解析账号、在 IProviderSettingsService 上执行动作、
 * 幂等写入账号前缀、读写 mirror-state.json 账本。触发时机见 host/index.ts（startup 在
 * 按需启动判定前、running 在状态转 running 的边沿或登录落盘后）——无文件 watcher，不轮询。
 */
import type { IProviderSettingsService } from "@zcode/services";
import {
  createServiceLogger,
  getDataBaseDir,
  listCliProxyAuthFiles,
  readCliProxyCredentialPrefix,
  readCliProxyMirrorState,
  resolveCliProxyCredentialAccounts,
  resolveCliProxyLayout,
  resolveCliProxyRoot,
  runCliProxyCredentialMirror,
  writeCliProxyMirrorState,
} from "@zcode/services/node";
import type { CliProxyCredentialMirrorPorts } from "@zcode/services/node";
import { cliProxyChannelFromTemplateId } from "@zcode/shared";

const logger = createServiceLogger("cliProxyCredentialMirror");

export interface CliProxyCredentialMirrorDeps {
  /** 窗口级服务集合的惰性取用；未初始化（null）时本次镜像跳过。 */
  getProviderSettings: () => IProviderSettingsService | null;
  /** Host CLI Proxy 服务的统一模型同步命令（账号 provider 传凭据绑定）。 */
  syncModels: CliProxyCredentialMirrorPorts["syncModels"];
  /** Host CLI Proxy 服务的账号前缀写入（管理面 PATCH，幂等由本执行器判等保证）。 */
  setCredentialPrefix: (credentialName: string, prefix: string) => Promise<void>;
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
    // 必须与 CliProxyService 同源：服务按 getDataBaseDir() 解析根目录（自定义数据目录时
    // 不等于 homedir）。直接 resolveCliProxyLayout() 只认 homedir，会读到空 auth 目录，
    // 表现为"镜像跑了但一张账号卡都没有"。
    const layout = resolveCliProxyLayout(resolveCliProxyRoot(getDataBaseDir()));
    const accounts = resolveCliProxyCredentialAccounts(await listCliProxyAuthFiles(layout.authDir));
    const state = await readCliProxyMirrorState(layout);
    const view = await providerSettings.getView();
    // 只有存在 cliproxy-* 模板的渠道参与镜像；后续渠道模板上线即自动加入。
    // 展示名取模板自身的多语言名称，账号邮箱由引擎拼到卡片名尾部。
    const channelTemplates = view.providerTemplates.flatMap((template) => {
      const channel = cliProxyChannelFromTemplateId(template.templateId);
      if (!channel) return [];
      const name =
        template.templateNameMap["zh-CN"] ??
        template.templateNameMap["en-US"] ??
        template.templateId;
      return [{ channel, templateId: template.templateId, name }];
    });
    const { nextState } = await runCliProxyCredentialMirror({
      phase,
      accounts,
      channelTemplates,
      providers: view.providers.map((provider) => ({
        providerId: provider.providerId,
        templateId: provider.templateId ?? null,
      })),
      state,
      ports: {
        createProviderFromTemplate: (templateId, options) =>
          providerSettings.createPersonalProvider({
            templateId,
            ...(options?.providerName ? { providerName: options.providerName } : {}),
          }),
        saveProviderVisibility: (providerId, visibility) =>
          providerSettings.savePersonalProviderOverlay(providerId, { visibility }),
        // 前缀的事实源是凭据文件：值相同即跳过网络写入（幂等，避免每次 running 都 PATCH）。
        ensureCredentialPrefix: async (credentialName, prefix) => {
          const current = await readCliProxyCredentialPrefix(layout, credentialName);
          if (current === prefix) return { changed: false };
          await deps.setCredentialPrefix(credentialName, prefix);
          return { changed: true };
        },
        syncModels: deps.syncModels,
        refreshVisibleProviderCapabilities: deps.refreshVisibleProviderCapabilities,
      },
    });
    await writeCliProxyMirrorState(layout, nextState);
    logger.info("cli-proxy credential mirror ran", {
      phase,
      accounts: accounts.map((account) => account.accountKey),
    });
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

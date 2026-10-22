import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
  IStorageService,
  IResourceUsageService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  ICuaPermissionService,
  IConversationShareService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  IUsageStatsService,
  IOpenCodeUsageService,
  IDeepSeekBalanceService,
  IMiniMaxQuotaService,
  IOpenRouterBalanceService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  IOffPeakTaskService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  ISettingsSyncService,
  IFeedbackService,
  IPromptAttachmentTransferService,
  IComposerDraftService,
  IWindowControllerService,
  IMobileRemoteControlService,
  ICliProxyQuotaService,
  ICliProxyService,
  IChatGPTPlanService,
  type CliProxyQuotaService,
  type IServiceAccessor,
} from "@zcode/services";

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export interface RemoteServiceAccessOptions {
  /** 该 attachment 是否注册了手机远控 channel；仅桌面本地窗口 Host 为 true。 */
  mobileRemoteControl?: boolean;
  /** 该 attachment 是否注册了 CLI Proxy 管理 channel；仅桌面 Renderer 本地连接为 true。 */
  cliProxy?: boolean;
  /** 本地桌面账户管理能力，与 CLI Proxy 插件无关。 */
  chatGPTPlan?: boolean;
  /** 该 attachment 是否提供只读额度查询；仅桌面手机远控连接为 true。 */
  cliProxyQuota?: boolean;
}
export class RemoteServiceAccess implements IServiceAccessor {
  readonly fileService: IFileService;
  readonly storageService: IStorageService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly chatGPTPlanService?: IChatGPTPlanService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  /**
   * 手机远控只在桌面本地窗口 Host 上注册，且远程 workspace scoped attachment 与
   * 独立 web server 都不暴露该 channel，所以这里按构造参数条件注入：
   * 存在即代表该 attachment 真的能提供远控。
   */
  readonly mobileRemoteControlService?: IMobileRemoteControlService;
  /**
   * CLI Proxy 二进制插件运行时（桌面本地窗口 Host 能力）。
   *
   * 与远控同款可选模式：只在桌面本地 attachment 上存在，远程 workspace 与
   * 独立 web server 都不暴露，入口据此自动隐藏。
   */
  readonly cliProxyService?: ICliProxyService;
  readonly cliProxyQuotaService?: CliProxyQuotaService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // cuaPermissionService 在 IServiceAccessor 上是可选（远端 host 不提供），但桌面 renderer
  // 经 RPC 一定能拿到（main host 始终注册此 descriptor；非 macOS / 未启用时方法返回 available:false）。
  readonly cuaPermissionService: ICuaPermissionService;
  readonly conversationShareService: IConversationShareService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly usageStatsService: IUsageStatsService;
  readonly opencodeUsageService: IOpenCodeUsageService;
  readonly deepSeekBalanceService: IDeepSeekBalanceService;
  readonly miniMaxQuotaService: IMiniMaxQuotaService;
  readonly openRouterBalanceService: IOpenRouterBalanceService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
  /**
   * 共享草稿服务。
   *
   * 只有注册了该服务的宿主（桌面 Host）才有；独立 web server 没有，
   * 调用会失败，调用方需要能退回本地草稿。
   */
  readonly composerDraftService: IComposerDraftService;
  /** 宿主进程资源采样（资源管理器数据源）；旧宿主没有该服务，调用会失败。 */
  readonly resourceUsageService: IResourceUsageService;

  constructor(channelClient: IChannelClient, options?: RemoteServiceAccessOptions) {
    this.resourceUsageService = ProxyChannel.toService<IResourceUsageService>(
      channelClient.getChannel(IResourceUsageService.channelName),
    );
    this.storageService = ProxyChannel.toService<IStorageService>(
      channelClient.getChannel(IStorageService.channelName),
    );
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    if (options?.mobileRemoteControl === true) {
      this.mobileRemoteControlService = ProxyChannel.toService<IMobileRemoteControlService>(
        channelClient.getChannel(IMobileRemoteControlService.channelName),
      );
    }
    if (options?.chatGPTPlan === true) {
      this.chatGPTPlanService = ProxyChannel.toService<IChatGPTPlanService>(
        channelClient.getChannel(IChatGPTPlanService.channelName),
      );
    }
    if (options?.cliProxy === true) {
      this.cliProxyService = ProxyChannel.toService<ICliProxyService>(
        channelClient.getChannel(ICliProxyService.channelName),
      );
    }
    if (options?.cliProxyQuota === true) {
      this.cliProxyQuotaService = ProxyChannel.toService<ICliProxyQuotaService>(
        channelClient.getChannel(ICliProxyQuotaService.channelName),
      );
    }
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.conversationShareService = ProxyChannel.toService<IConversationShareService>(
      channelClient.getChannel(IConversationShareService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.opencodeUsageService = ProxyChannel.toService<IOpenCodeUsageService>(
      channelClient.getChannel(IOpenCodeUsageService.channelName),
    );
    this.deepSeekBalanceService = ProxyChannel.toService<IDeepSeekBalanceService>(
      channelClient.getChannel(IDeepSeekBalanceService.channelName),
    );
    this.miniMaxQuotaService = ProxyChannel.toService<IMiniMaxQuotaService>(
      channelClient.getChannel(IMiniMaxQuotaService.channelName),
    );
    this.openRouterBalanceService = ProxyChannel.toService<IOpenRouterBalanceService>(
      channelClient.getChannel(IOpenRouterBalanceService.channelName),
    );
    this.codingPlanSubscriptionService = ProxyChannel.toService<ICodingPlanSubscriptionService>(
      channelClient.getChannel(ICodingPlanSubscriptionService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
    this.composerDraftService = ProxyChannel.toService<IComposerDraftService>(
      channelClient.getChannel(IComposerDraftService.channelName),
    );
  }
}

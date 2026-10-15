import { Loader2Icon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CliProxyLoginChannel, UsageQuotaLimit } from "@zcode/shared";
import { cliProxyChannelFromTemplateId, formatCliProxyObservedAgo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCliProxyAccount, type CliProxyLoginErrorKey, type CliProxyLoginPhase } from "@/hooks/useCliProxyAccount.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useModelProviderRefreshTick } from "@/settings/model-provider-section/RefreshSignal.js";
import { PlanUsageMetricCard } from "./StatusCards.js";

const WINDOW_LABEL_IDS = {
  "five-hour": "settings.modelProvider.cliproxyQuota.window.fiveHour",
  weekly: "settings.modelProvider.cliproxyQuota.window.weekly",
  other: "settings.modelProvider.cliproxyQuota.window.other",
} as const;

const WINDOW_PROGRESS_COLORS = {
  "five-hour": "var(--color-usage-chart-1)",
  weekly: "var(--color-usage-chart-2)",
  other: "var(--color-usage-chart-3)",
} as const;

/** Codex 窗口 → 官方 PlanUsageMetricCard 投影（已用占比，卡片内部反转为剩余展示）。 */
function toUsageLimit(usagePercent: number, resetAt: string | null): UsageQuotaLimit {
  return {
    type: "OPENCODE_USAGE",
    percentage: usagePercent,
    nextResetTime: resetAt ? Date.parse(resetAt) : undefined,
    usageDetails: [],
  };
}

/**
 * cliproxy-codex provider 卡片上的「剩余额度」区块（statusSection 插槽，
 * 与其他供应商相同位置，不新增界面元素）。
 * 只显示最后一次观测值 + 友好化时间；无数据显示"—"；不提供主动刷新按钮。
 * 空态：代理未启动（proxy-stopped）、账号未登录（not-logged-in）、
 * 无额度观测（no-observation）各有文案。
 */
export function CliProxyQuotaSection({
  providerId,
  templateId,
}: {
  providerId: string;
  /** Provider 视图的 templateId 可能显式为 null（无模板）；归一为 undefined。 */
  templateId?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const channel: CliProxyLoginChannel =
    cliProxyChannelFromTemplateId(templateId) ?? "codex";
  const channelName = channel.charAt(0).toUpperCase() + channel.slice(1);
  const account = useCliProxyAccount(providerId, channel);

  const refreshTick = useModelProviderRefreshTick();
  const observedTickRef = useRef(refreshTick);
  const refreshRef = useRef(account.reloadQuota);
  refreshRef.current = account.reloadQuota;
  useEffect(() => {
    if (refreshTick === observedTickRef.current) return;
    observedTickRef.current = refreshTick;
    refreshRef.current();
  }, [refreshTick]);

  const quota = account.quota;
  const observedAgo = formatCliProxyObservedAgo(quota?.observedAt ?? null);
  const detail = observedAgo
    ? intl.formatMessage(
        { id: "settings.modelProvider.cliproxyQuota.observedAgo" },
        { time: observedAgo },
      )
    : "—";
  // 登录入口的呈现条件（缺口修复）：
  // - quota?.error === "not-logged-in"：凭据缺失，登录是唯一出路；
  // - quota?.error === "proxy-stopped"：代理尚未启动（新建 provider 后常见），
  //   startLogin 会先拉起代理再取授权 URL，所以同样直接给登录入口；
  // - quota 为 null 且不在加载中：首屏/新建后额度尚未返回，不能留空白框，
  //   先把登录入口摆出来（已登录用户 quota 返回后入口自动消失）。
  // 已登录且有过额度观测（windows 非空 / no-observation）时不打扰用户。
  // 登录入口可见性（依据 spec「登录入口可见性」，2026-10-14 真机复测修正）：
  // 入口不得由额度错误码决定。本机已有凭据但尚无观测值时服务返回 no-observation，
  // 旧逻辑会据此隐藏入口，用户既没有额度、也无法重新登录，形成死路。
  // 现规则：桌面端（服务可用）恒显示；只有 web/远端（服务不可用）不渲染，改提示去桌面端。
  const loggedIn =
    quota?.error === "no-observation" || (quota?.windows.length ?? 0) > 0;
  const showLogin = account.loginAvailable || account.loginPhase !== "idle";
  const notLoggedIn = !loggedIn && account.loginAvailable;
  const showDesktopOnlyHint = !account.quotaAvailable;

  // 取到授权 URL 即自动打开浏览器（用户点一次"登录"即可），
  // 块内仍保留手动"打开浏览器授权"按钮做兜底（被拦截时可点）。
  const openedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      account.loginPhase === "awaiting" &&
      account.authUrl &&
      openedUrlRef.current !== account.authUrl
    ) {
      openedUrlRef.current = account.authUrl;
      platform.openExternal(account.authUrl);
    }
  }, [account.authUrl, account.loginPhase, platform]);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="shrink-0 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
        </h4>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {account.quotaLoading ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin text-foreground-subtle" />
          ) : null}
          {/* 已登录：角落「切换账号」（OpenCode「修改配置」同款版式），不再渲染登录横幅。
              未登录：同位置给「登录」按钮；web/远端不可用时按钮不出现，由下方文案提示。 */}
          {showLogin && account.available && account.loginPhase === "idle" ? (
            <ControlHintTooltip standalone title={intl.formatMessage(
              { id: "settings.modelProvider.cliproxyLogin.reauthorizeHint" },
              { channel: channelName },
            )}>
              <Button type="button" variant="ghost" size="sm" onClick={account.startLogin}>
                {intl.formatMessage(
                  {
                    id: loggedIn
                      ? "settings.modelProvider.cliproxyLogin.reauthorize"
                      : "settings.modelProvider.cliproxyLogin.loginShort",
                  },
                  { channel: channelName },
                )}
              </Button>
            </ControlHintTooltip>
          ) : null}
        </div>
      </div>

      {/* 登录引导：未登录时保留一行灰字说明（web/远端提示去桌面端）；
          已登录不再渲染任何横幅——账号操作收敛到标题右侧的「切换账号」。
          瞬时态（启动中/等待授权/失败）仍用紧凑行内块。 */}
      {showDesktopOnlyHint && account.loginPhase === "idle" ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.desktopOnly" })}
        </p>
      ) : null}
      {notLoggedIn && account.loginPhase === "idle" && account.loginAvailable && account.quotaAvailable ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.modelProvider.cliproxyLogin.notLoggedIn" },
            { channel: channelName },
          )}
        </p>
      ) : null}
      {account.loginPhase !== "idle" ? (
        <CliProxyLoginBlock
          phase={account.loginPhase}
          authUrl={account.authUrl}
          loginError={account.loginError}
          onStart={account.startLogin}
          onOpenUrl={(url) => platform.openExternal(url)}
        />
      ) : null}

      {quota?.error === "proxy-stopped" ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.cliproxyQuota.startingHint" })}
        </p>
      ) : null}
      {quota?.error === "no-observation" ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.cliproxyQuota.noObservation" })}
        </p>
      ) : null}
      {quota?.error === "unavailable" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-ui-xs text-warning" role="alert">
            {intl.formatMessage({ id: "settings.modelProvider.cliproxyQuota.unavailable" })}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void account.reloadQuota()}
            disabled={account.quotaLoading}
          >
            {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.retry" })}
          </Button>
        </div>
      ) : null}

      {quota && quota.windows.length > 0 ? (
        <div className="mt-2 flex w-full gap-2 max-sm:flex-col">
          {quota.windows.map((window, index) => (
            <PlanUsageMetricCard
              key={`${window.key}-${index}`}
              label={intl.formatMessage({ id: WINDOW_LABEL_IDS[window.key] })}
              limit={toUsageLimit(window.usagePercent, window.resetAt)}
              detail={detail}
              progressColor={WINDOW_PROGRESS_COLORS[window.key]}
              resetTimeFormat={window.key === "five-hour" ? "dateTime" : "date"}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 界面内引导授权：打开浏览器 → 轮询 → 凭据落盘即热加载。导出供单测直测各 phase。 */
export function CliProxyLoginBlock({
  phase,
  authUrl,
  loginError,
  onStart,
  onOpenUrl,
}: {
  phase: CliProxyLoginPhase;
  authUrl: string | null;
  loginError: CliProxyLoginErrorKey | null;
  onStart: () => void;
  onOpenUrl: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const busy = phase === "starting" || phase === "awaiting";
  // idle 态不渲染：登录/切换入口已上移到「剩余额度」标题右侧的角落按钮，
  // 这里只承载瞬时态（启动中/等待授权/完成/失败），不再出现整块登录横幅。
  if (phase === "idle") return null;
  return (
    <div className="mt-2 rounded-lg bg-surface p-3">
      {phase === "starting" ? (
        <p className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
          <Loader2Icon className="size-3.5 animate-spin" />
          {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.starting" })}
        </p>
      ) : null}
      {phase === "awaiting" && authUrl ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.awaiting" })}
          </p>
          <Button type="button" size="sm" onClick={() => onOpenUrl(authUrl)}>
            {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.openBrowser" })}
          </Button>
        </div>
      ) : null}
      {phase === "awaiting" && !authUrl ? (
        <p className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
          <Loader2Icon className="size-3.5 animate-spin" />
          {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.awaiting" })}
        </p>
      ) : null}
      {phase === "done" ? (
        <p className="text-ui-xs text-success">
          {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.done" })}
        </p>
      ) : null}
      {phase === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-ui-xs text-warning" role="alert">
            {/* 按码渲染（依据：docs/specs/plugin-cli-proxy-binary.md）：
                loginError 是联合类型，穷举映射为中文，禁止渲染原文；
                未来新增码走通用失败文案，机器码不得上屏。 */}
            {loginError === "callback-port-busy"
              ? intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.portBusy" })
              : loginError === "desktop-only"
                ? intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.desktopOnly" })
                : loginError === "proxy-stopped"
                  // 文案去重（依据 spec「额度区文案分工」）：灰字 startingHint 已承担
                  // “代理尚未启动”说明，橙框不再复述，改用独立的代理未启动登录文案。
                  ? intl.formatMessage({
                      id: "settings.modelProvider.cliproxyLogin.proxyNotRunning",
                    })
                  // 密钥缺失有独立指引：重试必然再失败，给出路而非通用重试。
                  : loginError === "management-key-missing"
                    ? intl.formatMessage({
                        id: "settings.modelProvider.cliproxyLogin.keyMissing",
                      })
                    : intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.failed" })}
          </p>
          {loginError === "desktop-only" ? null : (
            <Button type="button" size="sm" variant="outline" onClick={onStart} disabled={busy}>
              {intl.formatMessage({ id: "settings.modelProvider.cliproxyLogin.retry" })}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

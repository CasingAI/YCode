/**
 * CLI Proxy 凭据镜像：auth 目录 → provider 列表。
 *
 * 产品规则（docs/specs/plugin-cli-proxy-binary.md「凭据镜像」，2026-10-14 用户拍板）：
 * auth 目录里有哪些支持渠道的凭据，provider 列表就全部显示出来，哪怕不是在软件里
 * 亲自添加的（迁移/外部登录进来的账号不得要求先手建卡片）；凭据消失，对应条目退场。
 *
 * 所有者与写入路径：凭据文件（代理 OAuth 落盘）是事实源；mirror-state.json 是镜像
 * 归属账本（只记录镜像自己种下的条目）；provider 个人配置是唯一 UI 事实——种子、
 * 隐藏、恢复都是对它的普通写入（createPersonalProvider / savePersonalProviderOverlay），
 * 不存在第二条写入路径。本模块是纯决策 + 注入端口的执行引擎，不直接触达 provider
 * 服务，Host 负责把端口接到 IProviderSettingsService 上。
 *
 * 事件顺序（无文件 watcher，不轮询）：
 *   Host 初始化 → 镜像(startup)：种子/隐藏/恢复 → resumeIfEnabled 按需启动判定
 *   代理转 running（边沿）→ 镜像(running)：补种子模型、刷新所有可见 CLI Proxy Provider 能力并拾取运行期新凭据
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CLI_PROXY_LOGIN_CHANNELS } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { CliProxyLayout } from "./cliProxyVersions.js";

const logger = createServiceLogger("cliProxyMirror");

/** 镜像归属账本：一个渠道最多一条记录（一渠道一种子条目）。 */
export const cliProxyMirrorStateSchema = z.object({
  version: z.literal(1),
  channels: z.record(
    z.string(),
    z.object({
      providerId: z.string().min(1),
      seededAt: z.string().min(1),
      /** 凭据消失时我们写的隐藏态；凭据回来即恢复。 */
      hidden: z.boolean().optional(),
      /** 用户删掉了种子条目：永久放弃该渠道的自动种子（手动添加不受影响）。 */
      withdrawn: z.boolean().optional(),
      /** 已完成过一次动态模型同步（/v1/models 新鲜拉取成功）。 */
      modelsSynced: z.boolean().optional(),
    }),
  ),
});

export type CliProxyMirrorState = z.infer<typeof cliProxyMirrorStateSchema>;
export type CliProxyMirrorChannelState = CliProxyMirrorState["channels"][string];

export function mirrorStateFile(layout: CliProxyLayout): string {
  return join(layout.root, "mirror-state.json");
}

export async function readCliProxyMirrorState(
  layout: CliProxyLayout,
): Promise<CliProxyMirrorState> {
  try {
    return cliProxyMirrorStateSchema.parse(
      JSON.parse(await readFile(mirrorStateFile(layout), "utf8")),
    );
  } catch {
    // 缺文件/损坏按空状态重建（spec 定案：最坏情况是重新种子一次，可接受）。
    return { version: 1, channels: {} };
  }
}

export async function writeCliProxyMirrorState(
  layout: CliProxyLayout,
  state: CliProxyMirrorState,
): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  const file = mirrorStateFile(layout);
  await writeFile(file, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

/**
 * 从 auth 目录文件名识别有凭据的渠道：`<渠道>-*.json` 前缀（实测样本
 * `codex-77bf18ea-<email>-pro.json`）。管理面 credentials 的 provider 字段才是权威，
 * 但它要求代理在跑；启动期代理未起，文件名前缀是唯一可得来源。前缀不认识 → 忽略。
 */
export function resolveCliProxyCredentialChannels(fileNames: readonly string[]): string[] {
  const channels = new Set<string>();
  for (const name of fileNames) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".json") || lower.endsWith(".lock")) continue;
    const prefix = name.slice(0, -".json".length).split("-")[0]?.toLowerCase() ?? "";
    if ((CLI_PROXY_LOGIN_CHANNELS as readonly string[]).includes(prefix)) channels.add(prefix);
  }
  return [...channels];
}

export type CliProxyMirrorAction =
  | { kind: "seed"; channel: string; templateId: string }
  | { kind: "hide"; channel: string; providerId: string }
  | { kind: "unhide"; channel: string; providerId: string }
  | { kind: "withdraw"; channel: string; providerId: string };

export interface CliProxyCredentialMirrorPlanInput {
  /** auth 目录观测到凭据的渠道（resolveCliProxyCredentialChannels 的输出）。 */
  channels: readonly string[];
  /** 当前可用的 cliproxy 模板（渠道 → 模板 id）；没有模板的渠道不参与镜像。 */
  channelTemplates: readonly { channel: string; templateId: string }[];
  /** 可见 provider 投影（getView 已滤掉 visibility:hidden）。 */
  providers: readonly { providerId: string; templateId: string | null }[];
  state: CliProxyMirrorState;
}

/**
 * 纯规划：比对「凭据渠道 × 镜像账本 × 可见 provider」得出动作，不做任何 IO。
 * hidden 与 deleted 无法从视图区分（视图已滤掉 hidden），全靠账本的 hidden 标记分辨。
 */
export function resolveCliProxyCredentialMirrorPlan(
  input: CliProxyCredentialMirrorPlanInput,
): CliProxyMirrorAction[] {
  const actions: CliProxyMirrorAction[] = [];
  const providerIds = new Set(input.providers.map((provider) => provider.providerId));
  for (const { channel, templateId } of input.channelTemplates) {
    const hasCredential = input.channels.includes(channel);
    const entry = input.state.channels[channel];
    if (!entry) {
      // 无账本记录：渠道有凭据且没有可见同模板卡片（手动建过就交给用户）才种子。
      if (
        hasCredential &&
        !input.providers.some((provider) => provider.templateId === templateId)
      ) {
        actions.push({ kind: "seed", channel, templateId });
      }
      continue;
    }
    if (entry.withdrawn) continue;
    if (entry.hidden) {
      // 我们藏的：凭据回来就恢复；执行失败（条目其实已被手删）由引擎转 withdrawn。
      if (hasCredential) actions.push({ kind: "unhide", channel, providerId: entry.providerId });
      continue;
    }
    if (!providerIds.has(entry.providerId)) {
      // 不在可见视图且不是我们藏的：用户删了 → 永久放弃该渠道的自动种子。
      actions.push({ kind: "withdraw", channel, providerId: entry.providerId });
      continue;
    }
    if (!hasCredential) actions.push({ kind: "hide", channel, providerId: entry.providerId });
    // 在岗且有凭据：不动。
  }
  return actions;
}

/** 镜像引擎的副作用端口：Host 注入 IProviderSettingsService 与运行中模型的读取。 */
export interface CliProxyCredentialMirrorPorts {
  createProviderFromTemplate(templateId: string): Promise<{ providerId: string }>;
  saveProviderVisibility(providerId: string, visibility: "visible" | "hidden"): Promise<unknown>;
  syncModels(providerId: string): Promise<void>;
  /** 代理运行期间刷新可见 CLI Proxy Provider 的能力，不补名单、不改成员。 */
  refreshVisibleProviderCapabilities?(): Promise<void>;
}

export interface CliProxyCredentialMirrorInput extends CliProxyCredentialMirrorPlanInput {
  phase: "startup" | "running";
  ports: CliProxyCredentialMirrorPorts;
  now?: () => Date;
}

export interface CliProxyCredentialMirrorResult {
  actions: readonly CliProxyMirrorAction[];
  nextState: CliProxyMirrorState;
}

/**
 * 执行一次镜像：规划 → 逐动作执行（失败只记日志不中断，下次镜像重试）→ 产出新账本。
 * running 阶段顺带补模型同步：startup 时代理还没起，/v1/models 拉不到，只能留到这。
 */
export async function runCliProxyCredentialMirror(
  input: CliProxyCredentialMirrorInput,
): Promise<CliProxyCredentialMirrorResult> {
  const actions = resolveCliProxyCredentialMirrorPlan(input);
  const nextState: CliProxyMirrorState = {
    version: 1,
    channels: Object.fromEntries(
      Object.entries(input.state.channels).map(([channel, entry]) => [channel, { ...entry }]),
    ),
  };
  const now = input.now ?? (() => new Date());
  // 允许模型同步的条目：镜像前就可见的 + 本次种子/恢复的（视图快照落后于本 run 的写入）。
  const modelSyncProviderIds = new Set(input.providers.map((provider) => provider.providerId));
  for (const action of actions) {
    try {
      switch (action.kind) {
        case "seed": {
          const { providerId } = await input.ports.createProviderFromTemplate(action.templateId);
          nextState.channels[action.channel] = { providerId, seededAt: now().toISOString() };
          modelSyncProviderIds.add(providerId);
          break;
        }
        case "hide": {
          await input.ports.saveProviderVisibility(action.providerId, "hidden");
          const entry = nextState.channels[action.channel];
          if (entry) entry.hidden = true;
          break;
        }
        case "unhide": {
          await input.ports.saveProviderVisibility(action.providerId, "visible");
          const entry = nextState.channels[action.channel];
          if (entry) {
            delete entry.hidden;
            modelSyncProviderIds.add(action.providerId);
          }
          break;
        }
        case "withdraw": {
          const entry = nextState.channels[action.channel];
          if (entry) entry.withdrawn = true;
          break;
        }
      }
    } catch (error) {
      if (action.kind === "unhide") {
        // 恢复失败 = 条目其实已不在（隐藏期间被手删）：转 withdrawn 永久放弃，
        // 否则每次启动都会对同一个不存在的 id 重试恢复。
        const entry = nextState.channels[action.channel];
        if (entry) entry.withdrawn = true;
      }
      logger.warn("cli-proxy mirror action failed", {
        action: action.kind,
        channel: action.channel,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (input.phase === "running") {
    for (const entry of Object.values(nextState.channels)) {
      if (entry.withdrawn || entry.hidden || entry.modelsSynced) continue;
      if (!modelSyncProviderIds.has(entry.providerId)) continue;
      try {
        await input.ports.syncModels(entry.providerId);
        entry.modelsSynced = true;
      } catch (error) {
        logger.warn("cli-proxy mirror model sync failed", {
          providerId: entry.providerId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await input.ports.refreshVisibleProviderCapabilities?.();
    } catch (error) {
      logger.warn("cli-proxy provider capability refresh failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { actions, nextState };
}

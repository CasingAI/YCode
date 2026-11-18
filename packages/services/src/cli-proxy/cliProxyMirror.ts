/**
 * CLI Proxy 凭据镜像：auth 目录 → provider 列表（账号粒度）。
 *
 * 产品规则（docs/specs/plugin-cli-proxy-binary.md「凭据镜像」，2026-10-14 用户拍板，
 * 2026-11-18 收敛为账号粒度）：auth 目录里有哪些支持渠道的凭据，provider 列表就全部
 * 显示出来，哪怕不是在软件里亲自添加的；一条凭据一条 provider，凭据消失对应卡片退场。
 *
 * 所有者与写入路径：凭据文件（代理 OAuth 落盘）是事实源；mirror-state.json 是镜像
 * 归属账本（accountKey → providerId，只记录镜像自己种下的条目）；provider 个人配置是
 * 唯一 UI 事实——种子、隐藏、恢复都是对它的普通写入（createPersonalProvider /
 * savePersonalProviderOverlay），不存在第二条写入路径。本模块是纯决策 + 注入端口的
 * 执行引擎，不直接触达 provider 服务，Host 负责把端口接到 IProviderSettingsService 上。
 *
 * 账号隔离：每条账号 provider 的模型 id 带该账号的前缀（`<prefix>/<model>`），请求经
 * 前缀命中唯一凭据后由代理剥离前缀转发上游（见 spec「账号前缀与模型路由」）。
 *
 * 事件顺序（无文件 watcher，不轮询）：
 *   Host 初始化 → 镜像(startup)：迁移旧渠道账本/种子/隐藏/恢复 → resumeIfEnabled 按需启动判定
 *   登录轮询到 ok / 代理转 running（边沿）→ 镜像(running)：写账号前缀、按账号补模型、
 *   刷新所有可见 CLI Proxy Provider 能力并拾取运行期新凭据
 */
/* eslint-disable max-lines -- 账号解析、账本、规划与执行同属镜像的单一决策单元，拆文件会制造第二份状态定义。 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CLI_PROXY_LOGIN_CHANNELS } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { CliProxyLayout } from "./cliProxyVersions.js";

const logger = createServiceLogger("cliProxyMirror");

/** 一个账号（凭据文件）的镜像身份。 */
export interface CliProxyCredentialAccount {
  /** 渠道（codex/claude/…），来自文件名首段。 */
  channel: string;
  /** 账本键：`<channel>:<accountHash 或规范化邮箱>`。 */
  accountKey: string;
  /** 凭据文件名（管理面 name 参数、auth 目录内读取都用它）。 */
  fileName: string;
  /** 账号标识：accountHash；旧式无 hash 文件名回退为规范化邮箱。 */
  accountId: string;
  /** 从文件名解析出的邮箱（无 `@` 时为 null）。 */
  email: string | null;
  /** 该账号的模型前缀（`[a-z0-9-]`，不含 `/`）。 */
  prefix: string;
}

const mirrorAccountStateSchema = z.object({
  providerId: z.string().min(1),
  seededAt: z.string().min(1),
  /** 凭据文件名；外部改名后按 accountKey 重新认领。 */
  credentialName: z.string().min(1),
  /** 已写入成功的账号前缀；缺失表示尚未写入。 */
  prefix: z.string().min(1).optional(),
  /** 凭据消失时我们写的隐藏态；凭据回来即恢复。 */
  hidden: z.boolean().optional(),
  /** 用户删掉了种子条目：永久放弃该账号的自动种子。 */
  withdrawn: z.boolean().optional(),
  /** 已完成过一次该账号的动态模型同步。 */
  modelsSynced: z.boolean().optional(),
});

/** 镜像归属账本（version 2）：一个账号一条记录。 */
export const cliProxyMirrorStateSchema = z.object({
  version: z.literal(2),
  accounts: z.record(z.string(), mirrorAccountStateSchema),
});

/** 旧版渠道级账本（version 1）；只读入用于迁移，不再写出。 */
const legacyMirrorStateSchema = z.object({
  version: z.literal(1),
  channels: z.record(
    z.string(),
    z.object({
      providerId: z.string().min(1),
      seededAt: z.string().min(1),
      hidden: z.boolean().optional(),
      withdrawn: z.boolean().optional(),
      modelsSynced: z.boolean().optional(),
    }),
  ),
});

export type CliProxyMirrorAccountState = z.infer<typeof mirrorAccountStateSchema>;
export type CliProxyMirrorChannelState = z.infer<
  typeof legacyMirrorStateSchema
>["channels"][string];

export interface CliProxyMirrorState {
  version: 2;
  accounts: Record<string, CliProxyMirrorAccountState>;
  /** v1 渠道级账本读入后保留，迁移完成即丢弃；不写回磁盘。 */
  legacyChannels?: Record<string, CliProxyMirrorChannelState>;
}

export function mirrorStateFile(layout: CliProxyLayout): string {
  return join(layout.root, "mirror-state.json");
}

export async function readCliProxyMirrorState(
  layout: CliProxyLayout,
): Promise<CliProxyMirrorState> {
  try {
    const raw: unknown = JSON.parse(await readFile(mirrorStateFile(layout), "utf8"));
    const current = cliProxyMirrorStateSchema.safeParse(raw);
    if (current.success) {
      return { version: 2, accounts: current.data.accounts };
    }
    const legacy = legacyMirrorStateSchema.safeParse(raw);
    if (legacy.success) {
      return { version: 2, accounts: {}, legacyChannels: legacy.data.channels };
    }
    return { version: 2, accounts: {} };
  } catch {
    // 缺文件/损坏按空状态重建（spec 定案：最坏情况是重新种子一次，可接受）。
    return { version: 2, accounts: {} };
  }
}

export async function writeCliProxyMirrorState(
  layout: CliProxyLayout,
  state: CliProxyMirrorState,
): Promise<void> {
  await mkdir(layout.root, { recursive: true });
  const file = mirrorStateFile(layout);
  // 只写当前结构；迁移期间的 legacyChannels 是内存态，成功认领/退役后自然消失。
  await writeFile(file, JSON.stringify({ version: 2, accounts: state.accounts }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(file, 0o600);
}

/** 文件名里的计划后缀（上游 `codex-<hash>-<email>[-<plan>].json`）。 */
const PLAN_SUFFIXES = new Set(["pro", "plus", "team", "business", "free", "go"]);

function normalizeAccountToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/**
 * 从单个凭据文件名解析账号身份（实测样本 `codex-77bf18ea-<email>-pro.json`）。
 * 结构：`<渠道>-<accountHash>-<email>[-<plan>].json`；无 hash 的旧式文件名为
 * `<渠道>-<email>[-<plan>].json`。渠道不认识 → null。
 */
export function resolveCliProxyCredentialAccount(
  fileName: string,
): CliProxyCredentialAccount | null {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".json") || lower.endsWith(".lock")) return null;
  const stem = fileName.slice(0, -".json".length);
  const segments = stem.split("-");
  const channel = segments[0]?.toLowerCase() ?? "";
  if (!(CLI_PROXY_LOGIN_CHANNELS as readonly string[]).includes(channel)) return null;
  let rest = segments.slice(1);
  let hash: string | null = null;
  if (rest.length > 1 && /^[0-9a-f]{6,}$/.test(rest[0]!.toLowerCase())) {
    hash = rest[0]!.toLowerCase();
    rest = rest.slice(1);
  }
  let emailPart = rest.join("-");
  const lastSegment = emailPart.split("-").at(-1)?.toLowerCase() ?? "";
  if (PLAN_SUFFIXES.has(lastSegment)) {
    emailPart = emailPart.slice(0, -(lastSegment.length + 1));
  }
  const email = emailPart.includes("@") ? emailPart : null;
  const accountId = hash ?? normalizeAccountToken(email ?? stem);
  if (!accountId) return null;
  return {
    channel,
    accountKey: `${channel}:${accountId}`,
    fileName,
    accountId,
    email,
    prefix: `${channel}-${accountId}`,
  };
}

/**
 * 解析 auth 目录全部凭据为账号列表：按文件名排序保证稳定；同一账号多份文件只保留
 * 第一份（一账号一条 provider）；前缀冲突（异常命名）追加短序号。
 */
export function resolveCliProxyCredentialAccounts(
  fileNames: readonly string[],
): CliProxyCredentialAccount[] {
  const seenKeys = new Set<string>();
  const usedPrefixes = new Set<string>();
  const accounts: CliProxyCredentialAccount[] = [];
  for (const fileName of [...fileNames].sort()) {
    const account = resolveCliProxyCredentialAccount(fileName);
    if (!account || seenKeys.has(account.accountKey)) continue;
    seenKeys.add(account.accountKey);
    let prefix = account.prefix;
    let suffix = 2;
    while (usedPrefixes.has(prefix)) prefix = `${account.prefix}-${suffix++}`;
    usedPrefixes.add(prefix);
    accounts.push({ ...account, prefix });
  }
  return accounts;
}

/** 向后兼容的渠道清单（Host 已改用 resolveCliProxyCredentialAccounts）。 */
export function resolveCliProxyCredentialChannels(fileNames: readonly string[]): string[] {
  const channels = new Set<string>();
  for (const account of resolveCliProxyCredentialAccounts(fileNames)) channels.add(account.channel);
  return [...channels];
}

/**
 * 按 providerId 反查镜像账号（额度读取、同步按钮用）：账本是 provider → 凭据的唯一绑定。
 */
export async function findCliProxyMirrorAccountForProvider(
  layout: CliProxyLayout,
  providerId: string,
): Promise<{
  accountKey: string;
  channel: string;
  credentialName: string;
  prefix: string;
} | null> {
  const state = await readCliProxyMirrorState(layout);
  for (const [accountKey, entry] of Object.entries(state.accounts)) {
    if (entry.providerId !== providerId) continue;
    const channel = accountKey.split(":")[0] ?? "";
    const prefix =
      entry.prefix ?? `${channel}-${normalizeAccountToken(accountKey.slice(channel.length + 1))}`;
    return { accountKey, channel, credentialName: entry.credentialName, prefix };
  }
  return null;
}

export type CliProxyMirrorAction =
  | {
      kind: "seed";
      channel: string;
      templateId: string;
      accountKey: string;
      providerName: string;
      credentialName: string;
    }
  | {
      kind: "adopt";
      channel: string;
      accountKey: string;
      providerId: string;
      credentialName: string;
    }
  | { kind: "hide"; channel: string; accountKey: string; providerId: string }
  | { kind: "unhide"; channel: string; accountKey: string; providerId: string }
  | { kind: "withdraw"; channel: string; accountKey: string; providerId: string }
  | { kind: "retire-legacy"; channel: string; providerId: string };

export interface CliProxyCredentialMirrorPlanInput {
  /** auth 目录观测到的账号（resolveCliProxyCredentialAccounts 的输出）。 */
  accounts: readonly CliProxyCredentialAccount[];
  /** 当前可用的 cliproxy 模板（渠道 → 模板 id 与展示名）；没有模板的渠道不参与镜像。 */
  channelTemplates: readonly { channel: string; templateId: string; name?: string }[];
  /** 可见 provider 投影（getView 已滤掉 visibility:hidden）。 */
  providers: readonly { providerId: string; templateId: string | null }[];
  state: CliProxyMirrorState;
}

function accountProviderName(
  templateName: string | undefined,
  account: CliProxyCredentialAccount,
): string {
  const base = templateName?.trim() || account.channel;
  const tag = account.email ?? account.accountId;
  return `${base} · ${tag}`;
}

/**
 * 纯规划：比对「账号凭据 × 镜像账本 × 可见 provider」得出动作，不做任何 IO。
 * hidden 与 deleted 无法从视图区分（视图已滤掉 hidden），全靠账本的 hidden 标记分辨。
 *
 * 旧渠道级账本（v1）迁移规则（spec「凭据镜像」）：
 * - 渠道恰有 1 个账号且无账号账本 → 复用旧卡片（providerId/卡片名保留）；
 * - 渠道多于 1 个账号或 0 个账号 → 旧卡片 hide 并退役，再按账号各自处理。
 */
export function resolveCliProxyCredentialMirrorPlan(
  input: CliProxyCredentialMirrorPlanInput,
): CliProxyMirrorAction[] {
  const actions: CliProxyMirrorAction[] = [];
  const providerIds = new Set(input.providers.map((provider) => provider.providerId));
  const legacyChannels = input.state.legacyChannels ?? {};
  for (const { channel, templateId, name } of input.channelTemplates) {
    const channelAccounts = input.accounts.filter((account) => account.channel === channel);
    const legacyEntry = legacyChannels[channel];
    const adoptableLegacy =
      legacyEntry !== undefined &&
      !legacyEntry.withdrawn &&
      channelAccounts.length === 1 &&
      input.state.accounts[channelAccounts[0]!.accountKey] === undefined &&
      providerIds.has(legacyEntry.providerId);
    if (adoptableLegacy) {
      actions.push({
        kind: "adopt",
        channel,
        accountKey: channelAccounts[0]!.accountKey,
        providerId: legacyEntry.providerId,
        credentialName: channelAccounts[0]!.fileName,
      });
      continue;
    }
    if (legacyEntry && !legacyEntry.withdrawn) {
      // 多账号/无账号：旧卡由镜像种下，隐藏不违背用户意图，之后按账号重建。
      actions.push({ kind: "retire-legacy", channel, providerId: legacyEntry.providerId });
    }
    for (const account of channelAccounts) {
      const entry = input.state.accounts[account.accountKey];
      if (!entry) {
        // 该账号无账本记录：种子（与手动卡片共存，手动卡片没有账号绑定）。
        actions.push({
          kind: "seed",
          channel,
          templateId,
          accountKey: account.accountKey,
          providerName: accountProviderName(name, account),
          credentialName: account.fileName,
        });
        continue;
      }
      if (entry.withdrawn) continue;
      if (entry.hidden) {
        // 我们藏的：凭据回来就恢复；执行失败（条目其实已被手删）由引擎转 withdrawn。
        actions.push({
          kind: "unhide",
          channel,
          accountKey: account.accountKey,
          providerId: entry.providerId,
        });
        continue;
      }
      if (!providerIds.has(entry.providerId)) {
        // 不在可见视图且不是我们藏的：用户删了 → 永久放弃该账号的自动种子。
        actions.push({
          kind: "withdraw",
          channel,
          accountKey: account.accountKey,
          providerId: entry.providerId,
        });
      }
      // 在岗且有凭据：不动（running 阶段补前缀/模型）。
    }
    // 账本里的账号凭据已从 auth 目录消失：可见则隐藏（凭据回来再恢复），
    // 不可见说明卡片已被手删 → 转 withdrawn 不再重试。账号不在本轮观测里，
    // 上面的循环遍历不到，必须按账本补扫。
    const observedKeys = new Set(channelAccounts.map((account) => account.accountKey));
    for (const [accountKey, entry] of Object.entries(input.state.accounts)) {
      if (accountKey.split(":")[0] !== channel) continue;
      if (observedKeys.has(accountKey) || entry.withdrawn || entry.hidden) continue;
      actions.push(
        providerIds.has(entry.providerId)
          ? { kind: "hide", channel, accountKey, providerId: entry.providerId }
          : { kind: "withdraw", channel, accountKey, providerId: entry.providerId },
      );
    }
  }
  return actions;
}

/** 镜像引擎的副作用端口：Host 注入 IProviderSettingsService 与运行中模型的读取。 */
export interface CliProxyCredentialMirrorPorts {
  createProviderFromTemplate(
    templateId: string,
    options?: { providerName?: string },
  ): Promise<{ providerId: string }>;
  saveProviderVisibility(providerId: string, visibility: "visible" | "hidden"): Promise<unknown>;
  /**
   * 幂等写入账号前缀：读取凭据文件当前值，一致则跳过；
   * 返回 changed 表示前缀是否变化（变化后必须重同步模型清单）。
   */
  ensureCredentialPrefix(credentialName: string, prefix: string): Promise<{ changed: boolean }>;
  syncModels(
    providerId: string,
    account?: { credentialName: string; prefix: string },
  ): Promise<void>;
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
 * running 阶段写账号前缀并按账号同步模型：startup 时代理还没起，管理面/数据面都拿不到。
 */
export async function runCliProxyCredentialMirror(
  input: CliProxyCredentialMirrorInput,
): Promise<CliProxyCredentialMirrorResult> {
  const actions = resolveCliProxyCredentialMirrorPlan(input);
  const nextState: CliProxyMirrorState = {
    version: 2,
    accounts: Object.fromEntries(
      Object.entries(input.state.accounts).map(([accountKey, entry]) => [accountKey, { ...entry }]),
    ),
    ...(input.state.legacyChannels
      ? {
          legacyChannels: Object.fromEntries(
            Object.entries(input.state.legacyChannels).map(([channel, entry]) => [
              channel,
              { ...entry },
            ]),
          ),
        }
      : {}),
  };
  const now = input.now ?? (() => new Date());
  const accountsByKey = new Map(input.accounts.map((account) => [account.accountKey, account]));
  // 允许本轮补模型的 provider：镜像前就可见的 + 本次种子/认领/恢复的（视图快照落后于本 run 的写入）。
  const modelSyncProviderIds = new Set(input.providers.map((provider) => provider.providerId));
  for (const action of actions) {
    try {
      switch (action.kind) {
        case "seed": {
          const { providerId } = await input.ports.createProviderFromTemplate(action.templateId, {
            providerName: action.providerName,
          });
          nextState.accounts[action.accountKey] = {
            providerId,
            seededAt: now().toISOString(),
            credentialName: action.credentialName,
          };
          modelSyncProviderIds.add(providerId);
          break;
        }
        case "adopt": {
          nextState.accounts[action.accountKey] = {
            providerId: action.providerId,
            seededAt: now().toISOString(),
            credentialName: action.credentialName,
          };
          modelSyncProviderIds.add(action.providerId);
          // 认领后旧渠道键必须丢弃；否则下一轮会把这刚认领的卡片当成旧卡退役。
          if (nextState.legacyChannels) delete nextState.legacyChannels[action.channel];
          break;
        }
        case "hide": {
          await input.ports.saveProviderVisibility(action.providerId, "hidden");
          const entry = nextState.accounts[action.accountKey];
          if (entry) entry.hidden = true;
          break;
        }
        case "unhide": {
          await input.ports.saveProviderVisibility(action.providerId, "visible");
          const entry = nextState.accounts[action.accountKey];
          if (entry) {
            delete entry.hidden;
            modelSyncProviderIds.add(action.providerId);
          }
          break;
        }
        case "withdraw": {
          const entry = nextState.accounts[action.accountKey];
          if (entry) entry.withdrawn = true;
          break;
        }
        case "retire-legacy": {
          await input.ports.saveProviderVisibility(action.providerId, "hidden");
          if (nextState.legacyChannels) delete nextState.legacyChannels[action.channel];
          break;
        }
      }
    } catch (error) {
      if (action.kind === "unhide") {
        // 恢复失败 = 条目其实已不在（隐藏期间被手删）：转 withdrawn 永久放弃，
        // 否则每次启动都会对同一个不存在的 id 重试恢复。
        const entry = nextState.accounts[action.accountKey];
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
    for (const [accountKey, entry] of Object.entries(nextState.accounts)) {
      if (entry.withdrawn || entry.hidden) continue;
      if (!modelSyncProviderIds.has(entry.providerId)) continue;
      const account = accountsByKey.get(accountKey);
      if (!account) continue;
      try {
        const { changed } = await input.ports.ensureCredentialPrefix(
          account.fileName,
          account.prefix,
        );
        entry.credentialName = account.fileName;
        entry.prefix = account.prefix;
        if (changed) delete entry.modelsSynced;
        if (entry.modelsSynced) continue;
        await input.ports.syncModels(entry.providerId, {
          credentialName: account.fileName,
          prefix: account.prefix,
        });
        entry.modelsSynced = true;
      } catch (error) {
        logger.warn("cli-proxy mirror account sync failed", {
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

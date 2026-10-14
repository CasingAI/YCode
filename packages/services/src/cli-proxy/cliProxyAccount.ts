/**
 * CLI Proxy 账号面：OAuth 登录单步、管理面 credentials、数据面 /v1/models。
 *
 * 状态所有者仍是 CliProxyService（端口/key 同源）；本模块只放与运行态无关的
 * 纯 HTTP 封装：调用方先保证代理 running（stopped 时直接返回 proxy-stopped，
 * 不拉起——按需启动的判定只走 provider 配置）。
 * OAuth 落盘即被代理热加载（file watcher + CONFIG RELOAD 实测），我方不写 config。
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseCliProxyQuotaSignals,
  type CliProxyLoginChannel,
  type CliProxyModelsSnapshot,
  type CliProxyQuotaSnapshot,
  type CliProxyQuotaWindow,
} from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  readKeyFileIfExists,
  resolveCliProxyLayout,
  type CliProxyLayout,
} from "./cliProxyVersions.js";

const logger = createServiceLogger("cliProxyAccount");

const REQUEST_TIMEOUT_MS = 20_000;

export interface CliProxyAccountContext {
  layout?: CliProxyLayout;
  /** 当前运行端口（CliProxyService 快照）；null 表示未启动。 */
  port: number | null;
  fetchImpl?: typeof fetch;
}

interface ManagementCredentialsFile {
  id?: unknown;
  account?: unknown;
  email?: unknown;
  label?: unknown;
  provider?: unknown;
  quota?: { observed_at?: unknown; signals?: unknown };
  model_quotas?: unknown;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function managementHeaders(layout: CliProxyLayout): Promise<Record<string, string> | null> {
  const key = await readKeyFileIfExists(layout.managementKeyFile);
  if (!key) return null;
  return { Authorization: `Bearer ${key}` };
}

async function dataHeaders(layout: CliProxyLayout): Promise<Record<string, string> | null> {
  const key = await readKeyFileIfExists(layout.dataKeyFile);
  if (!key) return null;
  return { Authorization: `Bearer ${key}` };
}

/**
 * 取授权 URL 与 state（浏览器授权第一步）。
 * 必须带 is_webui=true：代理只在此时才为本次登录起该渠道专属端口的回调转发器
 *（源码 internal/api/handlers/management/auth_files_provider_oauth.go 的 isWebUIRequest →
 * startCallbackForwarder(channelCallbackPort)；codex=1455、claude=54545）。
 * 不带该参数时没有进程监听回调端口，浏览器回跳必然 ERR_CONNECTION_REFUSED
 *（codex 真机复现 2026-10-14，OpenAI 侧表现为 invalid_auth_step）。
 */
export async function getCliProxyAuthUrl(
  context: CliProxyAccountContext,
  channel: CliProxyLoginChannel,
): Promise<{
  url: string;
  state: string;
  fallbackHint: string | null;
}> {
  const layout = context.layout ?? resolveCliProxyLayout();
  if (context.port === null) throw new Error("proxy-stopped");
  const headers = await managementHeaders(layout);
  if (!headers) throw new Error("management-key-missing");
  // 必须带 is_webui=true：代理只在此时才为本次登录起 1455 回调转发器
  //（源码 internal/api/handlers/management/auth_files_provider_oauth.go 的 isWebUIRequest →
  // startCallbackForwarder(codexCallbackPort)）。redirect_uri 在二进制里写死
  // http://localhost:1455/auth/callback，而不带该参数时没有进程监听 1455，浏览器回跳
  // 必然 ERR_CONNECTION_REFUSED，OpenAI 侧表现为 invalid_auth_step（真机复现 2026-10-14）。
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${context.port}/v8/management/oauth/auth-url?provider=${channel}&is_webui=true`,
    { headers },
    context.fetchImpl,
  );
  if (!response.ok) throw new Error(`auth-url 失败：HTTP ${response.status}`);
  const body = (await response.json()) as { url?: unknown; state?: unknown };
  const url = typeof body.url === "string" ? body.url : "";
  const state = typeof body.state === "string" ? body.state : "";
  if (!url || !state) throw new Error("auth-url 返回缺 url/state");
  // 回调端口 1455 被占时转发器未必报错（实测仍返回 200），降级提示留在轮询超时后给出。
  return { url, state, fallbackHint: null };
}

/** 轮询授权状态：wait → 继续；ok/success → 完成；error → 失败。 */
export async function pollCliProxyAuthStatus(
  context: CliProxyAccountContext,
  state: string,
): Promise<"wait" | "ok"> {
  const layout = context.layout ?? resolveCliProxyLayout();
  if (context.port === null) throw new Error("proxy-stopped");
  const headers = await managementHeaders(layout);
  if (!headers) throw new Error("management-key-missing");
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${context.port}/v8/management/oauth/status?state=${encodeURIComponent(state)}`,
    { headers },
    context.fetchImpl,
  );
  if (!response.ok) throw new Error(`status 失败：HTTP ${response.status}`);
  const body = (await response.json()) as { status?: unknown };
  const status = typeof body.status === "string" ? body.status.toLowerCase() : "";
  if (status === "ok" || status === "success" || status === "authorized" || status === "done")
    return "ok";
  if (status === "error" || status === "failed" || status === "expired")
    throw new Error(`授权失败：${status}`);
  return "wait";
}

/** 提交回调（浏览器回跳带回 code 时由 UI 转交；多数实现轮询即完成，此步可选）。 */
export async function submitCliProxyAuthCallback(
  context: CliProxyAccountContext,
  channel: CliProxyLoginChannel,
  payload: Record<string, string>,
): Promise<void> {
  const layout = context.layout ?? resolveCliProxyLayout();
  if (context.port === null) throw new Error("proxy-stopped");
  const headers = await managementHeaders(layout);
  if (!headers) throw new Error("management-key-missing");
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${context.port}/v8/management/oauth/callback`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, provider: channel }),
    },
    context.fetchImpl,
  );
  if (!response.ok) throw new Error(`callback 失败：HTTP ${response.status}`);
}

/**
 * 模型清单动态拉取：数据面 `GET /v1/models` + 缓存 + 失败回退。
 * 全仓无先例、属新写。lastGood 只在内存（进程重启即丢，按"重启即不可信"处理）。
 */
const modelsCache = new Map<string, { ids: string[]; fetchedAt: number }>();

export async function fetchCliProxyModels(
  context: CliProxyAccountContext,
  cacheKey = "default",
): Promise<CliProxyModelsSnapshot> {
  const layout = context.layout ?? resolveCliProxyLayout();
  const previous = modelsCache.get(cacheKey);
  if (context.port === null) {
    return {
      models: (previous?.ids ?? []).map((id) => ({ id })),
      fetchedAt: previous?.fetchedAt ?? Date.now(),
      stale: true,
      error: "proxy-stopped",
    };
  }
  const headers = await dataHeaders(layout);
  if (!headers) {
    return {
      models: (previous?.ids ?? []).map((id) => ({ id })),
      fetchedAt: previous?.fetchedAt ?? Date.now(),
      stale: true,
      error: "data-key-missing",
    };
  }
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${context.port}/v1/models`,
      { headers },
      context.fetchImpl,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: unknown };
    const ids = Array.isArray(body.data)
      ? body.data
          .map((entry) => (entry as { id?: unknown }).id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    modelsCache.set(cacheKey, { ids, fetchedAt: Date.now() });
    return { models: ids.map((id) => ({ id })), fetchedAt: Date.now(), stale: false, error: null };
  } catch (error) {
    logger.warn("cli-proxy models fetch failed, falling back to cache", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      models: (previous?.ids ?? []).map((id) => ({ id })),
      fetchedAt: previous?.fetchedAt ?? Date.now(),
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 额度"最后一次观测"的本地缓存（docs/specs/plugin-cli-proxy-binary.md「额度」）。
 *
 * 上游观测只存在代理进程内存里，代理重启即清空——而 UI 承诺的是"最后一次观测值"，
 * 打开软件就要能看到，不能要求用户先发一次请求。因此 Host 在每次成功读取到窗口时
 * 把合并后的快照落盘（0600），之后的读取在 live 无窗口（代理未启动/重启后无观测/失败）
 * 时回落到这份缓存：observedAt 是旧值，界面按"N 小时前观测"如实呈现。
 */
export interface CliProxyQuotaCacheEntry {
  windows: CliProxyQuotaWindow[];
  planType: string | null;
  observedAt: string | null;
  savedAt: number;
}

function quotaCacheFile(layout: CliProxyLayout): string {
  return join(layout.root, "quota-snapshot.json");
}

async function writeCliProxyQuotaCache(
  layout: CliProxyLayout,
  channel: CliProxyLoginChannel,
  entry: CliProxyQuotaCacheEntry,
): Promise<void> {
  try {
    const file = quotaCacheFile(layout);
    let body: { version: number; channels: Record<string, CliProxyQuotaCacheEntry> } = {
      version: 1,
      channels: {},
    };
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as typeof body;
      if (parsed && typeof parsed === "object" && parsed.channels && typeof parsed.channels === "object") {
        body = parsed;
      }
    } catch {
      // 缺文件/损坏：整份重建。
    }
    body.channels[channel] = entry;
    await writeFile(file, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  } catch (error) {
    // 缓存写失败不影响本次额度返回，只记日志。
    logger.warn("cli-proxy quota cache write failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readCliProxyQuotaCache(
  layout: CliProxyLayout,
  channel: CliProxyLoginChannel,
): Promise<CliProxyQuotaCacheEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(quotaCacheFile(layout), "utf8")) as {
      channels?: Record<string, CliProxyQuotaCacheEntry | undefined>;
    };
    const entry = parsed.channels?.[channel];
    if (!entry || !Array.isArray(entry.windows)) return null;
    return entry;
  } catch {
    return null;
  }
}

/** 额度读取：credentials 全量条目里找该渠道的凭据（按 provider 字段），解析 quota.signals。 */
export async function fetchCliProxyQuota(
  context: CliProxyAccountContext,
  providerId: string,
  channel: CliProxyLoginChannel,
): Promise<CliProxyQuotaSnapshot> {
  const layout = context.layout ?? resolveCliProxyLayout();
  const base = { providerId, fetchedAt: Date.now(), observedAt: null as string | null };
  // live 无窗口时回落"最后一次观测"缓存（打开软件立刻可见，无需先发请求）。
  const fallbackToCache = async (
    error: CliProxyQuotaSnapshot["error"],
    errorMessage: string | null,
  ): Promise<CliProxyQuotaSnapshot> => {
    const cached = await readCliProxyQuotaCache(layout, channel);
    if (cached && cached.windows.length > 0) {
      return {
        providerId,
        fetchedAt: Date.now(),
        observedAt: cached.observedAt,
        windows: cached.windows,
        planType: cached.planType,
        error: null,
        errorMessage: null,
      };
    }
    return { ...base, windows: [], planType: null, error, errorMessage };
  };
  if (context.port === null)
    return fallbackToCache("proxy-stopped", null);
  const headers = await managementHeaders(layout);
  if (!headers)
    return fallbackToCache("unavailable", "管理面 key 缺失");
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${context.port}/v8/management/credentials`,
      { headers },
      context.fetchImpl,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { files?: unknown };
    const files: ManagementCredentialsFile[] = Array.isArray(body.files)
      ? (body.files as ManagementCredentialsFile[])
      : [];
    // 一账号一条 provider：按渠道取全部凭据；多账号时窗口合并展示。
    // 非 codex 渠道的 signals 目前为空（观测解析尚未适配）→ 落 no-observation 降级。
    const channelFiles = files.filter((file) => String(file.provider ?? "") === channel);
    if (channelFiles.length === 0)
      return fallbackToCache("not-logged-in", null);
    const windows = [];
    let planType: string | null = null;
    let observedAt: string | null = null;
    for (const file of channelFiles) {
      const quota = file.quota;
      const rawObserved =
        quota && typeof quota.observed_at === "string" ? quota.observed_at : null;
      // model_quotas 可能整个字段缺席：按可选处理，只读顶层 quota.signals。
      const signals =
        quota && quota.signals && typeof quota.signals === "object"
          ? (quota.signals as Record<string, unknown>)
          : null;
      const parsed = parseCliProxyQuotaSignals(signals, rawObserved);
      if (parsed.planType && !planType) planType = parsed.planType;
      if (rawObserved && (!observedAt || rawObserved > observedAt)) observedAt = rawObserved;
      windows.push(...parsed.windows);
    }
    if (windows.length === 0)
      return fallbackToCache("no-observation", null);
    // 成功观测即落盘为"最后一次观测"：代理重启清内存后，这里就是打开软件时的初始展示值。
    await writeCliProxyQuotaCache(layout, channel, {
      windows,
      planType,
      observedAt,
      savedAt: Date.now(),
    });
    return { ...base, observedAt, windows, planType, error: null, errorMessage: null };
  } catch (error) {
    logger.warn("cli-proxy quota fetch failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return fallbackToCache(
      "unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** 读代理 auth 目录确认账号是否已登录（凭据文件名含账号标识）。 */
export async function listCliProxyAuthFiles(authDir?: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = authDir ?? resolveCliProxyLayout().authDir;
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".json") && !name.endsWith(".lock"));
  } catch {
    return [];
  }
}

export async function readCliProxyConfigPort(layout?: CliProxyLayout): Promise<number | null> {
  const resolved = layout ?? resolveCliProxyLayout();
  try {
    const raw = await readFile(resolved.configFile, "utf8");
    const match = raw.match(/port:\s*(\d{2,5})/);
    return match?.[1] ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

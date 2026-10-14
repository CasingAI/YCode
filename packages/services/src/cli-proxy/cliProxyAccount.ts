/**
 * CLI Proxy 账号面：OAuth 登录单步、管理面 credentials、数据面 /v1/models。
 *
 * 状态所有者仍是 CliProxyService（端口/key 同源）；本模块只放与运行态无关的
 * 纯 HTTP 封装：调用方先保证代理 running（stopped 时直接返回 proxy-stopped，
 * 不拉起——按需启动的判定只走 provider 配置）。
 * OAuth 落盘即被代理热加载（file watcher + CONFIG RELOAD 实测），我方不写 config。
 */
import { readFile } from "node:fs/promises";
import {
  parseCliProxyQuotaSignals,
  type CliProxyModelsSnapshot,
  type CliProxyQuotaSnapshot,
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

/** 取授权 URL 与 state（浏览器授权第一步）。 */
export async function getCliProxyCodexAuthUrl(context: CliProxyAccountContext): Promise<{
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
    `http://127.0.0.1:${context.port}/v8/management/oauth/auth-url?provider=codex&is_webui=true`,
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
export async function pollCliProxyCodexAuthStatus(
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
export async function submitCliProxyCodexAuthCallback(
  context: CliProxyAccountContext,
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
      body: JSON.stringify(payload),
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

/** 额度读取：credentials 全量条目里找 codex 账号（按 provider 字段），解析 quota.signals。 */
export async function fetchCliProxyQuota(
  context: CliProxyAccountContext,
  providerId: string,
): Promise<CliProxyQuotaSnapshot> {
  const layout = context.layout ?? resolveCliProxyLayout();
  const base = { providerId, fetchedAt: Date.now(), observedAt: null as string | null };
  if (context.port === null)
    return { ...base, windows: [], planType: null, error: "proxy-stopped", errorMessage: null };
  const headers = await managementHeaders(layout);
  if (!headers)
    return { ...base, windows: [], planType: null, error: "unavailable", errorMessage: "管理面 key 缺失" };
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
    // 一账号一条 provider：按 provider=codex 取全部 codex 凭据；多账号时窗口合并展示。
    const codexFiles = files.filter((file) => String(file.provider ?? "") === "codex");
    if (codexFiles.length === 0)
      return { ...base, windows: [], planType: null, error: "not-logged-in", errorMessage: null };
    const windows = [];
    let planType: string | null = null;
    let observedAt: string | null = null;
    for (const file of codexFiles) {
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
      return { ...base, observedAt, windows: [], planType, error: "no-observation", errorMessage: null };
    return { ...base, observedAt, windows, planType, error: null, errorMessage: null };
  } catch (error) {
    logger.warn("cli-proxy quota fetch failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      ...base,
      windows: [],
      planType: null,
      error: "unavailable",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 读代理 auth 目录确认账号是否已登录（凭据文件名含账号标识）。 */
export async function listCliProxyAuthFiles(authDir?: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const dir = authDir ?? `${homedir()}/.cli-proxy-api`;
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

/**
 * OpenCode Go 套餐用量的解析纯函数。
 *
 * 数据有两种形态（字段结构一致，均为 `keyUsage:` 锚点 + 对象字面量）：
 * 1. server-fn 端点（`GET /_server?id=...&args=...`，带 Cookie）返回的纯 JS：
 *      rollingUsage: $R[2] = {
 *          status: "ok",
 *          resetInSec: 10785,
 *          usagePercent: 5.8, ...
 *      }
 *    三窗口齐整、形态稳定，是主数据源。
 * 2. Go 页面（/workspace/{id}/go）HTML 内嵌 store state（SSR flight payload）：
 *      rollingUsage:$R[34]={status:"ok",resetInSec:10194,usagePercent:5.8,...}
 *    内嵌形态随渲染批次漂移、窗口可能缺失，仅作回退。
 * 两种形态统一按窗口 key 定位锚点后提取平衡 `{...}` 片段，逐字段抓取；
 * `usagePercent` 与 `resetInSec` 存在两种字段顺序，不做依赖字段顺序的整体大正则。
 */
import type { OpenCodeUsageWindow, OpenCodeUsageWindowKey } from "@zcode/shared";

const USAGE_WINDOW_KEYS: readonly OpenCodeUsageWindowKey[] = ["rolling", "weekly", "monthly"];
// 病态输入防御：单个窗口对象片段不应超过 8 KiB。
const MAX_BODY_LENGTH = 8_192;

/**
 * 取 from 之后第一个平衡 `{ ... }` 片段（跳过字符串字面量内的花括号）。
 * 不用「第一个 `}`」截断：对象未来出现嵌套字段时会截半截。
 */
function extractBalancedObject(text: string, from: number): string | null {
  const open = text.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(text.length, open + MAX_BODY_LENGTH);
  for (let i = open; i < end; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function parseNumberField(body: string, field: string): number | null {
  const match = new RegExp(`${field}:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseStringField(body: string, field: string): string | null {
  const match = new RegExp(`${field}:\\s*"([^"]*)"`).exec(body);
  return match?.[1] ?? null;
}

/**
 * 解析三窗口用量。文本里一个窗口都解析不到时返回 null
 * （视为数据源结构变化，调用方按 unavailable 处理，禁止当 0% 展示）。
 * 单个窗口缺 usagePercent 时跳过该窗口（页面确实没给数据，不编造数值）。
 */
export function parseOpencodeUsageText(
  text: string,
  nowMs: number = Date.now(),
): OpenCodeUsageWindow[] | null {
  const windows: OpenCodeUsageWindow[] = [];
  for (const key of USAGE_WINDOW_KEYS) {
    const anchor = text.indexOf(`${key}Usage:`);
    if (anchor < 0) continue;
    const body = extractBalancedObject(text, anchor + `${key}Usage:`.length);
    if (!body) continue;
    const usagePercent = parseNumberField(body, "usagePercent");
    if (usagePercent === null) continue;
    const resetInSec = parseNumberField(body, "resetInSec");
    windows.push({
      key,
      status: parseStringField(body, "status") ?? "ok",
      usagePercent,
      usage: parseNumberField(body, "usage"),
      limit: parseNumberField(body, "limit"),
      resetInSec,
      resetAt: resetInSec !== null ? new Date(nowMs + resetInSec * 1000).toISOString() : null,
    });
  }
  return windows.length > 0 ? windows : null;
}

/**
 * 归一化用户粘贴的 Cookie：接受裸值 / `auth=xxx` / 整段 `Cookie:` 请求头，
 * 统一输出 `auth=<value>`。无法提取时返回空字符串。
 */
export function buildOpencodeAuthCookieHeader(raw: string): string {
  let cookie = raw.trim();
  if (cookie.toLowerCase().startsWith("cookie:")) {
    cookie = cookie.slice(7).trim();
  }
  if (!cookie) return "";
  for (const part of cookie.split(";")) {
    const segment = part.trim();
    if (segment.toLowerCase().startsWith("auth=")) {
      return segment;
    }
  }
  return `auth=${cookie}`;
}

/** 从裸 ID / 页面链接等文本里提取 `wrk_xxx`；提取不到返回空字符串。 */
export function normalizeOpencodeWorkspaceId(raw: string): string {
  const match = /wrk_[A-Za-z0-9]+/.exec(raw.trim());
  return match ? match[0] : "";
}

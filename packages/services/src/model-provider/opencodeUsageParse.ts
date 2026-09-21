/**
 * OpenCode Go 套餐用量的解析纯函数。
 *
 * 唯一数据来源：workspace 的 Go 用量页面 `GET /workspace/<workspaceId>/go`（认 workspace
 * 会话 `auth`）。页面把整块账号状态内联在 HTML 里，用的是 **seroval** 序列化：Go 套餐的
 * 三个窗口长这样
 *
 *   rollingUsage:$R[34]={status:"ok",resetInSec:7384,usagePercent:29.2,usage:350725236,limit:1200000000}
 *   weeklyUsage:$R[35]={…}   monthlyUsage:$R[36]={…}
 *
 * 每个对象只内联一次，之后同一对象再次出现时退化成纯引用 `$R[n]`。
 *
 * 历史实现是「找 `monthlyUsage:` 首次出现 → 取其后第一个 `{…}` → 要求含 usagePercent」，
 * 会静默丢窗口，「月额度时而显示、时而不显示」就是它造成的。真正的原因是**重名键**：
 * 同一页面里还有账号套餐对象
 *
 *   {$R[n]={monthlyUsage:null,timeMonthlyUsageUpdated:null,reloadError:null,…}}
 *
 * 也带 `monthlyUsage` 键。当它先被序列化时，锚点后面跟的不是用量对象，首次匹配落空，
 * 月度窗口被丢掉；`rollingUsage` / `weeklyUsage` 没有这种重名双胞胎，所以只有月度会闪。
 *
 * 现在的做法不依赖首次匹配，也不依赖序列化顺序：
 * 1. 扫出全部 `$R[n]=<字面量>` 定义，按需展开引用（带缓存）；
 * 2. 对每个窗口名检查**所有**出现位置，逐个把值解出来（引用按表展开），只接受
 *    「确实是含 usagePercent 的对象」的那一次；`null` 之类的干扰项记进结果里备查。
 *
 * 唯一「页面相关」的部分是取字面量：这里自带一个只认 seroval 用到的 JS 字面量子集的
 * 小解析器（对象/数组/字符串/数字/`!0`/`!1`/null/`$R[n]`），靠递归下降而不是正则，
 * 因此字符串里的花括号、嵌套对象、动态序号都不会误判。
 */
import type { OpenCodeUsageWindow, OpenCodeUsageWindowKey } from "@zcode/shared";

const BARE_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 归一化用户粘贴的凭据：接受原始 token（`Fe26.2**…`）/ 单个 `auth=xxx` /
 * 多对 `a=b; c=d` / 完整 `Cookie:` 头。
 *
 * 不去按 cookie 名白名单过滤：opencode.ai 的会话 cookie 名会变，按名字过滤会把真正
 * 管用的那个悄悄丢掉，表现为「凭据看起来没问题但一律被拒」。用户是从浏览器复制的整段
 * Cookie，原样回传给同一站点即可。
 * 提取不到任何 `name=value` 且不像 token 时返回空串（调用方按「凭据无效」提示，
 * 不发送畸形请求）。
 */
export function normalizeOpencodeCookieHeader(raw: string): string {
  let input = raw.trim();
  if (input.toLowerCase().startsWith("cookie:")) {
    input = input.slice(7).trim();
  }
  if (!input) return "";

  const pairs: string[] = [];
  for (const segment of input.split(";")) {
    const part = segment.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    pairs.push(`${name}=${value}`);
  }
  if (pairs.length > 0) return pairs.join("; ");

  // 裸 token：只包装形态可辨识的值（Iron Session 密封串或结构化 token），
  // 其余原样拒绝，避免把明显不合法的内容当 auth 发出去。
  if (input.startsWith("Fe26.2**") || BARE_TOKEN_PATTERN.test(input)) {
    return `auth=${input}`;
  }
  return "";
}

/** 从裸 ID / 页面链接等文本里提取 `wrk_xxx`；提取不到返回空字符串。 */
export function normalizeOpencodeWorkspaceId(raw: string): string {
  const match = /wrk_[A-Za-z0-9]+/.exec(raw.trim());
  return match ? match[0] : "";
}

/** 窗口名与序列化字段名的对应关系。 */
const WINDOW_FIELDS = [
  { field: "rollingUsage", key: "rolling" },
  { field: "weeklyUsage", key: "weekly" },
  { field: "monthlyUsage", key: "monthly" },
] as const satisfies ReadonlyArray<{ field: string; key: OpenCodeUsageWindowKey }>;

/** 窗口取法，进日志用：inline=字面量直接内联，reference=靠 `$R[n]` 展开，absent=页面上没有。 */
export type OpenCodeUsageWindowSource = "inline" | "reference" | "absent";

export interface OpenCodeUsagePageParseResult {
  windows: OpenCodeUsageWindow[];
  sources: Record<OpenCodeUsageWindowKey, OpenCodeUsageWindowSource>;
  /**
   * 被跳过的干扰项描述（如 `monthlyUsage:null`）。页面里同名的账号套餐字段会先出现，
   * 有了这个字段，将来再出问题一眼能看出是不是干扰项顺序变了。
   */
  ignored: string[];
}

/* ------------------------------ 序列化载荷读取 ------------------------------ */

class SerovalRef {
  constructor(readonly index: number) {}
}

type SerovalValue =
  | string
  | number
  | boolean
  | null
  | SerovalRef
  | SerovalValue[]
  | { [key: string]: SerovalValue };

interface ParseStep {
  value: SerovalValue;
  next: number;
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipWhitespace(src: string, from: number): number {
  let i = from;
  while (i < src.length && WHITESPACE.has(src[i]!)) i += 1;
  return i;
}

/** 读取一个带引号的字符串（seroval 里键与值都用 `"`，兼容 `'`）。 */
function parseQuoted(src: string, from: number): ParseStep | null {
  const quote = src[from];
  if (quote !== '"' && quote !== "'") return null;
  let i = from + 1;
  let out = "";
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      const escaped = src[i + 1];
      if (escaped === undefined) return null;
      out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, next: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

function parseBareToken(src: string, from: number): ParseStep | null {
  const rest = src.slice(from);
  const match = /^-?[0-9][0-9_]*(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
  if (match) {
    const raw = match[0].replace(/_/g, "");
    return { value: Number(raw), next: from + match[0].length };
  }
  if (rest.startsWith("!0")) return { value: true, next: from + 2 };
  if (rest.startsWith("!1")) return { value: false, next: from + 2 };
  if (rest.startsWith("null")) return { value: null, next: from + 4 };
  if (rest.startsWith("true")) return { value: true, next: from + 4 };
  if (rest.startsWith("false")) return { value: false, next: from + 5 };
  return null;
}

/** `$R[12]` 形式的对象引用。 */
function parseRef(src: string, from: number): ParseStep | null {
  if (!src.startsWith("$R[", from)) return null;
  const close = src.indexOf("]", from + 3);
  if (close === -1) return null;
  const index = Number(src.slice(from + 3, close));
  if (!Number.isInteger(index) || index < 0) return null;
  return { value: new SerovalRef(index), next: close + 1 };
}

/**
 * 解析一个 seroval 值。遇到本子集之外的结构（`new Date(...)`、`Promise` 等）返回 null，
 * 调用方跳过该候选位置继续往后找——我们只关心用量窗口那几个平面字段。
 */
function parseValue(src: string, from: number): ParseStep | null {
  const i = skipWhitespace(src, from);
  const ch = src[i];
  if (ch === undefined) return null;
  if (ch === '"' || ch === "'") return parseQuoted(src, i);
  if (ch === "$") return parseRef(src, i);
  if (ch === "{") return parseObject(src, i);
  if (ch === "[") return parseArray(src, i);
  return parseBareToken(src, i);
}

function parseObject(src: string, from: number): ParseStep | null {
  const result: { [key: string]: SerovalValue } = {};
  let i = skipWhitespace(src, from + 1);
  if (src[i] === "}") return { value: result, next: i + 1 };
  while (i < src.length) {
    let key: string;
    if (src[i] === '"' || src[i] === "'") {
      const parsedKey = parseQuoted(src, i);
      if (!parsedKey) return null;
      key = String(parsedKey.value);
      i = parsedKey.next;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      if (!match) return null;
      key = match[0];
      i += match[0].length;
    }
    i = skipWhitespace(src, i);
    if (src[i] !== ":") return null;
    const parsedValue = parseValue(src, i + 1);
    if (!parsedValue) return null;
    result[key] = parsedValue.value;
    i = skipWhitespace(src, parsedValue.next);
    if (src[i] === ",") {
      i = skipWhitespace(src, i + 1);
      if (src[i] === "}") return { value: result, next: i + 1 };
      continue;
    }
    if (src[i] === "}") return { value: result, next: i + 1 };
    return null;
  }
  return null;
}

function parseArray(src: string, from: number): ParseStep | null {
  const result: SerovalValue[] = [];
  let i = skipWhitespace(src, from + 1);
  if (src[i] === "]") return { value: result, next: i + 1 };
  while (i < src.length) {
    const parsedValue = parseValue(src, i);
    if (!parsedValue) return null;
    result.push(parsedValue.value);
    i = skipWhitespace(src, parsedValue.next);
    if (src[i] === ",") {
      i = skipWhitespace(src, i + 1);
      if (src[i] === "]") return { value: result, next: i + 1 };
      continue;
    }
    if (src[i] === "]") return { value: result, next: i + 1 };
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, SerovalValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 引用表：`$R[n]=<字面量>` 在页面里只内联一次，其余位置是 `$R[n]`。
 * 按需解析并缓存；找不到定义时返回 null（调用方当作解析不到）。
 */
function createRefResolver(src: string): (index: number) => SerovalValue | null {
  const cache = new Map<number, SerovalValue | null>();
  return (index: number): SerovalValue | null => {
    if (cache.has(index)) return cache.get(index) ?? null;
    const needle = `$R[${index}]=`;
    let from = 0;
    let resolved: SerovalValue | null = null;
    while (resolved === null) {
      const at = src.indexOf(needle, from);
      if (at === -1) break;
      const parsed = parseValue(src, at + needle.length);
      if (parsed) resolved = parsed.value;
      else from = at + needle.length;
    }
    cache.set(index, resolved);
    return resolved;
  };
}

/** 位置 `at` 的 `name:` 是否是独立键（前一个字符不能是标识符/引号的一部分）。 */
function isKeyBoundary(src: string, at: number): boolean {
  if (at === 0) return true;
  return !/[A-Za-z0-9_$."]/.test(src[at - 1]!);
}

/** 在整段载荷里找出真正承载用量的那个对象（跳过 null 之类的干扰项）。 */
function findUsageObject(
  src: string,
  field: string,
  resolve: (index: number) => SerovalValue | null,
  ignored: string[],
): { value: Record<string, SerovalValue>; source: "inline" | "reference" } | null {
  // 键可能带引号（`"monthlyUsage":`），两种形态都扫。
  for (const needle of [`${field}:`, `"${field}":`, `'${field}':`]) {
    let from = 0;
    while (true) {
      const at = src.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      if (!isKeyBoundary(src, at)) continue;
      const parsed = parseValue(src, from);
      if (!parsed) continue;
      const raw = parsed.value;
      const value = raw instanceof SerovalRef ? resolve(raw.index) : raw;
      if (isRecord(value) && Number.isFinite(Number(value.usagePercent))) {
        return { value, source: raw instanceof SerovalRef ? "reference" : "inline" };
      }
      // 记录干扰项（如 `monthlyUsage:null`），将来顺序变化时一眼可见。
      if (ignored.length < 8) ignored.push(`${field}:${describeValue(raw)}`);
    }
  }
  return null;
}

function describeValue(value: SerovalValue): string {
  if (value instanceof SerovalRef) return `$R[${value.index}]`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return String(value);
}

function finiteOrNull(value: SerovalValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function usageObjectToWindow(
  key: OpenCodeUsageWindowKey,
  value: Record<string, SerovalValue>,
  nowMs: number,
): OpenCodeUsageWindow | null {
  const percent = finiteOrNull(value.usagePercent);
  if (percent === null) return null;
  const resetInSec = finiteOrNull(value.resetInSec);
  const usage = finiteOrNull(value.usage);
  const limit = finiteOrNull(value.limit);
  return {
    key,
    status: typeof value.status === "string" && value.status ? value.status : "ok",
    usagePercent: Math.min(100, Math.max(0, percent)),
    usage,
    limit,
    resetInSec: resetInSec === null ? null : Math.max(0, Math.round(resetInSec)),
    resetAt: resetInSec === null ? null : new Date(nowMs + resetInSec * 1000).toISOString(),
  };
}

/**
 * 从 Go 用量页面（`/workspace/<id>/go`）的 HTML 里读出三个窗口。
 * 页面永远是 200，窗口缺失是常态（workspace 没启用 Go 套餐），因此这里不抛错，
 * 由调用方按「一个窗口都没有 → unavailable，不得展示 0%」处理。
 */
export function parseOpencodeUsagePage(
  html: string,
  nowMs: number = Date.now(),
): OpenCodeUsagePageParseResult {
  const resolve = createRefResolver(html);
  const windows: OpenCodeUsageWindow[] = [];
  const sources = {} as Record<OpenCodeUsageWindowKey, OpenCodeUsageWindowSource>;
  const ignored: string[] = [];

  for (const { field, key } of WINDOW_FIELDS) {
    const found = findUsageObject(html, field, resolve, ignored);
    if (!found) {
      sources[key] = "absent";
      continue;
    }
    const window = usageObjectToWindow(key, found.value, nowMs);
    if (!window) {
      sources[key] = "absent";
      continue;
    }
    sources[key] = found.source;
    windows.push(window);
  }

  return { windows, sources, ignored };
}

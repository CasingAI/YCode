// 模型 id 的展示名（`deepseek-v4.1-flash` → `Deepseek V4.1 Flash`）。
// 只做展示层排版：模型 id 始终是传给 runtime 的事实，这里的结果不写回配置、目录或请求。

/** 整词大写的缩写；不在此列的短词按普通单词首字母大写（`pro` → `Pro`，不是 `PRO`）。 */
const UPPERCASE_TOKENS = new Set(["glm", "gpt", "ai", "api", "mcp", "vl", "llm"]);

/** 纯数字与点分版本号（`5.3`、`250414`），保持原样。 */
const VERSION_TOKEN = /^\d+(\.\d+)*$/;

/** 相邻两个单个数字属于同一个版本号（`claude-sonnet-4-5` → `4.5`）。 */
const SINGLE_DIGIT_TOKEN = /^\d$/;

/** 版本号后面的视觉标记：`4.6v` → `4.6V`。 */
const VERSION_VISION_SUFFIX_TOKEN = /^(\d+(?:\.\d+)*)v$/;

/**
 * 只要词里含大写字母（任意字符集），或含拉丁字母以外的字母（西里尔、希腊、汉字…），
 * 就整词原样保留：MiniMax / FlashX / M2.1 是厂商写法，非拉丁脚本的大小写也不在
 * 「首字母大写」这套拉丁排版规则的适用范围内。拉丁字母与符号照旧走下面的改写，
 * 所以 `café` → `Café`、`model@2024` → `Model@2024`。
 */
const PRESERVE_CASE_TOKEN = /\p{Lu}|[^\P{L}\p{Script=Latin}]/u;

function formatModelDisplayNameToken(token: string): string {
  if (UPPERCASE_TOKENS.has(token.toLowerCase())) {
    return token.toUpperCase();
  }
  if (VERSION_TOKEN.test(token)) {
    return token;
  }
  if (PRESERVE_CASE_TOKEN.test(token)) {
    return token;
  }
  const visionSuffix = VERSION_VISION_SUFFIX_TOKEN.exec(token);
  if (visionSuffix?.[1]) {
    return `${visionSuffix[1]}V`;
  }
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function formatModelDisplayNameSegment(segment: string): string {
  const rendered: string[] = [];
  let previousSingleDigit = false;
  for (const token of segment.split(/[-_\s]+/).filter(Boolean)) {
    const isSingleDigit = SINGLE_DIGIT_TOKEN.test(token);
    if (isSingleDigit && previousSingleDigit && rendered.length > 0) {
      // 只合并单个数字：多位数字是日期戳（claude-haiku-4-5-20251001）或型号后缀
      //（qwen3.8-max-0902），并进版本号会读成 4.5.20251001 这种噪声。
      const head = rendered.pop() ?? "";
      rendered.push(`${head}.${token}`);
    } else {
      rendered.push(formatModelDisplayNameToken(token));
    }
    previousSingleDigit = isSingleDigit;
  }
  return rendered.join(" ");
}

/**
 * 把模型 id 排成展示名。规则与样例见 `docs/specs/composer-model-display-name.md`。
 * `/` 之前的 vendor slug（`anthropic`、`z-ai`）原样保留，只格式化模型段。
 */
export function formatModelDisplayName(modelId: string): string {
  const compact = modelId.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  const segments = compact.split("/");
  const modelSegment = segments.pop() ?? "";
  return [...segments, formatModelDisplayNameSegment(modelSegment)].join("/");
}

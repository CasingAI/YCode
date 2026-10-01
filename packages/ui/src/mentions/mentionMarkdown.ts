const LINK_MENTION_MARKDOWN_PATTERN =
  /\[((?:\\.|[^\\\]])*)\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)])*))\)/g;
const INLINE_MENTION_TOKEN_PATTERN =
  /(^|\s)(\$[a-zA-Z0-9._-]+|\/[a-zA-Z0-9._-]+|@[a-zA-Z0-9._-]+|#sess_[a-zA-Z0-9._-]+)(?=$|\s)/g;

function escapeMarkdownLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownDestination(destination: string): string {
  return destination.replaceAll("\\", "\\\\").replaceAll(">", "\\>");
}

function unescapeMarkdownText(text: string): string {
  let result = "";

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && index + 1 < text.length) {
      result += text[index + 1];
      index += 1;
      continue;
    }

    result += text[index];
  }

  return result;
}

function normalizeMarkdownDestination(destination: string): string {
  if (
    destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    destination.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(destination)
  ) {
    return destination;
  }

  // Streamdown/rehype-harden 会把 `foo/bar.ts` 这种裸路径当成自定义协议 `foo:`，
  // 结果用户消息里的文件引用会被渲染成 `[blocked]`。这里统一补成 `./foo/bar.ts`，
  // 让它明确成为相对路径链接，既保留 Markdown 语义，也能通过安全校验正常展示。
  return `./${destination}`;
}

function normalizeFileMentionRelativePath(
  relativePath: string,
  kind: "file" | "directory",
): string {
  const trimmedRelativePath = relativePath.trim();
  if (kind === "directory") {
    return `${trimmedRelativePath.replace(/[\\/]+$/, "")}/`;
  }

  return trimmedRelativePath;
}

export function buildFileMentionMarkdown(
  relativePath: string,
  label: string,
  kind: "file" | "directory" = "file",
): string {
  const normalizedRelativePath = normalizeFileMentionRelativePath(relativePath, kind);
  return `[${escapeMarkdownLabel(label)}](${escapeMarkdownDestination(normalizeMarkdownDestination(normalizedRelativePath))})`;
}

export function buildSkillMentionMarkdown(label: string, skillPath?: string): string {
  if (!skillPath) {
    return `$${label}`;
  }

  return `[${escapeMarkdownLabel(`$${label}`)}](${escapeMarkdownDestination(normalizeMarkdownDestination(skillPath))})`;
}

export function buildSubagentMentionMarkdown(label: string): string {
  return `@${label}`;
}

export function buildSessionMentionMarkdown(sessionId: string, label?: string): string {
  const trimmedLabel = label?.trim();
  if (!trimmedLabel || trimmedLabel === sessionId) {
    return `#${sessionId}`;
  }
  return `[${escapeMarkdownLabel(`#${trimmedLabel}`)}](#${escapeMarkdownDestination(sessionId)})`;
}

// Plugin 引用的 canonical 持久化载体：
// `[@Label](plugin://stable-id)`。身份只在 destination；label 仅用于展示。
export function buildPluginMentionMarkdown(label: string, pluginId: string): string {
  return `[${escapeMarkdownLabel(`@${label}`)}](plugin://${escapeMarkdownDestination(pluginId)})`;
}

type MentionTextPart =
  | { type: "text"; text: string }
  | { type: "file"; label: string }
  | { type: "directory"; label: string }
  | { type: "skill"; label: string }
  | { type: "command"; label: string }
  | { type: "subagent"; label: string }
  | { type: "session"; label: string }
  | { type: "plugin"; label: string; pluginId?: string };

const PLUGIN_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePluginStableId(destination: string): string | undefined {
  if (!destination.startsWith("plugin://")) return undefined;
  const candidate = destination.slice("plugin://".length);
  return candidate.length <= 256 && PLUGIN_STABLE_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

/**
 * 将技能 slug（如 code-review）格式化为聊天气泡中的可读标题（Code Review）。
 * 已是包含空格的短语时原样返回，避免破坏用户自定义展示名。
 */
export function formatSkillMentionDisplayLabel(label: string): string {
  const t = label.trim();
  if (!t) {
    return label;
  }
  if (t.includes(" ") && !t.includes("-") && !t.includes("_")) {
    return t;
  }
  const words = t.split(/[-_]/).filter(Boolean);
  if (words.length === 0) {
    return label;
  }
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function isDirectoryMentionDestination(destination: string): boolean {
  return /[\\/]$/.test(destination);
}

/**
 * 气泡裸 token 的存在性白名单（小写集合）。
 *
 * 裸 token 与 `[$name](path)` 链接的可信度不同：链接由编辑器 mention 节点序列化而来，
 * path 出自目录项，可以直接采信；裸 token 只是纯文本嗅探的猜测，`cost is $100 today`
 * 里的金额、`$12313132q13123` 这种算式、`@随手写的词` 都会命中同一条正则。
 *
 * 四类 token 共用一套 fail-open 语义：对应集合为 `undefined`（目录未就绪、只读分享视图
 * 等拿不到目录的场景）时一律放行，保持既有显示；传入集合时只有命中的才渲染芯片，
 * 其余按普通文本原样显示。比较统一小写，与各面板的同名折叠口径一致。
 */
export interface MentionWhitelist {
  /** `$name` 技能名（小写）。 */
  skillNames?: ReadonlySet<string>;
  /** `@name` 子智能体名（小写）。 */
  subagentNames?: ReadonlySet<string>;
  /** `/name` 命令名（小写，含 goal/target/plan/compact 内建兜底）。 */
  commandNames?: ReadonlySet<string>;
  /** `#sess_xxx` 会话 id（`sess_` 前缀，原文大小写，会话 id 区分大小写）。 */
  sessionIds?: ReadonlySet<string>;
}

/**
 * 裸 token 查白名单前的统一归一化。
 *
 * lookup 前统一 `trim().toLowerCase()`；尾部句点要剥掉——正则字符集含 `.`，句末的真实
 * 引用 `$debug-mode.` 会把句号吃进 token（label 变成 `"debug-mode."`）。剥离后命中时，
 * 芯片用剥离后的名字、尾部句点作为独立 text part 输出，芯片不再吞掉句末标点。
 */
function normalizeWhitelistLookupKey(label: string): string {
  return label.trim().toLowerCase().replace(/[.]+$/, "");
}

/** 裸 token 剥离尾部标点后剩余的后缀（`"."`/`"..."`），渲染时作为独立 text part 输出。 */
function splitTrailingPunctuation(label: string): { name: string; suffix: string } {
  const match = /[.]+$/.exec(label);
  if (!match) return { name: label, suffix: "" };
  return { name: label.slice(0, label.length - match[0].length), suffix: match[0] };
}

function isWhitelistedToken(
  label: string,
  allowlist: ReadonlySet<string> | undefined,
  options?: { caseSensitive?: boolean },
): { known: boolean; name: string; suffix: string } {
  if (!allowlist) return { known: true, name: label, suffix: "" };
  const { name, suffix } = splitTrailingPunctuation(label);
  // 会话 id 是系统生成的标识符，精确匹配（区分大小写）；技能/子智能体/命令名统一小写。
  const key = options?.caseSensitive ? name.trim() : normalizeWhitelistLookupKey(name);
  // 剥离后名字为空（如 token 本身就是 `$...`）时不查集合，直接当未知处理。
  if (!key) return { known: false, name, suffix };
  return { known: allowlist.has(key), name, suffix };
}

/**
 * 白名单门禁输出：命中则推对应 part（剥离尾部标点后的名字），尾部标点另推 text part；
 * 未命中则整段退回普通文本。集合为 `undefined` 时一律放行原文（fail-open）。
 */
function pushMentionOrText(
  parts: MentionTextPart[],
  type: "skill" | "command" | "subagent" | "session",
  token: string,
  rawLabel: string,
  allowlist: ReadonlySet<string> | undefined,
  caseSensitive = false,
): void {
  const { known, name, suffix } = isWhitelistedToken(rawLabel, allowlist, { caseSensitive });
  if (!known) {
    parts.push({ type: "text", text: token });
    return;
  }
  parts.push({ type, label: name } as MentionTextPart);
  if (suffix) {
    parts.push({ type: "text", text: suffix });
  }
}

function parseInlineMentionTokens(
  segment: string,
  whitelist?: MentionWhitelist,
): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  INLINE_MENTION_TOKEN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of segment.matchAll(INLINE_MENTION_TOKEN_PATTERN)) {
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    if (!token) {
      continue;
    }
    const matchStart = match.index ?? 0;
    const tokenStart = matchStart + prefix.length;
    if (tokenStart > cursor) {
      parts.push({
        type: "text",
        text: segment.slice(cursor, tokenStart),
      });
    }
    if (token.startsWith("$")) {
      pushMentionOrText(parts, "skill", token, token.slice(1), whitelist?.skillNames);
    } else if (token.startsWith("/")) {
      pushMentionOrText(parts, "command", token, token.slice(1), whitelist?.commandNames);
    } else if (token.startsWith("@")) {
      pushMentionOrText(parts, "subagent", token, token.slice(1), whitelist?.subagentNames);
    } else if (token.startsWith("#")) {
      // `#sess_` 前缀在正则层已限定；会话 id 区分大小写，精确匹配。
      pushMentionOrText(parts, "session", token, token.slice(1), whitelist?.sessionIds, true);
    } else {
      parts.push({ type: "text", text: token });
    }
    cursor = tokenStart + token.length;
  }

  if (cursor < segment.length) {
    parts.push({ type: "text", text: segment.slice(cursor) });
  }

  return parts;
}

/**
 * 把消息正文切成 text / mention 片段。
 *
 * `whitelist` 只约束裸 token（`$`/`@`/`/`/`#sess_`）：传目录集合时未命中的退回普通
 * 文本；传 `undefined` 或对应集合缺席时维持旧行为。`[$name](path)` 链接形式不受影响。
 */
export function parseMentionMarkdown(
  content: string,
  whitelist?: MentionWhitelist,
): MentionTextPart[] {
  const parts: MentionTextPart[] = [];
  LINK_MENTION_MARKDOWN_PATTERN.lastIndex = 0;
  let cursor = 0;

  for (const match of content.matchAll(LINK_MENTION_MARKDOWN_PATTERN)) {
    const fullMatch = match[0] ?? "";
    const label = match[1] ? unescapeMarkdownText(match[1]) : "";
    const destination = match[2] ?? match[3] ?? "";
    const matchStart = match.index ?? 0;
    if (matchStart > cursor) {
      parts.push(...parseInlineMentionTokens(content.slice(cursor, matchStart), whitelist));
    }
    if (/^#sess_[a-zA-Z0-9._-]+$/.test(destination)) {
      parts.push({ type: "session", label: label.startsWith("#") ? label.slice(1) : label });
    } else if (destination.startsWith("plugin://")) {
      // Plugin 引用链接绝不能落入 file 分支或被当外链处理；
      // 发送后曾只保留 label，消息层失去 stable ID，只能固定显示兜底图标。
      // 这里原样保留合法 destination 身份供 UI 与 Session catalog 关联；非法目标仍保持
      // display-only，不做 label 猜测、percent decode 或 canonical 改写。
      const pluginId = parsePluginStableId(destination);
      parts.push({
        type: "plugin",
        label: label.startsWith("@") ? label.slice(1) : label,
        ...(pluginId ? { pluginId } : {}),
      });
    } else if (label.startsWith("$")) {
      parts.push({ type: "skill", label: label.slice(1) });
    } else if (isDirectoryMentionDestination(destination)) {
      // 目录 mention 之前只按普通 file 还原，消息回显层拿不到 folder 语义，
      // 于是文件夹候选在气泡里会继续显示成普通文件图标。这里根据链接目标是否以斜杠结尾恢复目录类型。
      parts.push({ type: "directory", label: label.startsWith("@") ? label.slice(1) : label });
    } else {
      parts.push({ type: "file", label: label.startsWith("@") ? label.slice(1) : label });
    }
    cursor = matchStart + fullMatch.length;
  }

  if (cursor < content.length) {
    parts.push(...parseInlineMentionTokens(content.slice(cursor), whitelist));
  }

  return parts;
}

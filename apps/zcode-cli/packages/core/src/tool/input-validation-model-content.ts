import type { RuntimeInputValidationIssue } from "./input-normalization.js";
import {
  createCustomIssue,
  createInvalidFormatIssue,
  createTooBigIssue,
  createTooSmallIssue,
  type ToolInputValidationIssue,
  type ToolInputValidationPath,
} from "./tool-input-validation-issues.js";
import type { ToolEntry } from "./types.js";

export interface InitialModelValidationProjection {
  /** provider-visible 包装形式，回灌模型通道。 */
  modelContent: string;
  /** 无包装的可读文本，作为 CoreError.message 供 UI hover 与错误行复用。 */
  readableMessage: string;
}

export function projectInitialModelValidationContent(
  entry: ToolEntry,
  jsonIssues: readonly ToolInputValidationIssue[],
  runtimeIssues: readonly RuntimeInputValidationIssue[] | undefined,
): InitialModelValidationProjection {
  const readableMessage = formatInitialModelValidationText(entry, jsonIssues, runtimeIssues);
  return {
    readableMessage,
    modelContent: `<tool_use_error>InputValidationError: ${readableMessage}</tool_use_error>`,
  };
}

export function createInitialInputValidationModelContent(
  entry: ToolEntry,
  jsonIssues: readonly ToolInputValidationIssue[],
  runtimeIssues: readonly RuntimeInputValidationIssue[] | undefined,
): string {
  return projectInitialModelValidationContent(entry, jsonIssues, runtimeIssues).modelContent;
}

/**
 * 投影后的模型/UI 可读错误文本（不含 `<tool_use_error>` 包装）。模型通道由
 * `createInitialInputValidationModelContent` 的包装形式承担；CoreError.message
 * 作为 UI hover 与错误行的共同来源复用同一份文本，不再显示笼统的校验失败占位。
 */
export function formatInitialModelValidationText(
  entry: ToolEntry,
  jsonIssues: readonly ToolInputValidationIssue[],
  runtimeIssues: readonly RuntimeInputValidationIssue[] | undefined,
): string {
  const issues = projectInitialModelValidationIssues(entry.inputSchema, jsonIssues, runtimeIssues);
  return formatToolInputValidationError(entry.metadata.name, issues);
}

function formatToolInputValidationError(
  toolName: string,
  issues: readonly ToolInputValidationIssue[],
): string {
  const lines = formatValidationIssueLines(issues);
  if (lines.length > 0) {
    return `${toolName} failed due to the following ${
      lines.length > 1 ? "issues" : "issue"
    }:\n${lines.join("\n")}`;
  }

  // 原因与修复依据：JSON 兜底只服务未知 issue code。已知 code 必须由
  // `formatValidationIssueLines` 翻译成人话——范围、取值、格式、联合分支类
  // issue 一旦落进这里，会被 `JSON.stringify` 当成错误正文直接显示给用户和模型
  // （线上实例：TaskOutput 的 `timeout` 超过 300000 时，UI 气泡里显示的是
  // `[{"origin":"number","code":"too_big","maximum":300000,...}]`，看不出是哪个
  // 参数超了上限）。
  return (
    JSON.stringify(
      issues,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ) ?? "[]"
  );
}

/**
 * 逐条把 issue 翻译成人话。顺序固定：缺参 → 多参 → 类型错 → 范围 → 取值 →
 * 格式 → 联合分支 → 自定义规则。
 */
function formatValidationIssueLines(
  issues: readonly ToolInputValidationIssue[],
): string[] {
  const missingParameters = issues
    .filter(
      (issue) => issue.code === "invalid_type" && issue.message.includes("received undefined"),
    )
    .map((issue) => formatValidationPath(issue.path));
  const unexpectedParameters = issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : [],
  );
  const wrongTypes = issues.flatMap((issue) => {
    if (issue.code !== "invalid_type" || issue.message.includes("received undefined")) {
      return [];
    }
    return [
      {
        expected: issue.expected,
        param: formatValidationPath(issue.path),
        received: issue.message.match(/received (\w+)/)?.[1] ?? "unknown",
      },
    ];
  });

  const customRuleMessages = issues.flatMap((issue) =>
    issue.code === "custom" ? [issue.message] : [],
  );

  return [
    ...missingParameters.map((parameter) => `The required parameter \`${parameter}\` is missing`),
    ...unexpectedParameters.map(
      (parameter) => `An unexpected parameter \`${parameter}\` was provided`,
    ),
    ...wrongTypes.map(
      ({ expected, param, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    ),
    ...issues.flatMap((issue) => formatSizeBoundIssue(issue)),
    ...issues.flatMap((issue) => formatInvalidValueIssue(issue)),
    ...issues.flatMap((issue) => formatInvalidFormatIssue(issue)),
    ...issues.flatMap((issue) => formatInvalidUnionIssue(issue)),
    // 原因与修复依据：custom issue 来自 schema 里的 refine/superRefine 规则，
    // message 本来就是 schema 作者写给模型的完整句子；落进 JSON 兜底会让模型
    // 看到 `{"code":"custom","path":[]}` 这类内部格式（Sandbox 二选一即如此），
    // 既不知道错在哪个字段，也无法据此修正重试。
    ...customRuleMessages,
  ];
}

function formatSizeBoundIssue(issue: ToolInputValidationIssue): string[] {
  if (issue.code !== "too_big" && issue.code !== "too_small") return [];
  const limit = issue.code === "too_big" ? issue.maximum : issue.minimum;
  return [
    `${formatValidationSubject(issue.path)} must be ${formatSizeBoundComparison(issue)}${limit.toString()}${formatSizeUnit(issue.origin)}`,
  ];
}

function formatSizeBoundComparison(
  issue: Extract<ToolInputValidationIssue, { code: "too_big" | "too_small" }>,
): string {
  if (issue.exact === true) return "exactly ";
  if (issue.code === "too_big") return issue.inclusive ? "at most " : "less than ";
  return issue.inclusive ? "at least " : "greater than ";
}

function formatSizeUnit(origin: "array" | "number" | "string"): string {
  if (origin === "string") return " characters";
  if (origin === "array") return " items";
  return "";
}

function formatInvalidValueIssue(issue: ToolInputValidationIssue): string[] {
  if (issue.code !== "invalid_value") return [];
  const values = issue.values.map(formatIssueValueText);
  if (values.length === 0) {
    return [`${formatValidationSubject(issue.path)} is invalid`];
  }
  if (values.length === 1) {
    return [`${formatValidationSubject(issue.path)} must be ${values[0]}`];
  }
  return [
    `${formatValidationSubject(issue.path)} must be one of ${values.join(" | ")}`,
  ];
}

function formatInvalidFormatIssue(issue: ToolInputValidationIssue): string[] {
  if (issue.code !== "invalid_format") return [];
  return [`${formatValidationSubject(issue.path)} is invalid: ${issue.message}`];
}

function formatInvalidUnionIssue(issue: ToolInputValidationIssue): string[] {
  if (issue.code !== "invalid_union") return [];
  const subject = formatValidationSubject(issue.path);
  const branchLines = issue.errors
    .map((branch) => formatValidationIssueLines(branch))
    .filter((lines) => lines.length > 0);
  if (branchLines.length === 0) {
    return [`${subject} does not match any of the expected shapes`];
  }
  return [
    `${subject} does not match any of the expected shapes:`,
    ...branchLines.flatMap((lines) => lines.map((line) => `- ${line}`)),
  ];
}

function formatIssueValueText(value: unknown): string {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

/**
 * 范围、取值、格式类 issue 的主语。路径为空时作用在根值上，不能写成空反引号。
 */
function formatValidationSubject(path: ToolInputValidationPath): string {
  if (path.length === 0) return "The input";
  return `The parameter \`${formatValidationPath(path)}\``;
}

function projectInitialModelValidationIssues(
  inputSchema: ToolEntry["inputSchema"],
  jsonIssues: readonly ToolInputValidationIssue[],
  runtimeIssues: readonly RuntimeInputValidationIssue[] | undefined,
): ToolInputValidationIssue[] {
  if (!runtimeIssues || runtimeIssues.length === 0) return [...jsonIssues];

  const expandedRuntimeIssues = expandRuntimeIssues(runtimeIssues, jsonIssues);
  const matchedRuntimeIssues = new Set<number>();
  const matchedJsonIssues = new Map<number, ToolInputValidationIssue>();
  const jsonProjection: ToolInputValidationIssue[] = [];
  const jsonProjectionIdentities = new Set<string>();

  // runtime issues 判断错误是否真实存在，JSON issues 提供目标字段结构。
  // 先建立一对一映射，避免再把两套有序列表直接前后拼接而破坏字段校验顺序。
  for (const jsonIssue of jsonIssues) {
    const matchingRuntimeIndex = expandedRuntimeIssues.findIndex(
      (runtimeIssue, index) =>
        !matchedRuntimeIssues.has(index) && runtimeIssueMatchesJsonIssue(runtimeIssue, jsonIssue),
    );
    if (matchingRuntimeIndex < 0 && !isProviderOnlyStructuralIssue(jsonIssue, inputSchema)) {
      continue;
    }
    if (matchingRuntimeIndex >= 0) {
      matchedRuntimeIssues.add(matchingRuntimeIndex);
      matchedJsonIssues.set(matchingRuntimeIndex, jsonIssue);
    }
    const identity = toolInputIssueIdentity(jsonIssue);
    if (jsonProjectionIdentities.has(identity)) continue;
    jsonProjectionIdentities.add(identity);
    jsonProjection.push(jsonIssue);
  }

  // 参数类错误进入 formatter 后会省略所有其他 issue，因此直接使用 JSON projection
  // 保持 missing / unexpected / wrong type 的目标遍历顺序。
  if (jsonProjection.some(isParameterFormatterIssue)) {
    return jsonProjection;
  }

  const runtimeProjection: ToolInputValidationIssue[] = [];
  const runtimeProjectionIdentities = new Set<string>();
  for (const [index, runtimeIssue] of expandedRuntimeIssues.entries()) {
    const issue =
      matchedJsonIssues.get(index) ?? canonicalizeRuntimeOnlyIssue(runtimeIssue, inputSchema);
    if (!issue) continue;
    const identity = toolInputIssueIdentity(issue);
    if (runtimeProjectionIdentities.has(identity)) continue;
    runtimeProjectionIdentities.add(identity);
    runtimeProjection.push(issue);
  }

  // 非标准 runtime schema 可能只返回 success=false 而没有可读 issue；此时沿用
  // JSON Schema 的完整结果，不能把 provider-visible error 退化成空数组。
  return runtimeProjection.length > 0
    ? orderRuntimeFallbackIssues(runtimeProjection)
    : [...jsonIssues];
}

function isParameterFormatterIssue(issue: ToolInputValidationIssue): boolean {
  return issue.code === "invalid_type" || issue.code === "unrecognized_keys";
}

function orderRuntimeFallbackIssues(
  issues: readonly ToolInputValidationIssue[],
): ToolInputValidationIssue[] {
  const ordered = [...issues];

  // 本地 parser 在数组子项解析前记录数组 bounds；目标版本在子项之后记录。
  // 除这一个已确认的版本差异外，保留 runtime parser 的原始 issue 顺序。
  for (let issueIndex = ordered.length - 1; issueIndex >= 0; issueIndex -= 1) {
    const issue = ordered[issueIndex];
    if (!issue || !isArrayBoundIssue(issue)) continue;

    let lastDescendantIndex = -1;
    for (
      let candidateIndex = ordered.length - 1;
      candidateIndex > issueIndex;
      candidateIndex -= 1
    ) {
      const candidate = ordered[candidateIndex];
      if (candidate && isStrictDescendantPath(candidate.path, issue.path)) {
        lastDescendantIndex = candidateIndex;
        break;
      }
    }
    if (lastDescendantIndex < 0) continue;

    ordered.splice(issueIndex, 1);
    ordered.splice(lastDescendantIndex, 0, issue);
  }

  return ordered;
}

function isArrayBoundIssue(
  issue: ToolInputValidationIssue,
): issue is Extract<ToolInputValidationIssue, { code: "too_big" | "too_small" }> {
  return (issue.code === "too_big" || issue.code === "too_small") && issue.origin === "array";
}

function isStrictDescendantPath(
  candidate: ToolInputValidationPath,
  parent: ToolInputValidationPath,
): boolean {
  return (
    candidate.length > parent.length &&
    parent.every((segment, index) => candidate[index] === segment)
  );
}

function expandRuntimeIssues(
  runtimeIssues: readonly RuntimeInputValidationIssue[],
  jsonIssues: readonly ToolInputValidationIssue[],
): RuntimeInputValidationIssue[] {
  const expanded: RuntimeInputValidationIssue[] = [];
  for (const issue of runtimeIssues) {
    const hasJsonUnion = jsonIssues.some((jsonIssue) =>
      runtimeIssueMatchesJsonIssue(issue, jsonIssue),
    );
    const unionIssues = hasJsonUnion ? [] : readRuntimeUnionIssues(issue);
    if (unionIssues.length > 0) {
      expanded.push(...expandRuntimeIssues(unionIssues, jsonIssues));
    } else {
      expanded.push(issue);
    }
  }
  return expanded;
}

function readRuntimeUnionIssues(issue: RuntimeInputValidationIssue): RuntimeInputValidationIssue[] {
  if (issue.code !== "invalid_union" || !Array.isArray(issue.unionErrors)) return [];

  return issue.unionErrors.flatMap((unionError) => {
    if (!isRecord(unionError) || !Array.isArray(unionError.issues)) return [];
    return unionError.issues.filter((nestedIssue): nestedIssue is RuntimeInputValidationIssue =>
      isRecord(nestedIssue),
    );
  });
}

function runtimeIssueMatchesJsonIssue(
  runtimeIssue: RuntimeInputValidationIssue,
  jsonIssue: ToolInputValidationIssue,
): boolean {
  const runtimePath = readRuntimeIssuePath(runtimeIssue);
  if (!runtimePath || !sameValidationPath(runtimePath, jsonIssue.path)) return false;

  const runtimeCode = normalizeRuntimeIssueCode(runtimeIssue.code);
  if (runtimeCode === jsonIssue.code) return true;

  // 旧 parser 对缺失 enum/literal 使用 invalid_type；目标 issue 使用 invalid_value。
  return (
    runtimeIssue.code === "invalid_type" &&
    runtimeIssue.received === "undefined" &&
    jsonIssue.code === "invalid_value"
  );
}

function canonicalizeRuntimeOnlyIssue(
  issue: RuntimeInputValidationIssue,
  inputSchema: ToolEntry["inputSchema"],
): ToolInputValidationIssue | undefined {
  const path = readRuntimeIssuePath(issue);
  if (!path || typeof issue.code !== "string") return undefined;

  switch (issue.code) {
    case "custom":
      return createCustomIssue(readRuntimeIssueMessage(issue), path);
    case "invalid_string":
      return canonicalizeRuntimeStringIssue(issue, path, inputSchema);
    case "too_big": {
      const origin = readRuntimeIssueOrigin(issue);
      return origin && typeof issue.maximum === "number"
        ? createTooBigIssue(origin, issue.maximum, path, {
            exact: issue.exact === true,
            inclusive: issue.inclusive !== false,
          })
        : undefined;
    }
    case "too_small": {
      const origin = readRuntimeIssueOrigin(issue);
      return origin && typeof issue.minimum === "number"
        ? createTooSmallIssue(origin, issue.minimum, path, {
            exact: issue.exact === true,
            inclusive: issue.inclusive !== false,
          })
        : undefined;
    }
    default:
      return undefined;
  }
}

function canonicalizeRuntimeStringIssue(
  issue: RuntimeInputValidationIssue,
  path: ToolInputValidationPath,
  inputSchema: ToolEntry["inputSchema"],
): ToolInputValidationIssue | undefined {
  if (issue.validation === "url") {
    const message =
      issue.message === "Invalid url" ? "Invalid URL" : readRuntimeIssueMessage(issue);
    return createInvalidFormatIssue("url", message, path);
  }
  if (issue.validation !== "regex") return undefined;

  const schemaNode = readSchemaAtPath(inputSchema, path);
  const pattern = typeof schemaNode?.pattern === "string" ? `/${schemaNode.pattern}/` : undefined;
  const message =
    issue.message === "Invalid" && pattern
      ? `Invalid string: must match pattern ${pattern}`
      : readRuntimeIssueMessage(issue);
  return createInvalidFormatIssue("regex", message, path, {
    origin: "string",
    pattern,
  });
}

function isProviderOnlyStructuralIssue(
  issue: ToolInputValidationIssue,
  inputSchema: ToolEntry["inputSchema"],
): boolean {
  if (issue.code === "unrecognized_keys") return true;
  if (!isMissingTypeIssue(issue)) return false;
  const schemaNode = readSchemaAtPath(inputSchema, issue.path);
  return !schemaNode || !Object.prototype.hasOwnProperty.call(schemaNode, "default");
}

function isMissingTypeIssue(
  issue: ToolInputValidationIssue,
): issue is Extract<ToolInputValidationIssue, { code: "invalid_type" }> {
  return issue.code === "invalid_type" && issue.message.includes("received undefined");
}

function readRuntimeIssueOrigin(
  issue: RuntimeInputValidationIssue,
): "array" | "number" | "string" | undefined {
  return issue.type === "array" || issue.type === "number" || issue.type === "string"
    ? issue.type
    : undefined;
}

function readRuntimeIssueMessage(issue: RuntimeInputValidationIssue): string {
  return typeof issue.message === "string" ? issue.message : "Invalid input";
}

function readRuntimeIssuePath(
  issue: RuntimeInputValidationIssue,
): ToolInputValidationPath | undefined {
  if (
    !Array.isArray(issue.path) ||
    !issue.path.every((segment) => typeof segment === "string" || typeof segment === "number")
  ) {
    return undefined;
  }
  return [...issue.path];
}

function normalizeRuntimeIssueCode(code: unknown): string | undefined {
  if (code === "invalid_enum_value" || code === "invalid_literal") return "invalid_value";
  if (code === "invalid_string") return "invalid_format";
  return typeof code === "string" ? code : undefined;
}

function sameValidationPath(
  left: ToolInputValidationPath,
  right: ToolInputValidationPath,
): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function toolInputIssueIdentity(issue: ToolInputValidationIssue): string {
  return `${issue.code}:${JSON.stringify(issue.path)}:${issue.message}`;
}

function readSchemaAtPath(
  schema: ToolEntry["inputSchema"],
  path: ToolInputValidationPath,
): Record<string, unknown> | undefined {
  let current: unknown = schema;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    if (typeof segment === "number") {
      current = current.items;
      continue;
    }
    const properties = current.properties;
    if (!isRecord(properties)) return undefined;
    current = properties[segment];
  }
  return isRecord(current) ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValidationPath(path: ToolInputValidationPath): string {
  if (path.length === 0) return "";
  return path.reduce<string>((formatted, segment, index) => {
    if (typeof segment === "number") return `${formatted}[${segment.toString()}]`;
    return index === 0 ? segment : `${formatted}.${segment}`;
  }, "");
}

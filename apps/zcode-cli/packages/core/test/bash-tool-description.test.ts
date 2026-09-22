import assert from "node:assert/strict";
import test from "node:test";
import { BashInputJsonSchema, BashInputSchema, buildBashDescriptionFieldPrompt } from "@zcode/contracts";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

// description 是 UI 工具卡片的主文案，必须由模型稳定提供，
// 因此它从可选升级为必填；这里锁住 runtime schema 与 provider JSON Schema 两侧。

test("Bash：缺少 description 时 runtime 校验失败", () => {
  const parsed = BashInputSchema.safeParse({ command: "ls -la" });

  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error?.issues.some((issue) => issue.path.includes("description")),
    "失败应指向 description 字段",
  );
});

test("Bash：description 为空字符串时视为提供了值", () => {
  // 必填只约束“字段存在且为字符串”，空串留给上层兜底文案处理，
  // 避免把模型偶发的空描述升级成硬失败。
  const parsed = BashInputSchema.safeParse({ command: "ls -la", description: "" });

  assert.equal(parsed.success, true);
});

test("Bash：带 description 的调用通过校验", () => {
  const parsed = BashInputSchema.safeParse({
    command: "git status",
    description: "Show working tree status",
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.description, "Show working tree status");
});

test("Bash：provider JSON Schema 把 description 列为 required", () => {
  const required = BashInputJsonSchema.required as string[] | undefined;

  assert.ok(required?.includes("command"));
  assert.ok(required?.includes("description"), "description 应出现在 required 中");

  const properties = BashInputJsonSchema.properties as Record<string, { description?: string }>;
  assert.match(properties.description?.description ?? "", /Required/);
});

// description 提示的措辞由会话语言决定：语言已知时点名该语言并整体换示例，
// 未知时必须逐字节保持改动前的英文文案（旧会话没有语言）。

function descriptionSchemaOf(language?: string): string {
  const projected = bashToolEntry.resolveModelContract?.(language ? { language } : {});
  const properties = projected?.inputSchema?.properties as
    | Record<string, { description?: string }>
    | undefined;
  return properties?.description?.description ?? "";
}

test("buildBashDescriptionFieldPrompt：无语言时回退默认英文文案", () => {
  const prompt = buildBashDescriptionFieldPrompt();

  assert.match(prompt, /written in the user's language/);
  assert.match(prompt, /List files in current directory/);
  // 默认文案不得误点名语言：那会在没有语言事实时凭空断言。
  assert.doesNotMatch(prompt, /简体中文/);
  assert.doesNotMatch(prompt, /written in English/);
});

test("buildBashDescriptionFieldPrompt：zh-CN 点名简体中文并换成中文示例", () => {
  const prompt = buildBashDescriptionFieldPrompt("zh-CN");

  assert.match(prompt, /必须用简体中文书写，不要使用其他语言/);
  assert.match(prompt, /列出当前目录下的文件/);
  // 只改语言名而保留英文示例等于一边要求中文一边示范英文，模型会跟示例走。
  assert.doesNotMatch(prompt, /List files in current directory/);
});

test("buildBashDescriptionFieldPrompt：en-US 显式点名英文，与默认文案不同", () => {
  const prompt = buildBashDescriptionFieldPrompt("en-US");

  assert.match(prompt, /written in English; do not use any other language/);
  assert.match(prompt, /List files in current directory/);
  assert.notEqual(prompt, buildBashDescriptionFieldPrompt());
});

test("buildBashDescriptionFieldPrompt：未支持的语言标识回退默认文案", () => {
  assert.equal(buildBashDescriptionFieldPrompt("ja-JP"), buildBashDescriptionFieldPrompt());
});

test("Bash model contract：带会话语言时覆盖 provider 可见的 description 提示", () => {
  assert.match(descriptionSchemaOf("zh-CN"), /必须用简体中文书写/);
  assert.match(descriptionSchemaOf("en-US"), /written in English/);
});

test("Bash model contract：无会话语言时与静态 schema 逐字节一致", () => {
  const staticPrompt = (BashInputJsonSchema.properties as Record<string, { description?: string }>)
    .description?.description;

  assert.equal(descriptionSchemaOf(), staticPrompt);
  assert.equal(descriptionSchemaOf(undefined), staticPrompt);
});

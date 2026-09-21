import assert from "node:assert/strict";
import test from "node:test";
import { BashInputJsonSchema, BashInputSchema } from "@zcode/contracts";

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

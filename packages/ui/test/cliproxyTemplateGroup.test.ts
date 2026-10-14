import assert from "node:assert/strict";
import test from "node:test";
import { isCliProxyProviderTemplateId } from "@zcode/shared";

// CLI Proxy API 分类（docs/specs/plugin-cli-proxy-binary.md）：
// cliproxy-* 模板独立分组，一个 Codex 账号 = 一个 provider 条目。

test("cliproxy-codex 模板被识别为 CLI Proxy", () => {
  assert.equal(isCliProxyProviderTemplateId("cliproxy-codex"), true);
});

test("未来 cliproxy-* 模板自动继承", () => {
  assert.equal(isCliProxyProviderTemplateId("cliproxy-future"), true);
});

test("opencode/普通模板不被误判", () => {
  assert.equal(isCliProxyProviderTemplateId("opencode-go-chat"), false);
  assert.equal(isCliProxyProviderTemplateId("openai"), false);
  assert.equal(isCliProxyProviderTemplateId(null), false);
  assert.equal(isCliProxyProviderTemplateId(undefined), false);
});

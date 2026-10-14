import assert from "node:assert/strict";
import test from "node:test";
import { zcodePluginInfoSchema } from "../src/zcode-protocol/index.js";

// 第一切片（docs/specs/plugin-cli-proxy-binary.md）：binaryPlugin 是可选插件级字段，
// 只用于识别与渲染；无声明的插件缺省通过，组件 kind 枚举不受影响。

function baseInfo() {
  return {
    id: "cli-proxy@zcode-plugins-official",
    name: "cli-proxy",
    enabled: true,
    source: "official",
    marketplace: "zcode-plugins-official",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    rootPath: "/tmp/cli-proxy",
  };
}

test("binaryPlugin 缺省时校验通过", () => {
  const parsed = zcodePluginInfoSchema.parse(baseInfo());
  assert.equal(parsed.binaryPlugin, undefined);
});

test("binaryPlugin 声明透传发布源与 channel", () => {
  const parsed = zcodePluginInfoSchema.parse({
    ...baseInfo(),
    binaryPlugin: { releaseRepo: "router-for-me/CLIProxyAPI", defaultChannel: "stable" },
  });
  assert.deepEqual(parsed.binaryPlugin, {
    releaseRepo: "router-for-me/CLIProxyAPI",
    defaultChannel: "stable",
  });
});

test("binaryPlugin 缺发布源时校验拒绝", () => {
  assert.throws(() => zcodePluginInfoSchema.parse({ ...baseInfo(), binaryPlugin: {} }));
});

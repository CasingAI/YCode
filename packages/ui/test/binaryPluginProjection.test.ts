import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodePluginInfo } from "@zcode/shared";
import { selectBinaryPlugins, shouldRenderPluginToggle } from "../src/settings/pluginCapabilityProjection.js";

// 第一切片（docs/specs/plugin-cli-proxy-binary.md）：第四签「外部插件」是插件级过滤，
// 判定只看 binaryPlugin 标记，与组件 kind、有无组件无关。

function plugin(id: string, binaryPlugin?: ZCodePluginInfo["binaryPlugin"]): ZCodePluginInfo {
  return {
    id,
    name: id.split("@")[0] ?? id,
    enabled: true,
    source: "official",
    marketplace: "zcode-plugins-official",
    skillRootCount: 0,
    commandRootCount: 0,
    components: [],
    mcpServerNames: [],
    rootPath: `/tmp/${id}`,
    ...(binaryPlugin ? { binaryPlugin } : {}),
  };
}

test("第四签过滤只列二进制插件", () => {
  const items = [
    plugin("cli-proxy@zcode-plugins-official", { releaseRepo: "router-for-me/CLIProxyAPI" }),
    plugin("browser-use@zcode-plugins-official"),
  ];
  assert.deepEqual(
    selectBinaryPlugins(items).map((item) => item.id),
    ["cli-proxy@zcode-plugins-official"],
  );
});

test("无组件的二进制插件照样是一个列表条目", () => {
  const items = [
    plugin("cli-proxy@zcode-plugins-official", {
      releaseRepo: "router-for-me/CLIProxyAPI",
      defaultChannel: "stable",
    }),
  ];
  const selected = selectBinaryPlugins(items);
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0]?.components, []);
});

test("binaryPlugin 缺省的插件不进第四签", () => {
  const items = [plugin("sandbox@zcode-plugins-official"), plugin("bare@zcode-plugins-official")];
  assert.deepEqual(selectBinaryPlugins(items), []);
});

test("带 binaryPlugin 的插件不渲染启停开关，普通插件仍渲染", () => {
  assert.equal(
    shouldRenderPluginToggle({ binaryPlugin: { releaseRepo: "router-for-me/CLIProxyAPI" } }),
    false,
  );
  assert.equal(shouldRenderPluginToggle({}), true);
  assert.equal(shouldRenderPluginToggle({ binaryPlugin: undefined }), true);
});

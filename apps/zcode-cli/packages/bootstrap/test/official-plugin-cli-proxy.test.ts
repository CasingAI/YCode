import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  OFFICIAL_CLI_PROXY_PLUGIN_ID,
  OFFICIAL_CLI_PROXY_PLUGIN_NAME,
  OFFICIAL_PLUGIN_DEFINITIONS,
} from "../src/app/official-plugin-definitions.js";

// CLI Proxy 以内置条目播种：有 name/version、无任何组件字段、默认启用（二进制插件
// 无用户级启停意图，运行时拉起只由依赖 provider 派生按需启动）。
// listing 仅给英文简介（中文走 manifest description），不改变发现/安装面。

test("CLI Proxy 内置条目已播种且无组件声明", () => {
  const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
    (candidate) => candidate.name === OFFICIAL_CLI_PROXY_PLUGIN_NAME,
  );
  assert.ok(definition, "CLI Proxy 必须在官方插件定义中");
  assert.equal(
    `${definition.name}@zcode-plugins-official`,
    OFFICIAL_CLI_PROXY_PLUGIN_ID,
  );
  assert.equal(definition.version, "0.1.0");
  assert.equal(definition.defaultEnabled, true);
  assert.equal(
    definition.listing?.description_i18n?.["en-US"],
    "Local proxy supporting Codex: exposes Codex account capability over local HTTP as an OpenAI-compatible API.",
  );
  assert.deepEqual(definition.rootCandidates, [
    "packages/cli-proxy-plugin",
    "../cli-proxy-plugin",
    "../../cli-proxy-plugin",
    "../../../cli-proxy-plugin",
  ]);
});

test("CLI Proxy 已进默认启用集合", () => {
  assert.equal(DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(OFFICIAL_CLI_PROXY_PLUGIN_ID), true);
});

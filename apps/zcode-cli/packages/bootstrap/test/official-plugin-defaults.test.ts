import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS as BOOTSTRAP_DEFAULT_ENABLED_IDS,
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "../src/app/official-plugin-definitions.js";
import { resolveBuiltInNodeReplMcpServers } from "../src/app/built-in-node-repl.js";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS as SHARED_DEFAULT_ENABLED_IDS } from "@zcode/shared";

function plugin(id: string, enabled: boolean, rootPath = `/tmp/${id}`) {
  return { id, enabled, rootPath };
}

test("Browser Use 与 Computer Use 均不在官方默认集合，node-repl host 仍默认可发现", () => {
  assert.equal(BOOTSTRAP_DEFAULT_ENABLED_IDS.has(OFFICIAL_BROWSER_USE_PLUGIN_ID), false);
  assert.equal(BOOTSTRAP_DEFAULT_ENABLED_IDS.has(OFFICIAL_CUA_PLUGIN_ID), false);
  assert.equal(BOOTSTRAP_DEFAULT_ENABLED_IDS.has(OFFICIAL_NODE_REPL_HOST_PLUGIN_ID), true);
  assert.deepEqual(
    [...BOOTSTRAP_DEFAULT_ENABLED_IDS].sort(),
    [...SHARED_DEFAULT_ENABLED_IDS].sort(),
  );
});

test("node_repl 只有 Browser Use 或 Computer Use 任一显式启用时注册", () => {
  const host = plugin(OFFICIAL_NODE_REPL_HOST_PLUGIN_ID, true);
  const disabledBoth = resolveBuiltInNodeReplMcpServers({
    workingDirectory: "/tmp",
    pluginOutcome: {
      plugins: [
        host,
        plugin(OFFICIAL_BROWSER_USE_PLUGIN_ID, false),
        plugin(OFFICIAL_CUA_PLUGIN_ID, false),
      ],
    },
  });
  assert.deepEqual(disabledBoth, {});

  const browserEnabled = resolveBuiltInNodeReplMcpServers({
    workingDirectory: "/tmp",
    pluginOutcome: {
      plugins: [host, plugin(OFFICIAL_BROWSER_USE_PLUGIN_ID, true), plugin(OFFICIAL_CUA_PLUGIN_ID, false)],
    },
  });
  assert.equal(Object.keys(browserEnabled).length, 1);
  assert.ok(browserEnabled.node_repl);

  const computerEnabled = resolveBuiltInNodeReplMcpServers({
    workingDirectory: "/tmp",
    pluginOutcome: {
      plugins: [
        host,
        plugin(OFFICIAL_BROWSER_USE_PLUGIN_ID, false),
        plugin(OFFICIAL_CUA_PLUGIN_ID, true),
      ],
    },
  });
  assert.equal(Object.keys(computerEnabled).length, 1);
  assert.ok(computerEnabled.node_repl);
});

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNoProxyRules } from "../src/settings/NetworkSettingsSection.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "../src/lib/settingsNavigation.js";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

// HTTP 出口策略从「常规」迁到独立「网络」分区（docs/specs/network-settings.md）。
// 这里锁定分区注册与 No Proxy 输入规范化两个纯逻辑点，避免迁移过程中行为漂移。

test("network 分区已注册且可见，位于基础组", () => {
  assert.equal(resolveSettingsSection("network"), "network");
  assert.equal(isSettingsSectionEnabled("network"), true);

  const { settingsSections } = createSettingsPageConfig();
  const network = settingsSections.find((section) => section.id === "network");
  assert.ok(network, "network section 应出现在设置分区列表中");
  assert.equal(network.groupId, "basics");

  const ids = settingsSections.map((section) => section.id);
  assert.ok(ids.indexOf("network") > ids.indexOf("modelProvider"));
  assert.ok(ids.indexOf("network") < ids.indexOf("browser"));
});

test("normalizeNoProxyRules：trim、去空段并按英文逗号拼接", () => {
  assert.equal(
    normalizeNoProxyRules("localhost, 127.0.0.1 ,,.corp.com"),
    "localhost,127.0.0.1,.corp.com",
  );
});

test("normalizeNoProxyRules：空输入归一为空串", () => {
  assert.equal(normalizeNoProxyRules(""), "");
  assert.equal(normalizeNoProxyRules(" , , "), "");
});

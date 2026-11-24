import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettingsPatch } from "../src/setting/normalizeSettingsPatch.js";

// 内置浏览器代理标签页出口地址（docs/specs/browser-tab-proxy.md）：设置页「填写即生效」。
// 清空输入必须变成 undefined 删除旧值，才能让 main 重应用网络策略时代理分区回到 direct，
// 否则代理标签页会一直沿用已删除的地址。

test("embeddedBrowserProxy 保留有效地址并去除首尾空白", () => {
  assert.deepEqual(normalizeSettingsPatch({ embeddedBrowserProxy: " 127.0.0.1:7890 " }), {
    embeddedBrowserProxy: "127.0.0.1:7890",
  });
});

test("embeddedBrowserProxy 空串与纯空白清空后删除旧值", () => {
  assert.deepEqual(normalizeSettingsPatch({ embeddedBrowserProxy: "" }), {
    embeddedBrowserProxy: undefined,
  });
  assert.deepEqual(normalizeSettingsPatch({ embeddedBrowserProxy: "   " }), {
    embeddedBrowserProxy: undefined,
  });
});

test("未提及 embeddedBrowserProxy 的 patch 不注入该字段", () => {
  const normalized = normalizeSettingsPatch({ httpProxyEnabled: true });
  assert.equal("embeddedBrowserProxy" in normalized, false);
});

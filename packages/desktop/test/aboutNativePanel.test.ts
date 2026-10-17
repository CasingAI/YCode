import assert from "node:assert/strict";
import test from "node:test";
import { app } from "electron";
import { ZCODE_UPSTREAM_VERSION, ZCODE_VERSION } from "@zcode/shared";
import { join } from "node:path";
import { showAboutDialog } from "../src/main/about.js";

const testApp = app as typeof app & {
  __aboutPanelOptions?: Record<string, unknown>;
  __aboutPanelShown: boolean;
};

test("关于入口交给 Electron 原生 About 面板并传入产品信息", async () => {
  testApp.__aboutPanelOptions = undefined;
  testApp.__aboutPanelShown = false;

  await showAboutDialog(undefined, "zh-CN");

  assert.equal(testApp.__aboutPanelShown, true);
  const credits: string[] = [];
  if (process.platform === "darwin" && process.arch === "arm64") {
    credits.push("已针对 Apple Silicon 优化。");
  }
  if (ZCODE_UPSTREAM_VERSION && ZCODE_UPSTREAM_VERSION !== "unknown") {
    credits.push(`上游 ZCode 版本 ${ZCODE_UPSTREAM_VERSION}。`);
  }
  assert.deepEqual(testApp.__aboutPanelOptions, {
    applicationName: "YCode Desktop App",
    applicationVersion: ZCODE_VERSION,
    copyright: `版权所有 © ${new Date().getFullYear()} YCode。`,
    credits: credits.join("\n"),
    iconPath: join(import.meta.dirname, "../build/icon.png"),
  });
});

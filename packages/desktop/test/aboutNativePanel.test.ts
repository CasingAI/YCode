import assert from "node:assert/strict";
import test from "node:test";
import { app } from "electron";
import { ZCODE_UPSTREAM_VERSION, ZCODE_VERSION } from "@zcode/shared";
import { join } from "node:path";
import { buildAboutPanelOptions, showAboutDialog } from "../src/main/about.js";

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
  const commonOptions = {
    applicationName: "YCode Desktop App",
    applicationVersion: ZCODE_VERSION,
    copyright: `版权所有 © ${new Date().getFullYear()} YCode。`,
    iconPath: join(import.meta.dirname, "../build/icon.png"),
  };
  assert.deepEqual(
    testApp.__aboutPanelOptions,
    process.platform === "linux"
      ? { ...commonOptions, authors: ["YCode"], website: "https://github.com/CasingAI/YCode" }
      : { ...commonOptions, credits: credits.join("\n") },
  );
});

test("Linux About 使用系统支持的作者与网站字段，不设置 credits", () => {
  const options = buildAboutPanelOptions(
    {
      appVersion: "1.2.3",
      buildCommitId: "commit",
      buildTime: "time",
      environment: "production",
      electronVersion: "41",
      electronBuilderVersion: "26",
      chromiumVersion: "130",
      nodeVersion: "24",
      v8Version: "13",
      osType: "Linux",
      osPlatform: "linux",
      osRelease: "6.0",
      osVersion: "Linux",
      osArch: "x64",
      hostname: "test",
    },
    { locale: "en-US", isPackaged: false, platform: "linux" },
  );
  assert.equal(options.authors instanceof Array, true);
  assert.deepEqual(options.authors, ["YCode"]);
  assert.equal(options.website, "https://github.com/CasingAI/YCode");
  assert.equal("credits" in options, false);
});

test("macOS and Windows About retain credits", () => {
  const snapshot = {
    appVersion: "1.2.3",
    buildCommitId: "commit",
    buildTime: "time",
    environment: "production",
    electronVersion: "41",
    electronBuilderVersion: "26",
    chromiumVersion: "130",
    nodeVersion: "24",
    v8Version: "13",
    osType: "Darwin",
    osPlatform: "darwin",
    osRelease: "24.0",
    osVersion: "macOS",
    osArch: "arm64",
    hostname: "test",
  };
  for (const platform of ["darwin", "win32"] as const) {
    const options = buildAboutPanelOptions(snapshot, {
      locale: "en-US",
      isPackaged: false,
      platform,
    });
    assert.equal(typeof options.credits, "string");
  }
});

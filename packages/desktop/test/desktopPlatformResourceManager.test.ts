import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 桌面平台的资源管理器能力。
 *
 * 资源管理器入口按宿主能力渲染（见 packages/ui 的入口测试），
 * 桌面这一侧由平台层提供能力，并复用既有桌面命令打开独立窗口。
 */

const platformSource = readFileSync(
  new URL("../src/renderer/src/desktopPlatform.ts", import.meta.url),
  "utf8",
);

test("桌面平台提供 openResourceManager，并复用既有桌面命令", () => {
  assert.match(platformSource, /openResourceManager: \(\) => \{/, "桌面平台必须提供资源管理器能力");
  assert.match(
    platformSource,
    /executeDesktopCommand\(DesktopCommandIds\.OpenResourceManager\)/,
    "必须复用既有桌面命令打开资源管理器窗口",
  );
  assert.doesNotMatch(
    platformSource,
    /PlatformChannels\.OpenResourceManager/,
    "渲染进程不得绕过桌面命令直连 IPC 通道",
  );
});

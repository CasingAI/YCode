import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsPageSource = readFileSync(
  new URL("../src/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const windowFrameSource = readFileSync(
  new URL("../src/DesktopWindowFrame.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function readSourceSection(source: string, fileLabel: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `${fileLabel} 缺少源码片段起点：${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `${fileLabel} 缺少源码片段终点：${end}`);
  return source.slice(startIndex, endIndex);
}

function tokenizeClassName(classNameAttr: string): string[] {
  return classNameAttr.split(/\s+/).filter((token) => token.length > 0);
}

// 手机浏览器上 100vh 会把地址栏区域算进高度，设置页根网格比可视区高出一截，
// 超出部分被 h-dvh + overflow:hidden 的祖先裁切，滚动条滚到底也够不到（见 specs/settings-narrow-viewport-layout.md）。
test("设置页根网格用 h-dvh 而不是 h-screen", () => {
  const rootGrid = readSourceSection(
    settingsPageSource,
    "SettingsPage.tsx",
    "data-testid={TID_SETTINGS_PAGE}",
    "{isWindowsDesktop ? <WindowsTopLeftLogo /> : null}",
  );
  const classNameMatch = /className="([^"]*)"/.exec(rootGrid);
  assert.ok(classNameMatch, "设置页根网格必须有 className");
  const tokens = tokenizeClassName(classNameMatch[1]);
  assert.ok(tokens.includes("h-dvh"), "设置页根网格高度必须跟随动态视口（h-dvh）");
  assert.ok(!tokens.includes("h-screen"), "设置页根网格禁止使用 h-screen（100vh）");
  assert.ok(!tokens.includes("min-h-screen"), "设置页根网格禁止使用 min-h-screen");
});

// 两处高度必须同源：外层框架一旦改回 100vh，设置页的 h-dvh 会跟着错位，
// 反之亦然；任一回退都应让测试先响。
test("窗口框架与根样式保持 h-dvh 基准", () => {
  assert.ok(
    windowFrameSource.includes("h-dvh"),
    "DesktopWindowFrame 必须保持 h-dvh（它是设置页高度的基准）",
  );
  assert.ok(stylesSource.includes("100dvh"), "#root 必须保持 100dvh（它是全应用的高度基准）");
});

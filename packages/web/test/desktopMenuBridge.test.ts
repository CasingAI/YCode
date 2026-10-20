import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Web 端没有宿主应用菜单，桌面菜单相关的通道在 Web 端是空实现。
 *
 * 规则见 docs/specs/desktop-application-menu.md「Web 端与手机远控」：
 * 菜单上下文投影没有接收方，渲染进程命令也不会被下发，
 * Web 端不因界面切换改变任何宿主行为。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(HERE, "../src/main.tsx"), "utf-8");

test("Web 平台的菜单通道是空实现", () => {
  assert.match(
    mainSource,
    /syncMenuContext:\s*\(\)\s*=>\s*\{\}/,
    "Web 端必须提供 syncMenuContext 空实现",
  );
  assert.match(
    mainSource,
    /onExecuteUiCommand:\s*\(\)\s*=>\s*\(\)\s*=>\s*\{\}/,
    "Web 端必须提供 onExecuteUiCommand 空实现",
  );
});

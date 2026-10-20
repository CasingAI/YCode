import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, "../src");
const mainSource = readFileSync(resolve(WEB_SRC, "main.tsx"), "utf-8");
const pageSource = readFileSync(resolve(WEB_SRC, "ResourceManagerPage.tsx"), "utf-8");

test("Web 端资源管理器是独立路由，不复用主应用状态", () => {
  assert.match(
    mainSource,
    /const RESOURCE_MANAGER_PATH = "\/resource-manager";/,
    "必须声明资源管理器独立路径",
  );
  assert.match(
    mainSource,
    /window\.location\.pathname === RESOURCE_MANAGER_PATH/,
    "必须按路径分流到资源管理器页面",
  );
  assert.ok(mainSource.includes("<ResourceManagerPage"), "资源管理器路由必须渲染独立页面");
});

test("入口按宿主能力渲染：宿主未声明资源采样时不提供入口", () => {
  assert.match(
    mainSource,
    /resourceUsageAvailable: serverInfo\.capabilities\?\.resourceUsage === true/,
    "宿主能力必须来自 server-info 的能力协商",
  );
  assert.match(
    mainSource,
    /\.\.\.\(options\.resourceUsageAvailable\s*\?\s*\{/,
    "平台能力必须按宿主能力条件挂载",
  );
  assert.match(
    mainSource,
    /window\.open\("\/resource-manager", "ycode-resource-manager"\)/,
    "入口必须打开独立浏览器窗口",
  );
});

test("资源管理器页面只依赖宿主资源采样服务，且文案走 i18n", () => {
  assert.match(pageSource, /services\?\.resourceUsageService/, "页面必须从宿主服务读取资源快照");
  assert.match(pageSource, /service\.getSnapshot\(\)/, "必须调用宿主的资源采样接口");
  assert.match(pageSource, /id: "resourceManager\.unavailable"/, "不可用态必须使用 i18n 文案");
  assert.match(pageSource, /id: "resourceManager\.loading"/, "加载态必须使用 i18n 文案");
});

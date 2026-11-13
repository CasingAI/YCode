import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { findDesktopNativePackageViolations } from "../scripts/desktop-native-package-policy.mjs";

// Host 生命周期清理依赖 koffi 的 win32 native addon，且 native 必须从 app.asar 解包，
// 否则打包产物里 Node 无法 dlopen 它，Windows 容器会静默降级。见
// docs/specs/host-process-containment-cleanup.md。
const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "..", "..");

function readDesktopScript(relativePath: string): string {
  return readFileSync(resolve(desktopRoot, relativePath), "utf8");
}

test("native 策略要求 koffi.node 处于 unpack 状态", () => {
  const unpacked = [
    { packState: "unpack" as const, path: "/node_modules/koffi/build/koffi/win32_x64/koffi.node" },
  ];
  assert.deepEqual(findDesktopNativePackageViolations(unpacked, "win32-x64"), []);

  const packed = [
    { packState: "pack" as const, path: "/node_modules/koffi/build/koffi/win32_x64/koffi.node" },
  ];
  const violations = findDesktopNativePackageViolations(packed, "win32-x64");
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /koffi\.node/);
});

test("koffi 同时进入 electron-builder 与 bundle 的运行时模块清单", () => {
  // 校验与注入必须同口径：只加一边会让 afterPack 注入或 bundle 校验单侧漏掉它。
  const electronBuilderConfig = readDesktopScript("electron-builder.config.js");
  const requiredListMatch = /const REQUIRED_ASAR_RUNTIME_MODULES = \[([\s\S]*?)\n\];/.exec(
    electronBuilderConfig,
  );
  assert.ok(requiredListMatch, "未找到 REQUIRED_ASAR_RUNTIME_MODULES 清单");
  assert.match(requiredListMatch[1] ?? "", /^\s*"koffi",\s*$/m);

  const bundleScript = readDesktopScript("scripts/bundle.mjs");
  const bundleListMatch = /const requiredRuntimeModules = \[([\s\S]*?)\n\];/.exec(bundleScript);
  assert.ok(bundleListMatch, "未找到 requiredRuntimeModules 清单");
  assert.match(bundleListMatch[1] ?? "", /^\s*"koffi",\s*$/m);
});

test("koffi 仍是 services 的运行时依赖，而非 desktop 直连依赖", () => {
  // 出包只补运行时闭包，不在 desktop 重复声明依赖，避免两份版本来源。
  const desktopPackage = JSON.parse(readFileSync(resolve(desktopRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(desktopPackage.dependencies?.koffi, undefined);
  assert.equal(desktopPackage.devDependencies?.koffi, undefined);

  const servicesPackage = JSON.parse(
    readFileSync(resolve(workspaceRoot, "packages", "services", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.ok(servicesPackage.dependencies?.koffi, "koffi 必须继续由 @zcode/services 声明");
});

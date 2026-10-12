#!/usr/bin/env node
// 编译 macOS 关于面板的 endSheet 辅助模块。
// Electron 对 sheet 的 hide() 会先拆窗口再播收场；这个 N-API 模块只调用 AppKit endSheet。
// 非 darwin 跳过。缺 clang / node 头文件时警告不失败，关闭会退回硬切。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-about-sheet", "about-sheet.m");
const outputDir = join(packageRoot, "resources", "macos-about-sheet");
const outputPath = join(outputDir, "about-sheet.node");

if (process.platform !== "darwin") {
  console.log("[about-sheet] 跳过：仅 macOS 需要");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[about-sheet] 源文件缺失：${sourcePath}`);
  process.exit(1);
}

function nodeIncludeDir() {
  try {
    return execFileSync(
      process.execPath,
      [
        "-p",
        "require('node:path').join(require('node:path').dirname(process.execPath), '..', 'include', 'node')",
      ],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "";
  }
}

function hasClang() {
  try {
    execFileSync("xcrun", ["--find", "clang"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const includeDir = nodeIncludeDir();
if (!hasClang() || !includeDir || !existsSync(join(includeDir, "node_api.h"))) {
  console.warn("[about-sheet] 未找到 clang 或 node_api.h；跳过构建。关于面板关闭会退回硬切。");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

function compile(target, output) {
  execFileSync(
    "xcrun",
    [
      "clang",
      "-O2",
      "-fobjc-arc",
      "-shared",
      "-undefined",
      "dynamic_lookup",
      `-I${includeDir}`,
      "-framework",
      "AppKit",
      "-target",
      target,
      sourcePath,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
}

try {
  const arm64 = `${outputPath}-arm64`;
  const x64 = `${outputPath}-x86_64`;
  compile("arm64-apple-macos11", arm64);
  compile("x86_64-apple-macos11", x64);
  execFileSync("lipo", ["-create", arm64, x64, "-output", outputPath], { stdio: "inherit" });
  execFileSync("rm", ["-f", arm64, x64]);
  console.log(`[about-sheet] 已构建 universal 模块：${outputPath}`);
} catch (error) {
  console.warn(
    "[about-sheet] 构建失败；关于面板关闭会退回硬切：",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(0);
}

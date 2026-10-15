#!/usr/bin/env node
/**
 * 守护「剪贴板唯一写入入口」。
 *
 * 产品侧一切写剪贴板必须经 `packages/ui/src/lib/clipboard.ts` 的 writeTextToClipboard；
 * 调用点直连 navigator.clipboard.writeText 会在非安全上下文（远控 http 局域网直连）
 * 静默失败或抛未捕获异常。该约束由 oxlint 覆盖不到——ai-elements 与 components/ui
 * 在 .oxlintrc.json 的 ignorePatterns 里——因此用本脚本兜底，挂到 verify:pre-push。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_ROOT = path.join(ROOT, "packages/ui/src");
// 唯一允许直连的实现文件。
const ALLOWED = path.join(SCAN_ROOT, "lib/clipboard.ts");
const SOURCE_EXT = new Set([".ts", ".tsx"]);
const FORBIDDEN = /navigator\.clipboard\??\.writeText\b/;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const violations = [];
for await (const file of walk(SCAN_ROOT)) {
  if (file === ALLOWED) continue;
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (FORBIDDEN.test(line)) {
      violations.push(`${path.relative(ROOT, file)}:${index + 1}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    "[clipboard] 发现直连 navigator.clipboard.writeText，必须改走 lib/clipboard.ts 的 writeTextToClipboard：",
  );
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log("[clipboard] OK：packages/ui/src 内除 lib/clipboard.ts 外无直连写入");

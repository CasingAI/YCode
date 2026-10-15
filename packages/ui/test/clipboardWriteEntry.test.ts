import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// 唯一写入入口约束见 docs/specs/clipboard-write.md。调用点直连 navigator.clipboard.writeText
// 会在非安全上下文（远控 http 局域网直连）静默失败或抛未捕获异常，必须在源码层阻断。
// oxlint 的 ignorePatterns 排除了 ai-elements 与 components/ui，故不靠 lint，改用本测试守护。

const SRC_ROOT = path.resolve(import.meta.dirname, "../src");
const ALLOWED = path.join(SRC_ROOT, "lib/clipboard.ts");
const FORBIDDEN = /navigator\.clipboard\??\.writeText\b/;

test("packages/ui/src 内除 lib/clipboard.ts 外不得直连 navigator.clipboard.writeText", async () => {
  const entries = await readdir(SRC_ROOT, { recursive: true, withFileTypes: true });
  const violations: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (full === ALLOWED) continue;
    const lines = (await readFile(full, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (FORBIDDEN.test(line)) {
        violations.push(`${path.relative(SRC_ROOT, full)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], `发现直连剪贴板写入：${violations.join(", ")}`);
});

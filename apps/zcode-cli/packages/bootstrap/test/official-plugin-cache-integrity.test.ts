import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isOfficialPluginCacheExact } from "../src/app/bundled-plugins.js";

const MARKER_PATH = ".zcode-plugin-seed.json";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createCache(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "zcode-official-cache-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  writeFileSync(join(root, MARKER_PATH), JSON.stringify({ hash: "test", pluginVersion: "test" }));
  return root;
}

function expectedFiles(files: Record<string, string>): Array<{ path: string; sha256: string }> {
  return Object.entries(files).map(([path, content]) => ({ path, sha256: sha256(content) }));
}

function withCache<T>(root: string, run: () => T): T {
  try {
    return run();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("官方缓存文件集合和内容与 seed 源一致时通过校验", () => {
  const files = {
    ".zcode-plugin/plugin.json": '{"name":"documents","version":"0.1.7"}',
    "agents/visual-judge.md": "# visual judge",
    "skills/docx/SKILL.md": "# docx",
  };
  const root = createCache(files);

  withCache(root, () => {
    assert.equal(isOfficialPluginCacheExact(root, expectedFiles(files)), true);
  });
});

test("官方缓存文件内容被修改时校验失败", () => {
  const files = {
    ".zcode-plugin/plugin.json": '{"name":"documents","version":"0.1.7"}',
    "agents/visual-judge.md": "# visual judge",
  };
  const root = createCache(files);
  writeFileSync(join(root, "agents/visual-judge.md"), "# injected content");

  withCache(root, () => {
    assert.equal(isOfficialPluginCacheExact(root, expectedFiles(files)), false);
  });
});

test("官方缓存出现额外 agent 文件时校验失败", () => {
  const files = {
    ".zcode-plugin/plugin.json": '{"name":"documents","version":"0.1.7"}',
    "agents/visual-judge.md": "# visual judge",
  };
  const root = createCache(files);
  writeFileSync(join(root, "agents/unexpected.md"), "# unexpected");

  withCache(root, () => {
    assert.equal(isOfficialPluginCacheExact(root, expectedFiles(files)), false);
  });
});

test("官方缓存缺少 seed 文件时校验失败", () => {
  const files = {
    ".zcode-plugin/plugin.json": '{"name":"documents","version":"0.1.7"}',
    "agents/visual-judge.md": "# visual judge",
  };
  const root = createCache(files);
  rmSync(join(root, "agents/visual-judge.md"));

  withCache(root, () => {
    assert.equal(isOfficialPluginCacheExact(root, expectedFiles(files)), false);
  });
});

test("官方缓存文件被替换为符号链接时校验失败", { skip: process.platform === "win32" }, () => {
  const files = {
    ".zcode-plugin/plugin.json": '{"name":"documents","version":"0.1.7"}',
    "agents/visual-judge.md": "# visual judge",
  };
  const root = createCache(files);
  const agentPath = join(root, "agents/visual-judge.md");
  const linkedPath = join(root, "agents/linked.md");
  rmSync(agentPath);
  symlinkSync(linkedPath, agentPath);

  withCache(root, () => {
    assert.equal(isOfficialPluginCacheExact(root, expectedFiles(files)), false);
  });
});

test("官方缓存 marker 不能替代实际文件完整性校验", () => {
  const files = {
    ".zcode-plugin/plugin.json": '{"name":"documents","version":"0.1.7"}',
    "agents/visual-judge.md": "# visual judge",
  };
  const root = createCache(files);
  writeFileSync(join(root, "agents/unexpected.md"), "# unexpected");
  assert.notEqual(readFileSync(join(root, MARKER_PATH), "utf8"), "");
  assert.equal(isOfficialPluginCacheExact(root, expectedFiles(files)), false);
});

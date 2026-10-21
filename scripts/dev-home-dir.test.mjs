import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDevHomeDir } from "./dev-home-dir.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("dev home 优先取用户级 ZCODE_DEV_HOME_OVERRIDE", () => {
  assert.equal(
    resolveDevHomeDir({
      ZCODE_DEV_HOME_OVERRIDE: "C:/Users/override",
      ZCODE_DEV_HOME_DIR: "C:/Users/tester",
      HOME: "/home/other",
      USERPROFILE: "C:/Users/other",
    }),
    "C:/Users/override",
  );
});

test("dev home 优先取 mise 注入的 ZCODE_DEV_HOME_DIR", () => {
  assert.equal(
    resolveDevHomeDir({
      ZCODE_DEV_HOME_DIR: "C:/Users/tester",
      HOME: "/home/other",
      USERPROFILE: "C:/Users/other",
    }),
    "C:/Users/tester",
  );
});

test("没有 ZCODE_DEV_HOME_DIR 时依次回退 HOME、USERPROFILE", () => {
  assert.equal(
    resolveDevHomeDir({ HOME: "/home/tester", USERPROFILE: "C:/Users/other" }),
    "/home/tester",
  );
  assert.equal(resolveDevHomeDir({ USERPROFILE: "C:/Users/tester" }), "C:/Users/tester");
});

test("HOME 与 USERPROFILE 都缺失时回退 os.homedir()", () => {
  assert.equal(resolveDevHomeDir({}), homedir());
});

test("空字符串与纯空白视为未设置", () => {
  assert.equal(
    resolveDevHomeDir({ ZCODE_DEV_HOME_DIR: "  ", HOME: "/home/tester" }),
    "/home/tester",
  );
  assert.equal(
    resolveDevHomeDir({ ZCODE_DEV_HOME_DIR: "", HOME: "", USERPROFILE: "  " }),
    homedir(),
  );
});

test("mise.toml 的 dev home 模板带 USERPROFILE 兜底，任务不再直接引用 env.HOME", () => {
  const miseToml = readFileSync(resolve(repoRoot, "mise.toml"), "utf8");
  // 注释里可以出现这个写法（说明为什么不能用），只校验生效的配置行。
  const configLines = miseToml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  // Windows 的 cmd / PowerShell 没有 HOME，直接写 {{env.HOME}} 会让任务解析阶段就失败。
  assert.doesNotMatch(configLines, /\{\{\s*env\.HOME\s*\}\}/);
  assert.match(configLines, /ZCODE_DEV_HOME_DIR\s*=\s*'[^']*env\.HOME[^']*'/);
  assert.match(configLines, /ZCODE_DEV_HOME_DIR\s*=\s*'[^']*env\.USERPROFILE[^']*'/);
  // 用户级环境变量覆盖口：普通同名环境变量压不过 [env]，只能靠模板显式读取。
  assert.match(configLines, /ZCODE_DEV_HOME_DIR\s*=\s*'[^']*env\.ZCODE_DEV_HOME_OVERRIDE[^']*'/);

  const dataBaseDirTemplates = [...configLines.matchAll(/ZCODE_DATA_BASE_DIR\s*=\s*"([^"]*)"/g)];
  assert.equal(dataBaseDirTemplates.length, 3);
  for (const [, template] of dataBaseDirTemplates) {
    assert.match(template, /\{\{env\.ZCODE_DEV_HOME_DIR\}\}/);
  }
});

test("mise.local.toml 被 gitignore，避免把本机路径提交进仓库", () => {
  const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");
  assert.match(gitignore, /^mise\.local\.toml$/m);
});

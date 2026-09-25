import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_VERSION } from "@zcode/shared";
import { resolveAboutAppVersion } from "../src/main/about.js";

// 开发态下开发壳的 Info.plist 只带 Electron 自身版本，用它代表 app.getVersion() 的兜底取值。
const ELECTRON_SHELL_VERSION = "41.0.3";

test("第一级：优先使用打包元数据里的产品版本，不返回 Electron 运行壳版本", () => {
  assert.equal(
    resolveAboutAppVersion({ appVersion: "3.14.0" }, ELECTRON_SHELL_VERSION),
    "3.14.0",
  );
});

test("第一级：打包元数据里 appVersion 为空串时跳过，继续向下一级回退", () => {
  assert.equal(
    resolveAboutAppVersion({ appVersion: "" }, ELECTRON_SHELL_VERSION, "3.14.0"),
    "3.14.0",
  );
});

test("第二级：打包元数据缺少 appVersion 时回退到编译期注入常量", () => {
  assert.equal(
    resolveAboutAppVersion({ buildCommitId: "abc123" }, ELECTRON_SHELL_VERSION, "3.14.0"),
    "3.14.0",
  );
  assert.equal(resolveAboutAppVersion(null, ELECTRON_SHELL_VERSION, "3.14.0"), "3.14.0");
});

test("第三级：前两级都缺失时才回退到 app.getVersion()", () => {
  assert.equal(
    resolveAboutAppVersion(null, ELECTRON_SHELL_VERSION, ""),
    ELECTRON_SHELL_VERSION,
  );
  assert.equal(
    resolveAboutAppVersion({ appVersion: "" }, ELECTRON_SHELL_VERSION, ""),
    ELECTRON_SHELL_VERSION,
  );
});

test("不注入编译期常量时默认使用 ZCODE_VERSION", () => {
  assert.equal(
    resolveAboutAppVersion({ buildCommitId: "abc123" }, ELECTRON_SHELL_VERSION),
    ZCODE_VERSION,
  );
});

test("取值结果始终是非空字符串", () => {
  const results = [
    resolveAboutAppVersion({ appVersion: "3.14.0" }, ELECTRON_SHELL_VERSION, "3.14.0"),
    resolveAboutAppVersion({ appVersion: "" }, ELECTRON_SHELL_VERSION, "3.14.0"),
    resolveAboutAppVersion(null, ELECTRON_SHELL_VERSION, ""),
  ];

  for (const result of results) {
    assert.equal(typeof result, "string");
    assert.ok(result.trim().length > 0, `版本号不应为空，实际为 ${JSON.stringify(result)}`);
  }
});

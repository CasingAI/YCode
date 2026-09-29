import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_UPSTREAM_VERSION } from "@zcode/shared";
import { createRuntimeAiSdkModelExecutionConfig } from "../src/model-config.js";

// 与 shared 侧用例同构：appVersion 取一个与上游不同的值，
// 一条断言同时证明 (like …) 段存在且两个版本互不联动。
const APP_VERSION = "3.14.29";

test("CLI model requests send the YCode product token and upstream alignment", () => {
  const config = createRuntimeAiSdkModelExecutionConfig({}, { appVersion: APP_VERSION });

  assert.equal(
    config.defaultHeaders?.["User-Agent"],
    `YCode/${APP_VERSION} (like ZCode/${ZCODE_UPSTREAM_VERSION})`,
  );
});

test("CLI headers keep the upstream segment when the app version is unknown", () => {
  const config = createRuntimeAiSdkModelExecutionConfig({}, { sourceTitle: "cli" });

  assert.equal(
    config.defaultHeaders?.["User-Agent"],
    `YCode/unknown (like ZCode/${ZCODE_UPSTREAM_VERSION})`,
  );
  assert.equal(config.defaultHeaders?.["X-ZCode-App-Version"], undefined);
});

test("no CLI header falls back to the legacy ZCode/ product token", () => {
  const config = createRuntimeAiSdkModelExecutionConfig({}, { appVersion: APP_VERSION });

  for (const [name, value] of Object.entries(config.defaultHeaders ?? {})) {
    assert.doesNotMatch(value, /^ZCode\//, `${name} 仍是旧产品标识：${value}`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  appSettingsSchema,
  appSettingsPatchSchema,
} from "../../shared/src/validationAppSettings.js";
import { shouldHydrateConversationTurnNavigatorDirectory } from "../src/v4/conversationTurnNavigatorHelpers.js";

// 与 ConversationTurnNavigator 的 CSS container query 门槛（864px）保持一致。
const MIN_WIDTH_PX = 864;

// 对话问题导航是实验特性、默认关闭：既要不影响既有 setting.json（缺字段也解析为
// false），也要保证关闭时不会为它补拉整段会话历史。

test("对话问题导航开关默认关闭", () => {
  const settings = appSettingsSchema.parse({});
  assert.equal(settings.conversationTurnNavigatorEnabled, false);
});

test("对话问题导航开关可作为补丁单独写入", () => {
  assert.equal(appSettingsPatchSchema.parse({}).conversationTurnNavigatorEnabled, undefined);
  assert.equal(
    appSettingsPatchSchema.parse({ conversationTurnNavigatorEnabled: true })
      .conversationTurnNavigatorEnabled,
    true,
  );
});

test("开关关闭时不补齐问题目录历史", () => {
  const base = {
    canLoadOlder: true,
    containerWidthPx: MIN_WIDTH_PX,
    hasLoadHandler: true,
    loadingOlder: false,
  };
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({
      ...base,
      turnNavigatorEnabled: true,
    }),
    true,
  );
  // 即便宽度、可补页、加载器全部就绪，关闭开关也不允许请求全量历史。
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({
      ...base,
      turnNavigatorEnabled: false,
    }),
    false,
  );
});

test("开启后仍受宽度与补页资格约束", () => {
  const base = {
    turnNavigatorEnabled: true,
    canLoadOlder: true,
    hasLoadHandler: true,
    loadingOlder: false,
  };
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({
      ...base,
      containerWidthPx: MIN_WIDTH_PX - 1,
    }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({
      ...base,
      containerWidthPx: MIN_WIDTH_PX,
      loadingOlder: true,
    }),
    false,
  );
  assert.equal(
    shouldHydrateConversationTurnNavigatorDirectory({
      ...base,
      containerWidthPx: MIN_WIDTH_PX,
      canLoadOlder: false,
    }),
    false,
  );
});

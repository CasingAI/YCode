import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOpencodeWorkspaceOption,
  OPENCODE_WORKSPACE_AUTO_VALUE,
  resolveOpencodeWorkspaceTriggerLabel,
  shortenOpencodeWorkspaceId,
} from "../src/settings/model-provider-section/opencodeWorkspaceOptions.js";

// 设置页 Workspace 选择器的展示规则（docs/specs/opencode-usage-quota.md）。
// 触发器的价值就是「不要回显整段 wrk_」——设置卡片宽度有限，
// 选项全文会把选择器撑满并盖掉名称，这里锁定缩短与回退口径。
// 仓库没有 React 渲染测试基建，故只覆盖可判定的纯函数。

const DEFAULT_LABEL = "自动（列表首项）";
const LONG_ID = "wrk_01KZEM26S3A7ZCB12Y77RH4ZKW";
const SHORT_ID = "wrk_01KZEM26";

test("shortenOpencodeWorkspaceId：短 ID 原样返回，长 ID 中间省略且长度可控", () => {
  assert.equal(shortenOpencodeWorkspaceId(SHORT_ID), SHORT_ID);
  const shortened = shortenOpencodeWorkspaceId(LONG_ID);
  assert.equal(shortened, "wrk_01KZEM26…4ZKW");
  assert.ok(shortened.length < LONG_ID.length);
});

test("formatOpencodeWorkspaceOption：名称 + 缩短 ID；名称缺失或等于 ID 时只给 ID", () => {
  assert.equal(formatOpencodeWorkspaceOption("Default", LONG_ID), "Default (wrk_01KZEM26…4ZKW)");
  // host 侧对无名条目回退成 id，空串是本层的防御分支。
  assert.equal(formatOpencodeWorkspaceOption("", LONG_ID), LONG_ID);
  assert.equal(formatOpencodeWorkspaceOption(LONG_ID, LONG_ID), LONG_ID);
});

test("触发器：空选择回显「自动」，有名称时只给名称（不回显选项全文）", () => {
  const options = [{ id: LONG_ID, name: "Default" }];
  assert.equal(resolveOpencodeWorkspaceTriggerLabel("", options, DEFAULT_LABEL), DEFAULT_LABEL);
  assert.equal(resolveOpencodeWorkspaceTriggerLabel(LONG_ID, options, DEFAULT_LABEL), "Default");
});

test("触发器：选择不在列表里（列表未拉到）时退化为缩短 ID，不丢选中值", () => {
  assert.equal(
    resolveOpencodeWorkspaceTriggerLabel(LONG_ID, [], DEFAULT_LABEL),
    "wrk_01KZEM26…4ZKW",
  );
  // 列表里名称就是 ID 的条目同样不重复展示。
  assert.equal(
    resolveOpencodeWorkspaceTriggerLabel(LONG_ID, [{ id: LONG_ID, name: LONG_ID }], DEFAULT_LABEL),
    "wrk_01KZEM26…4ZKW",
  );
});

test("自动项哨兵值非空：Radix SelectItem 不接受空串 value", () => {
  assert.notEqual(OPENCODE_WORKSPACE_AUTO_VALUE, "");
});

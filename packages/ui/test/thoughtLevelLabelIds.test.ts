import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeThoughtLevelText,
  thoughtLevelLabelId,
} from "../src/chat-input-toolbar/thoughtLevelLabelIds.js";

// 这张表是「同一个档位在多处说同一个词」的唯一来源：工具条控件、工作流子代理模型标签、
// 行内编辑卡的冻结档位后缀都查它。拆成无依赖叶子模块后，node --test 可以直接覆盖。

test("规范档位值映射到既有词条", () => {
  assert.equal(thoughtLevelLabelId("high"), "chat.toolbar.thoughtLevel.value.high");
  assert.equal(thoughtLevelLabelId("low"), "chat.toolbar.thoughtLevel.value.low");
  assert.equal(thoughtLevelLabelId("medium"), "chat.toolbar.thoughtLevel.value.medium");
  assert.equal(thoughtLevelLabelId("xhigh"), "chat.toolbar.thoughtLevel.value.xhigh");
});

test("关闭档的多种写法归一到同一个词条", () => {
  for (const value of ["off", "none", "no-think", "no_think", "disabled"]) {
    assert.equal(thoughtLevelLabelId(value), "chat.toolbar.thoughtLevel.value.off", value);
  }
  for (const value of ["on", "enabled", "enable"]) {
    assert.equal(thoughtLevelLabelId(value), "chat.toolbar.thoughtLevel.value.on", value);
  }
});

test("大小写与空白不敏感：provider 送 HIGH 也要说同一个词", () => {
  assert.equal(normalizeThoughtLevelText("  HIGH  "), "high");
  assert.equal(thoughtLevelLabelId("  HIGH  "), "chat.toolbar.thoughtLevel.value.high");
});

test("表里没有的值返回 undefined，调用方原样显示 provider 自己的档位名", () => {
  assert.equal(thoughtLevelLabelId("turbo-3"), undefined);
  assert.equal(thoughtLevelLabelId(""), undefined);
});

test("原型键名不当成档位：不能把构造函数当词条 id 返回", () => {
  for (const value of ["constructor", "toString", "hasOwnProperty"]) {
    assert.equal(thoughtLevelLabelId(value), undefined, value);
  }
});

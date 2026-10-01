import assert from "node:assert/strict";
import { test } from "node:test";
import { formatModelChangeThoughtLabel } from "../src/v4/modelChangeThoughtLabel.js";

/**
 * echo 版 intl：把 id 原文吐出来，断言只关心「查没查表、拼了哪一段」。
 * 分隔符在这里写死成字面量，而不是从被测模块里 import 常量——否则断言的是同一个值，
 * 格式改错了测试也跟着一起错。
 */
const echoIntl = { formatMessage: (descriptor: { id: string }) => descriptor.id };

const label = (modelLabel: string, thought: string | undefined): string =>
  formatModelChangeThoughtLabel({ modelLabel, thought, intl: echoIntl });

test("档位查得到映射时，模型名后面接本地化档位词", () => {
  assert.equal(
    label("OpenCode Go/space-bunny-free", "high"),
    "OpenCode Go/space-bunny-free · chat.toolbar.thoughtLevel.value.high",
  );
});

test("内置档位都走同一张映射表", () => {
  for (const [value, id] of [
    ["low", "chat.toolbar.thoughtLevel.value.low"],
    ["medium", "chat.toolbar.thoughtLevel.value.medium"],
    ["xhigh", "chat.toolbar.thoughtLevel.value.xhigh"],
  ] as const) {
    assert.equal(label("m", value), `m · ${id}`, value);
  }
});

test("映射表里没有的档位原样显示（provider 自定义的档位名）", () => {
  assert.equal(label("m", "turbo-3"), "m · turbo-3");
});

test("档位缺席或只有空白时只说模型名，不留悬空的分隔符", () => {
  assert.equal(label("m", undefined), "m");
  assert.equal(label("m", "   "), "m");
  assert.equal(label("m", ""), "m");
});

test("档位值先 trim 再查表", () => {
  assert.equal(label("m", "  HIGH  "), "m · chat.toolbar.thoughtLevel.value.high");
});

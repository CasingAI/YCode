// 自动化失败原因展示（docs/specs/automation-failure-reason-display.md）：
// - 展示文本纯函数：trim、剥 [reason=…] 诊断后缀、空文本返回 null；
// - 两张任务卡（定时/延时与闲时）在失败态渲染原因行，行高放开为下限 132px。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { automationFailureDetailText } from "@/settings/automationFormat.js";

async function readUiSource(relativePath: string): Promise<string> {
  return (await readFile(new URL(`../src/${relativePath}`, import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );
}

test("空文本与纯空白返回 null，卡片不渲染原因行", () => {
  assert.equal(automationFailureDetailText(undefined), null);
  assert.equal(automationFailureDetailText(null), null);
  assert.equal(automationFailureDetailText(""), null);
  assert.equal(automationFailureDetailText("   "), null);
});

test("普通失败原因原样返回并去首尾空白", () => {
  assert.equal(
    automationFailureDetailText("Automation 模型选择不可用，请重新选择模型与思考档位"),
    "Automation 模型选择不可用，请重新选择模型与思考档位",
  );
  assert.equal(automationFailureDetailText("  派发超时  "), "派发超时");
});

test("剥掉跨进程诊断的 [reason=…] 后缀，只留人话文本", () => {
  assert.equal(
    automationFailureDetailText("模型组「team」没有可用模型 [reason=modelGroup.noMembers]"),
    "模型组「team」没有可用模型",
  );
  // 正文剥空时退回原文，避免展示空白。
  assert.equal(
    automationFailureDetailText("[reason=modelGroup.noMembers]"),
    "[reason=modelGroup.noMembers]",
  );
});

test("定时/延时任务卡渲染失败原因行并放开行高下限", async () => {
  const source = await readUiSource("settings/AutomationsSection.tsx");
  assert.match(source, /automationFailureDetailText\(automation\.lastError\)/);
  assert.match(
    source,
    /data-testid=\{TID_AUTOMATION_CARD_FAILURE_DETAIL\}\n\s*className="line-clamp-2 text-ui-base font-normal leading-5 text-destructive"/,
  );
  assert.match(source, /auto-rows-\[minmax\(132px,auto\)\]/);
  assert.doesNotMatch(source, /auto-rows-\[132px\]/);
});

test("闲时任务卡在失败态渲染失败原因行并放开行高下限", async () => {
  const source = await readUiSource("settings/OffPeakTaskList.tsx");
  assert.match(
    source,
    /task\.status === "failed" \? automationFailureDetailText\(task\.failureReason\) : null/,
  );
  assert.match(
    source,
    /data-testid=\{TID_AUTOMATION_CARD_FAILURE_DETAIL\}\n\s*className="line-clamp-2 text-ui-base font-normal leading-snug text-destructive"/,
  );
  assert.match(source, /auto-rows-\[minmax\(132px,auto\)\]/);
  assert.doesNotMatch(source, /auto-rows-\[132px\]/);
});

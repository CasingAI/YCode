import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  SUBAGENT_FOOTER_CONTAINER,
  SUBAGENT_FOOTER_TEST_IDS,
  resolveSubagentFooterBreakdown,
  SubagentStatusFooter,
} from "../src/v4/SubagentStatusFooter.js";
import type { ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

function makeSnapshot(
  overrides: {
    sessionId?: string;
    mode?: string;
    provider?: string;
    model?: string;
    thought?: string;
    usedTokens?: number | null;
    maxTokens?: number | null;
    breakdown?: Array<{ source: string; chars: number; tokens?: number }> | null;
  } = {},
): ConversationSnapshot {
  const {
    sessionId = "child_1",
    mode = "yolo",
    provider = "glm",
    model = "glm-4.7",
    thought = "high",
    usedTokens = 20_000,
    maxTokens = 200_000,
    breakdown = null,
  } = overrides;
  return {
    sessionId,
    seq: 1,
    config: {
      provider,
      model,
      thought,
      thoughtLevels: [],
      followupMode: "queue",
      mode,
    },
    usage: {
      contextWindow:
        usedTokens === null || maxTokens === null
          ? null
          : {
              usedTokens,
              maxTokens,
              autoCompactThresholdTokens: null,
              ...(breakdown ? { breakdown } : {}),
            },
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  } as unknown as ConversationSnapshot;
}

function renderFooter(
  snapshot: ConversationSnapshot | null | undefined,
  sessionId: string | null,
  locale: "zh-CN" | "en-US" = "zh-CN",
): string {
  const element = createElement(SubagentStatusFooter, {
    snapshot,
    sessionId,
  }) as ReactElement;
  return renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: locale }, element));
}

function getDataAttr(markup: string, name: string): string | null {
  const match = new RegExp(`data-${name}="([^"]*)"`).exec(markup);
  return match ? (match[1] ?? null) : null;
}

// 取 data-testid 所在元素的 class 属性值。
function getClassByTestId(markup: string, testId: string): string | null {
  const tagMatch = new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(markup);
  if (!tagMatch) return null;
  const classMatch = /class="([^"]*)"/.exec(tagMatch[0]);
  return classMatch ? (classMatch[1] ?? null) : null;
}

// 校验 class 里每个 @max-[…]/<name> 变体的容器名后缀都 === 常量。
// 容器声明与变体引用各自手写字符串时，一处笔误即静默失效，故逐个断言后缀。
function assertContainerSuffix(classValue: string | null, cellName: string): void {
  assert.ok(classValue !== null, `${cellName}应有 class`);
  const suffixes = [...classValue.matchAll(/@max-\[[^\]]+\]\/([^\s:]+)/g)].map((match) => match[1]);
  assert.ok(suffixes.length > 0, `${cellName}应挂至少一个容器 query 变体`);
  for (const suffix of suffixes) {
    assert.equal(suffix, SUBAGENT_FOOTER_CONTAINER, `${cellName}的容器名后缀错配`);
  }
}

// 模型格的 class：模型格是唯一带 title="<provider>/<model>" 的 span，
// 降级隐藏类挂在它身上（模型名自身不挂降级类）。
function getModelCellClass(markup: string, modelId: string): string | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagMatch = new RegExp(`<span[^>]*title="[^"]*${escaped}"[^>]*>`).exec(markup);
  if (!tagMatch) return null;
  const classMatch = /class="([^"]*)"/.exec(tagMatch[0]);
  return classMatch ? (classMatch[1] ?? null) : null;
}

// 数据取子会话自己的快照：mode/model/thought/usage 四个锚点都落在子快照的值上。
test("footer 四项锚点都读子会话快照", () => {
  const markup = renderFooter(
    makeSnapshot({ mode: "plan", model: "glm-4.7", thought: "high" }),
    "child_1",
  );
  assert.equal(getDataAttr(markup, "subagent-footer-mode"), "plan");
  assert.equal(getDataAttr(markup, "subagent-footer-provider"), "glm");
  assert.equal(getDataAttr(markup, "subagent-footer-model"), "glm-4.7");
  assert.equal(getDataAttr(markup, "subagent-footer-thought"), "high");
  assert.equal(getDataAttr(markup, "subagent-footer-usage-used"), "20000");
  assert.equal(getDataAttr(markup, "subagent-footer-usage-max"), "200000");
  // 模式显示名：plan → Plan；思考档本地化：high → 高（裸档位词展示）。
  assert.ok(markup.includes(`data-testid="${SUBAGENT_FOOTER_TEST_IDS.mode}"`));
  assert.ok(markup.includes(">Plan<"));
  assert.ok(markup.includes("· 高"));
});

// 快照身份与 sessionId 对不上时按空态处理，禁止回退父会话数值。
test("快照身份不匹配时不回退父会话数值", () => {
  const parentSnapshot = makeSnapshot({
    sessionId: "parent_9",
    mode: "bare",
    model: "parent-model",
  });
  const markup = renderFooter(parentSnapshot, "child_1");
  assert.equal(getDataAttr(markup, "subagent-footer-mode"), "yolo");
  assert.equal(getDataAttr(markup, "subagent-footer-model"), "");
  assert.equal(getDataAttr(markup, "subagent-footer-usage-used"), "");
});

// getRenderableTaskUsage 口径：used=0 时隐藏用量格，不渲染 0% 假数据。
test("used=0 时用量格隐藏不显示假数据", () => {
  const markup = renderFooter(makeSnapshot({ usedTokens: 0 }), "child_1");
  assert.equal(getDataAttr(markup, "subagent-footer-usage-used"), "");
  assert.ok(!markup.includes(SUBAGENT_FOOTER_TEST_IDS.usageUsed));
  assert.ok(markup.includes("上下文 --"));
});

// 只读无交互：footer 内没有任何 button / select / input / a 元素。
test("footer 只读无可交互元素", () => {
  const markup = renderFooter(makeSnapshot(), "child_1");
  assert.ok(markup.includes(`data-testid="${SUBAGENT_FOOTER_TEST_IDS.root}"`));
  assert.ok(!/<button[\s>]/.test(markup), "footer 不应渲染 button");
  assert.ok(!/<select[\s>]/.test(markup), "footer 不应渲染 select");
  assert.ok(!/<input[\s>]/.test(markup), "footer 不应渲染 input");
  assert.ok(!/<a[\s>]/.test(markup), "footer 不应渲染 a");
});

// 分级降级：container 声明落在 footer 根元素上；模型格挂 ≤320px 隐藏、
// 模式格挂 ≤220px 隐藏、上下文格不含任何 @max- 降级类、常驻显示。
// 阈值 320 > 220 保证模型先消失、模式后消失。
// 容器名以后缀形式逐一校验（必须 === SUBAGENT_FOOTER_CONTAINER）：
// 三处 class 若与常量错配，Tailwind 生成的 container query 互不关联，
// 样式静默失效而 SSR 仍全绿，故不能只做 includes 整串匹配。
test("分级降级类名挂载正确且顺序为模型先消失", () => {
  const markup = renderFooter(makeSnapshot(), "child_1");
  const rootClass = getClassByTestId(markup, SUBAGENT_FOOTER_TEST_IDS.root);
  assert.ok(
    rootClass?.includes(`@container/${SUBAGENT_FOOTER_CONTAINER}`),
    "footer 根必须是自己的 container",
  );
  const modeClass = getClassByTestId(markup, SUBAGENT_FOOTER_TEST_IDS.mode);
  assert.ok(
    modeClass?.includes(`@max-[220px]/${SUBAGENT_FOOTER_CONTAINER}:hidden`),
    "模式格应在 ≤220px 隐藏",
  );
  assert.ok(
    !modeClass?.includes(`@max-[320px]/${SUBAGENT_FOOTER_CONTAINER}`),
    "模式格不应挂 320px 档",
  );
  assertContainerSuffix(modeClass, "模式格");
  const modelClass = getClassByTestId(markup, SUBAGENT_FOOTER_TEST_IDS.model);
  const modelCellClass = getModelCellClass(markup, "glm-4.7");
  assert.ok(
    modelCellClass?.includes(`@max-[320px]/${SUBAGENT_FOOTER_CONTAINER}:hidden`),
    "模型格应在 ≤320px 隐藏",
  );
  assert.ok(
    !modelCellClass?.includes(`@max-[220px]/${SUBAGENT_FOOTER_CONTAINER}`),
    "模型格不应挂 220px 档",
  );
  assertContainerSuffix(modelCellClass, "模型格");
  assert.ok(!modelClass?.includes("@max-"), "模型名自身不应挂降级类");
  const usageTriggerClass = getClassByTestId(markup, "subagent-status-footer-usage-trigger");
  assert.ok(usageTriggerClass !== null, "上下文格应常驻显示");
  assert.ok(!usageTriggerClass?.includes("@max-"), "上下文格不应有任何降级档");
});

// 明细排序与输入框面板一致：直接调 footer 组件实际使用的
// resolveSubagentFooterBreakdown（与组件同一函数），输出 chars 降序，tie 按来源固定序。
// 注：hover 明细经 Radix Portal 渲染，不进 SSR 静态标记，这里断言组件所调的同一函数。
test("上下文明细排序与输入框面板一致", () => {
  const breakdown: ZCodeContextUsageBreakdownItem[] = [
    { source: "messages", chars: 500 },
    { source: "system_tool_schemas", chars: 4_000 },
    { source: "skills", chars: 4_000 },
  ];
  const segments = resolveSubagentFooterBreakdown(breakdown, 20_000);
  // skills(4000) 与 system_tool_schemas(4000) tie，按来源序 skills(3) < system_tool_schemas(5)；
  // messages(500) 最小垫底。
  assert.deepEqual(
    segments.map((segment) => segment.source),
    ["skills", "system_tool_schemas", "messages"],
  );
});

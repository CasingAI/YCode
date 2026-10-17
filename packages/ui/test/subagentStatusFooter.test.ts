import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ContextUsageDetails } from "../src/chat-input-toolbar/ContextUsageDisplay.js";
import {
  SUBAGENT_FOOTER_CONTAINER,
  SUBAGENT_FOOTER_TEST_IDS,
  SubagentContextUsageEmptyState,
  SubagentStatusFooter,
} from "../src/v4/SubagentStatusFooter.js";
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
    breakdown?: Array<{
      source: string;
      chars: number;
      tokens?: number;
    }> | null;
    cacheHitRate?: number | null;
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
    cacheHitRate = null,
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
              cache:
                cacheHitRate === null ? undefined : { hitRate: cacheHitRate },
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
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale }, element),
  );
}

function getDataAttr(markup: string, name: string): string | null {
  const match = new RegExp(`data-${name}="([^"]*)"`).exec(markup);
  return match ? (match[1] ?? null) : null;
}

// 取 data-testid 所在元素的 class 属性值。
function getClassByTestId(markup: string, testId: string): string | null {
  const tagMatch = new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`).exec(
    markup,
  );
  if (!tagMatch) return null;
  const classMatch = /class="([^"]*)"/.exec(tagMatch[0]);
  return classMatch ? (classMatch[1] ?? null) : null;
}

// 校验 class 里每个 @max-[…]/<name> 变体的容器名后缀都 === 常量。
// 容器声明与变体引用各自手写字符串时，一处笔误即静默失效，故逐个断言后缀。
function assertContainerSuffix(
  classValue: string | null,
  cellName: string,
): void {
  assert.ok(classValue !== null, `${cellName}应有 class`);
  const suffixes = [...classValue.matchAll(/@max-\[[^\]]+\]\/([^\s:]+)/g)].map(
    (match) => match[1],
  );
  assert.ok(suffixes.length > 0, `${cellName}应挂至少一个容器 query 变体`);
  for (const suffix of suffixes) {
    assert.equal(
      suffix,
      SUBAGENT_FOOTER_CONTAINER,
      `${cellName}的容器名后缀错配`,
    );
  }
}

// 模型格的 class：模型格是唯一带 title="<provider>/<model>" 的 span，
// 降级隐藏类挂在它身上（模型名自身不挂降级类）。
function getModelCellClass(markup: string, modelId: string): string | null {
  const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagMatch = new RegExp(`<span[^>]*title="[^"]*${escaped}"[^>]*>`).exec(
    markup,
  );
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

test("readonly 子会话底栏显示 Ask", () => {
  const markup = renderFooter(makeSnapshot({ mode: "readonly" }), "child_1");

  assert.equal(getDataAttr(markup, "subagent-footer-mode"), "readonly");
  assert.ok(markup.includes(">Ask<"));
  assert.ok(!markup.includes(">Agent<"));
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

// 缺少或无效的子会话用量时，入口仍显示空圆环，浮层只说明暂无用量。
test("无用量数据时仍显示空圆环和可访问的空态详情", () => {
  for (const snapshot of [
    makeSnapshot({ usedTokens: 0 }),
    makeSnapshot({ usedTokens: 20_000, maxTokens: 0 }),
    null,
    makeSnapshot({ sessionId: "parent_9" }),
  ]) {
    const markup = renderFooter(snapshot, "child_1");
    assert.ok(
      markup.includes('data-testid="subagent-status-footer-usage-trigger"'),
    );
    assert.equal((markup.match(/<button[\s>]/g) ?? []).length, 1);
    assert.ok(markup.includes('aria-label="暂无子会话用量"'));
    assert.ok(markup.includes("<svg"), "无数据时圆环入口仍存在");
    assert.equal(getDataAttr(markup, "subagent-footer-usage-used"), "");
    assert.ok(!markup.includes("上下文 --"));
    assert.ok(!markup.includes("20K/0"));
  }
});

test("空态详情独立渲染本地化说明且不包含虚构容量数字", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SubagentContextUsageEmptyState, {
        message: "暂无子会话用量",
      }),
    ),
  );
  assert.ok(markup.includes("暂无子会话用量"));
  assert.ok(!/\d+\s*(?:K|万|%)/.test(markup));
});

test("无快照时英文空态保持本地化", () => {
  const markup = renderFooter(null, "child_1", "en-US");
  assert.ok(markup.includes("No subagent usage yet"));
  assert.ok(!markup.includes("暂无子会话用量"));
});

test("有效用量仍显示原有容量详情锚点", () => {
  const markup = renderFooter(makeSnapshot(), "child_1");
  assert.equal(getDataAttr(markup, "subagent-footer-usage-used"), "20000");
  assert.equal(getDataAttr(markup, "subagent-footer-usage-max"), "200000");
  assert.ok(markup.includes('aria-label="上下文已用 20,000 / 总量 200,000"'));
});

// footer 可以点击用量按钮打开详情；其余区域不引入配置控件或导航链接。
test("footer 仅上下文用量使用按钮触发详情", () => {
  const markup = renderFooter(makeSnapshot(), "child_1");
  assert.ok(markup.includes(`data-testid="${SUBAGENT_FOOTER_TEST_IDS.root}"`));
  assert.equal(
    (markup.match(/<button[\s>]/g) ?? []).length,
    1,
    "上下文圆环应由按钮触发",
  );
  assert.ok(!/<select[\s>]/.test(markup), "footer 不应渲染 select");
  assert.ok(!/<input[\s>]/.test(markup), "footer 不应渲染 input");
  assert.ok(!/<a[\s>]/.test(markup), "footer 不应渲染 a");
  assert.ok(markup.includes("hover:bg-hover"), "上下文按钮应保留交互反馈");
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
    modelCellClass?.includes(
      `@max-[320px]/${SUBAGENT_FOOTER_CONTAINER}:hidden`,
    ),
    "模型格应在 ≤320px 隐藏",
  );
  assert.ok(
    !modelCellClass?.includes(`@max-[220px]/${SUBAGENT_FOOTER_CONTAINER}`),
    "模型格不应挂 220px 档",
  );
  assertContainerSuffix(modelCellClass, "模型格");
  assert.ok(!modelClass?.includes("@max-"), "模型名自身不应挂降级类");
  const usageTriggerClass = getClassByTestId(
    markup,
    "subagent-status-footer-usage-trigger",
  );
  assert.ok(usageTriggerClass !== null, "上下文格应常驻显示");
  assert.ok(!usageTriggerClass?.includes("@max-"), "上下文格不应有任何降级档");
});

// footer 触发器只显示圆环；共享详情组件单独渲染验证分段、缓存命中率与排序。
test("footer 使用共享圆环触发器和上下文详情", () => {
  const footerMarkup = renderFooter(makeSnapshot(), "child_1");
  const trigger =
    new RegExp(
      `<[^>]*data-testid="subagent-status-footer-usage-trigger"[^>]*>(.*?)</[^>]+>`,
    ).exec(footerMarkup)?.[1] ?? "";
  assert.ok(trigger.includes("<svg"), "触发器应显示用量圆环");
  assert.ok(!/\d+(?:\.\d+)?%/.test(trigger), "footer 触发器不应显示百分比文字");

  const detailsMarkup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ContextUsageDetails, {
        usedTokens: 20_000,
        maxTokens: 200_000,
        breakdown: [
          { source: "messages", chars: 500 },
          { source: "system_tool_schemas", chars: 4_000 },
          { source: "skills", chars: 4_000 },
        ],
        cacheHitRate: 0.5,
      }),
    ),
  );
  assert.ok(detailsMarkup.includes("缓存命中率"));
  assert.ok(detailsMarkup.includes("技能"));
  assert.ok(detailsMarkup.includes("系统工具"));
  assert.ok(detailsMarkup.includes("消息"));
  assert.ok(
    detailsMarkup.indexOf("技能") < detailsMarkup.indexOf("系统工具"),
    "相同字符量按共享来源顺序排序",
  );
  assert.ok(
    detailsMarkup.indexOf("系统工具") < detailsMarkup.indexOf("消息"),
    "较大字符量排在较小字符量前",
  );
});

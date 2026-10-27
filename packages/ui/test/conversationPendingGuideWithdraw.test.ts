import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../src/lib/codePreviewSettings.js";
import type { ConversationRowRenderContext } from "../src/v4/conversationRowContext.js";
import { ConversationPendingGuideList } from "../src/v4/ConversationPendingGuideList.js";

// 撤回必须走独立 onWithdraw（历史 onEdit 是编辑重发该轮）；无 DOM 基建，
// 这里用静态渲染锁入口显隐/禁用，并用源码断言锁 SessionPane 与 Timeline 的真实接线。
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const context: ConversationRowRenderContext = {
  workspacePath: "/workspace",
  theme: "light",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};

function pendingGuide(options: {
  id: string;
  admissionSeq?: number;
  dispatchState?: QueueItem["dispatch"]["state"];
}): QueueItem {
  return {
    sourceCommandId: `cmd-${options.id}`,
    queueItemId: options.id,
    clientId: "client-test",
    kind: "sendText",
    text: `正文-${options.id}`,
    attachments: [],
    delivery: { requested: "guide", admitted: "guide" },
    order: { admissionSeq: options.admissionSeq ?? 1, queuePosition: 1 },
    steer: { state: "notRequested" },
    dispatch: { state: options.dispatchState ?? "queued" },
    admittedAt: 1,
  } as QueueItem;
}

function renderList(options: {
  items?: readonly QueueItem[];
  onWithdraw?: (queueItemId: string) => void;
  withdrawDisabled?: boolean;
  locale?: "zh-CN" | "en-US";
}): string {
  return renderToStaticMarkup(
    createElement(
      ServiceProvider,
      { services: {} as IServiceAccessor },
      createElement(
        PlatformProvider,
        { platform: {} as IPlatformService },
        createElement(
          TooltipProvider,
          null,
          createElement(
            ZCodeIntlProvider,
            { initialLocale: options.locale ?? "zh-CN" },
            createElement(ConversationPendingGuideList, {
              context,
              items: options.items ?? [pendingGuide({ id: "guide-1", admissionSeq: 2 })],
              turnId: "turn-1",
              ...(options.onWithdraw ? { onWithdraw: options.onWithdraw } : {}),
              ...(options.withdrawDisabled !== undefined
                ? { withdrawDisabled: options.withdrawDisabled }
                : {}),
            }),
          ),
        ),
      ),
    ),
  );
}

/** 取出指定 testid 的 <button ...> 开标签，用于断言 disabled 等属性。 */
function buttonTag(markup: string, testId: string): string | undefined {
  const pattern = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`);
  return pattern.exec(markup)?.[0];
}

/** 只看 disabled 属性，不误判 class 里的 disabled:* 工具类。 */
function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|(?=[\s>]))/.test(tag);
}

test("提供 onWithdraw 时待引导行渲染撤回入口", () => {
  const markup = renderList({ onWithdraw: () => undefined });

  // rowId = -(admissionSeq + 1)
  const tag = buttonTag(markup, "v4-withdraw--3");
  assert.ok(tag, "待引导行必须渲染撤回按钮");
  assert.match(markup, /撤回/, "撤回按钮必须有无障碍文案");
  assert.equal(isDisabled(tag), false, "dispatch=queued 时撤回可用");
});

test("未提供 onWithdraw（只读/分享视图）时不渲染撤回入口", () => {
  const markup = renderList({});

  assert.doesNotMatch(markup, /v4-withdraw/);
  assert.doesNotMatch(markup, /撤回/);
});

test("撤回入口不借用历史消息编辑入口", () => {
  const markup = renderList({ onWithdraw: () => undefined });

  assert.doesNotMatch(markup, /v4-edit-/, "待引导行不得出现历史 onEdit 入口");
  assert.equal(buttonTag(markup, "v4-edit--3"), undefined);
});

test("dispatch.state 非 queued 时撤回入口禁用", () => {
  for (const dispatchState of ["reserved", "promoting"] as const) {
    const markup = renderList({
      items: [pendingGuide({ id: "guide-1", admissionSeq: 2, dispatchState })],
      onWithdraw: () => undefined,
    });
    const tag = buttonTag(markup, "v4-withdraw--3");
    assert.ok(tag, `${dispatchState} 时仍应保留入口（禁用而不是消失）`);
    assert.ok(isDisabled(tag), `${dispatchState} 时撤回必须禁用`);
  }
});

test("队列编辑操作进行中时禁用所有撤回", () => {
  const markup = renderList({ onWithdraw: () => undefined, withdrawDisabled: true });
  const tag = buttonTag(markup, "v4-withdraw--3");

  assert.ok(tag);
  assert.ok(isDisabled(tag));
});

test("英文文案为 Withdraw", () => {
  const markup = renderList({ onWithdraw: () => undefined, locale: "en-US" });

  assert.match(markup, /Withdraw/);
});

test("复制入口保持存在，撤回只是新增动作", () => {
  const markup = renderList({ onWithdraw: () => undefined });

  assert.ok(buttonTag(markup, "v4-copy--3"), "复制入口不能被撤回替换");
  assert.ok(buttonTag(markup, "v4-withdraw--3"));
});

test("PendingGuideList 按项传 queueItemId 与 dispatch 禁用，且不接历史 onEdit", () => {
  const list = read("../src/v4/ConversationPendingGuideList.tsx");
  const start = list.indexOf("<ConversationTurnRow");
  const block = list.slice(start, list.indexOf("/>", start));

  assert.ok(block.includes("onWithdraw: () => onWithdraw(item.queueItemId)"));
  assert.ok(
    block.includes('withdrawDisabled={withdrawDisabled || item.dispatch.state !== "queued"}'),
  );
  assert.ok(!block.includes("onEdit"), "待引导行不得借用历史编辑入口");
});

test("Timeline 把撤回 callback 与禁用态转发给 pending guide 列表", () => {
  const timeline = read("../src/v4/ConversationTimeline.tsx");
  assert.match(timeline, /onWithdrawPendingGuide\?: \(queueItemId: string\) => void;/);
  assert.match(timeline, /withdrawPendingGuideDisabled\?: boolean;/);

  const start = timeline.indexOf("<ConversationPendingGuideList");
  const block = timeline.slice(start, timeline.indexOf("/>", start));
  assert.ok(block.includes("onWithdraw: onWithdrawPendingGuide"));
  assert.ok(block.includes("withdrawDisabled: withdrawPendingGuideDisabled"));
});

test("SessionPane 复用 handleEditQueueItem，并用 editActionsEnabled/queueEditOperation 门禁", () => {
  const pane = read("../src/v4/SessionPane.tsx");
  assert.match(
    pane,
    /onWithdrawPendingGuide=\{editActionsEnabled \? handleEditQueueItem : undefined\}/,
  );
  assert.match(pane, /withdrawPendingGuideDisabled=\{queueEditOperation !== null\}/);

  // 撤回不得另写删除/回填路径：入口必须指向既有 handleEditQueueItem。
  const start = pane.indexOf("const handleEditQueueItem = useCallback(");
  assert.ok(start >= 0, "handleEditQueueItem 必须存在");
  const block = pane.slice(start, pane.indexOf("const handleSendQueuedNow", start));
  assert.match(block, /dispatchCommand\(\s*"deleteQueueItem"/);
  assert.match(block, /setComposerRestoreRequest\(/);
});

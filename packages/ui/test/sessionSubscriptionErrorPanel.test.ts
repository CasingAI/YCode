import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TID_V4_RETRY_SUBSCRIBE,
  TID_V4_SUBSCRIPTION_ERROR_DETAILS,
  TID_V4_SUBSCRIPTION_ERROR_PANEL,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  SessionSubscriptionErrorNotice,
  SessionSubscriptionErrorPanel,
} from "../src/v4/SessionSubscriptionErrorPanel.js";

// 面板 SSR 渲染：分级两档的按钮可见性与去噪展示
// （docs/specs/session-subscription-error-panel.md）。

const SESSION_NOT_FOUND_ERROR =
  "Session is not active and not persisted: sess_abc (fault.subscribe.sessionNotFound)";
const RESUME_FAILED_ERROR =
  "Failed to resume persisted session sess_abc: boom (fault.subscribe.resumeFailed)";

function render(element: ReactElement): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, element),
  );
}

function renderPanel(error: string): string {
  return render(
    createElement(SessionSubscriptionErrorPanel, {
      error,
      sessionId: "sess_abc",
      workspacePath: "/repo",
      onReconnect: () => {},
    }) as ReactElement,
  );
}

test("sessionNotFound：人话标题、无重新连接、保留反馈与查看详情", () => {
  const markup = renderPanel(SESSION_NOT_FOUND_ERROR);
  assert.match(markup, new RegExp(`data-testid="${TID_V4_SUBSCRIPTION_ERROR_PANEL}"`));
  assert.match(markup, /data-subscription-error-kind="sessionEnded"/);
  assert.match(markup, /该会话已结束，无法重新连接/);
  assert.doesNotMatch(markup, new RegExp(`data-testid="${TID_V4_RETRY_SUBSCRIBE}"`));
  assert.match(markup, new RegExp(`data-testid="${TID_V4_SUBSCRIPTION_ERROR_DETAILS}"`));
  assert.match(markup, /反馈问题/);
});

test("sessionNotFound：原始英文错误不在初始 markup 里（收进查看详情）", () => {
  const markup = renderPanel(SESSION_NOT_FOUND_ERROR);
  assert.doesNotMatch(markup, /Session is not active/);
  assert.doesNotMatch(markup, /font-mono/);
  assert.doesNotMatch(markup, /text-destructive/);
});

test("resumeFailed：保留重新连接与反馈，标题为连接断开", () => {
  const markup = renderPanel(RESUME_FAILED_ERROR);
  assert.match(markup, /data-subscription-error-kind="disconnected"/);
  assert.match(markup, /与代理的连接已断开/);
  assert.match(markup, new RegExp(`data-testid="${TID_V4_RETRY_SUBSCRIBE}"`));
  assert.match(markup, /反馈问题/);
  assert.match(markup, new RegExp(`data-testid="${TID_V4_SUBSCRIPTION_ERROR_DETAILS}"`));
});

test("紧凑横幅：与完整面板同一分级，且不渲染二级说明", () => {
  const endedNotice = render(
    createElement(SessionSubscriptionErrorNotice, {
      error: SESSION_NOT_FOUND_ERROR,
      sessionId: "sess_abc",
      workspacePath: "/repo",
      onReconnect: () => {},
    }) as ReactElement,
  );
  assert.match(
    endedNotice,
    new RegExp(`data-testid="${TID_V4_SUBSCRIPTION_ERROR_PANEL}"`),
  );
  assert.match(endedNotice, /data-subscription-error-kind="sessionEnded"/);
  assert.doesNotMatch(endedNotice, new RegExp(`data-testid="${TID_V4_RETRY_SUBSCRIBE}"`));
  assert.doesNotMatch(endedNotice, /会话已从当前运行环境移除/);

  const lostNotice = render(
    createElement(SessionSubscriptionErrorNotice, {
      error: RESUME_FAILED_ERROR,
      sessionId: "sess_abc",
      workspacePath: "/repo",
      onReconnect: () => {},
    }) as ReactElement,
  );
  assert.match(lostNotice, new RegExp(`data-testid="${TID_V4_RETRY_SUBSCRIBE}"`));
});

test("英文 locale：标题与按钮文案本地化", () => {
  const markup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(SessionSubscriptionErrorPanel, {
        error: SESSION_NOT_FOUND_ERROR,
        sessionId: "sess_abc",
        workspacePath: "/repo",
        onReconnect: () => {},
      }) as ReactElement,
    ),
  );
  assert.match(markup, /This session has ended and cannot be reconnected/);
  assert.match(markup, /Report issue/);
  assert.doesNotMatch(markup, new RegExp(`data-testid="${TID_V4_RETRY_SUBSCRIBE}"`));
});

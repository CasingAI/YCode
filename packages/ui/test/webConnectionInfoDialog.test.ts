import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WebConnectionInfo } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WebConnectionInfoContent } from "../src/WebConnectionInfoContent.js";
import type { ServiceConnectionStatus } from "../src/root/types.js";

/** 内容组件独立渲染；菜单接线见 workspaceShellChromeConnectionInfoEntry.test.ts。 */

const dialogSource = readFileSync(
  new URL("../src/WebConnectionInfoDialog.tsx", import.meta.url),
  "utf8",
);

function info(overrides: Partial<WebConnectionInfo> = {}): WebConnectionInfo {
  return {
    transport: "websocket",
    directState: "disabled",
    endpoint: "wss://remote.example.com",
    ...overrides,
  };
}

function render({
  status = "connected",
  connectionInfo = info(),
  locale = "zh-CN" as const,
}: {
  status?: ServiceConnectionStatus;
  connectionInfo?: WebConnectionInfo;
  locale?: "zh-CN" | "en-US";
} = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WebConnectionInfoContent, { status, connectionInfo }),
    ),
  );
}

test("四种连接状态分别使用既有事实文案", () => {
  const expected: Record<ServiceConnectionStatus, string> = {
    connecting: "正在连接",
    connected: "已连接",
    reconnecting: "正在重新连接",
    closed: "已断开",
  };
  for (const [status, label] of Object.entries(expected)) {
    const markup = render({ status: status as ServiceConnectionStatus });
    assert.match(markup, /data-testid="web-connection-info-status"/);
    assert.ok(markup.includes(label), `连接状态 ${status} 必须显示「${label}」`);
  }
});

test("三种业务通道与五种直连状态各有独立文案", () => {
  const transports = {
    websocket: "WebSocket",
    webrtc: "WebRTC 直连",
    null: "暂无活动连接",
  } as const;
  for (const [transport, label] of Object.entries(transports)) {
    const markup = render({
      connectionInfo: info({
        transport: transport === "null" ? null : (transport as "websocket" | "webrtc"),
      }),
    });
    assert.ok(markup.includes(label), `业务通道 ${transport} 必须显示「${label}」`);
  }

  const directStates = {
    disabled: "未启用直连",
    waiting: "等待基础连接",
    connecting: "正在尝试直连",
    connected: "已直连",
    fallback: "直连未建立或已中断",
  } as const;
  for (const [directState, label] of Object.entries(directStates)) {
    const markup = render({
      connectionInfo: info({ directState: directState as WebConnectionInfo["directState"] }),
    });
    assert.ok(markup.includes(label), `直连状态 ${directState} 必须显示「${label}」`);
  }
});

test("WebRTC 生效时只保留事实字段，不渲染传输机制说明", () => {
  const markup = render({
    connectionInfo: info({ transport: "webrtc", directState: "connected" }),
  });
  assert.ok(markup.includes("WebRTC 直连"));
  assert.ok(markup.includes("已直连"));
  assert.doesNotMatch(markup, /业务数据通过|信令和回退|不是直连对端地址/);
});

test("WebSocket 回退时只保留事实字段，不渲染回退说明", () => {
  const markup = render({
    connectionInfo: info({ transport: "websocket", directState: "fallback" }),
  });
  assert.ok(markup.includes("WebSocket"));
  assert.ok(markup.includes("直连未建立或已中断"));
  assert.doesNotMatch(markup, /直连不可用时也可以继续使用该通道/);
});

test("无活动连接时只显示空值事实字段，不补充解释文案", () => {
  const markup = render({ connectionInfo: info({ transport: null, directState: "waiting" }) });
  assert.ok(markup.includes("暂无活动连接"));
  assert.ok(markup.includes("等待基础连接"));
  assert.doesNotMatch(markup, /当前没有活动的业务连接/);
});

test("服务入口只渲染传入的已脱敏地址并允许长地址换行", () => {
  const endpoint = "wss://very-long-subdomain.example.com:8443";
  const markup = render({ connectionInfo: info({ endpoint }) });
  assert.ok(markup.includes(endpoint));
  assert.match(markup, /break-all/, "手机窄屏下长地址必须换行");
});

test("无服务地址时显示占位，不显示空值", () => {
  const markup = render({ connectionInfo: info({ endpoint: null }) });
  assert.ok(markup.includes("未知地址"));
});

test("英文语言包覆盖相同信息且不残留中文", () => {
  const markup = render({
    locale: "en-US",
    status: "reconnecting",
    connectionInfo: info({ transport: "webrtc", directState: "connected", endpoint: null }),
  });
  assert.ok(markup.includes("Reconnecting"));
  assert.ok(markup.includes("WebRTC direct"));
  assert.ok(markup.includes("Connected directly"));
  assert.ok(markup.includes("Unknown address"));
  assert.doesNotMatch(markup, /正在重新连接|未知地址|业务数据通过|Business data uses/);
});

test("标题下不再渲染可见描述，Dialog 关闭 aria-describedby", () => {
  assert.doesNotMatch(dialogSource, /DialogDescription/, "精简后标题下不应再有可见描述");
  assert.match(
    dialogSource,
    /aria-describedby=\{undefined\}/,
    "无描述对话框必须显式关闭 aria-describedby，保留标题作为可访问名称",
  );
});

test("精简后的说明类文案已从语言包移除", () => {
  const removedIds = [
    "webConnectionInfo.description",
    "webConnectionInfo.hint.webrtc",
    "webConnectionInfo.hint.websocket",
    "webConnectionInfo.hint.none",
  ];
  for (const id of removedIds) {
    assert.equal(id in zhCN, false, `zh-CN 不应再保留 ${id}`);
    assert.equal(id in enUS, false, `en-US 不应再保留 ${id}`);
  }
});

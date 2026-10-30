import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TID_WEB_CONNECTION_INFO_NETWORK_RTT,
  TID_WEB_CONNECTION_INFO_RECEIVED_BYTES,
  TID_WEB_CONNECTION_INFO_SENT_BYTES,
  TID_WEB_CONNECTION_INFO_SERVER_PROCESSING,
  type WebConnectionInfo,
  type WebConnectionLatency,
} from "@zcode/shared";
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
const contentSource = readFileSync(
  new URL("../src/WebConnectionInfoContent.tsx", import.meta.url),
  "utf8",
);

function info(overrides: Partial<WebConnectionInfo> = {}): WebConnectionInfo {
  return {
    transport: "websocket",
    directState: "disabled",
    ...overrides,
  };
}

function render({
  status = "connected",
  connectionInfo = info(),
  locale = "zh-CN" as const,
  latency,
  traffic = { sentBytes: 2_048, receivedBytes: 3 },
}: {
  status?: ServiceConnectionStatus;
  connectionInfo?: WebConnectionInfo;
  locale?: "zh-CN" | "en-US";
  latency?: WebConnectionLatency;
  traffic?: { sentBytes: number; receivedBytes: number };
} = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WebConnectionInfoContent, { status, connectionInfo, latency, traffic }),
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

test("显示累计收发字节数并使用中英文文案", () => {
  const chinese = render();
  assert.match(chinese, /累计发送量/);
  assert.match(chinese, /累计接收量/);
  assert.match(
    chinese,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_SENT_BYTES}"[^>]*>2\\.0 KB`),
  );
  assert.match(
    chinese,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_RECEIVED_BYTES}"[^>]*>3 B`),
  );

  const english = render({ locale: "en-US" });
  assert.match(english, /Total sent/);
  assert.match(english, /Total received/);
});

test("英文语言包覆盖相同信息且不残留中文", () => {
  const markup = render({
    locale: "en-US",
    status: "reconnecting",
    connectionInfo: info({ transport: "webrtc", directState: "connected" }),
  });
  assert.ok(markup.includes("Reconnecting"));
  assert.ok(markup.includes("WebRTC direct"));
  assert.ok(markup.includes("Connected directly"));
  assert.doesNotMatch(markup, /正在重新连接|业务数据通过|Business data uses/);
});

test("无 latency 或已断连时两个延迟字段只显示空值，不补造 0 ms", () => {
  const tidPattern = new RegExp(
    `data-testid="(${TID_WEB_CONNECTION_INFO_NETWORK_RTT}|${TID_WEB_CONNECTION_INFO_SERVER_PROCESSING})"[^>]*>—`,
    "g",
  );

  const missing = render();
  assert.match(missing, /网络往返（估算）/);
  assert.match(missing, /服务端处理/);
  assert.equal(missing.match(tidPattern)?.length, 2);
  assert.doesNotMatch(missing, />\s*0 ms</, "缺失值不能伪装成 0 ms");

  const closed = render({
    status: "closed",
    latency: { networkRoundTripMs: 12, serverProcessingMs: 4 },
  });
  assert.equal(closed.match(tidPattern)?.length, 2, "断连后不得继续显示旧样本");
  assert.doesNotMatch(closed, />\s*12 ms</);
});

test("合法样本按整数毫秒展示，真实 0 与同一样本的两个值都保留", () => {
  const zero = render({ latency: { networkRoundTripMs: 0, serverProcessingMs: 0 } });
  assert.match(zero, new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_NETWORK_RTT}"[^>]*>0 ms<`));
  assert.match(
    zero,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_SERVER_PROCESSING}"[^>]*>0 ms<`),
  );

  const sample = render({ latency: { networkRoundTripMs: 18, serverProcessingMs: 5 } });
  assert.match(
    sample,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_NETWORK_RTT}"[^>]*>18 ms<`),
  );
  assert.match(
    sample,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_SERVER_PROCESSING}"[^>]*>5 ms<`),
  );
});

test("小数样本也按整数毫秒显示，不输出长小数", () => {
  const markup = render({ latency: { networkRoundTripMs: 18.6, serverProcessingMs: 5.4 } });
  assert.match(
    markup,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_NETWORK_RTT}"[^>]*>19 ms<`),
  );
  assert.match(
    markup,
    new RegExp(`data-testid="${TID_WEB_CONNECTION_INFO_SERVER_PROCESSING}"[^>]*>5 ms<`),
  );
  assert.doesNotMatch(markup, /18\.6 ms|5\.4 ms/, "展示值必须取整，不能暴露原始小数");
});

test("内容只保留七项事实字段", () => {
  const markup = render();
  assert.equal(markup.match(/<dt\b/g)?.length, 7);
  assert.equal(markup.match(/<dd\b/g)?.length, 7);
});

test("英文语言包覆盖两个延迟字段与空值", () => {
  const sample = render({
    locale: "en-US",
    latency: { networkRoundTripMs: 23, serverProcessingMs: 6 },
  });
  assert.match(sample, /Network round trip \(estimated\)/);
  assert.match(sample, /Server processing/);
  assert.match(sample, />23 ms</);
  assert.match(sample, />6 ms</);

  const missing = render({ locale: "en-US" });
  assert.match(missing, /Network round trip \(estimated\)/);
  assert.match(missing, /Server processing/);
  assert.match(missing, />—</);
});

test("重复渲染按最新输入换代展示，不保留上一样本", () => {
  const first = render({ latency: { networkRoundTripMs: 10, serverProcessingMs: 2 } });
  assert.match(first, />10 ms</);
  assert.match(first, />2 ms</);

  const second = render({ latency: { networkRoundTripMs: 30, serverProcessingMs: 4 } });
  assert.match(second, />30 ms</);
  assert.match(second, />4 ms</);
  assert.doesNotMatch(second, />\s*(10|2) ms</, "换代后不能混入旧样本数值");
});

test("延迟文案使用最近样本措辞，不使用实时或平均说法", () => {
  const markup = render({ latency: { networkRoundTripMs: 18, serverProcessingMs: 5 } });
  assert.doesNotMatch(markup, /实时|平均|测速|当前速度/);
});

test("Dialog 只从既有连接 context 读取 latency，不新增请求或定时器", () => {
  assert.match(dialogSource, /latency=\{connection\.latency\}/);
  assert.doesNotMatch(
    dialogSource,
    /fetch\(|setInterval|setTimeout|new WebSocket|RTCPeerConnection/,
  );
  assert.doesNotMatch(
    contentSource,
    /fetch\(|setInterval|setTimeout|new WebSocket|RTCPeerConnection|useState|useEffect/,
    "内容组件只格式化传入的最近样本，不自行探测或缓存",
  );
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
    "webConnectionInfo.endpoint",
    "webConnectionInfo.endpoint.unknown",
  ];
  for (const id of removedIds) {
    assert.equal(id in zhCN, false, `zh-CN 不应再保留 ${id}`);
    assert.equal(id in enUS, false, `en-US 不应再保留 ${id}`);
  }
});

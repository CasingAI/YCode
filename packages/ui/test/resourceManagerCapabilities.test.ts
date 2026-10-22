import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DiskIoSnapshot, ResourceUsageSnapshot } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ResourceManagerApp } from "../src/resource-manager/ResourceManagerApp.js";

function renderApp({
  initialTab = "cpu",
  hasDiskIo = false,
}: {
  initialTab?: "cpu" | "memory" | "disk-io";
  hasDiskIo?: boolean;
} = {}) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ResourceManagerApp, {
        initialTab,
        getSnapshot: async () => ({}) as ResourceUsageSnapshot,
        ...(hasDiskIo ? { getDiskIoSnapshot: async () => ({}) as DiskIoSnapshot } : {}),
      }),
    ),
  );
}

test("Web 无磁盘 I/O 能力时隐藏页签并保留 CPU / 内存", () => {
  const markup = renderApp();

  assert.match(markup, /data-testid="resource-manager-tab-cpu"/);
  assert.match(markup, /data-testid="resource-manager-tab-memory"/);
  assert.doesNotMatch(markup, /data-testid="resource-manager-tab-disk-io"/);
  assert.doesNotMatch(markup, />资源管理器接口不可用</);
});

test("没有磁盘能力却指定磁盘初始页时落到 CPU", () => {
  const markup = renderApp({ initialTab: "disk-io" });

  assert.match(
    markup,
    /role="tab"[^>]*aria-selected="true"[^>]*data-testid="resource-manager-tab-cpu"/,
  );
  assert.doesNotMatch(markup, /data-testid="resource-manager-tab-disk-io"/);
});

test("宿主提供磁盘 I/O 能力时显示对应页签", () => {
  const markup = renderApp({ hasDiskIo: true });

  assert.match(markup, /data-testid="resource-manager-tab-disk-io"/);
});

test("窄屏文档顺序为指标摘要、趋势、进程列表", () => {
  const markup = renderApp();
  const summaryIndex = markup.indexOf('data-testid="resource-manager-cpu-footer-mobile-summary"');
  const trendIndex = markup.indexOf('data-testid="resource-manager-cpu-footer-trend"');
  const processListIndex = markup.indexOf('data-testid="resource-manager-process-list"');

  assert.ok(summaryIndex >= 0, "手机摘要应复用当前指标卡");
  assert.ok(summaryIndex < trendIndex, "摘要应排在趋势之前");
  assert.ok(trendIndex < processListIndex, "趋势应排在进程列表之前");
  assert.match(markup, /md:row-start-3/);
  assert.match(markup, /md:col-start-2 md:row-start-2/);
});

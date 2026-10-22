import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createEmptyDiskIoMetricValues,
  type DiskIoMetricRow,
  type DiskIoSnapshot,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { DiskIoTab } from "../src/resource-manager/DiskIoTab.js";
import { DiskIoTabContent } from "../src/resource-manager/DiskIoTabContent.js";
import { DiskIoDetailsTable } from "../src/resource-manager/DiskIoDetailsTable.js";

function snapshot(withData = true): DiskIoSnapshot {
  const row: DiskIoMetricRow = {
    process: "host",
    module: "filesystem",
    ...createEmptyDiskIoMetricValues(),
    readOperations: 2,
    writeOperations: 1,
    readBytes: 1024,
    writeBytes: 2048,
    failedOperations: 1,
    totalDurationMs: 15,
    latencyHistogram: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  return {
    startedAt: 0,
    sessionStartedAt: 0,
    capturedAt: 2_000,
    globalTotals: {
      readBytes: withData ? 1024 : 0,
      writeBytes: withData ? 2048 : 0,
      readOperations: withData ? 2 : 0,
      writeOperations: withData ? 1 : 0,
      databaseOperations: 0,
      failedOperations: withData ? 1 : 0,
    },
    historyIntervalMs: 2_000,
    historyRetentionMs: 300_000,
    osIoAvailable: false,
    cumulative: withData ? [row] : [],
    history: withData ? [{ timestamp: 2_000, rows: [row], osIoDelta: [] }] : [],
    osIoCumulative: {},
    logQueuePending: 0,
    logQueueDropped: 0,
  };
}

function renderContent(value: DiskIoSnapshot | null, error: string | null = null): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(DiskIoTabContent, {
        snapshot: value,
        error,
        available: true,
        refreshIntervalMs: 2_000,
        processFilter: "all",
        moduleFilter: "all",
        setProcessFilter: () => {},
        setModuleFilter: () => {},
      }),
    ),
  );
}

test("缺少磁盘接口时只呈现中性不可用状态，不生成零值仪表盘", () => {
  const markup = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, createElement(DiskIoTab)),
  );
  assert.match(markup, /当前平台不可用/);
  assert.doesNotMatch(markup, /role="alert"|0 B\/s|resource-manager-disk-footer|累计逻辑读取量/);
});

test("初次采样与空快照分开呈现，均不伪造 0 速率", () => {
  const loading = renderContent(null);
  assert.match(loading, /正在读取资源占用/);
  assert.doesNotMatch(loading, /0 B\/s|resource-manager-disk-footer/);
  const empty = renderContent(snapshot(false));
  assert.match(empty, /当前范围暂无采集数据/);
  assert.doesNotMatch(empty, /0 B\/s|resource-manager-disk-footer/);
});

test("采样失败时仅有真实旧快照才能展示旧数据，并明确标识", () => {
  const failed = renderContent(null, "sample failed");
  assert.match(failed, /role="alert"/);
  assert.match(failed, /sample failed/);
  assert.doesNotMatch(failed, /resource-manager-disk-footer|0 B\/s/);
  const stale = renderContent(snapshot(), "sample failed");
  assert.match(stale, /采样失败，以下为上次采样数据/);
  assert.match(stale, /sample failed/);
  assert.match(stale, /resource-manager-disk-footer/);
  assert.match(stale, /512 B\/s/);
});

test("窄屏来源摘要保留表格全部指标，详情可展开且无内嵌横向表格", () => {
  const markup = renderToStaticMarkup(
    createElement(DiskIoDetailsTable, {
      selectedRows: snapshot().cumulative,
      processFilter: "all",
      moduleFilter: "all",
      setProcessFilter: () => {},
      setModuleFilter: () => {},
      processLabel: (process) => process,
      moduleLabel: (module) => module,
      text: (key) => key,
    }),
  );
  const mobile = markup.slice(
    markup.indexOf('data-testid="disk-io-mobile-sources"'),
    markup.indexOf('data-testid="disk-io-desktop-sources"'),
  );
  assert.match(mobile, /<details/);
  assert.match(mobile, /<summary/);
  for (const label of [
    "readTotal",
    "writeTotal",
    "failures",
    "operations",
    "averageLatency",
    "p95Latency",
  ]) {
    assert.ok(mobile.includes(label), label);
  }
  assert.match(mobile, /filesystem/);
  assert.doesNotMatch(mobile, /<table/);
  assert.match(markup, /data-testid="disk-io-desktop-sources"[\s\S]*<table/);
});

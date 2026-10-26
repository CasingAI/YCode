import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceUsageSnapshot } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  ResourceManagerCpuFooter,
  ResourceManagerMemoryFooter,
  ResourceManagerOverviewFooter,
} from "../src/resource-manager/ResourceManagerOverviewFooter.js";
import {
  buildOverviewTrendPath,
  resolveOverviewMaxValue,
  toMemoryPercent,
  type OverviewSeries,
} from "../src/resource-manager/resourceOverviewView.js";

// 资源管理器三个页签共用同一套底部概览栏（specs/resource-manager-ui.md）。
// 数值和占位状态用真实组件的 SSR 结果验证；布局接线另锁定单一概览节点。

const appSource = readFileSync(
  new URL("../src/resource-manager/ResourceManagerApp.tsx", import.meta.url),
  "utf8",
);
const usageTabSource = readFileSync(
  new URL("../src/resource-manager/ResourceManagerUsageTab.tsx", import.meta.url),
  "utf8",
);
const diskIoTabSource = readFileSync(
  new URL("../src/resource-manager/DiskIoTab.tsx", import.meta.url),
  "utf8",
);
const diskIoContentSource = readFileSync(
  new URL("../src/resource-manager/DiskIoTabContent.tsx", import.meta.url),
  "utf8",
);

const FOOTER_KEYS: Record<string, readonly string[]> = {
  cpuFooter: [
    "summary",
    "usage",
    "trend",
    "trendDescription",
    "system",
    "app",
    "idle",
    "processes",
    "logicalCpus",
  ],
  memoryFooter: [
    "summary",
    "usage",
    "trend",
    "trendDescription",
    "system",
    "app",
    "idle",
    "processes",
    "totalMemory",
  ],
  diskFooter: [
    "summary",
    "usage",
    "trend",
    "trendDescription",
    "read",
    "write",
    "operations",
    "readTotal",
    "writeTotal",
  ],
};

test("三个页签的概览栏文案在两种语言下都存在", () => {
  for (const [namespace, keys] of Object.entries(FOOTER_KEYS)) {
    for (const key of keys) {
      const id = `resourceManager.${namespace}.${key}`;
      assert.ok(zhCN[id], `缺少中文文案 ${id}`);
      assert.ok(enUS[id], `缺少英文文案 ${id}`);
      assert.notEqual(zhCN[id], id, `${id} 不能回退成键名`);
      assert.notEqual(enUS[id], id, `${id} 不能回退成键名`);
    }
  }
});

test("概览栏曲线按固定上限或峰值换算纵轴", () => {
  const percentSeries: OverviewSeries[] = [
    { label: "system", values: [0, 50, 100], tone: "primary" },
  ];
  assert.equal(resolveOverviewMaxValue(percentSeries, 100), 100);
  assert.equal(resolveOverviewMaxValue(percentSeries), 100);
  assert.equal(resolveOverviewMaxValue([{ label: "a", values: [0, 0], tone: "primary" }]), 1);

  // 0% 落在底部，100% 落在顶部，中间点取半高。
  assert.equal(buildOverviewTrendPath([0, 50, 100], 100), "M4.0,72.0 L210.0,38.0 L416.0,4.0");
  assert.equal(buildOverviewTrendPath([], 100), "");
  // 超过上限的值被夹到顶部，不能画出坐标区之外。
  assert.equal(buildOverviewTrendPath([150], 100), "M210.0,4.0");
});

test("趋势在不完整点断开，完整恢复后重新连线", () => {
  const gap = buildOverviewTrendPath([10, null, 20], 100);
  assert.equal(gap.match(/M/g)?.length, 2);
  assert.equal(gap.match(/L/g)?.length ?? 0, 0);
  assert.equal(
    resolveOverviewMaxValue([{ label: "YCode", values: [null, 40, null], tone: "primary" }]),
    40,
  );

  const recovered = buildOverviewTrendPath([10, 20, 30], 100);
  assert.equal(recovered.match(/M/g)?.length, 1);
  assert.equal(recovered.match(/L/g)?.length, 2);
});

test("内存百分比在物理内存总量未知时按 0 处理", () => {
  assert.equal(toMemoryPercent(1024, 4096), 25);
  assert.equal(toMemoryPercent(1024, 0), 0);
  assert.equal(toMemoryPercent(Number.NaN, 4096), 0);
});

test("CPU 与内存共用一个按断点重排的概览节点", () => {
  assert.equal(appSource.match(/<ResourceManagerCpuFooter/g)?.length, 1);
  assert.equal(appSource.match(/<ResourceManagerMemoryFooter/g)?.length, 1);
  assert.match(usageTabSource, /data-testid="resource-manager-usage-layout"/);
  assert.match(usageTabSource, /md:row-start-3/);
  assert.match(appSource, /mobileSummary=/);
});

test("窄屏摘要与趋势来自同一个概览，不叠加重复数值区", () => {
  const markup = renderToStaticMarkup(
    createElement(ResourceManagerOverviewFooter, {
      testId: "overview-test",
      ariaLabel: "概览",
      usageLabel: "占用",
      statsLabel: "统计",
      rows: [{ label: "YCode", value: "21.6%" }],
      stats: [{ label: "进程", value: "8" }],
      series: [{ label: "YCode", values: [12, 21.6], tone: "primary" }],
      trendTitle: "最近趋势",
      trendAriaLabel: "占用趋势",
      mobileSummary: createElement("div", { "data-testid": "summary-test" }, "21.6%"),
      maxValue: 100,
    }),
  );

  assert.equal(markup.match(/data-testid="summary-test"/g)?.length, 1);
  assert.ok(
    markup.indexOf('data-testid="summary-test"') <
      markup.indexOf('data-testid="overview-test-trend"'),
  );
  assert.match(markup, /class="[^"]*hidden md:flex[^"]*"[^>]*data-testid="overview-test-usage"/);
  assert.match(markup, /<svg[^>]*role="img"[^>]*aria-label="占用趋势"/);
  assert.match(markup, /md:grid-cols-/);
  assert.doesNotMatch(markup, /(?:class="| )h-36(?: |")/);
});

test("CPU 与内存概览仍保留统计口径，缺快照不会显示真实零值", () => {
  const snapshot: ResourceUsageSnapshot = {
    sampledAt: 1,
    logicalCpuCount: 8,
    system: { cpuPercent: 38.2, memoryTotalBytes: 16 * 1024 ** 3, memoryUsedBytes: 8 * 1024 ** 3 },
    app: { cpuPercent: 21.6, memoryBytes: 2 * 1024 ** 3 },
    processes: [],
  };
  const text = (key: string) => key;
  const cpu = renderToStaticMarkup(
    createElement(ResourceManagerCpuFooter, { snapshot, samples: [], text }),
  );
  const memory = renderToStaticMarkup(
    createElement(ResourceManagerMemoryFooter, { snapshot, samples: [], text }),
  );
  assert.match(cpu, /38.2%/);
  assert.match(cpu, /21.6%/);
  assert.match(cpu, /61.8%/);
  assert.match(memory, /50.0%/);
  assert.match(memory, /2(?:\.0)? GB/);

  for (const component of [ResourceManagerCpuFooter, ResourceManagerMemoryFooter]) {
    const empty = renderToStaticMarkup(
      createElement(component, { snapshot: null, samples: [], text }),
    );
    assert.equal(empty.match(/>—<\/strong>/g)?.length, 5);
    assert.doesNotMatch(empty, />0(?:\.0)?%<\/strong>/);
  }
});

test("不完整快照保留整机底栏数值，YCode 合计显示占位", () => {
  const incomplete = {
    sampledAt: 1,
    logicalCpuCount: 8,
    system: { cpuPercent: 38.2, memoryTotalBytes: 16 * 1024 ** 3, memoryUsedBytes: 8 * 1024 ** 3 },
    app: { cpuPercent: 21.6, memoryBytes: 2 * 1024 ** 3 },
    processes: [],
    samplingStatus: "pending",
  } as ResourceUsageSnapshot;
  const partialSamples = [
    {
      systemCpuPercent: 38.2,
      appCpuPercent: null,
      systemMemoryPercent: 50,
      appMemoryPercent: null,
    },
  ];
  const text = (key: string) => key;
  const cpu = renderToStaticMarkup(
    createElement(ResourceManagerCpuFooter, {
      snapshot: incomplete,
      samples: partialSamples,
      text,
    }),
  );
  const memory = renderToStaticMarkup(
    createElement(ResourceManagerMemoryFooter, {
      snapshot: incomplete,
      samples: partialSamples,
      text,
    }),
  );

  assert.match(cpu, /38\.2%/);
  assert.match(cpu, /61\.8%/);
  assert.match(memory, /50\.0%/);
  assert.match(memory, /8(?:\.0)? GB/);
  assert.doesNotMatch(cpu, /21\.6%/);
  assert.doesNotMatch(memory, /2(?:\.0)? GB/);
  assert.match(cpu, />—<\/strong>/);
  assert.match(memory, />—<\/strong>/);

  const complete = {
    ...incomplete,
    samplingStatus: "complete",
  } as ResourceUsageSnapshot;
  const recoveredSamples = [
    {
      systemCpuPercent: 38.2,
      appCpuPercent: 21.6,
      systemMemoryPercent: 50,
      appMemoryPercent: 12.5,
    },
  ];
  const recoveredCpu = renderToStaticMarkup(
    createElement(ResourceManagerCpuFooter, {
      snapshot: complete,
      samples: recoveredSamples,
      text,
    }),
  );
  const recoveredMemory = renderToStaticMarkup(
    createElement(ResourceManagerMemoryFooter, {
      snapshot: complete,
      samples: recoveredSamples,
      text,
    }),
  );
  assert.match(recoveredCpu, /21\.6%/);
  assert.match(recoveredMemory, /2(?:\.0)? GB/);
});

test("磁盘 I/O 页复用自身快照渲染概览栏", () => {
  assert.match(diskIoContentSource, /<ResourceManagerOverviewFooter/);
  assert.match(diskIoContentSource, /testId="resource-manager-disk-footer"/);
  // 磁盘页自行管理滚动区与底栏，不额外建立第二份轮询。
  assert.equal(diskIoTabSource.match(/window\.setInterval/g)?.length, 1);
});

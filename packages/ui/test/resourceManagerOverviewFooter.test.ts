import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  buildOverviewTrendPath,
  resolveOverviewMaxValue,
  toMemoryPercent,
  type OverviewSeries,
} from "../src/resource-manager/resourceOverviewView.js";

// 资源管理器三个页签共用同一套底部概览栏（specs/resource-manager-ui.md）。
// ui 包测试为源码断言式（无组件渲染/jsdom），这里锁定文案覆盖、趋势换算与页签接线。

const appSource = readFileSync(
  new URL("../src/resource-manager/ResourceManagerApp.tsx", import.meta.url),
  "utf8",
);
const diskIoTabSource = readFileSync(
  new URL("../src/resource-manager/DiskIoTab.tsx", import.meta.url),
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

test("内存百分比在物理内存总量未知时按 0 处理", () => {
  assert.equal(toMemoryPercent(1024, 4096), 25);
  assert.equal(toMemoryPercent(1024, 0), 0);
  assert.equal(toMemoryPercent(Number.NaN, 4096), 0);
});

test("CPU 与内存页在滚动区域之外渲染各自的概览栏", () => {
  assert.match(appSource, /tab === "cpu"[\s\S]*?<ResourceManagerCpuFooter/);
  assert.match(appSource, /tab === "memory"[\s\S]*?<ResourceManagerMemoryFooter/);
  // 概览栏在滚动容器之后渲染，不能被滚动区域带走。
  const scrollIndex = appSource.indexOf(
    'className="min-h-0 flex-1 overflow-auto bg-background-alt p-4"',
  );
  const cpuFooterIndex = appSource.indexOf("<ResourceManagerCpuFooter");
  assert.ok(scrollIndex >= 0 && cpuFooterIndex > scrollIndex, "概览栏必须位于滚动区域之后");
});

test("磁盘 I/O 页复用自身快照渲染概览栏", () => {
  assert.match(diskIoTabSource, /<ResourceManagerOverviewFooter/);
  assert.match(diskIoTabSource, /testId="resource-manager-disk-footer"/);
  // 磁盘页自行管理滚动区与底栏，不额外建立第二份轮询。
  assert.equal(diskIoTabSource.match(/window\.setInterval/g)?.length, 1);
});

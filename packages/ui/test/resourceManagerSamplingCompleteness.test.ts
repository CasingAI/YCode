import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ResourceUsageProcess,
  ResourceUsageSamplingStatus,
  ResourceUsageSnapshot,
} from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ResourceManagerHeader } from "../src/resource-manager/ResourceManagerHeader.js";
import {
  ResourceManagerUsageTab,
  UsageMetricSummary,
} from "../src/resource-manager/ResourceManagerUsageTab.js";
import { UsageGroup } from "../src/resource-manager/resourceUsageParts.js";
import {
  groupResourceUsage,
  isResourceUsageSnapshotComplete,
} from "../src/resource-manager/resourceUsageView.js";
import { createResourceManagerSample } from "../src/resource-manager/resourceOverviewView.js";

// 覆盖不完整采样的展示约束、旧宿主行级兼容与完整恢复。

type SnapshotWithStatus = ResourceUsageSnapshot & {
  samplingStatus?: ResourceUsageSamplingStatus;
};

function processRow(overrides: Partial<ResourceUsageProcess> = {}): ResourceUsageProcess {
  return {
    pid: 100,
    name: "ycode-agent",
    category: "base",
    groupKey: "host",
    groupLabel: "Host",
    cpuPercent: 12.5,
    memoryBytes: 512 * 1024 ** 2,
    sampled: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<SnapshotWithStatus> = {}): SnapshotWithStatus {
  return {
    sampledAt: 1,
    logicalCpuCount: 8,
    system: {
      cpuPercent: 38.2,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedBytes: 8 * 1024 ** 3,
    },
    app: { cpuPercent: 21.6, memoryBytes: 2 * 1024 ** 3 },
    processes: [processRow()],
    ...overrides,
  };
}

function render(element: ReactElement, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  return renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: locale }, element));
}

test("完整判定兼容旧宿主并优先识别非 complete 状态", () => {
  assert.equal(isResourceUsageSnapshotComplete(null), false);
  assert.equal(isResourceUsageSnapshotComplete(snapshot({ samplingStatus: "complete" })), true);
  // 旧宿主缺 status、所有行已采样：仍按完整处理。
  assert.equal(isResourceUsageSnapshotComplete(snapshot()), true);
  assert.equal(isResourceUsageSnapshotComplete(snapshot({ samplingStatus: "pending" })), false);
  assert.equal(isResourceUsageSnapshotComplete(snapshot({ samplingStatus: "failed" })), false);
  assert.equal(isResourceUsageSnapshotComplete(snapshot({ samplingStatus: "stale" })), false);
  // status 为 complete 也不能掩盖行级未采样。
  assert.equal(
    isResourceUsageSnapshotComplete(
      snapshot({ samplingStatus: "complete", processes: [processRow({ sampled: false })] }),
    ),
    false,
  );
  assert.equal(
    isResourceUsageSnapshotComplete(snapshot({ processes: [processRow({ sampled: false })] })),
    false,
  );
});

test("不完整快照保留系统采样，YCode 样本记为 null 留出趋势断点", () => {
  const pending = createResourceManagerSample(snapshot({ samplingStatus: "pending" }));
  assert.equal(pending.systemCpuPercent, 38.2);
  assert.equal(pending.systemMemoryPercent, 50);
  assert.equal(pending.appCpuPercent, null);
  assert.equal(pending.appMemoryPercent, null);

  const legacyPartial = createResourceManagerSample(
    snapshot({ processes: [processRow({ sampled: false })] }),
  );
  assert.equal(legacyPartial.appCpuPercent, null);

  const complete = createResourceManagerSample(snapshot({ samplingStatus: "complete" }));
  assert.equal(complete.appCpuPercent, 21.6);
  assert.equal(complete.appMemoryPercent, 12.5);
});

test("CPU / 内存指标卡不完整时 YCode 合计为占位且进度条为零", () => {
  const incomplete = snapshot({ samplingStatus: "pending" });
  for (const metric of ["cpu", "memory"] as const) {
    const markup = render(
      createElement(UsageMetricSummary, {
        metric,
        snapshot: incomplete,
        testId: `meter-${metric}`,
      }),
    );
    assert.match(markup, new RegExp(`data-testid="meter-${metric}-app"[^>]*>—</`));
    assert.match(markup, /style="width:0%"/);
    assert.match(markup, /style="width:(?:38\.2|50)%"/);
  }

  const completeCpu = render(
    createElement(UsageMetricSummary, {
      metric: "cpu",
      snapshot: snapshot({ samplingStatus: "complete" }),
      testId: "meter-cpu",
    }),
  );
  assert.match(completeCpu, /data-testid="meter-cpu-app"[^>]*>21\.6%</);
  assert.match(completeCpu, /style="width:21\.6%"/);
});

test("页头在不完整采样时只报告已发现的进程数", () => {
  const incomplete = snapshot({ samplingStatus: "pending" });
  const zh = render(
    createElement(ResourceManagerHeader, {
      selectedTab: "cpu",
      hasDiskIo: false,
      onTabChange: () => {},
      snapshot: incomplete,
      refreshIntervalMs: 2_000,
      onRefreshIntervalChange: () => {},
    }),
  );
  const en = render(
    createElement(ResourceManagerHeader, {
      selectedTab: "cpu",
      hasDiskIo: false,
      onTabChange: () => {},
      snapshot: incomplete,
      refreshIntervalMs: 2_000,
      onRefreshIntervalChange: () => {},
    }),
    "en-US",
  );

  assert.match(zh, /已发现 1 个进程/);
  assert.match(en, /Discovered 1 processes/);
  assert.ok(zhCN["resourceManager.processCountDiscovered"]);
  assert.ok(enUS["resourceManager.processCountDiscovered"]);

  const complete = render(
    createElement(ResourceManagerHeader, {
      selectedTab: "cpu",
      hasDiskIo: false,
      onTabChange: () => {},
      snapshot: snapshot({ samplingStatus: "complete" }),
      refreshIntervalMs: 2_000,
      onRefreshIntervalChange: () => {},
    }),
  );
  assert.match(complete, /1 个进程/);
  assert.doesNotMatch(complete, /已发现/);
});

test("不完整说明在中英文下都可见，完整后消失", () => {
  const incomplete = snapshot({ samplingStatus: "pending" });
  const groups = groupResourceUsage(incomplete.processes);
  const baseProps = {
    metric: "cpu" as const,
    snapshot: incomplete,
    error: null,
    groups,
    expanded: { base: true, "builtin-plugin": true, "community-plugin": true },
    onToggleGroup: () => {},
    overviewFooter: createElement("div"),
  };

  const zh = render(createElement(ResourceManagerUsageTab, baseProps));
  const en = render(createElement(ResourceManagerUsageTab, baseProps), "en-US");
  assert.match(zh, /data-testid="resource-manager-sampling-incomplete"/);
  assert.match(zh, /进程采样尚未完成/);
  assert.match(en, /data-testid="resource-manager-sampling-incomplete"/);
  assert.match(en, /Process sampling is incomplete/);
  assert.ok(zhCN["resourceManager.samplingIncomplete"]);
  assert.ok(enUS["resourceManager.samplingIncomplete"]);

  const complete = render(
    createElement(ResourceManagerUsageTab, {
      ...baseProps,
      snapshot: snapshot({ samplingStatus: "complete" }),
      groups: groupResourceUsage(snapshot({ samplingStatus: "complete" }).processes),
    }),
  );
  assert.doesNotMatch(complete, /data-testid="resource-manager-sampling-incomplete"/);
});

test("组内存在未采样成员时合计显示占位，完整组恢复原合计", () => {
  const incompleteGroups = groupResourceUsage([
    processRow({ sampled: false }),
    processRow({ pid: 101, cpuPercent: 1, memoryBytes: 1024 }),
  ]);
  const incompleteBase = incompleteGroups.find((group) => group.category === "base");
  assert.ok(incompleteBase?.hasUnsampled);

  const incompleteMarkup = render(
    createElement(UsageGroup, {
      group: incompleteBase!,
      metric: "cpu",
      title: "基础服务",
      expanded: false,
      onToggle: () => {},
      emptyText: "暂无进程",
      samplingText: "指标采集中",
      columns: { process: "进程", pid: "PID", cpu: "CPU", memory: "内存" },
    }),
  );
  assert.match(incompleteMarkup, /data-testid="resource-manager-group-total-base"[^>]*>—</);
  assert.doesNotMatch(incompleteMarkup, /13\.5%/);

  const completeGroups = groupResourceUsage([processRow()]);
  const completeBase = completeGroups.find((group) => group.category === "base");
  const completeMarkup = render(
    createElement(UsageGroup, {
      group: completeBase!,
      metric: "cpu",
      title: "基础服务",
      expanded: false,
      onToggle: () => {},
      emptyText: "暂无进程",
      samplingText: "指标采集中",
      columns: { process: "进程", pid: "PID", cpu: "CPU", memory: "内存" },
    }),
  );
  assert.match(completeMarkup, /data-testid="resource-manager-group-total-base"[^>]*>12\.5%</);
});

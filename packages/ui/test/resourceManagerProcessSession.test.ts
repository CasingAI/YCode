import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceUsageProcess } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { UsageGroup } from "../src/resource-manager/resourceUsageParts.js";

// 资源管理器进程行的会话标注（docs/specs/resource-manager-process-session-attribution.md）：
// 进程名之后追加“· 会话标题”，列宽不足时由 truncate 截断，名称本身始终可见。

function renderGroup(processes: ResourceUsageProcess[]): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(UsageGroup, {
        group: {
          category: "base",
          processCount: processes.length,
          cpuPercent: 0,
          memoryBytes: 0,
          hasUnsampled: false,
          processes,
        },
        metric: "memory",
        title: "基础服务",
        expanded: true,
        onToggle: () => {},
        emptyText: "暂无进程",
        samplingText: "指标采集中",
        columns: { process: "进程", pid: "PID", cpu: "CPU", memory: "内存" },
      }),
    ),
  );
}

function baseProcess(overrides: Partial<ResourceUsageProcess>): ResourceUsageProcess {
  return {
    pid: 4242,
    name: "node",
    category: "base",
    groupKey: "cli",
    groupLabel: "cli",
    cpuPercent: 1,
    memoryBytes: 1024,
    sampled: true,
    ...overrides,
  };
}

test("带会话的进程行在名称后显示会话标题", () => {
  const markup = renderGroup([baseProcess({ sessionId: "sess-1", sessionTitle: "修复弹窗" })]);

  assert.match(markup, /node/);
  assert.match(markup, /修复弹窗/);
  assert.match(markup, /会话：修复弹窗/);
});

test("没有会话的进程行不显示会话标题", () => {
  const markup = renderGroup([baseProcess({})]);

  assert.match(markup, /node/);
  assert.equal(markup.includes("修复弹窗"), false);
  assert.equal(markup.includes("resource-manager-process-session"), false);
});

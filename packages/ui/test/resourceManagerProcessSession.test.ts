import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceUsageProcess } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { UsageGroup, UsageMeter } from "../src/resource-manager/resourceUsageParts.js";

// 资源管理器进程行的会话标注（docs/specs/resource-manager-process-session-attribution.md）：
// 窄屏保留完整名称与来源，PID/来源移到次行；宽屏保留独立 PID 和指标列。

function renderGroup(processes: ResourceUsageProcess[], expanded = true): string {
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
        expanded,
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

test("长进程名和来源完整呈现在正文，PID 与来源共用窄屏元信息行", () => {
  const name = "node-worker-with-a-very-long-unbroken-process-name";
  const sessionTitle = "排查手机远控连接后资源监控界面中很长的会话来源标题";
  const markup = renderGroup([baseProcess({ name, sessionTitle })]);

  assert.ok(markup.includes(`>${name}</span>`), "完整名称必须作为正文存在");
  assert.ok(markup.includes(`>· ${sessionTitle}</span>`), "来源不能只放在 hover 提示里");
  assert.match(markup, /data-testid="resource-manager-process-pid"/);
  assert.match(markup, /PID<\/span> ?4242/);
  assert.equal(markup.match(/4242/g)?.length, 1, "手机和宽屏复用同一个 PID 节点");
});

test("宽屏名称与会话共用内联容器，手机使用同一节点分配名称行和来源行", () => {
  const markup = renderGroup([baseProcess({ sessionTitle: "修复弹窗" })]);
  const identity = markup.match(
    /<div class="([^"]*)" data-testid="resource-manager-process-identity">([\s\S]*?)<\/div>/,
  );
  assert.ok(identity, "名称和会话必须共用展示容器");
  assert.match(identity[1], /contents/);
  assert.match(identity[1], /md:flex/);
  assert.match(identity[2], />node<\/span>/);
  assert.match(identity[2], />· 修复弹窗<\/span>/);
  assert.match(identity[2], /col-start-2 row-start-2/);
  assert.match(identity[2], /md:truncate/);
  assert.match(
    markup,
    /class="[^"]*col-start-1 row-start-2[^"]*md:col-start-2[^"]*md:row-start-1[^"]*" data-testid="resource-manager-process-pid"/,
  );
  assert.equal(markup.match(/data-testid="resource-manager-process-session"/g)?.length, 1);
});

test("未采样进程显示占位和可阅读说明，不伪装成零用量", () => {
  const markup = renderGroup([baseProcess({ sampled: false, memoryBytes: 0 })]);

  assert.match(markup, />—<\/div>/);
  assert.match(markup, />指标采集中<\/span>/);
});

test("折叠只收起进程行，仍保留分组总数", () => {
  const markup = renderGroup([baseProcess({}), baseProcess({ pid: 4243 })], false);

  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, />2<\/span>/);
  assert.equal(markup.includes('data-testid="resource-manager-process-row"'), false);
});

test("插件进程的归属标签与来源会话同时保留", () => {
  const markup = renderGroup([
    baseProcess({
      category: "community-plugin",
      groupLabel: "文档检索插件",
      sessionTitle: "调研接口约束",
    }),
  ]);

  assert.match(markup, />文档检索插件<\/span>/);
  assert.match(markup, />· 调研接口约束<\/span>/);
  assert.match(markup, /md:col-span-1 md:col-start-1 md:row-start-2/);
});

test("概览同时呈现整机和 YCode 数值，长内存值与占位共用摘要结构", () => {
  const markup = renderToStaticMarkup(
    createElement(UsageMeter, {
      testId: "resource-manager-memory",
      label: "内存",
      appLabel: "YCode 占用",
      systemLabel: "整机占用",
      appValue: "—",
      systemValue: "123.45 GB / 1024.00 GB",
      appPercent: 0,
      systemPercent: 12,
    }),
  );

  assert.match(
    markup,
    /data-testid="resource-manager-memory-system">123\.45 GB \/ 1024\.00 GB<\/span>/,
  );
  assert.match(markup, /data-testid="resource-manager-memory-app">—<\/span>/);
  assert.match(markup, /aria-label="整机占用 123\.45 GB \/ 1024\.00 GB"/);
  assert.match(markup, /aria-label="YCode 占用 —"/);
});

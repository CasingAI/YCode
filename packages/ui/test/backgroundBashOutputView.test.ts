import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundBashOutput } from "@zcode/shared";
import {
  backgroundBashElapsedMs,
  backgroundBashOutputView,
  backgroundBashViewStatus,
  formatBackgroundBashBytes,
  isBackgroundBashTerminal,
} from "../src/app-shell/backgroundBashOutputView.js";

function output(overrides: Partial<BackgroundBashOutput> = {}): BackgroundBashOutput {
  return {
    kind: "output",
    workId: "exec_1",
    status: "running",
    output: "",
    truncated: false,
    outputPath: "/tmp/exec/sess_1/call_1-stdout.log",
    ...overrides,
  };
}

test("首帧还在途时是 loading，且命令回退到 tab 标题", () => {
  assert.equal(backgroundBashViewStatus(null), "loading");
  const view = backgroundBashOutputView({
    latest: null,
    fallbackTitle: "带完整校验地修复 17 个破坏文件",
    now: 1_000,
  });
  assert.equal(view.status, "loading");
  assert.equal(view.command, "带完整校验地修复 17 个破坏文件");
  assert.equal(view.elapsedMs, undefined);
  assert.equal(view.canStop, false);
  assert.equal(view.hasOutput, false);
  assert.equal(view.truncated, false);
});

test("运行中：命令、目录、字节数与停止入口都在", () => {
  const view = backgroundBashOutputView({
    latest: output({
      command: "pnpm typecheck",
      cwd: "/repo",
      startedAt: 1_000,
      stdoutBytes: 0,
    }),
    fallbackTitle: "回退标题",
    now: 61_000,
  });
  assert.equal(view.status, "running");
  assert.equal(view.command, "pnpm typecheck");
  assert.equal(view.cwd, "/repo");
  assert.equal(view.elapsedMs, 60_000);
  assert.equal(view.stdoutBytes, 0);
  assert.equal(view.canStop, true);
});

test("执行器没带命令时回退 tab 标题，而不是留空", () => {
  const blank = backgroundBashOutputView({
    latest: output({ command: "   " }),
    fallbackTitle: "回退标题",
    now: 0,
  });
  assert.equal(blank.command, "回退标题");
  const missing = backgroundBashOutputView({
    latest: output(),
    fallbackTitle: "回退标题",
    now: 0,
  });
  assert.equal(missing.command, "回退标题");
});

test("六种状态各自可读，只有 running 给停止入口", () => {
  const cases = [
    ["running", false],
    ["completed", true],
    ["failed", true],
    ["timed_out", true],
    ["cancelled", true],
    ["spawn_error", true],
  ] as const;
  for (const [status, terminal] of cases) {
    assert.equal(isBackgroundBashTerminal(status), terminal, status);
    const view = backgroundBashOutputView({
      latest: output({ status }),
      fallbackTitle: "t",
      now: 0,
    });
    assert.equal(view.canStop, status === "running", status);
  }
  assert.equal(isBackgroundBashTerminal("loading"), false);
});

test("终态用时优先按结算时刻定格，不继续爬", () => {
  const elapsed = backgroundBashElapsedMs({
    latest: { status: "completed", startedAt: 1_000, completedAt: 31_000 },
    now: 99_000,
  });
  assert.equal(elapsed, 30_000);
});

test("Stop 先标 cancelled、结算未完成的窗口用观察时刻定格", () => {
  // completedAt 缺席时退回 now：调用方在观察到终态那一刻把 now 冻结住，
  // 于是这个值等价于「被标记为取消的那一刻」。
  const elapsed = backgroundBashElapsedMs({
    latest: { status: "cancelled", startedAt: 1_000 },
    now: 45_000,
  });
  assert.equal(elapsed, 44_000);
});

test("没有起点就不显示耗时，而不是显示 0", () => {
  assert.equal(backgroundBashElapsedMs({ latest: { status: "running" }, now: 5_000 }), undefined);
  assert.equal(backgroundBashElapsedMs({ latest: null, now: 5_000 }), undefined);
});

test("退出码、截断与是否有输出都跟着快照走", () => {
  const view = backgroundBashOutputView({
    latest: output({
      status: "failed",
      exitCode: 2,
      truncated: true,
      output: "boom\n",
      stdoutBytes: 9000,
      startedAt: 0,
      completedAt: 5_000,
    }),
    fallbackTitle: "t",
    now: 9_000,
  });
  assert.equal(view.exitCode, 2);
  assert.equal(view.truncated, true);
  assert.equal(view.hasOutput, true);
  assert.equal(view.elapsedMs, 5_000);
});

test("退出码缺席时不渲染，不补 0", () => {
  const view = backgroundBashOutputView({ latest: output(), fallbackTitle: "t", now: 0 });
  assert.equal(view.exitCode, undefined);
  assert.equal(view.stdoutBytes, undefined);
});

test("字节数按 B / KB / MB 三档显示", () => {
  assert.equal(formatBackgroundBashBytes(0, "en-US"), "0 B");
  assert.equal(formatBackgroundBashBytes(812, "en-US"), "812 B");
  assert.equal(formatBackgroundBashBytes(8192, "en-US"), "8 KB");
  assert.equal(formatBackgroundBashBytes(1536, "en-US"), "1.5 KB");
  assert.equal(formatBackgroundBashBytes(1024 * 1024 * 3, "en-US"), "3 MB");
});

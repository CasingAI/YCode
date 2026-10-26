import assert from "node:assert/strict";
import test from "node:test";
import {
  createProcessResourceSampler,
  createProcessResourceTableReader,
} from "../src/process/processResourceSampler.js";

/**
 * Windows 进程表采样测试。
 *
 * 这里不启动真实 PowerShell：解析与差分逻辑用注入的 execFile / readTable 覆盖，
 * 真实只读查询在本地手工验证一次即可。
 */

type TableRow = {
  pid: number;
  ppid: number;
  rssKb: number;
  cpuTimeMs: number;
  command: string;
};

function row(
  pid: number,
  ppid: number,
  cpuTimeMs: number,
  command = "node",
  rssKb = 1024,
): TableRow {
  return { pid, ppid, rssKb, cpuTimeMs, command };
}

function createReaderWithOutput(output: string) {
  const calls: {
    file: string;
    args: readonly string[];
    options: { timeout: number; maxBuffer: number; windowsHide?: boolean; signal?: AbortSignal };
  }[] = [];
  const reader = createProcessResourceTableReader({
    platform: "win32",
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: output };
    },
  });
  return { reader, calls };
}

test("Windows 输出按一次 CIM 查询批量解析，CPU 为 Kernel+User 累计", async () => {
  const { reader, calls } = createReaderWithOutput(
    [
      "4 0 1048576 25000000 powershell.exe",
      "8 4 2097152 10000000 node.exe",
      "12 8 0 0 ",
      "not a process row",
      "0 1 2 3 invalid-pid",
    ].join("\r\n"),
  );

  const rows = await reader();

  assert.ok(rows);
  assert.deepEqual(
    rows.map((entry) => ({
      pid: entry.pid,
      ppid: entry.ppid,
      rssKb: entry.rssKb,
      cpuTimeMs: entry.cpuTimeMs,
      command: entry.command,
    })),
    [
      { pid: 4, ppid: 0, rssKb: 1024, cpuTimeMs: 2500, command: "powershell.exe" },
      { pid: 8, ppid: 4, rssKb: 2048, cpuTimeMs: 1000, command: "node.exe" },
      { pid: 12, ppid: 8, rssKb: 0, cpuTimeMs: 0, command: "" },
    ],
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "powershell.exe");
  assert.equal(calls[0]?.options.timeout, 5_000);
  assert.equal(calls[0]?.options.windowsHide, true);
  const script = calls[0]?.args.at(-1) ?? "";
  // 单次 CIM 查询 + foreach + StringBuilder 批量输出，避免逐条管道对象开销。
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /foreach\s*\(/);
  assert.match(script, /StringBuilder/);
  assert.match(script, /\[Console\]::Out\.Write/);
  assert.doesNotMatch(script, /\|/);
  // 显式把两个累计字段转成无符号整数再相加，避免 PowerShell 退化成字符串拼接。
  assert.match(script, /\[uint64\]\$p\.KernelModeTime/);
  assert.match(script, /\[uint64\]\$p\.UserModeTime/);
});

test("Windows 命令失败时即使 stdout 有内容也不当作完整进程表", async () => {
  const reader = createProcessResourceTableReader({
    platform: "win32",
    execFile: async () => ({
      error: new Error("powershell failed"),
      stdout: "4 0 1048576 25000000 powershell.exe\r\n",
    }),
  });

  assert.equal(await reader(), undefined);
});

test("Windows 查询开始前已取消则不再执行 execFile", async () => {
  let execCalls = 0;
  const reader = createProcessResourceTableReader({
    platform: "win32",
    execFile: async () => {
      execCalls += 1;
      return { stdout: "" };
    },
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(reader(controller.signal), { name: "AbortError" });
  assert.equal(execCalls, 0);
});

test("首个样本没有差分基线，CPU 记 0", async () => {
  const sampler = createProcessResourceSampler({
    readTable: async () => [row(10, 1, 0)],
    now: () => 1_000,
    logicalCpuCount: 4,
  });

  const samples = await sampler.sample();
  assert.equal(samples?.get(10)?.cpuPercent, 0);
});

test("后续样本按耗时与逻辑核归一化 CPU，并保留基线重用", async () => {
  let now = 1_000;
  let table: TableRow[] = [row(10, 1, 0)];
  const sampler = createProcessResourceSampler({
    readTable: async () => table,
    now: () => now,
    logicalCpuCount: 4,
  });

  await sampler.sample();

  // 2000ms 内累计 CPU 增加 1000ms，4 核整机归一化 = 12.5%。
  now = 3_000;
  table = [row(10, 1, 1_000)];
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 12.5);

  // 同一 command 且累计时间单调递增时继续复用基线。
  now = 4_000;
  table = [row(10, 1, 1_500)];
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 12.5);

  // 超出整机容量的差分被夹到 100%，不出现 2500% 之类的值。
  now = 5_000;
  table = [row(10, 1, 101_500)];
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 100);
});

test("命令变化或累计时间倒退视为 PID 复用并重建基线", async () => {
  let now = 1_000;
  let table: TableRow[] = [row(10, 1, 5_000, "node")];
  const sampler = createProcessResourceSampler({
    readTable: async () => table,
    now: () => now,
    logicalCpuCount: 2,
  });

  await sampler.sample();

  now = 2_000;
  table = [row(10, 1, 6_000, "node")];
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 50);

  // command 变了：新进程，不能沿用旧基线。
  now = 3_000;
  table = [row(10, 1, 7_000, "worker")];
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 0);

  // 同一 command 但累计时间倒退：同样重建基线。
  now = 4_000;
  table = [row(10, 1, 1_000, "worker")];
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 0);
});

test("超过 TTL 未再出现的基线被丢弃，再次出现按首样本处理", async () => {
  let now = 0;
  let table: TableRow[] = [row(10, 1, 5_000)];
  const sampler = createProcessResourceSampler({
    readTable: async () => table,
    now: () => now,
    logicalCpuCount: 2,
  });

  await sampler.sample();

  // 60s 内短暂消失仍保留基线。
  now = 1_000;
  table = [];
  await sampler.sample();

  now = 61_000;
  await sampler.sample();

  now = 62_000;
  table = [row(10, 1, 9_000)];
  // 旧基线已被 TTL 清理，本轮只能作为首样本记 0，避免跨 PID 复用误差。
  assert.equal((await sampler.sample())?.get(10)?.cpuPercent, 0);
});

test("进程表读取返回 undefined 时本轮采样失败", async () => {
  const sampler = createProcessResourceSampler({
    readTable: async () => undefined,
    logicalCpuCount: 4,
  });

  assert.equal(await sampler.sample(), undefined);
});

test("读取完成后被取消时不发布样本", async () => {
  const controller = new AbortController();
  const sampler = createProcessResourceSampler({
    readTable: async () => {
      controller.abort();
      return [row(10, 1, 5_000)];
    },
    logicalCpuCount: 4,
  });

  await assert.rejects(sampler.sample(controller.signal), { name: "AbortError" });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  HostMessageTypes,
  hostResourceUsageSnapshotResultResponseSchema,
  type HostResourceUsageSnapshotResultResponse,
} from "@zcode/shared";
import type { ProcessResourceSample, ProcessResourceSampler } from "@zcode/services/node";
import { createHostResourceUsageResponder } from "../src/host/hostResourceUsage.js";

/**
 * 资源管理器 Host 侧采样回帖
 * （docs/specs/resource-manager-process-sampling.md）。
 *
 * 普通终端/工具派生的后代由 Host 自行按 PPID 归属，不要求项目上报；
 * 成功和失败都必须显式回帖，busy 不能被当作成功的空进程表。
 */

const HOST_PID = 100;

function sample(pid: number, ppid: number, command: string): ProcessResourceSample {
  return { pid, ppid, rssKb: 1024, cpuPercent: 1, command };
}

function createSampler(
  samples: Map<number, ProcessResourceSample>,
): ProcessResourceSampler & { calls: number } {
  const sampler = {
    calls: 0,
    async sample(): Promise<Map<number, ProcessResourceSample>> {
      sampler.calls += 1;
      return samples;
    },
  };
  return sampler;
}

function request(requestId: string) {
  return { type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId };
}

function parseResponse(messages: HostResourceUsageSnapshotResultResponse[]) {
  return messages.map((message) => hostResourceUsageSnapshotResultResponseSchema.parse(message));
}

test("终端派生链 shell → node → worker 全部纳入且只计一次", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  const sampler = createSampler(
    new Map([
      [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
      [300, sample(300, HOST_PID, "/bin/zsh")],
      [301, sample(301, 300, "/usr/local/bin/node")],
      [302, sample(302, 301, "/usr/local/bin/node")],
    ]),
  );
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler,
    getAgentService: () => undefined,
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  await responder.handleRequest(request("req-shell"));

  assert.equal(messages.length, 1);
  const [reply] = parseResponse(messages);
  assert.equal(reply?.samplingStatus, "complete");
  assert.deepEqual(
    reply?.processes.map((process) => process.pid),
    [300, 301, 302],
  );
  assert.equal(new Set(reply?.processes.map((process) => process.pid)).size, 3);
});

test("带会话的工具后代回帖能通过真实 strict schema", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  const longTitle = "长".repeat(600);
  const sampler = createSampler(
    new Map([
      [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
      [200, sample(200, HOST_PID, "ycode-cli")],
      [300, sample(300, 200, "/bin/zsh")],
      [301, sample(301, 300, "/usr/local/bin/node")],
    ]),
  );
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler,
    getAgentService: () => ({
      collectLocalRuntimeChildProcesses: async () => [
        {
          pid: 200,
          provider: "glm",
          workspacePath: "/repo/YCode",
          children: [],
          toolProcesses: [{ pid: 300, sessionId: "sess-1", sessionTitle: longTitle }],
        },
      ],
    }),
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  await responder.handleRequest(request("req-session"));

  // 这里使用 Main 实际使用的 schema，防止会话字段再次让整份回帖被拒绝。
  const [reply] = parseResponse(messages);
  const byPid = new Map(reply?.processes.map((process) => [process.pid, process]));
  assert.equal(byPid.get(300)?.sessionId, "sess-1");
  assert.equal(byPid.get(300)?.sessionTitle, longTitle);
  assert.equal(byPid.get(301)?.sessionId, "sess-1");
  assert.equal(reply?.samplingStatus, "complete");
});

test("进程表采样失败显式回帖 failed，不返回看似完整的空表", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler: {
      async sample() {
        throw new Error("process table unavailable");
      },
    },
    getAgentService: () => undefined,
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  await responder.handleRequest(request("req-fail"));

  const [reply] = parseResponse(messages);
  assert.equal(reply?.samplingStatus, "failed");
  assert.deepEqual(reply?.processes, []);
});

test("Agent 元数据失败只影响会话标注，不得把 PPID 后代采样判为失败", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler: createSampler(
      new Map([
        [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
        [300, sample(300, HOST_PID, "node")],
      ]),
    ),
    getAgentService: () => ({
      async collectLocalRuntimeChildProcesses() {
        throw new Error("agent metadata unavailable");
      },
    }),
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  await responder.handleRequest(request("req-agent-fail"));

  const [reply] = parseResponse(messages);
  assert.equal(reply?.samplingStatus, "complete");
  assert.deepEqual(
    reply?.processes.map((process) => process.pid),
    [300],
  );
});

test("进程表缺少 Host 自身时回 failed，避免空表伪装完整", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler: createSampler(new Map([[999, sample(999, 1, "unrelated")]])),
    getAgentService: () => undefined,
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  await responder.handleRequest(request("req-missing-host"));

  const [reply] = parseResponse(messages);
  assert.equal(reply?.samplingStatus, "failed");
  assert.deepEqual(reply?.processes, []);
});

test("已有采样在途时新请求回 failed，且不启动第二条采样", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  const samples = new Map([
    [HOST_PID, sample(HOST_PID, 1, "ycode-host")],
    [300, sample(300, HOST_PID, "node")],
  ]);
  let release: (value: Map<number, ProcessResourceSample>) => void = () => {};
  let calls = 0;
  const sampler: ProcessResourceSampler = {
    sample() {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler,
    getAgentService: () => undefined,
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  const first = responder.handleRequest(request("req-1"));
  await Promise.resolve();
  await responder.handleRequest(request("req-2"));

  assert.equal(calls, 1, "busy 时不能再启动第二条底层采样");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.requestId, "req-2");
  assert.equal(messages[0]?.samplingStatus, "failed");

  release(samples);
  await first;
  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.requestId, "req-1");
  assert.equal(messages[1]?.samplingStatus, "complete");
});

test("取消后不发布迟到结果", async () => {
  const messages: HostResourceUsageSnapshotResultResponse[] = [];
  let signalSeen: AbortSignal | undefined;
  const responder = createHostResourceUsageResponder({
    hostPid: HOST_PID,
    sampler: {
      sample(signal) {
        signalSeen = signal;
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(undefined));
        });
      },
    },
    getAgentService: () => undefined,
    postMessage: (message) => messages.push(message),
    now: () => 1,
  });

  const pending = responder.handleRequest(request("req-cancel"));
  await Promise.resolve();
  assert.equal(signalSeen?.aborted, false);
  responder.cancelRequest("req-cancel");
  await pending;

  assert.equal(signalSeen?.aborted, true);
  assert.deepEqual(messages, []);
});

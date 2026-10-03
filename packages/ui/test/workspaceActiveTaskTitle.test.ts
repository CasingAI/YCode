import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionsIndexScopes } from "../src/lib/buildSessionsIndexScopes.js";
import { resolveActiveTaskTitle } from "../src/lib/resolveActiveTaskTitle.js";

// 文案 id 到中文文案的最小映射，够断言占位分支选对了 key。
const PLACEHOLDERS: Record<string, string> = {
  "taskList.forkedUntitled": "新任务",
  "taskList.newThread": "新建任务",
};

const formatMessage = (descriptor: { id: string }): string => PLACEHOLDERS[descriptor.id];

test("meta 标题优先于 sessions-index", () => {
  // 重命名时新标题先落 tasks-index，session summary 稍后才回流；
  // 若让 sessions-index 优先，改完名的瞬间 Header 会闪回旧标题。
  assert.equal(
    resolveActiveTaskTitle({
      metaTitle: "手动改过的标题",
      sessionsIndexTitle: "旧标题",
      hasMeta: true,
      formatMessage,
    }),
    "手动改过的标题",
  );
});

test("meta 缺失时回落 sessions-index（置顶/归档会话的真实场景）", () => {
  assert.equal(
    resolveActiveTaskTitle({
      metaTitle: null,
      sessionsIndexTitle: "高性能只读方案调研",
      hasMeta: false,
      formatMessage,
    }),
    "高性能只读方案调研",
  );
});

test("meta 标题为空串或纯空白时同样让位给 sessions-index", () => {
  for (const metaTitle of ["", "   ", "\n\t"]) {
    assert.equal(
      resolveActiveTaskTitle({
        metaTitle,
        sessionsIndexTitle: "会话标题",
        hasMeta: true,
        formatMessage,
      }),
      "会话标题",
    );
  }
});

test("两个来源皆空：普通会话回落新建任务", () => {
  assert.equal(
    resolveActiveTaskTitle({
      hasMeta: false,
      formatMessage,
    }),
    "新建任务",
  );
});

test("两个来源皆空：fork 出的会话回落 forkedUntitled", () => {
  assert.equal(
    resolveActiveTaskTitle({
      hasMeta: true,
      forkedFromTaskId: "sess_parent",
      formatMessage,
    }),
    "新任务",
  );
});

test("无 meta 时即便传了 forkedFromTaskId 也按普通占位处理", () => {
  // forkedFromTaskId 只在 meta 存在时可信；草稿态不能因为脏值换文案。
  assert.equal(
    resolveActiveTaskTitle({
      hasMeta: false,
      forkedFromTaskId: "sess_parent",
      formatMessage,
    }),
    "新建任务",
  );
});

test("非空标题按原值返回，不做 trim 改写", () => {
  assert.equal(
    resolveActiveTaskTitle({
      metaTitle: "  前后留白  ",
      hasMeta: true,
      formatMessage,
    }),
    "  前后留白  ",
  );
});

test("sessions-index 标题为空串时继续落到占位文案", () => {
  assert.equal(
    resolveActiveTaskTitle({
      metaTitle: null,
      sessionsIndexTitle: "",
      hasMeta: false,
      formatMessage,
    }),
    "新建任务",
  );
});
// ── sessions-index scope 构造 ──
// 口径错了会让 sessionsIndexRegistry 为同一 endpoint+workspace 登记两条 entry：多建 store、
// 多发 subscribe；workspaceKey 相同而 agentService 不同时还可能挤掉侧栏正在用的本机 entry。

const localAgentService = { id: "local" };
const remoteAgentService = { id: "remote" };

test("scope 构造：本机 workspace 不带 endpointKey", () => {
  assert.deepEqual(
    buildSessionsIndexScopes({
      workspacePath: "/repo",
      resolvedRemoteSessionId: null,
      targetReady: true,
      agentService: localAgentService,
    }),
    [{ workspacePath: "/repo", agentService: localAgentService }],
  );
});

test("scope 构造：远端 shard 带 remoteSessionId 作为 endpointKey", () => {
  assert.deepEqual(
    buildSessionsIndexScopes({
      workspacePath: "/repo",
      workspaceIdentity: "ssh-host-1::/repo",
      resolvedRemoteSessionId: "sess_remote",
      targetReady: true,
      agentService: remoteAgentService,
    }),
    [
      {
        workspacePath: "/repo",
        workspaceIdentity: "ssh-host-1::/repo",
        endpointKey: "sess_remote",
        agentService: remoteAgentService,
      },
    ],
  );
});

test("scope 构造：remote-waiting 返回空数组，不拿断连代理占 __base__ key", () => {
  // useWorkspaceTaskLists 在同一状态下整条 config 直接 skip；这里若仍构造 scope，
  // 会用断连代理在 __base__ 上新建 entry，既订阅失败也可能挤掉同 key 的本机 entry。
  assert.deepEqual(
    buildSessionsIndexScopes({
      workspacePath: "/repo",
      workspaceIdentity: "ssh-host-1::/repo",
      resolvedRemoteSessionId: null,
      targetReady: false,
      agentService: { id: "disconnected-proxy" },
    }),
    [],
  );
});

test("scope 构造：空 workspaceIdentity 不展开该字段", () => {
  // 保持与 useWorkspaceTaskLists 的 truthy 判断一致，避免 scope 对象形状在订阅去重时抖动。
  const scopes = buildSessionsIndexScopes({
    workspacePath: "/repo",
    workspaceIdentity: "",
    resolvedRemoteSessionId: "sess_remote",
    targetReady: true,
    agentService: remoteAgentService,
  });
  assert.equal("workspaceIdentity" in scopes[0], false);
});

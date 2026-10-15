import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCliProxyMirrorState,
  resolveCliProxyCredentialChannels,
  resolveCliProxyCredentialMirrorPlan,
  runCliProxyCredentialMirror,
  writeCliProxyMirrorState,
} from "../src/cli-proxy/cliProxyMirror.js";
import { resolveCliProxyLayout } from "../src/cli-proxy/cliProxyVersions.js";
import type { CliProxyCredentialMirrorPorts } from "../src/cli-proxy/cliProxyMirror.js";

// 凭据镜像（docs/specs/plugin-cli-proxy-binary.md「凭据镜像」）：
// auth 目录里的支持渠道凭据自动镜像成 provider 条目；凭据消失条目退场；
// 手动卡片不受镜像管束；用户删过就永久放弃（withdrawn）。

function codexTemplates() {
  return [{ channel: "codex", templateId: "cliproxy-codex" }];
}

function plan(overrides: Partial<Parameters<typeof resolveCliProxyCredentialMirrorPlan>[0]> = {}) {
  return resolveCliProxyCredentialMirrorPlan({
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers: [],
    state: { version: 1, channels: {} },
    ...overrides,
  });
}

test("渠道识别：codex 前缀（真实样本）、多渠道去重、未知前缀与 lock 忽略", () => {
  assert.deepEqual(
    resolveCliProxyCredentialChannels([
      "codex-77bf18ea-thisisforgpt1234@gmail.com-pro.json",
      "codex-abc123-another@gmail.com.json",
      "claude-something.json",
      "config-backup.json",
      "codex-xxx.json.lock",
      "not-a-channel.json",
      "README.md",
    ]),
    ["codex", "claude"],
  );
  // 空目录/无文件 → 空渠道。
  assert.deepEqual(resolveCliProxyCredentialChannels([]), []);
});

test("规划：有凭据 + 无账本 + 无卡片 → 种子", () => {
  assert.deepEqual(plan(), [{ kind: "seed", channel: "codex", templateId: "cliproxy-codex" }]);
});

test("规划：已有可见同模板卡片（手动建过）→ 不种子、不收编", () => {
  assert.deepEqual(
    plan({
      providers: [{ providerId: "personal-codex", templateId: "cliproxy-codex" }],
    }),
    [],
  );
});

test("规划：在岗种子条目 + 凭据消失 → 隐藏；凭据回来 → 不动", () => {
  const state = {
    version: 1 as const,
    channels: {
      codex: { providerId: "personal-codex", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  const providers = [{ providerId: "personal-codex", templateId: "cliproxy-codex" as const }];
  assert.deepEqual(plan({ channels: [], state, providers }), [
    { kind: "hide", channel: "codex", providerId: "personal-codex" },
  ]);
  assert.deepEqual(plan({ state, providers }), []);
});

test("规划：已隐藏 + 凭据回来 → 恢复；仍无凭据 → 维持现状", () => {
  const state = {
    version: 1 as const,
    channels: {
      codex: {
        providerId: "personal-codex",
        seededAt: "2026-10-14T00:00:00.000Z",
        hidden: true,
      },
    },
  };
  assert.deepEqual(plan({ state }), [
    { kind: "unhide", channel: "codex", providerId: "personal-codex" },
  ]);
  assert.deepEqual(plan({ channels: [], state }), []);
});

test("规划：账本在岗但条目被用户删了（不在可见视图）→ withdraw，与凭据有无无关", () => {
  const state = {
    version: 1 as const,
    channels: {
      codex: { providerId: "personal-codex", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  const expected = [{ kind: "withdraw", channel: "codex", providerId: "personal-codex" }];
  assert.deepEqual(plan({ state }), expected);
  assert.deepEqual(plan({ channels: [], state }), expected);
});

test("规划：withdrawn 后永不动作（尊重删除意图，手动添加不受影响）", () => {
  const state = {
    version: 1 as const,
    channels: {
      codex: {
        providerId: "personal-codex",
        seededAt: "2026-10-14T00:00:00.000Z",
        withdrawn: true,
      },
    },
  };
  assert.deepEqual(plan({ state }), []);
  // 即使后来用户手动建了卡片再删掉，账本仍 withdrawn，不重新种子。
  assert.deepEqual(
    plan({
      state,
      providers: [{ providerId: "personal-codex-2", templateId: "cliproxy-codex" }],
    }),
    [],
  );
});

test("规划：无模板的渠道不参与；模板在但无凭据且无账本不动作", () => {
  assert.deepEqual(plan({ channels: ["claude"] }), []);
  assert.deepEqual(plan({ channels: [] }), []);
});

// ── 引擎（注入端口）──

function fakePorts(
  overrides: Partial<CliProxyCredentialMirrorPorts> = {},
): CliProxyCredentialMirrorPorts & {
  created: string[];
  visibility: Array<{ providerId: string; visibility: string }>;
  added: Array<{ providerId: string; modelId: string }>;
} {
  const created: string[] = [];
  const visibility: Array<{ providerId: string; visibility: string }> = [];
  const added: Array<{ providerId: string; modelId: string }> = [];
  return {
    created,
    visibility,
    added,
    createProviderFromTemplate: async (templateId) => {
      created.push(templateId);
      return { providerId: `personal-${templateId}-${created.length}` };
    },
    saveProviderVisibility: async (providerId, nextVisibility) => {
      visibility.push({ providerId, visibility: nextVisibility });
    },
    syncModels: async (providerId) => {
      added.push({ providerId, modelId: "gpt-6" }, { providerId, modelId: "gpt-6-codex" });
    },
    refreshVisibleProviderCapabilities: async () => {},
    ...overrides,
  };
}

test("引擎 startup：种子记录 providerId 与 seededAt，不做模型同步（代理还没起）", async () => {
  const ports = fakePorts({
    syncModels: async () => {
      throw new Error("startup 不该拉模型");
    },
  });
  const { actions, nextState } = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers: [],
    state: { version: 1, channels: {} },
    ports,
    now: () => new Date("2026-10-14T08:00:00.000Z"),
  });
  assert.deepEqual(actions, [{ kind: "seed", channel: "codex", templateId: "cliproxy-codex" }]);
  assert.deepEqual(ports.created, ["cliproxy-codex"]);
  assert.deepEqual(ports.added, []);
  assert.deepEqual(nextState.channels.codex, {
    providerId: "personal-cliproxy-codex-1",
    seededAt: "2026-10-14T08:00:00.000Z",
  });
});

test("引擎 running：可见的未同步条目补模型并记账；拉取失败/为空不记账", async () => {
  const state = {
    version: 1 as const,
    channels: {
      codex: { providerId: "personal-codex", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  const providers = [{ providerId: "personal-codex", templateId: "cliproxy-codex" as const }];
  const ports = fakePorts();
  const { nextState } = await runCliProxyCredentialMirror({
    phase: "running",
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers,
    state,
    ports,
  });
  assert.deepEqual(ports.added, [
    { providerId: "personal-codex", modelId: "gpt-6" },
    { providerId: "personal-codex", modelId: "gpt-6-codex" },
  ]);
  assert.equal(nextState.channels.codex.modelsSynced, true);

  // 拉取失败：不写模型、不记账（下次转 running 重试）。
  const retryPorts = fakePorts({
    syncModels: async () => {
      throw new Error("network down");
    },
  });
  const retried = await runCliProxyCredentialMirror({
    phase: "running",
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers,
    state,
    ports: retryPorts,
  });
  assert.deepEqual(retryPorts.added, []);
  assert.equal(retried.nextState.channels.codex.modelsSynced, undefined);
});

test("引擎 running：hidden/withdrawn/modelsSynced 条目跳过模型同步", async () => {
  const ports = fakePorts();
  await runCliProxyCredentialMirror({
    phase: "running",
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers: [],
    state: {
      version: 1,
      channels: {
        codex: {
          providerId: "personal-codex",
          seededAt: "2026-10-14T00:00:00.000Z",
          modelsSynced: true,
        },
      },
    },
    ports,
  });
  assert.deepEqual(ports.added, []);
});

test("引擎：unhide 失败（条目已被手删）转 withdrawn，防止每次启动重试", async () => {
  const ports = fakePorts({
    saveProviderVisibility: async () => {
      throw new Error("not found");
    },
  });
  const { nextState } = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers: [],
    state: {
      version: 1,
      channels: {
        codex: {
          providerId: "personal-codex",
          seededAt: "2026-10-14T00:00:00.000Z",
          hidden: true,
        },
      },
    },
    ports,
  });
  assert.equal(nextState.channels.codex.withdrawn, true);
});

test("引擎：hide/seed 失败不改账本（下次镜像重试），不中断其它动作", async () => {
  const ports = fakePorts({
    createProviderFromTemplate: async () => {
      throw new Error("busy");
    },
  });
  const { nextState } = await runCliProxyCredentialMirror({
    phase: "startup",
    channels: ["codex"],
    channelTemplates: codexTemplates(),
    providers: [],
    state: { version: 1, channels: {} },
    ports,
  });
  assert.equal(nextState.channels.codex, undefined);
});

test("状态账本：roundtrip + 损坏按空状态重建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-proxy-mirror-"));
  try {
    const layout = resolveCliProxyLayout(join(dir, "cli-proxy"));
    await writeCliProxyMirrorState(layout, {
      version: 1,
      channels: {
        codex: { providerId: "personal-codex", seededAt: "2026-10-14T00:00:00.000Z" },
      },
    });
    // 0600 落盘（与其他状态文件同一安全边界）。
    const raw = await readFile(join(layout.root, "mirror-state.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), {
      version: 1,
      channels: {
        codex: { providerId: "personal-codex", seededAt: "2026-10-14T00:00:00.000Z" },
      },
    });
    assert.deepEqual(await readCliProxyMirrorState(layout), {
      version: 1,
      channels: {
        codex: { providerId: "personal-codex", seededAt: "2026-10-14T00:00:00.000Z" },
      },
    });

    await writeFile(join(layout.root, "mirror-state.json"), "{broken", "utf8");
    assert.deepEqual(await readCliProxyMirrorState(layout), { version: 1, channels: {} });
    // 缺文件同样空状态。
    assert.deepEqual(await readCliProxyMirrorState(resolveCliProxyLayout(join(dir, "none"))), {
      version: 1,
      channels: {},
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

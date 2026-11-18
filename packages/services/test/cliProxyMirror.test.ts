import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCliProxyMirrorState,
  resolveCliProxyCredentialAccount,
  resolveCliProxyCredentialAccounts,
  resolveCliProxyCredentialChannels,
  resolveCliProxyCredentialMirrorPlan,
  runCliProxyCredentialMirror,
  writeCliProxyMirrorState,
} from "../src/cli-proxy/cliProxyMirror.js";
import { resolveCliProxyLayout } from "../src/cli-proxy/cliProxyVersions.js";
import type { CliProxyCredentialMirrorPorts } from "../src/cli-proxy/cliProxyMirror.js";

// 凭据镜像（docs/specs/plugin-cli-proxy-binary.md「凭据镜像」）：
// auth 目录里的一条凭据 = 一张 provider 卡片；账号靠模型前缀隔离；
// 凭据消失卡片退场；用户删过就永久放弃（withdrawn）；旧渠道级账本一次性迁移。

function codexTemplates() {
  return [{ channel: "codex", templateId: "cliproxy-codex", name: "CLI Proxy API (Codex)" }];
}

function plan(overrides: Partial<Parameters<typeof resolveCliProxyCredentialMirrorPlan>[0]> = {}) {
  return resolveCliProxyCredentialMirrorPlan({
    accounts: resolveCliProxyCredentialAccounts(["codex-77bf18ea-a@example.com-pro.json"]),
    channelTemplates: codexTemplates(),
    providers: [],
    state: { version: 2, accounts: {} },
    ...overrides,
  });
}

test("账号解析：hash/邮箱/计划后缀、无 hash 旧式文件名、未知前缀忽略", () => {
  assert.deepEqual(resolveCliProxyCredentialAccount("codex-77bf18ea-a@example.com-pro.json"), {
    channel: "codex",
    accountKey: "codex:77bf18ea",
    fileName: "codex-77bf18ea-a@example.com-pro.json",
    accountId: "77bf18ea",
    email: "a@example.com",
    prefix: "codex-77bf18ea",
  });
  const legacy = resolveCliProxyCredentialAccount("codex-b@example.com.json");
  assert.equal(legacy?.accountKey, "codex:b-example-com");
  assert.equal(legacy?.email, "b@example.com");
  assert.equal(legacy?.prefix, "codex-b-example-com");
  assert.equal(resolveCliProxyCredentialAccount("config-backup.json"), null);
  assert.equal(resolveCliProxyCredentialAccount("codex-xxx.json.lock"), null);
  assert.equal(resolveCliProxyCredentialAccount("README.md"), null);
});

test("账号列表：按文件名稳定排序、同账号去重、前缀冲突追加序号", () => {
  const accounts = resolveCliProxyCredentialAccounts([
    "codex-77bf18ea-a@example.com-pro.json",
    "codex-77bf18ea-a@example.com.json",
    "codex-abcdef-b@example.com.json",
    "claude-cccccc-c@example.com.json",
  ]);
  assert.deepEqual(
    accounts.map((account) => account.accountKey),
    ["claude:cccccc", "codex:77bf18ea", "codex:abcdef"],
  );
  assert.deepEqual(
    resolveCliProxyCredentialChannels([
      "codex-77bf18ea-a@example.com-pro.json",
      "claude-cccccc-c@example.com.json",
    ]),
    ["claude", "codex"],
  );
});

test("规划：两个账号 + 无账本 → 各自种子，卡片名带邮箱", () => {
  const accounts = resolveCliProxyCredentialAccounts([
    "codex-77bf18ea-a@example.com.json",
    "codex-abcdef-b@example.com.json",
  ]);
  assert.deepEqual(plan({ accounts }), [
    {
      kind: "seed",
      channel: "codex",
      templateId: "cliproxy-codex",
      accountKey: "codex:77bf18ea",
      providerName: "CLI Proxy API (Codex) · a@example.com",
      credentialName: "codex-77bf18ea-a@example.com.json",
    },
    {
      kind: "seed",
      channel: "codex",
      templateId: "cliproxy-codex",
      accountKey: "codex:abcdef",
      providerName: "CLI Proxy API (Codex) · b@example.com",
      credentialName: "codex-abcdef-b@example.com.json",
    },
  ]);
});

test("规划：手动添加的同模板卡片不阻止账号种子（手动卡片没有账号绑定）", () => {
  const actions = plan({
    providers: [{ providerId: "personal-codex", templateId: "cliproxy-codex" }],
  });
  assert.deepEqual(
    actions.map((action) => action.kind),
    ["seed"],
  );
});

test("规划：在岗账号凭据消失 → 隐藏；凭据回来 → 恢复", () => {
  const state = {
    version: 2 as const,
    accounts: {
      "codex:77bf18ea": {
        providerId: "personal-codex",
        seededAt: "2026-11-18T00:00:00.000Z",
        credentialName: "codex-77bf18ea-a@example.com.json",
      },
    },
  };
  const providers = [{ providerId: "personal-codex", templateId: "cliproxy-codex" }];
  assert.deepEqual(plan({ accounts: [], state, providers }), [
    { kind: "hide", channel: "codex", accountKey: "codex:77bf18ea", providerId: "personal-codex" },
  ]);
  assert.deepEqual(plan({ state, providers }), []);
  const hiddenState = {
    version: 2 as const,
    accounts: {
      "codex:77bf18ea": {
        ...state.accounts["codex:77bf18ea"]!,
        hidden: true,
      },
    },
  };
  assert.deepEqual(plan({ state: hiddenState }), [
    {
      kind: "unhide",
      channel: "codex",
      accountKey: "codex:77bf18ea",
      providerId: "personal-codex",
    },
  ]);
  assert.deepEqual(plan({ accounts: [], state: hiddenState }), []);
});

test("规划：账本在岗但卡片被删（不在可见视图）→ withdraw；withdrawn 后永不动作", () => {
  const state = {
    version: 2 as const,
    accounts: {
      "codex:77bf18ea": {
        providerId: "personal-codex",
        seededAt: "2026-11-18T00:00:00.000Z",
        credentialName: "codex-77bf18ea-a@example.com.json",
      },
    },
  };
  assert.deepEqual(plan({ state }), [
    {
      kind: "withdraw",
      channel: "codex",
      accountKey: "codex:77bf18ea",
      providerId: "personal-codex",
    },
  ]);
  const withdrawn = {
    version: 2 as const,
    accounts: {
      "codex:77bf18ea": { ...state.accounts["codex:77bf18ea"]!, withdrawn: true },
    },
  };
  assert.deepEqual(plan({ state: withdrawn }), []);
});

test("迁移：旧渠道账本 + 单账号 + 可见旧卡片 → 认领复用，不新种", () => {
  const legacyState = {
    version: 2 as const,
    accounts: {},
    legacyChannels: {
      codex: { providerId: "personal-legacy", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  assert.deepEqual(
    plan({
      state: legacyState,
      providers: [{ providerId: "personal-legacy", templateId: "cliproxy-codex" }],
    }),
    [
      {
        kind: "adopt",
        channel: "codex",
        accountKey: "codex:77bf18ea",
        providerId: "personal-legacy",
        credentialName: "codex-77bf18ea-a@example.com-pro.json",
      },
    ],
  );
});

test("迁移：旧渠道账本 + 多账号/无账号 → 旧卡退役，多账号各建一条", () => {
  const legacyState = {
    version: 2 as const,
    accounts: {},
    legacyChannels: {
      codex: { providerId: "personal-legacy", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  const providers = [{ providerId: "personal-legacy", templateId: "cliproxy-codex" }];
  const accounts = resolveCliProxyCredentialAccounts([
    "codex-77bf18ea-a@example.com.json",
    "codex-abcdef-b@example.com.json",
  ]);
  const actions = plan({ accounts, state: legacyState, providers });
  assert.equal(actions[0]?.kind, "retire-legacy");
  assert.deepEqual(
    actions.slice(1).map((action) => action.kind),
    ["seed", "seed"],
  );
  assert.deepEqual(plan({ accounts: [], state: legacyState, providers }), [
    { kind: "retire-legacy", channel: "codex", providerId: "personal-legacy" },
  ]);
});

test("迁移：模板基底卡 + 多账号 → 退役旧卡，按账号各建一条", () => {
  // 一卡一渠道时期用户手工启用的模板卡（providerId === templateId），没有 v1 账本。
  const providers = [{ providerId: "cliproxy-codex", templateId: "cliproxy-codex" }];
  const accounts = resolveCliProxyCredentialAccounts([
    "codex-77bf18ea-a@example.com.json",
    "codex-abcdef-b@example.com.json",
  ]);
  assert.deepEqual(
    plan({ accounts, providers }).map((action) => action.kind),
    ["retire-legacy", "seed", "seed"],
  );
});

test("迁移：模板基底卡 + 单账号 → 认领复用，不再退役、不新种", () => {
  const providers = [{ providerId: "cliproxy-codex", templateId: "cliproxy-codex" }];
  assert.deepEqual(plan({ providers }), [
    {
      kind: "adopt",
      channel: "codex",
      accountKey: "codex:77bf18ea",
      providerId: "cliproxy-codex",
      credentialName: "codex-77bf18ea-a@example.com-pro.json",
    },
  ]);
});

test("迁移：账号账本已落账后模板基底卡不再被退役", () => {
  const providers = [{ providerId: "cliproxy-codex", templateId: "cliproxy-codex" }];
  const state = {
    version: 2 as const,
    accounts: {
      "codex:77bf18ea": {
        providerId: "cliproxy-codex",
        seededAt: "2026-11-18T00:00:00.000Z",
        credentialName: "codex-77bf18ea-a@example.com-pro.json",
      },
    },
  };
  assert.deepEqual(plan({ state, providers }), []);
});

// ── 引擎（注入端口）──

function fakePorts(
  overrides: Partial<CliProxyCredentialMirrorPorts> = {},
): CliProxyCredentialMirrorPorts & {
  created: Array<{ templateId: string; providerName?: string }>;
  visibility: Array<{ providerId: string; visibility: string }>;
  prefixes: Array<{ credentialName: string; prefix: string }>;
  synced: Array<{ providerId: string; credentialName?: string; prefix?: string }>;
} {
  const created: Array<{ templateId: string; providerName?: string }> = [];
  const visibility: Array<{ providerId: string; visibility: string }> = [];
  const prefixes: Array<{ credentialName: string; prefix: string }> = [];
  const synced: Array<{ providerId: string; credentialName?: string; prefix?: string }> = [];
  return {
    created,
    visibility,
    prefixes,
    synced,
    createProviderFromTemplate: async (templateId, options) => {
      created.push({
        templateId,
        ...(options?.providerName ? { providerName: options.providerName } : {}),
      });
      return { providerId: `personal-${templateId}-${created.length}` };
    },
    saveProviderVisibility: async (providerId, nextVisibility) => {
      visibility.push({ providerId, visibility: nextVisibility });
    },
    ensureCredentialPrefix: async (credentialName, prefix) => {
      prefixes.push({ credentialName, prefix });
      return { changed: false };
    },
    syncModels: async (providerId, account) => {
      synced.push({
        providerId,
        ...(account ? { credentialName: account.credentialName, prefix: account.prefix } : {}),
      });
    },
    refreshVisibleProviderCapabilities: async () => {},
    ...overrides,
  };
}

const oneAccount = resolveCliProxyCredentialAccounts(["codex-77bf18ea-a@example.com.json"]);

test("引擎 startup：种子记录 accountKey/凭据文件名，不做前缀与模型同步", async () => {
  const ports = fakePorts({
    ensureCredentialPrefix: async () => {
      throw new Error("startup 不该写前缀");
    },
    syncModels: async () => {
      throw new Error("startup 不该拉模型");
    },
  });
  const { actions, nextState } = await runCliProxyCredentialMirror({
    phase: "startup",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers: [],
    state: { version: 2, accounts: {} },
    ports,
    now: () => new Date("2026-11-18T08:00:00.000Z"),
  });
  assert.deepEqual(
    actions.map((action) => action.kind),
    ["seed"],
  );
  assert.deepEqual(ports.created, [
    { templateId: "cliproxy-codex", providerName: "CLI Proxy API (Codex) · a@example.com" },
  ]);
  assert.deepEqual(ports.prefixes, []);
  assert.deepEqual(ports.synced, []);
  assert.deepEqual(nextState.accounts["codex:77bf18ea"], {
    providerId: "personal-cliproxy-codex-1",
    seededAt: "2026-11-18T08:00:00.000Z",
    credentialName: "codex-77bf18ea-a@example.com.json",
  });
});

test("引擎迁移：单账号认领旧卡后丢弃渠道键，下一轮不再退役", async () => {
  const ports = fakePorts();
  const legacyState = {
    version: 2 as const,
    accounts: {},
    legacyChannels: {
      codex: { providerId: "personal-legacy", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  const providers = [{ providerId: "personal-legacy", templateId: "cliproxy-codex" }];
  const first = await runCliProxyCredentialMirror({
    phase: "startup",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers,
    state: legacyState,
    ports,
  });
  assert.deepEqual(
    first.actions.map((action) => action.kind),
    ["adopt"],
  );
  assert.equal(first.nextState.accounts["codex:77bf18ea"]?.providerId, "personal-legacy");
  assert.equal(first.nextState.legacyChannels?.codex, undefined);
  // 第二轮：认领已落账，旧键不再残留 → 不会再对刚认领的卡片退役，也不新种。
  const second = await runCliProxyCredentialMirror({
    phase: "startup",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers,
    state: first.nextState,
    ports,
  });
  assert.deepEqual(second.actions, []);
  assert.deepEqual(ports.created, []);
});

test("引擎 running：先幂等写前缀，再按账号同步模型并记账；前缀变化时重新同步", async () => {
  const state = {
    version: 2 as const,
    accounts: {
      "codex:77bf18ea": {
        providerId: "personal-codex",
        seededAt: "2026-11-18T00:00:00.000Z",
        credentialName: "codex-77bf18ea-a@example.com.json",
        prefix: "codex-77bf18ea",
        modelsSynced: true,
      },
    },
  };
  const providers = [{ providerId: "personal-codex", templateId: "cliproxy-codex" }];
  const unchanged = fakePorts();
  const first = await runCliProxyCredentialMirror({
    phase: "running",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers,
    state,
    ports: unchanged,
  });
  assert.deepEqual(unchanged.prefixes, [
    { credentialName: "codex-77bf18ea-a@example.com.json", prefix: "codex-77bf18ea" },
  ]);
  // 前缀值未变且模型已同步：不重复拉模型。
  assert.deepEqual(unchanged.synced, []);
  assert.equal(first.nextState.accounts["codex:77bf18ea"]?.modelsSynced, true);

  // 前缀被外部清掉（changed=true）：必须重同步。
  const changed = fakePorts({
    ensureCredentialPrefix: async (credentialName, prefix) => {
      changed.prefixes.push({ credentialName, prefix });
      return { changed: true };
    },
  });
  const second = await runCliProxyCredentialMirror({
    phase: "running",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers,
    state,
    ports: changed,
  });
  assert.deepEqual(changed.synced, [
    {
      providerId: "personal-codex",
      credentialName: "codex-77bf18ea-a@example.com.json",
      prefix: "codex-77bf18ea",
    },
  ]);
  assert.equal(second.nextState.accounts["codex:77bf18ea"]?.modelsSynced, true);
});

test("引擎 running：前缀写入失败 → 不记 modelsSynced（下次 running 重试）", async () => {
  const ports = fakePorts({
    ensureCredentialPrefix: async () => {
      throw new Error("management unavailable");
    },
  });
  const { nextState } = await runCliProxyCredentialMirror({
    phase: "running",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers: [{ providerId: "personal-codex", templateId: "cliproxy-codex" }],
    state: {
      version: 2,
      accounts: {
        "codex:77bf18ea": {
          providerId: "personal-codex",
          seededAt: "2026-11-18T00:00:00.000Z",
          credentialName: "codex-77bf18ea-a@example.com.json",
        },
      },
    },
    ports,
  });
  assert.deepEqual(ports.synced, []);
  assert.equal(nextState.accounts["codex:77bf18ea"]?.modelsSynced, undefined);
});

test("引擎：hidden/withdrawn 账号跳过前缀与模型同步", async () => {
  const ports = fakePorts();
  await runCliProxyCredentialMirror({
    phase: "running",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers: [],
    state: {
      version: 2,
      accounts: {
        "codex:77bf18ea": {
          providerId: "personal-codex",
          seededAt: "2026-11-18T00:00:00.000Z",
          credentialName: "codex-77bf18ea-a@example.com.json",
          withdrawn: true,
        },
      },
    },
    ports,
  });
  assert.deepEqual(ports.prefixes, []);
  assert.deepEqual(ports.synced, []);
});

test("引擎：旧卡退役成功才丢弃 legacyChannels；失败保留待重试", async () => {
  const legacyState = {
    version: 2 as const,
    accounts: {},
    legacyChannels: {
      codex: { providerId: "personal-legacy", seededAt: "2026-10-14T00:00:00.000Z" },
    },
  };
  const okPorts = fakePorts();
  const ok = await runCliProxyCredentialMirror({
    phase: "startup",
    accounts: [],
    channelTemplates: codexTemplates(),
    providers: [{ providerId: "personal-legacy", templateId: "cliproxy-codex" }],
    state: legacyState,
    ports: okPorts,
  });
  assert.deepEqual(okPorts.visibility, [{ providerId: "personal-legacy", visibility: "hidden" }]);
  assert.equal(ok.nextState.legacyChannels?.codex, undefined);

  const failing = fakePorts({
    saveProviderVisibility: async () => {
      throw new Error("not found");
    },
  });
  const failed = await runCliProxyCredentialMirror({
    phase: "startup",
    accounts: [],
    channelTemplates: codexTemplates(),
    providers: [{ providerId: "personal-legacy", templateId: "cliproxy-codex" }],
    state: legacyState,
    ports: failing,
  });
  assert.equal(failed.nextState.legacyChannels?.codex?.providerId, "personal-legacy");
});

test("引擎：unhide 失败（条目已被手删）转 withdrawn，防止每次启动重试", async () => {
  const ports = fakePorts({
    saveProviderVisibility: async () => {
      throw new Error("not found");
    },
  });
  const { nextState } = await runCliProxyCredentialMirror({
    phase: "startup",
    accounts: oneAccount,
    channelTemplates: codexTemplates(),
    providers: [],
    state: {
      version: 2,
      accounts: {
        "codex:77bf18ea": {
          providerId: "personal-codex",
          seededAt: "2026-11-18T00:00:00.000Z",
          credentialName: "codex-77bf18ea-a@example.com.json",
          hidden: true,
        },
      },
    },
    ports,
  });
  assert.equal(nextState.accounts["codex:77bf18ea"]?.withdrawn, true);
});

test("状态账本：v2 roundtrip、v1 读入迁移、损坏按空状态重建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-proxy-mirror-"));
  try {
    const layout = resolveCliProxyLayout(join(dir, "cli-proxy"));
    const account = {
      providerId: "personal-codex",
      seededAt: "2026-11-18T00:00:00.000Z",
      credentialName: "codex-77bf18ea-a@example.com.json",
      prefix: "codex-77bf18ea",
    };
    await writeCliProxyMirrorState(layout, {
      version: 2,
      accounts: { "codex:77bf18ea": account },
    });
    const raw = JSON.parse(await readFile(join(layout.root, "mirror-state.json"), "utf8"));
    assert.deepEqual(raw, { version: 2, accounts: { "codex:77bf18ea": account } });
    assert.deepEqual(await readCliProxyMirrorState(layout), {
      version: 2,
      accounts: { "codex:77bf18ea": account },
    });

    // v1 渠道级账本读入为 legacyChannels（迁移前的输入），不会丢。
    await writeFile(
      join(layout.root, "mirror-state.json"),
      JSON.stringify({
        version: 1,
        channels: {
          codex: { providerId: "personal-legacy", seededAt: "2026-10-14T00:00:00.000Z" },
        },
      }),
      "utf8",
    );
    assert.deepEqual(await readCliProxyMirrorState(layout), {
      version: 2,
      accounts: {},
      legacyChannels: {
        codex: { providerId: "personal-legacy", seededAt: "2026-10-14T00:00:00.000Z" },
      },
    });

    await writeFile(join(layout.root, "mirror-state.json"), "{broken", "utf8");
    assert.deepEqual(await readCliProxyMirrorState(layout), { version: 2, accounts: {} });
    assert.deepEqual(await readCliProxyMirrorState(resolveCliProxyLayout(join(dir, "none"))), {
      version: 2,
      accounts: {},
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 技能目录渲染的真实生命周期回归：在测试自己的 Chromium 中挂载真实的
// useSessionSkillCatalogViews + SkillToolCallBlock，用可注入的目录服务控制
// subscribe ACK 门槛、pending/ready/error/scope 切换/runtime restart，验证 ACK 前
// 0 请求且不露原始 ref、首帧不跳变、late result 不跨 scope 回填、每个 scope 只请求一次。
// 不连接、不操作正在运行的 YCode；没有独立 Chromium 时显式跳过。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadChromium, resolveSource, uiRoot } from "./helpers/chromiumFixture.js";

// 使用非官方来源的插件技能：内置 i18n 标题只覆盖官方插件，这里的 display name
// 必须来自 frontmatter title，才能验证 scope 切换后拿到的是当前 scope 的数据。
const SKILL_REF = "community:team";
const TEAM_TITLE = "Team 派工手册";

function fixtureSource(): string {
  const hookPath = JSON.stringify(
    join(uiRoot, "src", "hooks", "useSessionSkillCatalogViews.ts").replace(/\\/g, "/"),
  );
  const rendererPath = JSON.stringify(
    join(uiRoot, "src", "ToolCallBlocks", "renderers", "skill.tsx").replace(/\\/g, "/"),
  );
  const intlPath = JSON.stringify(
    join(uiRoot, "src", "i18n", "IntlProvider.tsx").replace(/\\/g, "/"),
  );
  return `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useSessionSkillCatalogViews } from ${hookPath};
import { SkillToolCallBlock } from ${rendererPath};
import { ZCodeIntlProvider } from ${intlPath};

const runtime = {
  workspacePath: "/workspace",
  rpcReady: true,
  remoteSessionId: "remote-1",
  calls: [],
  pending: [],
  restartListeners: new Set(),
  setSessionId: null,
  setIdentity: null,
  setScope: null,
  setCatalogEnabled: null,
  refresh: null,
};

const services = {
  zcodeAgentService: {
    getSkillReferenceCatalog(params) {
      runtime.calls.push(params);
      return new Promise((resolve, reject) => {
        runtime.pending.push({ params, resolve, reject });
      });
    },
    onAgentRuntimeRestarted(listener) {
      runtime.restartListeners.add(listener);
      return { dispose: () => runtime.restartListeners.delete(listener) };
    },
  },
};
runtime.services = services;

function catalogResult(skills, authority = "session") {
  return { authority, skills };
}

function teamSkill() {
  return {
    id: "glm:plugin:community:skill-hash",
    name: "team",
    title: ${JSON.stringify(TEAM_TITLE)},
    description: "Team-mode dispatch handbook.",
    path: "/opt/zcode-community/team/1.0.0/skills/team/SKILL.md",
    scope: "plugin",
    enabled: true,
    pluginName: "community",
  };
}

function titledSkill(title) {
  return {
    ...teamSkill(),
    title,
  };
}

function SkillCard({ views }) {
  const context = {
    toolCallNode: {
      childToolCalls: [],
      toolCall: {
        toolId: "skill-e2e",
        toolName: "Skill",
        kind: "skill",
        title: "Skill",
        input: { skill: ${JSON.stringify(SKILL_REF)} },
        output: "loaded",
        status: "completed",
      },
    },
    skillDisplayNameByRef: views.skillDisplayNameByRef,
    workspacePath: "/workspace",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: true,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "已完成",
    childToolList: null,
    canToggle: true,
    forceOpen: false,
  };
  return <SkillToolCallBlock {...context} />;
}

function Fixture() {
  const [sessionId, setSessionId] = useState("sess-A");
  const [workspaceIdentity, setWorkspaceIdentity] = useState("ws-A");
  // 对应 SessionPane 的订阅 ACK 门槛：live 之前 enabled=false，目录不得发请求。
  const [catalogEnabled, setCatalogEnabled] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    runtime.setSessionId = setSessionId;
    runtime.setIdentity = setWorkspaceIdentity;
    runtime.setCatalogEnabled = setCatalogEnabled;
    // identity 与 remote attachment 属于同一个生命周期 scope：必须合并成一次提交，
    // 否则中间态会多发一次请求，测不到「一个 scope 一次请求」。
    runtime.setScope = (identity, remote) => {
      runtime.remoteSessionId = remote;
      setWorkspaceIdentity(identity);
    };
    runtime.refresh = () => setTick((value) => value + 1);
  }, []);
  const views = useSessionSkillCatalogViews({
    workspacePath: runtime.workspacePath,
    workspaceIdentity,
    sessionId,
    enabled: catalogEnabled,
  });
  const title = views.skillDisplayNameByRef?.get(${JSON.stringify(SKILL_REF)}) ?? "";
  return (
    <div>
      <div data-testid="ready">ready</div>
      <div data-testid="probe-ready">{views.skillDisplayNameByRef ? "1" : "0"}</div>
      <div data-testid="probe-title">{title || "none"}</div>
      <div data-testid="probe-session">{sessionId}</div>
      <div data-testid="probe-identity">{workspaceIdentity}</div>
      <SkillCard views={views} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="zh-CN">
    <Fixture />
  </ZCodeIntlProvider>,
);

globalThis.__skillRuntime = runtime;
globalThis.__skill = {
  calls: () => runtime.calls.slice(),
  pending: () => runtime.pending.map((entry) => entry.params),
  resolveAt: (index, result) => {
    const entry = runtime.pending.splice(index, 1)[0];
    if (!entry) throw new Error("no pending catalog request at " + index);
    entry.resolve(result);
  },
  rejectAt: (index, message) => {
    const entry = runtime.pending.splice(index, 1)[0];
    if (!entry) throw new Error("no pending catalog request at " + index);
    entry.reject(new Error(message));
  },
  restart: (workspaceKey) => {
    for (const listener of runtime.restartListeners) listener({ workspaceKey });
  },
  setRpcReady: (value) => {
    runtime.rpcReady = value;
    runtime.refresh();
  },
  setSession: (value) => runtime.setSessionId(value),
  setScope: (identity, remote) => runtime.setScope(identity, remote),
  setCatalogEnabled: (value) => runtime.setCatalogEnabled(value),
  teamSkill,
  titledSkill,
  catalogResult,
  TEAM_TITLE: ${JSON.stringify(TEAM_TITLE)},
};
`;
}

type BrowserRuntimeApi = {
  calls: () => Array<{ sessionId?: string; workspaceIdentity?: string; remoteSessionId?: string }>;
  pending: () => Array<{ sessionId?: string }>;
  resolveAt: (index: number, result: unknown) => void;
  rejectAt: (index: number, message: string) => void;
  restart: (workspaceKey: string) => void;
  setRpcReady: (value: boolean) => void;
  setSession: (value: string) => void;
  setScope: (identity: string, remote: string) => void;
  setCatalogEnabled: (value: boolean) => void;
  teamSkill: () => Record<string, unknown>;
  titledSkill: (title: string) => Record<string, unknown>;
  catalogResult: (skills: unknown[], authority?: string) => unknown;
};

test(
  "技能目录 subscribe ACK 门槛、pending→ready、错误、scope 切换/runtime restart 回归",
  { timeout: 90_000 },
  async (t) => {
    const chromiumFixture = await loadChromium();
    if (!chromiumFixture) {
      t.skip("未找到独立 Chromium；可设置 ZCODE_TEST_CHROMIUM_PATH 后重跑技能目录生命周期测试");
      return;
    }
    const { chromium, executablePath } = chromiumFixture;
    const { build } = await import("esbuild");
    const directory = await mkdtemp(join(tmpdir(), "ycode-skill-catalog-"));
    try {
      const entry = join(directory, "entry.tsx");
      const bundle = join(directory, "fixture.js");
      await writeFile(entry, fixtureSource(), "utf8");
      await build({
        entryPoints: [entry],
        outfile: bundle,
        bundle: true,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        target: ["chrome120"],
        logLevel: "silent",
        nodePaths: [join(uiRoot, "node_modules"), join(uiRoot, "..", "..", "node_modules")],
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [
          {
            name: "fake-workspace-services",
            setup(build) {
              build.onResolve({ filter: /^@\/hooks\/useWorkspaceServices(\.js)?$/ }, () => ({
                path: "fake-workspace-services",
                namespace: "skill-fixture",
              }));
              build.onLoad({ filter: /.*/, namespace: "skill-fixture" }, () => ({
                loader: "ts",
                contents: `
export function useWorkspaceServicesResolution(_workspacePath, preferredRemoteSessionId) {
  const runtime = globalThis.__skillRuntime;
  return {
    services: runtime.services,
    remoteSessionId: runtime.remoteSessionId ?? preferredRemoteSessionId,
    isRemoteTarget: false,
    connectionKind: "local-ready",
    targetReady: true,
    rpcReady: runtime.rpcReady,
  };
}
`,
              }));
            },
          },
          {
            name: "resolve-ui-source",
            setup(build) {
              build.onResolve({ filter: /^@\// }, async (args) => {
                const target = join(uiRoot, "src", args.path.slice(2));
                const resolvedPath = await resolveSource(target);
                return resolvedPath ? { path: resolvedPath } : undefined;
              });
              build.onResolve({ filter: /\.js$/ }, async (args) => {
                if (!args.path.startsWith(".")) return undefined;
                const resolvedPath = await resolveSource(join(args.resolveDir, args.path));
                return resolvedPath ? { path: resolvedPath } : undefined;
              });
            },
          },
        ],
      });

      const context = await chromium.launchPersistentContext(join(directory, "profile"), {
        executablePath,
        headless: true,
        viewport: { width: 900, height: 700 },
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(
          '<!doctype html><html><head><script>globalThis.__name = value => value;</script></head><body><div id="root"></div></body></html>',
        );
        await page.addScriptTag({ path: bundle });
        await page.getByTestId("ready").waitFor();

        const readCalls = () =>
          page.evaluate(
            () =>
              globalThis.__skill.calls() as Array<{
                workspacePath?: string;
                workspaceIdentity?: string;
                remoteSessionId?: string;
                sessionId?: string;
              }>,
          );
        const resolveAt = (index: number, result: unknown) =>
          page.evaluate(({ i, value }) => globalThis.__skill.resolveAt(i, value), {
            i: index,
            value: result,
          });
        const rejectAt = (index: number, message: string) =>
          page.evaluate(({ i, text }) => globalThis.__skill.rejectAt(i, text), {
            i: index,
            text: message,
          });
        const call = (name: keyof BrowserRuntimeApi, value?: unknown) =>
          page.evaluate(
            ({ key, next }) =>
              (globalThis.__skill as Record<string, (v?: unknown) => void>)[key](next),
            { key: name, next: value },
          );
        const setScope = (identity: string, remote: string) =>
          page.evaluate(
            ({ nextIdentity, nextRemote }) =>
              (globalThis.__skill as Record<string, (...args: unknown[]) => void>).setScope(
                nextIdentity,
                nextRemote,
              ),
            { nextIdentity: identity, nextRemote: remote },
          );
        const teamResult = () =>
          page.evaluate(() => globalThis.__skill.catalogResult([globalThis.__skill.teamSkill()]));
        const titledResult = (title: string) =>
          page.evaluate(
            (value) => globalThis.__skill.catalogResult([globalThis.__skill.titledSkill(value)]),
            title,
          );
        const waitForCalls = (count: number) =>
          page.waitForFunction(
            (expected) => globalThis.__skill.calls().length === expected,
            count,
            { timeout: 5_000 },
          );
        const probe = (id: string) => page.getByTestId(id).innerText();
        const bodyText = () => page.locator("body").innerText();
        const summaryText = () => page.getByTestId("tool-summary-trigger-skill-e2e").innerText();
        const waitForTitle = (title: string) =>
          page.getByTestId("probe-title").filter({ hasText: title }).waitFor({ timeout: 5_000 });
        const assertNeutral = async (label: string) => {
          assert.equal(await probe("probe-ready"), "0", `${label}: 查找表必须未就绪`);
          assert.equal(await probe("probe-title"), "none", `${label}: 不应出现标题`);
          assert.equal(
            (await summaryText()).includes(SKILL_REF),
            false,
            `${label}: 折叠摘要不能露出原始 ref`,
          );
        };

        // 订阅尚未 ACK：目录 enabled=false，不能发请求，也不能露出原始 ref。
        await assertNeutral("订阅未 ACK");
        assert.equal((await bodyText()).includes(SKILL_REF), false, "整页不能出现原始 ref");
        await page.waitForTimeout(120);
        assert.equal((await readCalls()).length, 0, "subscribe 未 ready 时不能请求目录");
        assert.equal(await page.evaluate(() => globalThis.__skill.pending().length), 0);

        // ACK live 后启用：effect 回填前仍是中性占位；一个 pane 只发一次请求。
        await call("setCatalogEnabled", true);
        await waitForCalls(1);
        assert.deepEqual(await readCalls(), [
          {
            workspacePath: "/workspace",
            workspaceIdentity: "ws-A",
            remoteSessionId: "remote-1",
            sessionId: "sess-A",
          },
        ]);
        assert.equal(await page.evaluate(() => globalThis.__skill.pending().length), 1);
        await assertNeutral("请求在途");

        // ready：最终友好名一次出现；折叠卡片可展开看到原始 ref，请求数不增加。
        await resolveAt(0, await teamResult());
        await waitForTitle(TEAM_TITLE);
        assert.equal(await probe("probe-ready"), "1");
        assert.equal((await bodyText()).includes(SKILL_REF), false);
        await page.getByTestId("tool-summary-trigger-skill-e2e").click();
        await page.waitForFunction((ref) => document.body.innerText.includes(ref), SKILL_REF, {
          timeout: 5_000,
        });
        assert.equal((await readCalls()).length, 1);

        // 会话切换：新 scope 立即回到未就绪；旧请求 late result 不得回填。
        // 连续切换到 sess-B/c 且都不先回填，确保 pending 队列里同时存在新旧两个 scope。
        await call("setSession", "sess-B");
        await waitForCalls(2);
        await assertNeutral("切会话后");
        await call("setSession", "sess-C");
        await waitForCalls(3);
        await assertNeutral("再次切会话后");
        assert.equal((await readCalls())[1]?.sessionId, "sess-B");
        assert.equal((await readCalls())[2]?.sessionId, "sess-C");
        await resolveAt(0, await teamResult());
        await page.waitForTimeout(120);
        await assertNeutral("旧会话 late result");
        await resolveAt(0, await titledResult("Team C Handbook"));
        await waitForTitle("Team C Handbook");
        assert.equal((await readCalls()).length, 3);

        // workspaceIdentity + remote attachment 切换：请求参数跟随新 scope；
        // 旧 scope 的在途结果同样不得回填。
        await setScope("ws-B", "remote-2");
        await waitForCalls(4);
        await assertNeutral("切 workspace/remote 后");
        assert.deepEqual((await readCalls())[3], {
          workspacePath: "/workspace",
          workspaceIdentity: "ws-B",
          remoteSessionId: "remote-2",
          sessionId: "sess-C",
        });
        await setScope("ws-C", "remote-3");
        await waitForCalls(5);
        await resolveAt(0, await titledResult("Stale Workspace B"));
        await page.waitForTimeout(120);
        await assertNeutral("旧 workspace late result");
        await resolveAt(0, await titledResult("Workspace C Handbook"));
        await waitForTitle("Workspace C Handbook");
        assert.equal((await readCalls()).length, 5);

        // 失败：不伪装成空目录；不显示 raw，也不能沿用上一份标题。
        await call("setSession", "sess-D");
        await waitForCalls(6);
        await rejectAt(0, "catalog unavailable");
        await page.waitForTimeout(120);
        await assertNeutral("目录失败");
        assert.equal((await readCalls()).length, 6);

        // 失败后恢复：新 scope 重新请求并显示标题。
        await call("setSession", "sess-E");
        await waitForCalls(7);
        await resolveAt(0, await titledResult("Recovered Handbook"));
        await waitForTitle("Recovered Handbook");

        // runtime restart：代次变化立即回到未就绪；旧代次 late result 丢弃。
        await call("setSession", "sess-F");
        await waitForCalls(8);
        await call("restart", "ws-C");
        await waitForCalls(9);
        await assertNeutral("runtime restart 后");
        await resolveAt(0, await titledResult("Stale Generation"));
        await page.waitForTimeout(120);
        await assertNeutral("旧 runtime generation late result");
        await resolveAt(0, await titledResult("Restarted Handbook"));
        await waitForTitle("Restarted Handbook");

        // 其它 workspace 的 restart 不触发请求；restart 后立即切 scope 与处于 pending 的
        // 请求共同验证作用域隔离。
        const beforeForeignRestart = (await readCalls()).length;
        await call("restart", "ws-other");
        await page.waitForTimeout(120);
        assert.equal((await readCalls()).length, beforeForeignRestart);

        // rpc 未就绪时不发请求；恢复后只补一次，不是按视图数放大。
        await call("setRpcReady", false);
        await page.waitForTimeout(120);
        const beforeNotReady = (await readCalls()).length;
        assert.equal(beforeNotReady, beforeForeignRestart);
        await call("setRpcReady", true);
        await waitForCalls(beforeNotReady + 1);

        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

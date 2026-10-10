import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SandboxConsoleDeadOverlay } from "../src/app-shell/SandboxConsoleSidePane.js";
import {
  openSandboxConsoleSidePane,
  type OpenSandboxConsoleSideTabRequest,
} from "../src/lib/workspaceSidePane.js";

// 沙盒控制台只读 tab：身份 = workspaceKey + parentSessionId + remoteSessionId，
// 一会话一 tab，已开则激活不重复建。规则见 docs/specs/sandbox-system-tool.md「控制台」。

function buildRequest(overrides?: Partial<OpenSandboxConsoleSideTabRequest>) {
  return {
    workspacePath: "/workspace",
    rootSessionId: "root-1",
    sessionId: "session-1",
    ...overrides,
  } satisfies OpenSandboxConsoleSideTabRequest;
}

test("openSandboxConsoleSidePane creates a sandbox-console tab with stable identity", () => {
  const next = openSandboxConsoleSidePane(null, buildRequest());
  assert.equal(next.tabs.length, 1);
  const tab = next.tabs[0];
  assert.equal(tab.type, "sandbox-console");
  assert.equal(next.activeTabId, tab.id);
  assert.match(tab.id, /^sandbox-console:/);
});

test("openSandboxConsoleSidePane reuses the existing tab for the same session", () => {
  const first = openSandboxConsoleSidePane(null, buildRequest());
  const second = openSandboxConsoleSidePane(first, buildRequest());
  assert.equal(second.tabs.length, 1);
  assert.equal(second.tabs[0].id, first.tabs[0].id);
});

test("openSandboxConsoleSidePane separates sessions and remote identities", () => {
  const first = openSandboxConsoleSidePane(null, buildRequest());
  const otherSession = openSandboxConsoleSidePane(
    first,
    buildRequest({ sessionId: "session-2" }),
  );
  assert.equal(otherSession.tabs.length, 2);
  const remote = openSandboxConsoleSidePane(
    first,
    buildRequest({ remoteSessionId: "remote-1" }),
  );
  assert.equal(remote.tabs.length, 2);
  assert.notEqual(remote.tabs[1].id, first.tabs[0].id);
});

test("openSandboxConsoleSidePane prefers workspaceIdentity as the workspace key", () => {
  const withIdentity = openSandboxConsoleSidePane(
    null,
    buildRequest({ workspaceIdentity: "  id-1  " }),
  );
  const withoutIdentity = openSandboxConsoleSidePane(null, buildRequest());
  assert.notEqual(withIdentity.tabs[0].id, withoutIdentity.tabs[0].id);
  assert.match(withIdentity.tabs[0].id, /id-1/);
});

// 死亡覆盖层直渲染（阶段7/8主路径点检的渲染面）：重置后已开 tab 不自动关，
// 整页覆盖挡住全部内容——标题/描述/关闭按钮三件齐全（中英文案均不断键）。
test("SandboxConsoleDeadOverlay renders title, description and close button", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const markup = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: locale },
        createElement(SandboxConsoleDeadOverlay, {}),
      ),
    );
    assert.match(markup, /sandbox-console-dead-overlay/);
    assert.match(markup, /sandbox-console-close/);
    // 标题与描述必须有真实文案（不是空壳，也不断 i18n 键）。
    assert.equal(markup.includes("sandboxConsole.dead"), false);
  }
  const zhMarkup = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SandboxConsoleDeadOverlay, {}),
    ),
  );
  assert.match(zhMarkup, /沙盒已经没了/);
  assert.match(zhMarkup, /关闭/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { handleSecondInstanceWorkspaceRequest } from "../src/main/desktopSecondInstanceDeepLink.js";

function makeDeps(
  overrides: Partial<Parameters<typeof handleSecondInstanceWorkspaceRequest>[0]> = {},
) {
  const opened: string[] = [];
  let focusedGate = 0;
  return {
    opened,
    get focusedGate() {
      return focusedGate;
    },
    deps: {
      additionalData: {},
      argv: [],
      forceUpdateBlocked: false,
      focusForceUpdateGateWindow: () => {
        focusedGate += 1;
      },
      handleDeepLink: () => false,
      handleOpenWorkspacePath: () => false,
      handleOpenFilePath: (path: string) => {
        opened.push(path);
        return true;
      },
      openFilePaths: ["/tmp/first.ts", "/tmp/second.pdf"],
      logger: { warn: () => undefined },
      ...overrides,
    },
  };
}

test("second instance routes every associated file in argument order", () => {
  const fixture = makeDeps();
  assert.equal(handleSecondInstanceWorkspaceRequest(fixture.deps), true);
  assert.deepEqual(fixture.opened, ["/tmp/first.ts", "/tmp/second.pdf"]);
});

test("force-update gate blocks OS file opening from a second instance", () => {
  const fixture = makeDeps({ forceUpdateBlocked: true });
  assert.equal(handleSecondInstanceWorkspaceRequest(fixture.deps), true);
  assert.deepEqual(fixture.opened, []);
  assert.equal(fixture.focusedGate, 1);
});

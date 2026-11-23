import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema } from "../src/validationAppSettings.js";

test("会话快照条目保留 lastActivatedAt，缺少时通过校验", () => {
  const settings = appSettingsSchema.parse({
    lastWorkspaceSession: [
      { kind: "local", workspacePath: "C:\\work\\a", lastActivatedAt: 100 },
      {
        kind: "remote",
        workspacePath: "/home/dev/app",
        target: { kind: "wsl", distro: "Ubuntu" },
        lastOpenedAt: 90,
        lastConnectionStatus: "connected",
        lastActivatedAt: 200,
      },
      { kind: "local", workspacePath: "C:\\work\\b" },
    ],
  });

  assert.deepEqual(
    settings.lastWorkspaceSession?.map((entry) => entry.lastActivatedAt),
    [100, 200, undefined],
  );
  // 非法值在迁移阶段被丢弃，视为从未激活，而不是让整份设置校验失败。
  assert.equal(
    appSettingsSchema.safeParse({
      lastWorkspaceSession: [{ kind: "local", workspacePath: "C:\\work\\a", lastActivatedAt: -1 }],
    }).success,
    true,
  );
  assert.equal(
    appSettingsSchema.parse({
      lastWorkspaceSession: [{ kind: "local", workspacePath: "C:\\work\\a", lastActivatedAt: -1 }],
    }).lastWorkspaceSession?.[0]?.lastActivatedAt,
    undefined,
  );
});

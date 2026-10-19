import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlatformChannels } from "@zcode/shared";
import {
  clearOAuthRoutesForWindow,
  deliverPendingDeepLink,
  handleOpenFilePath,
  isValidLocalOpenFilePath,
} from "../src/main/desktopOAuthDeepLink.js";

test("system file requests validate regular files and queue them until renderer readiness", () => {
  const directory = mkdtempSync(join(tmpdir(), "ycode-open-file-route-"));
  const filePath = join(directory, "source file.ts");
  writeFileSync(filePath, "export const value = 1;", "utf8");
  const logger = { info: () => undefined, warn: () => undefined };
  const sent: Array<[string, string]> = [];
  try {
    assert.equal(isValidLocalOpenFilePath(filePath), true);
    assert.equal(isValidLocalOpenFilePath(directory), false);
    assert.equal(
      handleOpenFilePath(directory, logger, { resolveApplicationWindow: () => null }),
      false,
    );
    assert.equal(
      handleOpenFilePath(filePath, logger, {
        allowWithoutReadyWindow: true,
        resolveApplicationWindow: () => null,
      }),
      true,
    );

    deliverPendingDeepLink({
      id: 987654,
      send: (channel: string, path: string) => sent.push([channel, path]),
    } as never);
    assert.deepEqual(sent, [[PlatformChannels.OpenFilePath, filePath]]);
  } finally {
    clearOAuthRoutesForWindow(987654);
    rmSync(directory, { recursive: true, force: true });
  }
});

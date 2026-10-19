import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeepLinkSingleInstanceData,
  extractOpenFilePathsFromArgs,
  extractOpenFilePathsFromSingleInstanceData,
} from "../src/main/desktopDeepLinkUrl.js";

test("OS file arguments retain absolute paths, spaces, Windows paths, and deduplicate requests", () => {
  assert.deepEqual(
    extractOpenFilePathsFromArgs([
      "/Users/test/My Project/src/main.ts",
      "/Users/test/My Project/src/main.ts",
      "C:\\Users\\test\\Documents\\notes.pdf",
      "\\\\server\\share\\report.docx",
      "relative.ts",
      "--verbose",
      "--open-workspace",
      "/Users/test/Project",
      "zcode://workspace/open?path=%2FUsers%2Ftest%2FProject",
    ]),
    [
      "/Users/test/My Project/src/main.ts",
      "C:\\Users\\test\\Documents\\notes.pdf",
      "\\\\server\\share\\report.docx",
    ],
  );
});

test("single-instance metadata transports multiple file paths for cold and warm launches", () => {
  const devData = createDeepLinkSingleInstanceData([
    "/Applications/Electron",
    "/repo/packages/desktop/out/main/index.js",
    "/tmp/first.ts",
    "/tmp/second.pdf",
  ]);
  assert.deepEqual(extractOpenFilePathsFromSingleInstanceData(devData), [
    "/tmp/first.ts",
    "/tmp/second.pdf",
  ]);

  const packagedData = createDeepLinkSingleInstanceData(
    ["/Applications/YCode.app/Contents/MacOS/YCode", "/tmp/one.ts"],
    { isPackaged: true },
  );
  assert.deepEqual(extractOpenFilePathsFromSingleInstanceData(packagedData), ["/tmp/one.ts"]);
  assert.deepEqual(extractOpenFilePathsFromSingleInstanceData({ openFilePaths: "not-json" }), []);
});

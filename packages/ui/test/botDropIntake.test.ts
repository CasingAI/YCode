import assert from "node:assert/strict";
import test from "node:test";
import { classifyBotDrop, droppedFilesToAttachments, pathFromFileUri } from "../src/bots/botDropIntake.js";

test("file URI 转成本地路径", () => {
  assert.equal(pathFromFileUri("file:///Users/ada/proj"), "/Users/ada/proj");
  assert.equal(pathFromFileUri("file:///C:/Users/ada/proj"), "C:/Users/ada/proj");
  assert.equal(pathFromFileUri("/already/path"), "/already/path");
});

test("空 type 且大小为 0 的项当文件夹", () => {
  const folder = { name: "proj", type: "", size: 0 } as File;
  const intake = classifyBotDrop({
    files: [folder],
    getPathForFile: () => "/Users/ada/proj",
  });
  assert.deepEqual(intake, { kind: "folders", paths: ["/Users/ada/proj"] });
});

test("有内容的文件进对话附件", () => {
  const file = { name: "shot.png", type: "image/png", size: 12 } as File;
  const intake = classifyBotDrop({
    files: [file],
    getPathForFile: () => "/tmp/shot.png",
  });
  assert.equal(intake.kind, "files");
  if (intake.kind !== "files") {
    return;
  }
  assert.deepEqual(droppedFilesToAttachments(intake.files), [
    { ref: "/tmp/shot.png", fileName: "shot.png", mime: "image/png", bytes: 12 },
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { isMissingFileError } from "../src/lib/fileReadError.js";

test("通过错误码或文件不存在消息识别缺失文件", () => {
  assert.equal(isMissingFileError({ code: "ENOENT" }), true);
  assert.equal(isMissingFileError(new Error("ENOENT: no such file or directory")), true);
  assert.equal(isMissingFileError(new Error("no such file or directory")), true);
});

test("权限错误和非错误值不识别为缺失文件", () => {
  assert.equal(isMissingFileError(new Error("permission denied")), false);
  assert.equal(isMissingFileError({ code: "EACCES" }), false);
  assert.equal(isMissingFileError(null), false);
});

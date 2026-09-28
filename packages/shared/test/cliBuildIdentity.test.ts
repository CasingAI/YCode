import assert from "node:assert/strict";
import test from "node:test";
import { isBoundCliBuildVersion, parseCliVersionSidecar } from "../src/cli-build-identity.js";

test("三段数字版本才构成绑定身份", () => {
  assert.equal(isBoundCliBuildVersion("0.16.10"), true);
  assert.equal(isBoundCliBuildVersion("3.14.0"), true);
});

test("空串、开发占位和预发布后缀都不构成绑定", () => {
  assert.equal(isBoundCliBuildVersion(undefined), false);
  assert.equal(isBoundCliBuildVersion(""), false);
  assert.equal(isBoundCliBuildVersion("0.0.0-dev"), false);
  assert.equal(isBoundCliBuildVersion("unknown"), false);
  assert.equal(isBoundCliBuildVersion("0.16.10-beta"), false);
});

test("sidecar 只接受对象里的合法 version 字段", () => {
  assert.equal(parseCliVersionSidecar({ version: "0.16.10" }), "0.16.10");
  assert.equal(parseCliVersionSidecar({ version: " 0.16.10 " }), "0.16.10");
  assert.equal(parseCliVersionSidecar({ version: "0.16.10-dev" }), undefined);
  assert.equal(parseCliVersionSidecar({ version: "" }), undefined);
  assert.equal(parseCliVersionSidecar([]), undefined);
  assert.equal(parseCliVersionSidecar("0.16.10"), undefined);
});

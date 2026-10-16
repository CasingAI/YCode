import assert from "node:assert/strict";
import test from "node:test";
import { getZCodeToolFamilyForName, normalizeZCodeToolName } from "../src/tool-identity.js";

test("消息工具新旧名统一归一到 RelayToSubagent message family", () => {
  for (const toolName of ["RelayToSubagent", "SendMessage"]) {
    assert.equal(normalizeZCodeToolName(toolName), "RelayToSubagent");
    assert.equal(getZCodeToolFamilyForName(toolName), "message");
  }
});

test("沙盒工具新旧名统一归一到 JSVM 且不分配跨端 family", () => {
  for (const toolName of ["JSVM", "Sandbox"]) {
    assert.equal(normalizeZCodeToolName(toolName), "JSVM");
    assert.equal(getZCodeToolFamilyForName(toolName), null);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { resolveDirectCliDynamicWorkflowEnabled } from "../src/dynamic-workflow.js";

test("直接 CLI 默认关闭 Dynamic Workflow", () => {
  assert.equal(resolveDirectCliDynamicWorkflowEnabled({}), false);
  assert.equal(
    resolveDirectCliDynamicWorkflowEnabled({ ZCODE_DYNAMIC_WORKFLOW_MODE: "disabled" }),
    false,
  );
  assert.equal(
    resolveDirectCliDynamicWorkflowEnabled({ ZCODE_DYNAMIC_WORKFLOW_MODE: "unexpected" }),
    false,
  );
});

test("直接 CLI 只有显式合法模式才开启 Dynamic Workflow", () => {
  assert.equal(
    resolveDirectCliDynamicWorkflowEnabled({ ZCODE_DYNAMIC_WORKFLOW_MODE: "onDemand" }),
    true,
  );
  assert.equal(
    resolveDirectCliDynamicWorkflowEnabled({ ZCODE_DYNAMIC_WORKFLOW_MODE: "alwaysOn" }),
    true,
  );
});

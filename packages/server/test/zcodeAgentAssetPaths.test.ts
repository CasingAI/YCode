import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOTE_AGENT_BUNDLE_NAME,
  REMOTE_AGENT_HISTORY_WORKER_NAME,
  REMOTE_AGENT_SQLITE_WORKER_NAME,
} from "../src/remote/zcodeAgentBundleWrapper.js";
import { buildRemoteAgentRequiredAssetPaths } from "../src/remote/zcodeAgentAssetPaths.js";

test("远端 Agent 资产校验同时要求 bundle 与两个只读 worker", () => {
  assert.deepEqual(buildRemoteAgentRequiredAssetPaths("/agents/glm"), [
    `/agents/glm/${REMOTE_AGENT_BUNDLE_NAME}`,
    `/agents/glm/${REMOTE_AGENT_HISTORY_WORKER_NAME}`,
    `/agents/glm/${REMOTE_AGENT_SQLITE_WORKER_NAME}`,
  ]);
});

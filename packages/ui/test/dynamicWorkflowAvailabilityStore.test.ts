import assert from "node:assert/strict";
import test from "node:test";
import { useDynamicWorkflowAvailabilityStore } from "../src/store/dynamicWorkflowAvailabilityStore.js";

test("Dynamic Workflow availability 直接由用户设置 true 控制", () => {
  const store = useDynamicWorkflowAvailabilityStore.getState();
  store.setUserOptIn(true);

  const state = useDynamicWorkflowAvailabilityStore.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.enabled, true);
  assert.equal(state.config, null);
});

test("Dynamic Workflow availability 直接由用户设置 false 控制", () => {
  const store = useDynamicWorkflowAvailabilityStore.getState();
  store.setUserOptIn(false);

  const state = useDynamicWorkflowAvailabilityStore.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.enabled, false);
  assert.equal(state.config, null);
});

test("未发布用户设置时 availability 保持 loading", () => {
  useDynamicWorkflowAvailabilityStore.getState().setUserOptIn(undefined);

  const state = useDynamicWorkflowAvailabilityStore.getState();
  assert.equal(state.status, "loading");
  assert.equal(state.enabled, false);
  assert.equal(state.config, null);
});

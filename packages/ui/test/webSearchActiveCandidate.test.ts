import assert from "node:assert/strict";
import test from "node:test";
import { resolveActiveWebSearchCandidateId } from "../src/lib/webSearchActiveCandidate.js";

test("网络搜索：排序首项缺少 Key 时，激活徽章标记实际可用的后续搜索源", () => {
  assert.equal(
    resolveActiveWebSearchCandidateId([
      { providerId: "plan-no-key", hasApiKey: false },
      { providerId: "paid-with-key", hasApiKey: true },
    ]),
    "paid-with-key",
  );
});

test("网络搜索：全部缺少 Key 时不标记任何激活项", () => {
  assert.equal(
    resolveActiveWebSearchCandidateId([
      { providerId: "plan-no-key", hasApiKey: false },
      { providerId: "paid-no-key", hasApiKey: false },
    ]),
    undefined,
  );
  assert.equal(resolveActiveWebSearchCandidateId([]), undefined);
});

test("网络搜索：首项 Key 可用时仍优先首项，排序变化同步改变激活项", () => {
  const candidates = [
    { providerId: "plan", hasApiKey: true },
    { providerId: "paid", hasApiKey: true },
  ];
  assert.equal(resolveActiveWebSearchCandidateId(candidates), "plan");
  assert.equal(resolveActiveWebSearchCandidateId([...candidates].reverse()), "paid");
});

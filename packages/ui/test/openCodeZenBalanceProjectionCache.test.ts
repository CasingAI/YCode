import assert from "node:assert/strict";
import test from "node:test";
import type { OpenCodeZenBalanceSnapshot } from "@zcode/shared";
import { projectOpenCodeZenBalanceResponse } from "@/hooks/openCodeZenBalanceProjectionCache.js";

function createSnapshot(params: {
  credentialRevision: number;
  amount?: number;
  error?: OpenCodeZenBalanceSnapshot["error"];
  withBalance?: boolean;
}): OpenCodeZenBalanceSnapshot {
  return {
    providerId: "opencode-zen-responses",
    fetchedAt: 1_000,
    credentialRevision: params.credentialRevision,
    balances:
      params.withBalance === false ? [] : [{ currency: "USD", amount: params.amount ?? 4.1 }],
    error: params.error ?? null,
    errorMessage: null,
  };
}

test("same Zen API Key 的临时失败保留 last-good 余额", () => {
  const previous = createSnapshot({ credentialRevision: 1, amount: 4.1 });
  const projected = projectOpenCodeZenBalanceResponse({
    previous: { lastGood: previous, error: null },
    snapshot: createSnapshot({ credentialRevision: 1, error: "unavailable", withBalance: false }),
  });
  assert.equal(projected?.lastGood, previous);
  assert.equal(projected?.error, "unavailable");
});

test("Zen API Key 换账号后失败时不显示旧账号余额", () => {
  const previous = createSnapshot({ credentialRevision: 1, amount: 4.1 });
  const projected = projectOpenCodeZenBalanceResponse({
    previous: { lastGood: previous, error: null },
    snapshot: createSnapshot({ credentialRevision: 2, error: "unavailable", withBalance: false }),
  });
  assert.equal(projected?.lastGood, null);
  assert.equal(projected?.error, "unavailable");
});

test("API Key 移除后清除旧余额投影", () => {
  const previous = createSnapshot({ credentialRevision: 1, amount: 4.1 });
  assert.equal(
    projectOpenCodeZenBalanceResponse({
      previous: { lastGood: previous, error: null },
      snapshot: createSnapshot({
        credentialRevision: 2,
        error: "not-configured",
        withBalance: false,
      }),
    }),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import type {
  DeepSeekBalanceInfo,
  DeepSeekBalanceSnapshot,
} from "@zcode/shared";
import {
  formatDeepSeekAmount,
  toDeepSeekBalanceLines,
} from "@/settings/model-provider-section/deepseekBalanceDisplay.js";
import {
  beginDeepSeekBalanceProjectionRequest,
  clearDeepSeekBalanceProjection,
  commitDeepSeekBalanceProjection,
  isCurrentDeepSeekBalanceProjectionRequest,
  projectDeepSeekBalanceResponse,
  readDeepSeekBalanceProjection,
} from "@/hooks/deepSeekBalanceProjectionCache.js";

function balance(
  overrides: Partial<DeepSeekBalanceInfo> = {},
): DeepSeekBalanceInfo {
  return {
    currency: "CNY",
    totalBalance: 110,
    grantedBalance: 10,
    toppedUpBalance: 100,
    ...overrides,
  };
}

function snapshot(params: {
  balances: DeepSeekBalanceInfo[];
  error?: DeepSeekBalanceSnapshot["error"];
  fetchedAt?: number;
}): DeepSeekBalanceSnapshot {
  return {
    providerId: "p1",
    fetchedAt: params.fetchedAt ?? 1_000,
    isAvailable: null,
    balances: params.balances,
    error: params.error ?? null,
    errorMessage: null,
  };
}

test("formatDeepSeekAmount 保留两位上限并去掉尾随 0", () => {
  assert.equal(formatDeepSeekAmount(110), "110");
  assert.equal(formatDeepSeekAmount(110.5), "110.5");
  assert.equal(formatDeepSeekAmount(0.5), "0.5");
  assert.equal(formatDeepSeekAmount(0), "0");
  assert.equal(formatDeepSeekAmount(-3.25), "-3.25");
  // 缺失与非有限数不展示成 0，避免把「没有数据」说成「没钱」。
  assert.equal(formatDeepSeekAmount(null), "");
  assert.equal(formatDeepSeekAmount(Number.NaN), "");
});

test("toDeepSeekBalanceLines 过滤空币种与空壳条目", () => {
  const lines = toDeepSeekBalanceLines([
    balance({ currency: "" }),
    balance({
      totalBalance: null,
      grantedBalance: null,
      toppedUpBalance: null,
    }),
    balance(),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.currency, "CNY");
});

test("toDeepSeekBalanceLines 只保留币种与金额两个字段", () => {
  const [line] = toDeepSeekBalanceLines([
    balance({ grantedBalance: 0, toppedUpBalance: 0 }),
  ]);
  assert.deepEqual(Object.keys(line ?? {}).sort(), ["currency", "total"]);
  assert.equal(line?.currency, "CNY");
  assert.equal(line?.total, 110);
});

test("toDeepSeekBalanceLines 金额缺失但有构成数据时仍出行，金额为 null", () => {
  const lines = toDeepSeekBalanceLines([
    balance({ totalBalance: null, grantedBalance: 5, toppedUpBalance: null }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.total, null);
});

test("toDeepSeekBalanceLines 让 CNY 排在首位，其余保持远端顺序", () => {
  const lines = toDeepSeekBalanceLines([
    balance({ currency: "USD" }),
    balance({ currency: "EUR" }),
    balance({ currency: "CNY" }),
  ]);
  assert.deepEqual(
    lines.map((line) => line.currency),
    ["CNY", "USD", "EUR"],
  );
});

test("投影：成功快照更新余额，失败保留上一次展示值", () => {
  const good = projectDeepSeekBalanceResponse({
    previous: null,
    snapshot: snapshot({ balances: [balance()] }),
  });
  assert.equal(good?.lastGood?.balances.length, 1);
  assert.equal(good?.error, null);

  const failed = projectDeepSeekBalanceResponse({
    previous: good,
    snapshot: snapshot({ balances: [], error: "unavailable" }),
  });
  assert.equal(failed?.error, "unavailable");
  assert.equal(failed?.lastGood?.balances.length, 1);
});

test("投影：not-configured 清空该 provider 的展示值", () => {
  assert.equal(
    projectDeepSeekBalanceResponse({
      previous: null,
      snapshot: snapshot({ balances: [], error: "not-configured" }),
    }),
    null,
  );
});

test("投影按 Service 实例与 providerId 隔离", () => {
  const serviceA = {};
  const serviceB = {};
  const generation = beginDeepSeekBalanceProjectionRequest(serviceA, "p1");
  const projection = projectDeepSeekBalanceResponse({
    previous: null,
    snapshot: snapshot({ balances: [balance()] }),
  });
  assert.ok(projection);
  assert.equal(
    commitDeepSeekBalanceProjection({
      service: serviceA,
      providerId: "p1",
      generation,
      projection,
    }),
    true,
  );
  assert.equal(
    readDeepSeekBalanceProjection(serviceA, "p1")?.lastGood?.balances.length,
    1,
  );
  // 另一个 Service 实例 / 另一个 provider 都读不到。
  assert.equal(readDeepSeekBalanceProjection(serviceB, "p1"), null);
  assert.equal(readDeepSeekBalanceProjection(serviceA, "p2"), null);
});

test("投影：过期 generation 不能提交（后发请求已领取）", () => {
  const service = {};
  const stale = beginDeepSeekBalanceProjectionRequest(service, "p1");
  const current = beginDeepSeekBalanceProjectionRequest(service, "p1");
  const projection = projectDeepSeekBalanceResponse({
    previous: null,
    snapshot: snapshot({ balances: [balance()] }),
  });
  assert.ok(projection);
  assert.equal(
    commitDeepSeekBalanceProjection({
      service,
      providerId: "p1",
      generation: stale,
      projection,
    }),
    false,
  );
  assert.equal(
    isCurrentDeepSeekBalanceProjectionRequest(service, "p1", current),
    true,
  );
});

test("投影：清除 entry 后读不到，旧请求失效", () => {
  const service = {};
  const generation = beginDeepSeekBalanceProjectionRequest(service, "p1");
  const projection = projectDeepSeekBalanceResponse({
    previous: null,
    snapshot: snapshot({ balances: [balance()] }),
  });
  assert.ok(projection);
  commitDeepSeekBalanceProjection({
    service,
    providerId: "p1",
    generation,
    projection,
  });

  const cleared = clearDeepSeekBalanceProjection(service, "p1");
  assert.equal(readDeepSeekBalanceProjection(service, "p1"), null);
  assert.equal(
    isCurrentDeepSeekBalanceProjectionRequest(service, "p1", generation),
    false,
  );
  assert.ok(cleared > generation);
});

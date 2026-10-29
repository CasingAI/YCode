import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelGroupMemberOrderEntries,
  resolveModelGroupMemberOrder,
} from "../src/settings/modelGroupMemberOrder.js";

// 模型组成员可重复（docs/specs/model-group.md）：拖拽 id 必须按出现序号区分，
// 同模型同档位的多条成员各自独立搬运、不合并、不改写。
const members = [
  { providerId: "p", modelId: "m", reasoningLevel: "high" },
  { providerId: "p", modelId: "m", reasoningLevel: "high", selectable: false },
  { providerId: "p", modelId: "m", reasoningLevel: "low" },
  { providerId: "q", modelId: "n" },
];

test("重复成员 id 唯一且相同基础键按出现序号递增", () => {
  const entries = buildModelGroupMemberOrderEntries(members);
  const ids = entries.map((entry) => entry.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(ids[0], ids[1]);
  // selectable 不参与基础键：同 provider+model+档位仍靠出现序号区分。
  assert.equal(
    ids[0]!.slice(0, ids[0]!.lastIndexOf("#")),
    ids[1]!.slice(0, ids[1]!.lastIndexOf("#")),
  );
  assert.match(ids[0]!, /#0$/);
  assert.match(ids[1]!, /#1$/);
  assert.notEqual(ids[2], ids[0]);
  assert.match(ids[2]!, /#0$/);
});

test("按 id 顺序还原成员，重复条目保持各自策略", () => {
  const entries = buildModelGroupMemberOrderEntries(members);
  const nextIds = entries.map((entry) => entry.id).reverse();
  const resolved = resolveModelGroupMemberOrder(entries, nextIds);

  assert.deepEqual(resolved, [...members].reverse());
  assert.equal(resolved?.[2]?.selectable, false);
  assert.equal(resolved?.[3]?.reasoningLevel, "high");
});

test("未知 id 返回 null，不写出残缺名单", () => {
  const entries = buildModelGroupMemberOrderEntries(members);
  const nextIds = entries.map((entry) => entry.id);
  nextIds[1] = "unknown-member-id";

  assert.equal(resolveModelGroupMemberOrder(entries, nextIds), null);
});

test("数量不匹配或 id 重复返回 null", () => {
  const entries = buildModelGroupMemberOrderEntries(members);
  const ids = entries.map((entry) => entry.id);

  assert.equal(resolveModelGroupMemberOrder(entries, ids.slice(0, -1)), null);
  assert.equal(resolveModelGroupMemberOrder(entries, [...ids.slice(0, -1), ids[0]!]), null);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  modelGroupDeprioritizeScheduleSchema,
  pickLowestCostReasoningLevel,
  selectModelGroupCandidates,
  type ModelGroupMemberRef,
} from "../src/model-selection.js";

test("最低成本档位优先关闭语义值，否则取配置第一项并保留原值", () => {
  // 关闭语义值优先于配置顺序，且返回配置原值而不是归一化文本。
  assert.equal(pickLowestCostReasoningLevel(["low", "OFF", "high"]), "OFF");
  assert.equal(pickLowestCostReasoningLevel(["no_think", "low"]), "no_think");
  assert.equal(pickLowestCostReasoningLevel(["high", "low"]), "high");
  assert.equal(pickLowestCostReasoningLevel(["Low", "No-Think"]), "No-Think");
});

test("最低成本档位：空表/缺席返回 undefined，不编档位", () => {
  assert.equal(pickLowestCostReasoningLevel(undefined), undefined);
  assert.equal(pickLowestCostReasoningLevel([]), undefined);
});

test("模型组候选默认包含旧成员、排除 selectable=false 并保留完整快照", () => {
  const members = [
    { providerId: "p", modelId: "old-default", reasoningLevel: "high", snapshot: 1 },
    { providerId: "p", modelId: "disabled", selectable: false, snapshot: 2 },
  ] as const satisfies readonly (ModelGroupMemberRef & { readonly snapshot: number })[];

  assert.deepEqual(selectModelGroupCandidates(members, new Date("2026-10-26T12:00:00Z")), [
    members[0],
  ]);
  assert.equal(selectModelGroupCandidates([], new Date()).length, 0);
  assert.equal(
    selectModelGroupCandidates(
      [{ providerId: "p", modelId: "disabled", selectable: false }],
      new Date(),
    ).length,
    0,
  );
});

test("模型组候选只返回正常优先级成员，全部降级时保留降级候选", () => {
  const members = [
    {
      providerId: "p",
      modelId: "weekday-window",
      deprioritizeSchedule: {
        timeZone: "America/Los_Angeles",
        windows: [{ daysOfWeek: [1], startTime: "09:00", endTime: "10:00" }],
      },
      metadata: "first",
    },
    { providerId: "p", modelId: "normal", metadata: "second" },
    {
      providerId: "p",
      modelId: "disabled",
      selectable: false,
      metadata: "third",
    },
  ] as const;

  assert.deepEqual(
    selectModelGroupCandidates(members, new Date("2026-10-26T16:30:00Z")).map(
      (item) => item.modelId,
    ),
    ["normal"],
  );
  assert.deepEqual(
    selectModelGroupCandidates([members[0], members[2]], new Date("2026-10-26T16:30:00Z")).map(
      (item) => item.modelId,
    ),
    ["weekday-window"],
  );
});

test("降级窗口遵循时区、开始日、左闭右开、跨午夜与重叠并集", () => {
  const members = [
    {
      providerId: "p",
      modelId: "scheduled",
      deprioritizeSchedule: {
        timeZone: "Europe/Paris",
        windows: [
          { daysOfWeek: [5], startTime: "22:00", endTime: "02:00" },
          { daysOfWeek: [6], startTime: "01:00", endTime: "03:00" },
        ],
      },
    },
    { providerId: "p", modelId: "normal" },
  ] as const;
  const idsAt = (instant: string) =>
    selectModelGroupCandidates(members, new Date(instant)).map((item) => item.modelId);

  assert.deepEqual(idsAt("2026-10-30T21:00:00Z"), ["normal"]); // 周五 22:00 巴黎时间
  assert.deepEqual(idsAt("2026-10-30T23:30:00Z"), ["normal"]); // 周六 00:30，跨午夜延续
  assert.deepEqual(idsAt("2026-10-31T01:00:00Z"), ["normal"]); // 周六 02:00，重叠窗口仍命中
  assert.deepEqual(idsAt("2026-10-31T02:00:00Z"), ["scheduled", "normal"]); // 周六 03:00 结束
});

test("周日跨周一的跨午夜窗口归属开始日", () => {
  const members = [
    {
      providerId: "p",
      modelId: "sunday-window",
      deprioritizeSchedule: {
        timeZone: "Etc/UTC",
        windows: [{ daysOfWeek: [7], startTime: "22:00", endTime: "02:00" }],
      },
    },
    { providerId: "p", modelId: "normal" },
  ] as const;
  const idsAt = (instant: string) =>
    selectModelGroupCandidates(members, new Date(instant)).map((item) => item.modelId);

  assert.deepEqual(idsAt("2026-11-01T22:00:00Z"), ["normal"]);
  assert.deepEqual(idsAt("2026-11-02T01:59:00Z"), ["normal"]);
  assert.deepEqual(idsAt("2026-11-02T02:00:00Z"), ["sunday-window", "normal"]);
  assert.deepEqual(idsAt("2026-11-02T22:30:00Z"), ["sunday-window", "normal"]);
});

test("全天窗口在开始边界命中，结束边界与非命中日不命中", () => {
  const members = [
    {
      providerId: "p",
      modelId: "all-day",
      deprioritizeSchedule: {
        timeZone: "Etc/UTC",
        windows: [{ daysOfWeek: [1], startTime: "00:00", endTime: "24:00" }],
      },
    },
    { providerId: "p", modelId: "normal" },
  ] as const;
  const idsAt = (instant: string) =>
    selectModelGroupCandidates(members, new Date(instant)).map((item) => item.modelId);

  assert.deepEqual(idsAt("2026-10-26T00:00:00Z"), ["normal"]);
  assert.deepEqual(idsAt("2026-10-26T23:59:00Z"), ["normal"]);
  assert.deepEqual(idsAt("2026-10-27T00:00:00Z"), ["all-day", "normal"]);
  assert.deepEqual(idsAt("2026-10-25T12:00:00Z"), ["all-day", "normal"]);
});

test("时段按 DST 当地时间解释，重复小时都适用、跳过小时没有命中", () => {
  const members = [
    {
      providerId: "p",
      modelId: "dst-fall-back",
      deprioritizeSchedule: {
        timeZone: "America/New_York",
        windows: [{ daysOfWeek: [7], startTime: "01:15", endTime: "01:45" }],
      },
    },
    {
      providerId: "p",
      modelId: "dst-spring-forward",
      deprioritizeSchedule: {
        timeZone: "America/New_York",
        windows: [{ daysOfWeek: [7], startTime: "02:15", endTime: "02:45" }],
      },
    },
    { providerId: "p", modelId: "normal" },
  ] as const;
  const idsAt = (instant: string) =>
    selectModelGroupCandidates(members, new Date(instant)).map((item) => item.modelId);

  assert.deepEqual(idsAt("2026-11-01T05:30:00Z"), ["dst-spring-forward", "normal"]); // 首次 01:30
  assert.deepEqual(idsAt("2026-11-01T06:30:00Z"), ["dst-spring-forward", "normal"]); // 重复的 01:30
  assert.deepEqual(idsAt("2026-03-08T06:30:00Z"), ["dst-spring-forward", "normal"]); // 01:30，跳时前
  assert.deepEqual(idsAt("2026-03-08T07:30:00Z"), [
    "dst-fall-back",
    "dst-spring-forward",
    "normal",
  ]); // 03:30，跳时后；不存在 02:15–02:45 实际时刻
  assert.deepEqual(idsAt("2026-03-08T08:30:00Z"), [
    "dst-fall-back",
    "dst-spring-forward",
    "normal",
  ]); // 04:30，01:15–01:45 窗口已结束
});

test("schedule schema 校验 IANA 时区、ISO 星期、时间范围和非空窗口", () => {
  const valid = {
    timeZone: "Etc/UTC",
    windows: [{ daysOfWeek: [1, 7], startTime: "00:00", endTime: "24:00" }],
  };
  assert.deepEqual(modelGroupDeprioritizeScheduleSchema.parse(valid), valid);
  assert.deepEqual(
    modelGroupDeprioritizeScheduleSchema.parse({ ...valid, timeZone: "UTC" }).timeZone,
    "UTC",
  );
  assert.deepEqual(
    modelGroupDeprioritizeScheduleSchema.parse({ ...valid, timeZone: "US/Eastern" }).timeZone,
    "US/Eastern",
  );
  for (const invalid of [
    { ...valid, timeZone: "Not/AZone" },
    { ...valid, timeZone: "+08:00" },
    { ...valid, timeZone: "-0500" },
    { ...valid, timeZone: "+00" },
    { ...valid, windows: [] },
    { ...valid, windows: [{ daysOfWeek: [], startTime: "00:00", endTime: "01:00" }] },
    { ...valid, windows: [{ daysOfWeek: [0], startTime: "00:00", endTime: "01:00" }] },
    { ...valid, windows: [{ daysOfWeek: [8], startTime: "00:00", endTime: "01:00" }] },
    { ...valid, windows: [{ daysOfWeek: [1], startTime: "24:00", endTime: "01:00" }] },
    { ...valid, windows: [{ daysOfWeek: [1], startTime: "00:00", endTime: "24:01" }] },
    { ...valid, windows: [{ daysOfWeek: [1], startTime: "01:00", endTime: "01:00" }] },
  ]) {
    assert.equal(modelGroupDeprioritizeScheduleSchema.safeParse(invalid).success, false);
  }
});

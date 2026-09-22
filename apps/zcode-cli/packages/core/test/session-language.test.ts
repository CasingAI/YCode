import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ENTRY_SESSION_LANGUAGE } from "@zcode/contracts";
import type { SessionEntryInfo } from "@zcode/contracts";
import {
  buildSessionLanguageEntry,
  parseSessionLanguageEntry,
  persistRuntimeSessionLanguage,
  readRuntimeSessionLanguage,
} from "../src/runtime/session-language.js";
import { setSessionLanguage } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

// 会话语言是创建时快照、之后不变的会话级事实：没有会话事件，只走 session entry。
// 这里锁住三件事——真值读法、entry 形态、以及「draft 期不写、落库后补写」的落盘时机。

type FakeRuntime = {
  runtime: AgentRuntimeInternal;
  saved: SessionEntryInfo[];
};

function fakeRuntime(options: {
  language?: string;
  persisted: boolean;
  withStore?: boolean;
}): FakeRuntime {
  const saved: SessionEntryInfo[] = [];
  const runtime = {
    sessionId: "sess-language",
    config: { language: options.language },
    sessionPersisted: options.persisted,
    // 置为有 active turn，跳过 setSessionLanguage 的 context 重建（那是真正的 runtime 行为，
    // 这里只验证语言真值与落盘）。
    activeTurn: {},
    sessionStore: options.withStore === false ? undefined : {
      saveSessionEntry: async (entry: SessionEntryInfo) => {
        saved.push(entry);
      },
    },
  } as unknown as AgentRuntimeInternal;
  return { runtime, saved };
}

test("readRuntimeSessionLanguage：真值位置是 runtime.config.language", () => {
  assert.equal(readRuntimeSessionLanguage(fakeRuntime({ language: "zh-CN", persisted: true }).runtime), "zh-CN");
  assert.equal(readRuntimeSessionLanguage(fakeRuntime({ persisted: true }).runtime), undefined);
});

test("buildSessionLanguageEntry：类型与数据形态固定，不触碰 session 时间戳", () => {
  const entry = buildSessionLanguageEntry("sess-language", "zh-CN");

  assert.equal(entry.type, SESSION_ENTRY_SESSION_LANGUAGE);
  assert.equal(entry.sessionID, "sess-language");
  assert.equal(entry.data.language, "zh-CN");
  // touchSession=false：语言是创建时事实，不应把会话的 updated 时间往前推。
  assert.equal(entry.touchSession, false);
});

test("persistRuntimeSessionLanguage：draft 期静默跳过，不产生悬空 entry", async () => {
  const { runtime, saved } = fakeRuntime({ language: "zh-CN", persisted: false });

  await persistRuntimeSessionLanguage(runtime);

  assert.deepEqual(saved, []);
});

test("persistRuntimeSessionLanguage：会话落库后写入当前语言", async () => {
  const { runtime, saved } = fakeRuntime({ language: "zh-CN", persisted: true });

  await persistRuntimeSessionLanguage(runtime);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.data.language, "zh-CN");
});

test("persistRuntimeSessionLanguage：没有语言事实时不写空 entry", async () => {
  const { runtime, saved } = fakeRuntime({ persisted: true });

  await persistRuntimeSessionLanguage(runtime);

  assert.deepEqual(saved, []);
});

test("persistRuntimeSessionLanguage：store 缺席时不抛错", async () => {
  const { runtime, saved } = fakeRuntime({ language: "zh-CN", persisted: true, withStore: false });

  await persistRuntimeSessionLanguage(runtime);

  assert.deepEqual(saved, []);
});

test("parseSessionLanguageEntry：冷恢复只接受非空字符串", () => {
  assert.equal(parseSessionLanguageEntry({ language: "en-US" }), "en-US");
  // 升级前没有该 entry，或旧格式缺字段 —— 都必须是「未知」，不能凭当前界面语言补值。
  assert.equal(parseSessionLanguageEntry(undefined), undefined);
  assert.equal(parseSessionLanguageEntry(null), undefined);
  assert.equal(parseSessionLanguageEntry({}), undefined);
  assert.equal(parseSessionLanguageEntry({ language: "" }), undefined);
  assert.equal(parseSessionLanguageEntry({ language: 42 }), undefined);
  assert.equal(parseSessionLanguageEntry(["zh-CN"]), undefined);
  assert.equal(parseSessionLanguageEntry("zh-CN"), undefined);
});

// setSessionLanguage 的写入路径：重放或重复 createSession 会带着同一个语言再来一次，
// 必须同值早返回——否则每次都多一条落盘 entry 和一次无意义的 context 重建。

test("setSessionLanguage：写入 runtime 真值并落盘一次", async () => {
  const { runtime, saved } = fakeRuntime({ persisted: true });

  await setSessionLanguage.call(runtime, "zh-CN");

  assert.equal(readRuntimeSessionLanguage(runtime), "zh-CN");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.data.language, "zh-CN");
});

test("setSessionLanguage：同值重复应用不再落盘", async () => {
  const { runtime, saved } = fakeRuntime({ language: "zh-CN", persisted: true });

  await setSessionLanguage.call(runtime, "zh-CN");

  assert.deepEqual(saved, []);
});

test("setSessionLanguage：空语言不写入，避免把「未知」覆盖成空串", async () => {
  const { runtime, saved } = fakeRuntime({ language: "zh-CN", persisted: true });

  await setSessionLanguage.call(runtime, "");

  assert.equal(readRuntimeSessionLanguage(runtime), "zh-CN");
  assert.deepEqual(saved, []);
});

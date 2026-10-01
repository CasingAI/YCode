import assert from "node:assert/strict";
import test from "node:test";
import { type MentionWhitelist, parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";
import { materializeGoalEchoParts } from "../src/v4/goalQueryDisplay.js";

// 用户气泡里裸 token 的存在性白名单。
//
// 分词器此前只看 `INLINE_MENTION_TOKEN_PATTERN`，不看任何目录，于是 `cost is $100 today`
// 里的金额、`$12313132q13123` 这种算式、`@随手写的词` 都会被画成芯片。修复后：裸 token
// 必须命中对应目录才渲染芯片，否则按普通文本原样显示。
//
// 不变式：
// - `[$name](path)` 链接形式来自编辑器 mention 节点序列化，路径可信，不受白名单影响；
// - 对应集合为 `undefined`（目录未就绪 / 只读分享视图）时该类别行为与修复前完全一致；
// - `whitelist` 整体为 `undefined` 时等价于四个集合全缺席。

const WL: MentionWhitelist = {
  skillNames: new Set(["debug-mode", "writing-plans"]),
  subagentNames: new Set(["reviewer"]),
  commandNames: new Set(["goal", "target", "plan", "compact", "compress", "init"]),
  sessionIds: new Set(["sess_abc123"]),
};

function typesOf(parts: ReturnType<typeof parseMentionMarkdown>): string[] {
  return parts.map((p) => p.type);
}

function labelsOf(parts: ReturnType<typeof parseMentionMarkdown>, type: string): string[] {
  return parts.filter((p) => p.type === type).map((p) => (p as { label: string }).label);
}

function textsOf(parts: ReturnType<typeof parseMentionMarkdown>): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
}

// ── $ 技能 ──

test("裸 $name 命中技能目录：仍渲染技能 part", () => {
  const parts = parseMentionMarkdown("帮我 $debug-mode 查一下", WL);
  assert.deepEqual(labelsOf(parts, "skill"), ["debug-mode"]);
});

test("裸 $name 未命中技能目录：退回普通文本", () => {
  const parts = parseMentionMarkdown("cost is $100 today", WL);
  assert.deepEqual(labelsOf(parts, "skill"), []);
  assert.equal(textsOf(parts), "cost is $100 today");
});

test("字母数字混合的裸 $token 同样不再被染色", () => {
  const parts = parseMentionMarkdown("3r2r2r3 Goal 12313132q13123 $12313132q13123", WL);
  assert.deepEqual(labelsOf(parts, "skill"), []);
});

test("技能匹配大小写不敏感", () => {
  assert.deepEqual(labelsOf(parseMentionMarkdown("$Debug-Mode", WL), "skill"), ["Debug-Mode"]);
});

test("句末句号不吃进芯片：$debug-mode. 画芯片且句号落在芯片外", () => {
  // 正则字符集含 `.`，句末的真实引用会把句号吃进 token；白名单剥离尾部句点后查集合。
  const parts = parseMentionMarkdown("用 $debug-mode. 查一下", WL);
  assert.deepEqual(labelsOf(parts, "skill"), ["debug-mode"]);
  assert.ok(textsOf(parts).includes("."));
});

test("未知 $name 带句号：整体退回普通文本", () => {
  const parts = parseMentionMarkdown("算式 $12313. 结束", WL);
  assert.deepEqual(labelsOf(parts, "skill"), []);
  assert.equal(textsOf(parts), "算式 $12313. 结束");
});

// ── @ 子智能体 ──

test("裸 @name 命中目录：仍渲染子智能体 part", () => {
  const parts = parseMentionMarkdown("交给 @reviewer 处理", WL);
  assert.deepEqual(labelsOf(parts, "subagent"), ["reviewer"]);
});

test("裸 @name 未命中目录：退回普通文本", () => {
  const parts = parseMentionMarkdown("见 @12313213 备注", WL);
  assert.deepEqual(labelsOf(parts, "subagent"), []);
  assert.equal(textsOf(parts), "见 @12313213 备注");
});

test("子智能体匹配大小写不敏感", () => {
  assert.deepEqual(labelsOf(parseMentionMarkdown("@Reviewer", WL), "subagent"), ["Reviewer"]);
});

// ── / 命令 ──

test("裸 /name 命中目录：仍渲染命令 part", () => {
  assert.deepEqual(labelsOf(parseMentionMarkdown("/init", WL), "command"), ["init"]);
  assert.deepEqual(labelsOf(parseMentionMarkdown("/goal 目标", WL), "command"), ["goal"]);
});

test("裸 /name 未命中目录：退回普通文本", () => {
  const parts = parseMentionMarkdown("路径 /notacommand/x", WL);
  assert.deepEqual(labelsOf(parts, "command"), []);
});

// ── #sess_ 会话 ──

test("裸 #sess_xxx 命中目录：仍渲染会话 part", () => {
  assert.deepEqual(labelsOf(parseMentionMarkdown("见 #sess_abc123 记录", WL), "session"), [
    "sess_abc123",
  ]);
});

test("裸 #sess_xxx 未命中目录：退回普通文本", () => {
  const parts = parseMentionMarkdown("见 #sess_deleted 记录", WL);
  assert.deepEqual(labelsOf(parts, "session"), []);
  assert.equal(textsOf(parts), "见 #sess_deleted 记录");
});

test("会话 id 精确匹配：大小写不同不命中", () => {
  assert.deepEqual(labelsOf(parseMentionMarkdown("#sess_ABC123", WL), "session"), []);
});

// ── fail-open ──

test("whitelist 为 undefined：行为与修复前一致", () => {
  // 行首第一个 token 前没有 prefix 空白，直接就是芯片 part，无前导 text。
  const parts = parseMentionMarkdown("$100 @someone /compact #sess_abc", undefined);
  assert.deepEqual(typesOf(parts), [
    "skill",
    "text",
    "subagent",
    "text",
    "command",
    "text",
    "session",
  ]);
});

test("单个集合缺席：仅该类别放行，其余仍过滤", () => {
  const partial: MentionWhitelist = { skillNames: WL.skillNames };
  const parts = parseMentionMarkdown("$100 @someone", partial);
  // $100 不在技能集合 → 文本；@someone 无子智能体集合 → 放行芯片。
  assert.deepEqual(labelsOf(parts, "skill"), []);
  assert.deepEqual(labelsOf(parts, "subagent"), ["someone"]);
});

// ── 可信路径不受影响 ──

test("链接形式 [$name](path) 不受白名单约束", () => {
  const parts = parseMentionMarkdown("[$totally-unknown](./a/b.md)", {
    skillNames: new Set<string>(),
  });
  assert.deepEqual(labelsOf(parts, "skill"), ["totally-unknown"]);
});

test("用户实测串：只有真实引用染色", () => {
  const wl: MentionWhitelist = {
    ...WL,
    subagentNames: new Set(["control-browser"]),
  };
  // control-browser 是真实存在的插件技能名，这里模拟命中；其余裸 token 均不在目录里。
  const parts = parseMentionMarkdown(
    "[$control-browser](./skills/control-browser/SKILL.md) $12313. #23131312 @12313213",
    wl,
  );
  assert.deepEqual(labelsOf(parts, "skill"), ["control-browser"]);
  assert.deepEqual(labelsOf(parts, "subagent"), []);
  assert.deepEqual(labelsOf(parts, "session"), []);
  // `$12313.` 整体退回普通文本（含句号原样保留），`#23131312` 本就不匹配 `#sess_` 前缀。
  assert.ok(textsOf(parts).includes("$12313."));
});

// ── goal 补芯片路径透传 ──

test("materializeGoalEchoParts 透传白名单", () => {
  assert.deepEqual(labelsOf(materializeGoalEchoParts("$100", WL), "skill"), []);
  assert.deepEqual(labelsOf(materializeGoalEchoParts("$debug-mode", WL), "skill"), ["debug-mode"]);
  assert.deepEqual(labelsOf(materializeGoalEchoParts("@nope", WL), "subagent"), []);
});

test("materializeGoalEchoParts 补 goal 芯片时仍过滤裸 token", () => {
  const parts = materializeGoalEchoParts("$100 /goal 目标正文", WL);
  assert.deepEqual(labelsOf(parts, "skill"), []);
  assert.ok(parts.some((p) => p.type === "command" && p.label === "goal"));
});

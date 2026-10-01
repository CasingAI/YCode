import assert from "node:assert/strict";
import test from "node:test";
import {
  restoreMentionLinkPayload,
  splitMentionLinks,
} from "../src/mentions/mentionMarkdownRestore.js";

// 行内编辑恢复：canonical 链接 → mention 节点载荷。
//
// 发送时 `$getPromptMarkdown` 对每个 PromptMentionNode 直接输出构造时存下的
// `__markdown`，行内编辑回填（ChatPromptEditor + restoreMentionNodes）要把这些
// 链接还原成节点，否则编辑框显示裸 `[...](...)` 原文。
//
// 不变式：
// - `markdown` 取 match 全文原样回填 `__markdown`，重发逐字一致；
// - 裸 token（/$/@/#/sess）一律不还原，保持纯文本；
// - plugin 映射与既有 `replaceEditorTextWithPluginMentions` 逐字一致。

test("技能链接还原成 skills 载荷，markdown 原样回填", () => {
  const markdown = "[$control-browser](/x/skills/control-browser/SKILL.md)";
  const payload = restoreMentionLinkPayload({
    markdown,
    label: "$control-browser",
    destination: "/x/skills/control-browser/SKILL.md",
  });
  assert.ok(payload);
  assert.equal(payload.category, "skills");
  assert.equal(payload.value, "control-browser");
  assert.equal(payload.markdown, markdown);
  assert.deepEqual(payload.data, { path: "/x/skills/control-browser/SKILL.md" });
});

test("会话链接还原成 sessions 载荷，label 原样保留", () => {
  const markdown = "[#Skill 格式化误触发排查](#sess_f2c3a316-e7b1-41a5-b979-1a600a12c6b4)";
  const payload = restoreMentionLinkPayload({
    markdown,
    label: "#Skill 格式化误触发排查",
    destination: "#sess_f2c3a316-e7b1-41a5-b979-1a600a12c6b4",
  });
  assert.ok(payload);
  assert.equal(payload.category, "sessions");
  assert.equal(payload.id, "session:sess_f2c3a316-e7b1-41a5-b979-1a600a12c6b4");
  assert.equal(payload.value, "sess_f2c3a316-e7b1-41a5-b979-1a600a12c6b4");
  assert.equal(payload.markdown, markdown);
});

test("plugin 链接沿用既有映射", () => {
  const markdown = "[@Label](plugin://name@market)";
  const payload = restoreMentionLinkPayload({
    markdown,
    label: "@Label",
    destination: "plugin://name@market",
  });
  assert.ok(payload);
  assert.equal(payload.category, "plugins");
  assert.equal(payload.id, "plugin:name@market");
  assert.equal(payload.value, "name@market");
  assert.equal(payload.markdown, markdown);
});

test("plugin 非法 id 不还原", () => {
  const payload = restoreMentionLinkPayload({
    markdown: "[@x](plugin://bad id!)",
    label: "@x",
    destination: "plugin://bad id!",
  });
  assert.equal(payload, null);
});

test("目录链接按尾斜杠走 files/kind=directory", () => {
  const payload = restoreMentionLinkPayload({
    markdown: "[src](./src/)",
    label: "src",
    destination: "./src/",
  });
  assert.ok(payload);
  assert.equal(payload.category, "files");
  assert.deepEqual(payload.data, { kind: "directory", relativePath: "./src/" });
});

test("文件链接走 files 分支", () => {
  const payload = restoreMentionLinkPayload({
    markdown: "[guide.md](./guide.md)",
    label: "guide.md",
    destination: "./guide.md",
  });
  assert.ok(payload);
  assert.equal(payload.category, "files");
  assert.equal(payload.value, "./guide.md");
});

test("http(s) 外链保持纯文本，不凭空造文件芯片", () => {
  const payload = restoreMentionLinkPayload({
    markdown: "[docs](https://example.com/guide)",
    label: "docs",
    destination: "https://example.com/guide",
  });
  assert.equal(payload, null);
});

test("用户实测串：技能与会话还原，裸 token 保持文本", () => {
  const text =
    "[$control-browser](/x/SKILL.md) ¥12313 [#Skill 格式化误触发排查](#sess_f2c3a316-e7b1-41a5-b979-1a600a12c6b4) #12312312 @123132";
  const parts = splitMentionLinks(text);
  const payloads = parts.flatMap((p) => ("payload" in p ? [p.payload] : []));
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0]?.category, "skills");
  assert.equal(payloads[1]?.category, "sessions");
  const rest = parts.flatMap((p) => ("payload" in p ? [] : [p.text])).join("");
  assert.ok(rest.includes("¥12313"));
  assert.ok(rest.includes("#12312312"));
  assert.ok(rest.includes("@123132"));
});

test("转义 label 正确还原", () => {
  const parts = splitMentionLinks("[a\\]b](./a.md)");
  const payload = parts.flatMap((p) => ("payload" in p ? [p.payload] : []))[0];
  assert.ok(payload);
  assert.equal(payload.label, "a]b");
});

test("无链接文本原样返回单个 text 段", () => {
  const parts = splitMentionLinks("hello $12313 @abc /cmd #sess_x");
  assert.equal(parts.length, 1);
  assert.equal("text" in parts[0]! && parts[0].text, "hello $12313 @abc /cmd #sess_x");
});

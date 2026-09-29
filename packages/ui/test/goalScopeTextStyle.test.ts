import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GOAL_SCOPE_TEXT_CSS_TEXT, GOAL_SCOPE_TEXT_STYLE } from "../src/goalScopeTextStyle.js";
import { GOAL_ECHO_SCOPE_STYLE } from "../src/v4/goalQueryDisplay.js";

// goal 目标正文的高亮（docs/specs/goal-command-scope-and-decoration.md「装饰（纯视觉）」）。
// 高亮只有颜色与字重：命令芯片的装饰覆盖不到 ::before 图标，线天生在图标左边断开，
// zcode 原版其它命令也不带线。任何一处把 text-decoration 写回来都是回归。

const editorDecorationSource = readFileSync(
  new URL("../src/prompt-editor/goalScopeDecoration.ts", import.meta.url),
  "utf8",
);
const stylesCss = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** styles.css 里 goal 芯片的规则块（编辑器与气泡共用同一批 data-mention-id）。 */
function goalChipRule(): string {
  const match = /\.prompt-mention\[data-mention-id="slash:goal"\][^{]*\{[^}]*\}/.exec(stylesCss);
  assert.ok(match, "styles.css 必须保留 goal 芯片规则");
  return match[0];
}

/** styles.css 里 goal 芯片图标的规则块。 */
function goalChipIconRule(): string {
  const match = /\.prompt-mention\[data-mention-id="slash:goal"\]::before[^{]*\{[^}]*\}/.exec(
    stylesCss,
  );
  assert.ok(match, "styles.css 必须保留 goal 芯片图标规则");
  return match[0];
}

/** 去掉注释，只留 `prop: value`，免得规则里的说明文字混进声明表。 */
function cssDeclarations(rule: string): Map<string, string> {
  return new Map(
    rule
      .replace(/^[^{]*\{/, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(";")
      .map((entry) => entry.split(":").map((part) => part.trim()))
      .filter((parts) => parts.length === 2)
      .map(([property, value]) => [property, value]),
  );
}

test("目标正文只有颜色与字重，不带任何下划线声明", () => {
  assert.deepEqual(
    { ...GOAL_SCOPE_TEXT_STYLE },
    {
      color: "var(--color-command-node-foreground)",
      fontWeight: 500,
    },
  );
  const properties = Object.keys(GOAL_SCOPE_TEXT_STYLE).map((property) =>
    property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`),
  );
  assert.equal(
    properties.some(
      (property) => property.includes("text-decoration") || property.includes("underline"),
    ),
    false,
  );
});

test("Lexical 的 cssText 由同一份样式序列化，不再另写字符串", () => {
  assert.equal(
    GOAL_SCOPE_TEXT_CSS_TEXT,
    "color: var(--color-command-node-foreground); font-weight: 500;",
  );
  // 编辑器侧只能引用共享声明：手写 cssText 就是样式漂移的复发路径。
  assert.match(editorDecorationSource, /GOAL_SCOPE_TEXT_CSS_TEXT/);
  assert.equal(/const GOAL_SCOPE_STYLE = "/.test(editorDecorationSource), false);
});

test("气泡与编辑器共用同一份目标正文高亮", () => {
  assert.equal(GOAL_ECHO_SCOPE_STYLE, GOAL_SCOPE_TEXT_STYLE);
});

test("goal 芯片脱离 inline-flex，基线才是文字基线", () => {
  const rule = goalChipRule();
  // inline-flex 的基线取自第一个 flex item（无行盒的 ::before 图标），整枚芯片会比正文
  // 低 4px。这与画不画线无关，装饰改成纯着色之后错位依然一眼可见。
  assert.match(rule, /display:\s*inline;/);
  const declarations = cssDeclarations(rule);
  assert.deepEqual([...declarations.keys()], ["display"]);
});

test("goal 图标脱离 flex 流并与文字同基线", () => {
  const rule = goalChipIconRule();
  // 脱离 inline-flex 后 items-center / gap 同时失效，图标自己接：inline-block 才吃
  // vertical-align，间距用 margin 表达。
  assert.match(rule, /display:\s*inline-block;/);
  assert.match(rule, /vertical-align:\s*-0\.2em;/);
  assert.match(rule, /margin-right:\s*0\.25em;/);
});

test("四套主题的命令色是同一个亮蓝，浅色深一档保对比度", () => {
  const values = [...stylesCss.matchAll(/--color-command-node-foreground:\s*([^;]+);/g)].map(
    (match) => match[1]?.trim(),
  );
  assert.equal(values.length, 4, "四套主题各有一处取值");
  assert.deepEqual(values, ["#0070cc", "#4da3ff", "#0070cc", "#4da3ff"]);
  // 浅色两套压深一档：#0070cc 在白底 5.0:1、#f8f8f8 底 4.7:1（AA 阈值 4.5:1）；
  // 深色两套用亮蓝：#4da3ff 在 #171717 底 6.8:1。
  for (const value of values) {
    assert.match(value ?? "", /^#[0-9a-f]{6}$/);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyConversationFindHighlights,
  applySearchResultHighlight,
} from "../src/v4/conversationFindHighlightDom.js";
import { applyTrajectorySearchHighlights } from "../src/ModelTrajectorySearchHighlight.js";

// 高亮配色回归：四套主题的普通命中/当前命中必须使用成对前景，且文字与底色 >= 4.5:1。
// 这里调用模块真实的 ::highlight 注入路径，并读取 styles.css / Tailwind 的真实 token，
// 不复制一份测试专用色表。旧实现统一 var(--color-foreground) 时本测试会失败。

const CONVERSATION_STYLE_ID = "zcode-v4-conversation-find-highlight-style";
const TRAJECTORY_STYLE_ID = "zcode-model-trajectory-find-highlight-style";
const MIN_CONTRAST = 4.5;

interface StyleElement {
  id: string;
  textContent: string;
  isConnected: boolean;
}

interface FakeDocument {
  getElementById: (id: string) => StyleElement | null;
  createElement: () => StyleElement;
  head: { append: (style: StyleElement) => void };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function captureInjectedHighlightStyles(): Map<string, StyleElement> {
  const styles = new Map<string, StyleElement>();
  const documentStub: FakeDocument = {
    getElementById: (id) => styles.get(id) ?? null,
    createElement: () => ({ id: "", textContent: "", isConnected: false }),
    head: {
      append: (style) => {
        style.isConnected = true;
        styles.set(style.id, style);
      },
    },
  };
  class HighlightStub {
    priority = 0;
    constructor(...ranges: Range[]) {
      void ranges;
    }
  }
  const registry = new Map<string, unknown>();
  const globals = globalThis as Record<string, unknown>;
  const previous = {
    document: globals.document,
    window: globals.window,
    CSS: globals.CSS,
  };
  globals.document = documentStub;
  globals.window = { Highlight: HighlightStub };
  globals.CSS = {
    highlights: {
      set: (name: string, value: unknown) => registry.set(name, value),
      delete: (name: string) => registry.delete(name),
    },
  };
  try {
    const root = { querySelectorAll: () => [] } as unknown as HTMLElement;
    applyConversationFindHighlights({ root, query: "x", matches: [], activeMatch: null });
    applySearchResultHighlight({ root, query: "x", match: { rowId: 1 } as never });
    applyTrajectorySearchHighlights({ root, query: "x", matches: [], activeMatch: null });
  } finally {
    globals.document = previous.document;
    globals.window = previous.window;
    globals.CSS = previous.CSS;
  }
  return styles;
}

function parseHighlightRules(css: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  const rulePattern = /::highlight\(([^)]+)\)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(css))) {
    const declarations = new Map<string, string>();
    for (const part of match[2].split(";")) {
      const separator = part.indexOf(":");
      if (separator === -1) continue;
      declarations.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
    rules.set(match[1].trim(), declarations);
  }
  return rules;
}

function ruleColor(rules: Map<string, Map<string, string>>, name: string): string {
  const color = rules.get(name)?.get("color");
  assert.ok(color, `缺少 ::highlight(${name}) 的 color 声明`);
  return color;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBlock(css: string, selector: string): string {
  const pattern = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(selector)}\\s*\\{`);
  const match = pattern.exec(css);
  assert.ok(match, `styles.css 缺少 ${selector} 块`);
  let index = match.index + match[0].length;
  let depth = 1;
  let block = "";
  while (index < css.length && depth > 0) {
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    block += char;
    index += 1;
  }
  return block;
}

function parseDeclarations(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css))) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

function encodeSrgb(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  const encoded =
    clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function oklchToRgb(lightnessPercent: number, chroma: number, hueDegrees: number): Rgb {
  const lightness = lightnessPercent / 100;
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return {
    r: encodeSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encodeSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encodeSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function parseColorValue(value: string): Rgb {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex[1];
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }
  const oklch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/i.exec(value);
  if (oklch) {
    return oklchToRgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
  }
  if (value === "white") return { r: 255, g: 255, b: 255 };
  if (value === "black") return { r: 0, g: 0, b: 0 };
  throw new Error(`不支持的色值: ${value}`);
}

function resolveColor(name: string, tokens: Map<string, string>, seen = new Set<string>()): Rgb {
  if (seen.has(name)) throw new Error(`token 循环引用: --${name}`);
  const raw = tokens.get(name);
  assert.ok(raw, `缺少 token: --${name}`);
  seen.add(name);
  const value = raw.trim();
  const reference = /^var\(\s*--([a-z0-9-]+)\s*(?:,\s*(.+))?\)$/i.exec(value);
  if (reference) {
    if (tokens.has(reference[1])) return resolveColor(reference[1], tokens, seen);
    assert.ok(reference[2], `--${reference[1]} 未定义且无 fallback`);
    return parseColorValue(reference[2].trim());
  }
  return parseColorValue(value);
}

function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first: Rgb, second: Rgb): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

test("高亮注入：普通命中与当前命中分别消费成对前景 token", () => {
  const styles = captureInjectedHighlightStyles();
  const conversationCss = styles.get(CONVERSATION_STYLE_ID)?.textContent ?? "";
  const trajectoryCss = styles.get(TRAJECTORY_STYLE_ID)?.textContent ?? "";
  assert.ok(conversationCss, "会话查找未注入 ::highlight 样式");
  assert.ok(trajectoryCss, "模型轨迹搜索未注入 ::highlight 样式");

  const conversation = parseHighlightRules(conversationCss);
  for (const name of ["zcode-v4-conversation-find", "zcode-v4-conversation-find-active"]) {
    assert.ok(conversation.has(name), `缺少 ${name} 规则`);
  }
  assert.match(
    ruleColor(conversation, "zcode-v4-conversation-find"),
    /--color-find-highlight-foreground\b/,
    "普通命中必须消费 --color-find-highlight-foreground",
  );
  assert.match(
    ruleColor(conversation, "zcode-v4-conversation-find-active"),
    /--color-find-highlight-active-foreground\b/,
    "当前命中必须消费 --color-find-highlight-active-foreground",
  );
  assert.match(
    ruleColor(conversation, "zcode-v4-conversation-search-result"),
    /--color-find-highlight-active-foreground\b/,
    "引用/搜索结果跳转必须复用当前命中的成对前景",
  );

  const trajectory = parseHighlightRules(trajectoryCss);
  assert.match(
    ruleColor(trajectory, "zcode-model-trajectory-find"),
    /--color-find-highlight-foreground\b/,
    "轨迹搜索普通命中必须消费 --color-find-highlight-foreground",
  );
  assert.match(
    ruleColor(trajectory, "zcode-model-trajectory-find-active"),
    /--color-find-highlight-active-foreground\b/,
    "轨迹搜索当前命中必须消费 --color-find-highlight-active-foreground",
  );
});

test("四套主题的普通命中/当前命中对比度均不低于 4.5:1", async () => {
  const [stylesCss, tailwindCss] = await Promise.all([
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../../node_modules/tailwindcss/theme.css", import.meta.url), "utf8"),
  ]);
  const tailwind = parseDeclarations(tailwindCss);
  // 默认浅色 token 定义在 Tailwind 的 @theme 里，深色与 Zai 主题在独立 class 块覆盖。
  const base = parseDeclarations(extractBlock(stylesCss, "@theme"));
  const dark = parseDeclarations(extractBlock(stylesCss, ".dark"));
  const zaiLight = parseDeclarations(extractBlock(stylesCss, ".theme-zai-light"));
  const zaiDark = parseDeclarations(extractBlock(stylesCss, ".theme-zai-dark"));

  const themes = [
    { name: "default light", tokens: new Map([...tailwind, ...base]) },
    { name: "default dark", tokens: new Map([...tailwind, ...base, ...dark]) },
    { name: "zai light", tokens: new Map([...tailwind, ...base, ...zaiLight]) },
    { name: "zai dark", tokens: new Map([...tailwind, ...base, ...dark, ...zaiDark]) },
  ];
  const variants = [
    {
      name: "base",
      background: "color-find-highlight",
      foreground: "color-find-highlight-foreground",
    },
    {
      name: "active",
      background: "color-find-highlight-active",
      foreground: "color-find-highlight-active-foreground",
    },
  ];

  for (const theme of themes) {
    for (const variant of variants) {
      const background = resolveColor(variant.background, theme.tokens);
      const foreground = resolveColor(variant.foreground, theme.tokens);
      const ratio = contrastRatio(background, foreground);
      assert.ok(
        ratio >= MIN_CONTRAST,
        `${theme.name} ${variant.name} 对比度 ${ratio.toFixed(2)}:1 < ${MIN_CONTRAST}:1`,
      );
    }
  }
});

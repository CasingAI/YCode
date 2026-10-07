import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const formControlsSource = readFileSync(
  new URL("../src/settings/model-provider-section/ProviderFormControls.tsx", import.meta.url),
  "utf8",
);

// specs/settings-narrow-viewport-layout.md「模型行换行」：
// 行主容器与左侧信息区允许换行，操作组整体折到第二行，模型名不再被压到单字。
// ui 包测试为源码断言式（无组件渲染），这里锁定行布局的实现要点防回退。
test("模型行主容器允许换行，窄屏操作组整体折行", () => {
  const rowContainerMatch = /<div className="([^"]*)">\s*<div className="flex min-w-0 flex-1/.exec(
    formControlsSource,
  );
  assert.ok(rowContainerMatch, "模型行主容器必须存在");
  const tokens = rowContainerMatch[1].split(/\s+/);
  assert.ok(tokens.includes("flex-wrap"), "行主容器必须允许换行（flex-wrap）");
  assert.ok(!tokens.includes("flex-nowrap"), "行主容器禁止强制单行（flex-nowrap）");
});

test("模型行左侧信息区可内部换行，操作组包成不拆散的整体", () => {
  const infoAreaMatch = /<div className="(flex min-w-0 flex-1[^"]*)">/.exec(formControlsSource);
  assert.ok(infoAreaMatch, "左侧信息区必须存在");
  const tokens = infoAreaMatch[1].split(/\s+/);
  assert.ok(tokens.includes("flex-wrap"), "左侧信息区必须允许徽标折到模型名下一行");

  const actionGroupMatch = /<div className="(ml-auto flex shrink-0[^"]*)">/.exec(
    formControlsSource,
  );
  assert.ok(actionGroupMatch, "操作按钮组必须包一层不拆散的容器");
  const actionTokens = actionGroupMatch[1].split(/\s+/);
  assert.ok(actionTokens.includes("items-center"), "操作组换行后仍与行基线对齐");
});

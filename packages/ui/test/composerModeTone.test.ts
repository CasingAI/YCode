import assert from "node:assert/strict";
import test from "node:test";
import { resolveModeOptionToneClass } from "../src/v4/composer/composerModeTone.js";

test("三档各有自己的身份色", () => {
  assert.equal(
    resolveModeOptionToneClass("plan"),
    "text-mode-plan hover:text-mode-plan aria-expanded:text-mode-plan",
  );
  assert.equal(
    resolveModeOptionToneClass("readonly"),
    "text-mode-ask hover:text-mode-ask aria-expanded:text-mode-ask",
  );
  assert.equal(
    resolveModeOptionToneClass("yolo"),
    "text-mode-agent hover:text-mode-agent aria-expanded:text-mode-agent",
  );
});

test("内部值与显示名不同：Ask 的内部值是 readonly", () => {
  // 档位色必须按内部值（readonly）挂载，不能按显示名（Ask）拼类名。
  assert.match(resolveModeOptionToneClass("readonly"), /text-mode-ask/);
  assert.equal(resolveModeOptionToneClass("ask"), "");
});

test("Agent 不再占用 warning 作为风险信号", () => {
  // 档位色只表达「是哪一档」；高权限的风险提示由 ShieldAlert 图标承担。
  assert.doesNotMatch(resolveModeOptionToneClass("yolo"), /warning/);
});

test("未知值与非字符串回退为空串，保持默认前景色", () => {
  for (const value of [undefined, null, "", "build", "auto", 0, {}]) {
    assert.equal(resolveModeOptionToneClass(value), "");
  }
});

test("每个档位都成套给出基础 / hover / aria-expanded 三条变体", () => {
  // ghost 按钮变体自带这三条前景色，档位色缺一条就会在 hover 或下拉展开时被赢回去。
  // 之前 v4 触发器只覆盖了前两条，yolo 一点开下拉就掉色。
  const expected: Record<string, string> = {
    plan: "text-mode-plan",
    readonly: "text-mode-ask",
    yolo: "text-mode-agent",
  };
  for (const [value, base] of Object.entries(expected)) {
    assert.deepEqual(resolveModeOptionToneClass(value).split(" "), [
      base,
      `hover:${base}`,
      `aria-expanded:${base}`,
    ]);
  }
});

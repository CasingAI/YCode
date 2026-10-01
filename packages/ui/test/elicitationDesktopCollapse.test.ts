import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dialogSource = readFileSync(new URL("../src/ElicitationDialog.tsx", import.meta.url), "utf8");

function readSourceSection(start: string, end: string): string {
  const startIndex = dialogSource.indexOf(start);
  assert.notEqual(startIndex, -1, `缺少源码片段起点：${start}`);
  const endIndex = dialogSource.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `缺少源码片段终点：${end}`);
  return dialogSource.slice(startIndex, endIndex);
}

test("顶部整卡收起按钮不再被窄屏断点隐藏", () => {
  const collapseButton = readSourceSection(
    "aria-label={dialogCollapseLabel}",
    "{isDialogExpanded ? (\n                    <ChevronDown",
  );
  assert.doesNotMatch(
    collapseButton,
    /max-md/,
    "整卡收起按钮不能带 max-md 门控，否则桌面永远看不到收起入口",
  );
  assert.doesNotMatch(collapseButton, /className="[^"]*\bhidden\b/, "收起按钮不能被整体隐藏");
});

test("收起摘要行在所有视口渲染", () => {
  const summaryRow = readSourceSection(
    "{!isDialogExpanded ? (\n            <div className=",
    'data-elicitation-dialog-footer="true"',
  );
  assert.match(
    summaryRow,
    /className="flex min-w-0 items-center justify-between/,
    "摘要行必须无条件显示",
  );
  assert.doesNotMatch(summaryRow, /max-md/, "摘要行不能带 max-md 门控");
  // 摘要行保留恢复展开的两条入口：整行可点 + 最右侧展开按钮。
  assert.match(summaryRow, /onClick=\{\(\) => setIsDialogExpanded\(true\)\}/);
  assert.match(summaryRow, /aria-expanded=\{isDialogExpanded\}/);
});

test("收起态用 display:none 隐藏正文区与底部操作区，保证隐藏元素不可聚焦", () => {
  const hiddenRules = dialogSource.match(/!isDialogExpanded \? "[^"]*" : undefined/g);
  assert.deepEqual(hiddenRules, [
    '!isDialogExpanded ? "hidden" : undefined',
    '!isDialogExpanded ? "hidden" : undefined',
  ]);
  assert.doesNotMatch(
    dialogSource,
    /max-md:hidden/,
    "max-md:hidden 在桌面是死代码，且会让隐藏选项留在可聚焦树里",
  );
});

test("收起态拦截方向键、Tab 和 Enter，Escape 例外", () => {
  const cardKeyDown = readSourceSection(
    "const handleCardKeyDown = useCallback(",
    "const primaryActionMessageId",
  );
  assert.match(
    cardKeyDown,
    /if \(!isDialogExpanded && event\.key !== "Escape"\) return;/,
    "收起态必须拦住会推进焦点索引的按键",
  );
  assert.match(
    cardKeyDown,
    /\[([^\]]*isDialogExpanded[^\]]*)\],\n  \);/,
    "isDialogExpanded 必须进入 handleCardKeyDown 的依赖数组",
  );
});

test("展开态仍是默认状态，收起是用户主动 opt-in", () => {
  assert.match(
    dialogSource,
    /const \[isDialogExpanded, setIsDialogExpanded\] = useState\(true\);/,
    "询问框不得自行收起",
  );
});

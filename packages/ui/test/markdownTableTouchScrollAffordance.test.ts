import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 触屏端（hover: none）既没有指针悬停也没有 Tab 键，group-hover/* 永不匹配。
// Markdown 表格的虚拟横向滚动条如果只带桌面 hover 路径，手机远控里的宽表格
// 会既看不到「右边还有内容」，也没有一条能拖动的滚动条可以拉——原生滚动条
// 又被 !scrollbar-hide 整条移除，溢出因此完全不可发现、不可操作。
//
// 这里锁的是「触屏常驻 + 桌面降噪」两条规则必须同时存在，且触屏变体必须
// 同时补齐 opacity 与 pointer-events：只补 opacity 会得到一条看得见却
// 拖不动的死条。
//
// 产品规则见 docs/specs/markdown-table-touch-scroll-affordance.md。

const tableSource = readFileSync(
  new URL("../src/components/ai-elements/markdown-table.tsx", import.meta.url),
  "utf8",
);

const swipeHookSource = readFileSync(
  new URL("../src/app-shell/useWorkspaceSidebarSwipe.ts", import.meta.url),
  "utf8",
);

const TOUCH_PERSISTENT = "[@media(hover:none)]:opacity-100";
const TOUCH_INTERACTIVE = "[@media(hover:none)]:pointer-events-auto";

/** 取出虚拟滚动条容器（virtualScrollbarWrapperRef）那一段 className 表达式。 */
function readScrollbarWrapperClassName(): string {
  const anchor = tableSource.indexOf("ref={virtualScrollbarWrapperRef}");
  assert.ok(anchor > 0, "找不到虚拟滚动条容器");
  const start = tableSource.indexOf("className={cn(", anchor);
  assert.ok(start > 0, "找不到虚拟滚动条容器的 className");
  const end = tableSource.indexOf(")}", start);
  assert.ok(end > 0, "虚拟滚动条容器的 className 表达式没有闭合");
  return tableSource.slice(start, end);
}

const wrapperClassName = readScrollbarWrapperClassName();

test("虚拟滚动条在触屏端常驻可见", () => {
  assert.ok(
    wrapperClassName.includes(TOUCH_PERSISTENT),
    `触屏端缺少 ${TOUCH_PERSISTENT}：group-hover 在手机上永不匹配，滚动条会永久停在 opacity-0`,
  );
});

test("触屏端滚动条必须可交互，否则看得见却拖不动", () => {
  assert.ok(
    wrapperClassName.includes(TOUCH_INTERACTIVE),
    `触屏端缺少 ${TOUCH_INTERACTIVE}：容器保持 pointer-events-none 时滑块收不到触摸，溢出仍然拉不出来`,
  );
});

test("触屏变体不得顶掉桌面降噪基线", () => {
  // 桌面端行为不能变：仍然只在 hover 表格框时淡入，离开时淡出。
  for (const utility of [
    "opacity-0",
    "group-hover/markdown-table-frame:opacity-100",
    "group-hover/markdown-table-frame:pointer-events-auto",
  ]) {
    assert.ok(
      wrapperClassName.includes(utility),
      `虚拟滚动条丢失桌面端类名 ${utility}：桌面端行为被触屏变体改掉了`,
    );
  }
});

test("触屏变体排在降噪基线之后，媒体查询内才能覆盖 opacity-0", () => {
  // Tailwind 把变体排在基础工具类之后；顺序反了媒体查询里的 opacity-100 会被
  // 后面的 opacity-0 盖掉，表现为「类名加了但仍然看不见」。
  assert.ok(
    wrapperClassName.lastIndexOf(TOUCH_PERSISTENT) > wrapperClassName.indexOf("opacity-0"),
    "触屏变体必须写在 opacity-0 之后",
  );
});

test("触屏常驻仍然受溢出判定约束，不给窄表凭空加控件", () => {
  // 可见性的唯一真相是 virtualScrollbarVisible：表格不横向溢出时，
  // 触屏端也不该出现这条滚动条。
  assert.ok(
    /virtualScrollbarVisible\s*&&\s*"\[@media\(hover:none\)\]:opacity-100/.test(
      tableSource.replace(/\s+/g, " "),
    ),
    "触屏常驻必须挂在 virtualScrollbarVisible 条件上",
  );
});

test("触屏端轨道与滑块有足够大的手指命中区", () => {
  // 桌面端 12px 高的滑块对手指太窄，触屏端要加高。
  assert.ok(tableSource.includes("[@media(hover:none)]:h-5"), "触屏端轨道缺少加高变体");
  assert.ok(tableSource.includes("[@media(hover:none)]:h-4"), "触屏端滑块缺少加高变体");
});

test("拖动表格滚动条不被侧栏右滑手势抢走", () => {
  // 滚动条轨道自身不产生 overflow，第 5 条让位规则拦不住它；
  // 必须显式排除，否则拖滑块会顺带把侧栏拽开。
  // 只匹配选择器本身，不匹配引号风格：格式化工具会在单双引号之间切换。
  assert.ok(
    swipeHookSource.includes("[data-markdown-table-virtual-scroll-track]"),
    "侧栏右滑手势的让位选择器必须排除表格虚拟滚动条轨道",
  );
});

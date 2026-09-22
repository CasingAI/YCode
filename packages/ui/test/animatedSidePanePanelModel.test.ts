import assert from "node:assert/strict";
import test from "node:test";
import { resolveAnimatedSidePanePanelLayout } from "../src/app-shell/animatedSidePanePanelModel.js";

// 分栏形态下面板只占分栏组的一段宽度：下限 240px 保证内容可读，上限 65% 保证会话列还在。
test("分栏形态：面板在 240px 与 65% 之间", () => {
  const layout = resolveAnimatedSidePanePanelLayout({ presentation: "inline" });
  assert.equal(layout.minSize, "240px");
  assert.equal(layout.maxSize, "65%");
  assert.equal(layout.defaultSize, "0px");
  assert.equal(layout.collapsedSize, "0px");
});

// 覆盖层形态下面板自己就是最终宽度：240px 下限会让它在窄屏收不起，
// 65% 上限又会让它永远填不满包裹层。
test("覆盖层形态：面板宽度不受分栏上下限限制", () => {
  const layout = resolveAnimatedSidePanePanelLayout({ presentation: "drawer" });
  assert.equal(layout.minSize, "0px");
  assert.equal(layout.maxSize, "100%");
  assert.equal(layout.defaultSize, "0px");
  assert.equal(layout.collapsedSize, "0px");
});

// 两种形态都必须继续渲染 ResizablePanel：换成普通容器会改变元素类型，
// 面板重挂载后远端 Browser Guest 会被销毁。
test("两种形态都保留 ResizablePanel", () => {
  assert.equal(
    resolveAnimatedSidePanePanelLayout({ presentation: "inline" }).useResizablePanel,
    true,
  );
  assert.equal(
    resolveAnimatedSidePanePanelLayout({ presentation: "drawer" }).useResizablePanel,
    true,
  );
  // 不传形态时退回分栏语义，避免调用点漏传时面板在宽屏失去宽度下限。
  assert.deepEqual(resolveAnimatedSidePanePanelLayout(), resolveAnimatedSidePanePanelLayout({}));
  assert.equal(resolveAnimatedSidePanePanelLayout().minSize, "240px");
});

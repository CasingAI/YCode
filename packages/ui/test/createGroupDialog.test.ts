import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildCreateGroupValue,
  CreateGroupDialog,
  CreateGroupDialogHost,
} from "../src/workspace-grouped-tasks/create-group-dialog.js";
import { EmojiPickerDialog } from "../src/workspace-grouped-tasks/emoji-picker-dialog.js";
import { useFlatTaskGroupCreateDialogStore } from "../src/store/flatTaskGroupCreateDialogStore.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

/**
 * 新建分组对话框与 emoji 选择对话框。
 *
 * Radix Dialog 走 Portal，SSR 静态渲染不参与输出——交互行为（取消零 RPC、
 * 确认带参提交）由 hook/e2e 链路覆盖（flatTaskGroupMoveE2E.test.ts 验证
 * 确认后的带参创建与移入；取消路径不触发任何提交在服务端断言为 membership 不变）。
 * 这里覆盖可静态验证的部分：closed 零渲染、Host 的 store 挂载语义、
 * 确认值构造的默认名语义。
 */

function resetDialogStore(): void {
  useFlatTaskGroupCreateDialogStore.getState().closeCreateGroupDialog();
}

test("closed 状态零渲染：不挂载 Portal、无任何 DOM 输出", () => {
  const dialog = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      null,
      createElement(CreateGroupDialog, {
        open: false,
        onOpenChange: () => {},
        mode: "createAndMove",
        onConfirm: () => {},
      }),
    ),
  );
  assert.equal(dialog, "");

  const emojiDialog = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      null,
      createElement(EmojiPickerDialog, {
        open: false,
        onOpenChange: () => {},
        onSelect: () => {},
      }),
    ),
  );
  assert.equal(emojiDialog, "");
});

test("Host 语义：菜单生命周期之外的稳定挂载，closed 零渲染、store 驱动开关与回调", () => {
  resetDialogStore();
  const hostClosed = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, null, createElement(CreateGroupDialogHost)),
  );
  assert.equal(hostClosed, "", "未打开时 Host 零渲染");

  let confirmed: string | null = null;
  useFlatTaskGroupCreateDialogStore.getState().openCreateGroupDialog((value) => {
    confirmed = value.title;
  });
  assert.equal(useFlatTaskGroupCreateDialogStore.getState().open, true);
  // 确认闭包经 store 注册：打开方（菜单内容组件）随菜单关闭卸载后，回调依然可达。
  useFlatTaskGroupCreateDialogStore.getState().confirmHandler?.({
    title: "新组",
    color: "gray",
  });
  assert.equal(confirmed, "新组");

  useFlatTaskGroupCreateDialogStore.getState().closeCreateGroupDialog();
  assert.equal(useFlatTaskGroupCreateDialogStore.getState().open, false);
  assert.equal(useFlatTaskGroupCreateDialogStore.getState().confirmHandler, null);
  resetDialogStore();
});

test("确认值构造：空名回填默认名，非空名 trim，emoji 缺省不下发", () => {
  const fallbackTitle = "新建分组";

  assert.deepEqual(
    buildCreateGroupValue({ titleDraft: "  ", color: "gray" }, fallbackTitle),
    { title: fallbackTitle, color: "gray" },
    "空白名称回填 i18n 默认名",
  );
  assert.deepEqual(
    buildCreateGroupValue({ titleDraft: " 发布 " }, fallbackTitle).title,
    "发布",
    "名称两侧空白被 trim",
  );
  const withEmoji = buildCreateGroupValue(
    { titleDraft: "组", color: "blue", emoji: "🚀" },
    fallbackTitle,
  );
  assert.deepEqual(withEmoji, { title: "组", color: "blue", emoji: "🚀" });
  assert.ok(
    !("emoji" in buildCreateGroupValue({ titleDraft: "组", color: "blue" }, fallbackTitle)),
  );
});

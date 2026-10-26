import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { FilesEditorGroupPane } from "../src/files-workbench/FilesEditorGroupPane.js";
import { FilesEditorTabBar } from "../src/files-workbench/FilesEditorTabBar.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

type GroupProps = ComponentProps<typeof FilesEditorGroupPane>;
const noop = () => {};

function groupProps(id: string, isFocused: boolean, populated = true): GroupProps {
  const buffers: GroupProps["buffers"] = populated
    ? ["first", "second"].map((name) => ({
        id: `${id}:${name}`,
        kind: "text",
        untitled: false,
        path: `/workspace/${name}.ts`,
        title: `${name}.ts`,
        text: "saved",
        savedText: "saved",
        workspace: {
          workspacePath: "/workspace",
          ...(id === "remote" ? { workspaceIdentity: "test-remote-workspace" } : {}),
        },
      }))
    : [];
  return {
    group: {
      id,
      views: buffers.map((buffer) => ({ id: `view:${buffer.id}`, bufferId: buffer.id })),
      activeViewId: populated ? `view:${id}:second` : undefined,
    },
    buffers,
    isActiveView: true,
    // 本用例验证结构和标签投影，不挂载 Monaco 或读取工作区文件。
    hasEnteredFiles: false,
    isFocused,
    loadRestoredTextFile: async () => {},
    onActivate: noop,
    onKeepOpen: noop,
    onClose: noop,
    onCloseOthers: noop,
    onCloseToRight: noop,
    onCloseSaved: noop,
    onCloseAll: noop,
    canCloseSaved: true,
    onCopyPath: noop,
    onRevealInFileTree: noop,
    canRevealInFileTree: () => true,
    onMoveView: noop,
    onSplit: noop,
    onChange: noop,
    onOpenPath: () => false,
    onRevealPositionApplied: noop,
    onCreateUntitled: noop,
    onSave: noop,
    onSaveAs: noop,
    onFocusGroup: noop,
  };
}

function render(children: ReactNode): string {
  return renderToStaticMarkup(
    createElement(ServiceProvider, {
      services: {} as IServiceAccessor,
      children: createElement(PlatformProvider, {
        platform: {} as IPlatformService,
        children: createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children }),
      }),
    }),
  );
}

function renderGroups(...groups: GroupProps[]): string {
  return render(
    groups.map((props) => createElement(FilesEditorGroupPane, { ...props, key: props.group.id })),
  );
}

function openingTags(markup: string, role: string): string[] {
  return Array.from(markup.matchAll(/<[^/!][^>]*>/g), (match) => match[0]).filter((tag) =>
    tag.includes(`role="${role}"`),
  );
}

function classTokens(tag: string): string[] {
  return (tag.match(/\bclass="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

function styleAttribute(tag: string): string | undefined {
  return tag.match(/\bstyle="([^"]*)"/)?.[1];
}

function groupMarkup(markup: string): string[] {
  return Array.from(markup.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g), (match) => match[0]);
}

function emphasisCount(markup: string): number {
  return Array.from(markup.matchAll(/<span\b[^>]*>/g), (match) => match[0]).filter((tag) => {
    const tokens = classTokens(tag);
    return tokens.includes("top-0") && tokens.includes("bg-brand");
  }).length;
}

function assertNoGroupFrame(tag: string): void {
  const decoration = classTokens(tag).filter((token) =>
    /^(?:[^:]+:)*(?:border|rounded|ring|shadow)(?:-|$)/.test(token),
  );
  assert.deepEqual(decoration, [], "编辑器布局组不得增加整圈边框、圆角、ring 或阴影");
}

test("空组与有标签组在聚焦或失焦时均不绘制独立结构框", () => {
  for (const populated of [false, true]) {
    for (const isFocused of [false, true]) {
      const markup = renderGroups(groupProps("main", isFocused, populated));
      const roots = openingTags(markup, "group");
      assert.equal(roots.length, 1);
      assertNoGroupFrame(roots[0]!);
      assert.ok(roots[0]!.includes(`data-editor-group-focused="${isFocused}"`));
      assert.equal(openingTags(markup, "tab").length, populated ? 2 : 0);
      assert.equal(emphasisCount(markup), populated && isFocused ? 1 : 0);
      assert.ok(classTokens(openingTags(markup, "tablist")[0]!).includes("border-b"));
    }
  }
});

test("本地和远程分屏各保留活动标签，只有聚焦组显示主文字和顶沿强调", () => {
  for (const focusedId of ["local", "remote"]) {
    const markup = renderGroups(
      groupProps("local", focusedId === "local"),
      groupProps("remote", focusedId === "remote"),
    );
    const groups = groupMarkup(markup);
    assert.equal(groups.length, 2);
    assert.equal(emphasisCount(markup), 1);
    for (const group of groups) {
      const root = openingTags(group, "group")[0]!;
      const isFocused = root.includes(`data-editor-group-id="${focusedId}"`);
      assertNoGroupFrame(root);
      const tabs = openingTags(group, "tab");
      assert.equal(tabs.length, 2);
      assert.match(tabs[0]!, /aria-selected="false"/);
      assert.match(tabs[1]!, /aria-selected="true"/);
      const selectedTokens = classTokens(tabs[1]!);
      assert.ok(selectedTokens.includes("bg-background"));
      assert.ok(selectedTokens.includes(isFocused ? "text-foreground" : "text-foreground-subtle"));
      assert.equal(emphasisCount(group), isFocused ? 1 : 0);
    }
  }
});

test("切换组聚焦只改变视觉强调，不改变内容和标签条的几何样式", () => {
  for (const populated of [false, true]) {
    const unfocused = renderGroups(groupProps("main", false, populated));
    const focused = renderGroups(groupProps("main", true, populated));
    for (const role of ["group", "tablist", "tab"]) {
      const before = openingTags(unfocused, role);
      const after = openingTags(focused, role);
      assert.equal(before.length, after.length);
      for (let index = 0; index < before.length; index += 1) {
        // 文本颜色之外的全部 class（含尺寸、边线、间距）必须保持一致。
        const geometry = (tag: string) =>
          classTokens(tag).filter((token) => !/^text-foreground(?:-|$)/.test(token));
        assert.deepEqual(geometry(before[index]!), geometry(after[index]!));
        assert.equal(styleAttribute(before[index]!), styleAttribute(after[index]!));
      }
    }
  }
});

test("未传组聚焦参数的既有标签条调用仍保留活动标签强调", () => {
  const props = groupProps("main", true);
  const tabs = props.group.views.map((view) => ({
    viewId: view.id,
    buffer: props.buffers.find((buffer) => buffer.id === view.bufferId)!,
  }));
  const markup = render(
    createElement(FilesEditorTabBar, {
      ...props,
      groupId: props.group.id,
      activeViewId: props.group.activeViewId,
      tabs,
    }),
  );
  const selected = openingTags(markup, "tab").find((tag) => tag.includes('aria-selected="true"'));
  assert.ok(selected);
  assert.ok(classTokens(selected).includes("text-foreground"));
  assert.equal(emphasisCount(markup), 1);
});

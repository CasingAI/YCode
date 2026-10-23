import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  FilesWorkbenchMenuBar,
  type FilesWorkbenchMenuBarProps,
} from "@/files-workbench/FilesWorkbenchMenuBar.js";
import { resolveFilesEditorMenuState } from "@/files-workbench/filesEditorMenuContext.js";
import { useFilesEditorStore } from "@/files-workbench/FilesEditorStoreProvider.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { formatShortcutBindingLabel } from "@/shortcuts/label.js";

/** 菜单仅订阅能力投影，正文击键不会触发不相关的菜单重渲染。 */
export function FilesWorkbenchToolbar({
  isDesktop,
  canEdit,
  ...props
}: Omit<FilesWorkbenchMenuBarProps, "state" | "shortcutLabels"> & { isDesktop: boolean }) {
  const menuState = useFilesEditorStore(useShallow(resolveFilesEditorMenuState));
  const shortcutBindings = useEffectiveShortcutBindings();
  const shortcutLabels = useMemo(() => {
    const label = (id: keyof typeof shortcutBindings) => {
      const binding = shortcutBindings[id]?.[0];
      return binding ? formatShortcutBindingLabel(binding) : "";
    };
    return {
      newFile: label("newFile"),
      saveFile: label("saveFile"),
      saveFileAs: label("saveFileAs"),
      saveAllFiles: label("saveAllFiles"),
      findInTask: label("findInTask"),
      findReplaceInEditor: label("findReplaceInEditor"),
      // Web 的 Ctrl/⌘W 属于浏览器；可点击关闭编辑器，但不提示不存在的编辑器快捷键。
      closeActiveContext: isDesktop ? label("closeActiveContext") : "",
    };
  }, [isDesktop, shortcutBindings]);
  return (
    <FilesWorkbenchMenuBar
      {...props}
      state={menuState}
      canEdit={menuState.canSave && canEdit}
      shortcutLabels={shortcutLabels}
    />
  );
}

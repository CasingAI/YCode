import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, FilePlus } from "lucide-react";
import {
  TID_FILES_EXPLORER_WORKSPACE,
  TID_FILES_NEW_FILE,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import {
  filesExplorerWorkspaceOptions,
  filesDefaultSaveDirectory,
  findFilesExplorerWorkspaceOption,
} from "@/files-workbench/filesExplorerWorkspace.js";
import { resolveExplorerWorkspaceKey } from "@/files-workbench/filesEditorModel.js";
import {
  useFilesEditorStore,
  useFilesEditorStoreApi,
} from "@/files-workbench/FilesEditorStoreProvider.js";

export function FilesExplorerPane({
  isDesktop,
  onOpenBrowserUrl,
  onOpenedFile,
}: {
  isDesktop: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenedFile?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const store = useFilesEditorStoreApi();
  const workspaceTabs = useTabStore(
    useShallow((state) => state.tabs.filter(isWorkspaceTab)),
  );
  const explorerWorkspaceKey = useFilesEditorStore((state) => state.explorerWorkspaceKey);
  const revealPath = useFilesEditorStore((state) => state.revealPath);
  const options = useMemo(() => filesExplorerWorkspaceOptions(workspaceTabs), [workspaceTabs]);
  const selectedKey = resolveExplorerWorkspaceKey({
    preferredKey: explorerWorkspaceKey,
    workspaceKeys: options.map((option) => option.key),
  });
  const selected = findFilesExplorerWorkspaceOption(options, selectedKey);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [selectedIsDirectory, setSelectedIsDirectory] = useState(false);
  const handleSelectedPathChange = useCallback((path: string, isDirectory: boolean) => {
    setSelectedPath((current) => (current === path ? current : path));
    setSelectedIsDirectory((current) => (current === isDirectory ? current : isDirectory));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2 pt-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="min-w-0 flex-1 justify-between gap-2 px-2.5"
              data-testid={TID_FILES_EXPLORER_WORKSPACE}
            >
              <span className="min-w-0 truncate">
                {selected?.label ?? intl.formatMessage({ id: "filesWorkbench.emptyExplorer" })}
              </span>
              <ChevronDown className="size-4 shrink-0 text-foreground-subtle" />
            </Button>
          </DropdownMenuTrigger>
          {options.length > 0 ? (
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuRadioGroup
                value={selected?.key}
                onValueChange={(key) => {
                  store.getState().setExplorerWorkspaceKey(key);
                }}
              >
                {options.map((option) => (
                  <DropdownMenuRadioItem key={option.key} value={option.key}>
                    {option.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          ) : null}
        </DropdownMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_FILES_NEW_FILE}
          disabled={!selected}
          aria-label={intl.formatMessage({ id: "filesWorkbench.newFile" })}
          title={intl.formatMessage({ id: "filesWorkbench.newFile" })}
          onClick={() => {
            if (!selected) {
              return;
            }
            store.getState().setPendingSaveDirectory(
              filesDefaultSaveDirectory({
                selectedPath,
                selectedIsDirectory,
                workspaceRoot: selected.workspace.workspacePath,
              }),
            );
            store.getState().createUntitled(selected.workspace);
            onOpenedFile?.();
          }}
        >
          <FilePlus className="size-3.5" />
        </Button>
      </div>
      {selected ? (
        <div className="min-h-0 flex-1">
          <WorkspaceFileTree
            workspacePath={selected.workspace.workspacePath}
            workspaceName={selected.label}
            workspaceIdentity={selected.workspace.workspaceIdentity}
            workspaceRemoteSessionId={selected.workspace.workspaceRemoteSessionId}
            revealPath={revealPath}
            canOpenLocalFileManager={isDesktop}
            onOpenBrowserUrl={isDesktop ? onOpenBrowserUrl : undefined}
            onSelectedPathChange={handleSelectedPathChange}
            onOpenPreview={(source) => {
              if (!source.path) {
                return;
              }
              store.getState().requestOpenPath({
                workspace: selected.workspace,
                path: source.path,
              });
              onOpenedFile?.();
            }}
          />
        </div>
      ) : (
        <p className="px-4 py-8 text-center text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "filesWorkbench.emptyExplorer" })}
        </p>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { CircleX, TriangleAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  FILES_EDITOR_INDENT_SIZES,
  filesEditorFilterLanguages,
  filesEditorLanguageDescription,
  filesEditorLanguageLabelById,
  filesEditorMarkerCounts,
  filesEditorResolveGotoLine,
} from "@/files-workbench/filesEditorStatusModel.js";
import type {
  FilesEditorEol,
  FilesEditorStatusMarker,
} from "@/files-workbench/filesEditorStatusModel.js";
import type {
  FilesEditorStatusLanguage,
  FilesEditorStatusState,
} from "@/files-workbench/filesMonacoStatusHandle.js";
import { filesEditorAssociationPatternForPath } from "@/files-workbench/filesEditorLanguageAssociations.js";

/**
 * 文件工作台编辑器状态栏。
 *
 * 只做展示与命令转发：状态来自 handle 快照，行为一律回调给上层，
 * 组件自身不持有编辑器状态。规格见 docs/specs/files-editor-status-bar.md。
 */
export function FilesEditorStatusBar({
  state,
  languages,
  filePath,
  onGoToLine,
  onSetIndentation,
  onSetLanguage,
  onSaveLanguageAssociation,
  onSetEol,
  onRevealMarker,
}: {
  state: FilesEditorStatusState;
  languages: readonly FilesEditorStatusLanguage[];
  /** 当前文件路径：用于「保存为关联」时算出模式键与路径键。 */
  filePath?: string;
  onGoToLine: (line: number) => void;
  onSetIndentation: (next: { insertSpaces: boolean; tabSize: number }) => void;
  onSetLanguage: (languageId: string) => void;
  onSaveLanguageAssociation?: (languageId: string, scope: "pattern" | "file") => void;
  onSetEol: (eol: FilesEditorEol) => void;
  onRevealMarker: (marker: FilesEditorStatusMarker) => void;
}) {
  const { intl } = useZCodeIntl();
  const [gotoLineInput, setGotoLineInput] = useState("");
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [languageQuery, setLanguageQuery] = useState("");
  const [languageOpen, setLanguageOpen] = useState(false);

  const { snapshot, markers } = state;
  const { errors, warnings } = filesEditorMarkerCounts(markers);

  const filteredLanguages = useMemo(
    () => filesEditorFilterLanguages(languages, languageQuery),
    [languageQuery, languages],
  );

  const indentLabel =
    snapshot.indentKind === "spaces"
      ? intl.formatMessage(
          { id: "filesWorkbench.statusBar.indentSpaces" },
          { size: snapshot.tabSize },
        )
      : intl.formatMessage(
          { id: "filesWorkbench.statusBar.indentTabs" },
          { size: snapshot.tabSize },
        );

  const cursorLabel = intl.formatMessage(
    { id: "filesWorkbench.statusBar.cursorPosition" },
    { line: snapshot.lineNumber, column: snapshot.column },
  );

  const markerPositionLabel = (marker: FilesEditorStatusMarker) =>
    intl.formatMessage(
      { id: "filesWorkbench.statusBar.cursorPosition" },
      { line: marker.lineNumber, column: marker.column },
    );

  const gotoLine = (line: number) => {
    onGoToLine(line);
    setGotoLineOpen(false);
    setGotoLineInput("");
  };

  const submitGotoLine = () => {
    const line = filesEditorResolveGotoLine(gotoLineInput, snapshot.lineCount);
    if (line === undefined) return;
    gotoLine(line);
  };

  const itemClass = cn(
    "flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-ui-sm text-foreground-subtle",
    "hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none",
  );

  return (
    <div
      data-testid="files-editor-status-bar"
      className="flex h-6 shrink-0 items-center justify-end gap-0.5 border-t border-border px-1 text-ui-sm text-foreground-subtle [app-region:no-drag]"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={itemClass}
            aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.problems" })}
          >
            <CircleX
              className={cn("size-3", errors > 0 ? "text-destructive" : "text-foreground-subtlest")}
              aria-hidden="true"
            />
            <span>{errors}</span>
            <TriangleAlert
              className={cn(
                "size-3",
                warnings > 0 ? "text-foreground" : "text-foreground-subtlest",
              )}
              aria-hidden="true"
            />
            <span>{warnings}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {markers.length === 0 ? (
            <DropdownMenuItem disabled>
              {intl.formatMessage({ id: "filesWorkbench.statusBar.noProblems" })}
            </DropdownMenuItem>
          ) : (
            markers.map((marker) => (
              <DropdownMenuItem
                key={marker.id}
                onSelect={() => onRevealMarker(marker)}
                className="flex-col items-start gap-0.5 py-1.5"
              >
                <span className="w-full truncate text-ui-sm">{marker.message}</span>
                <span className="text-ui-xs text-foreground-subtlest">
                  {markerPositionLabel(marker)}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={itemClass}
            aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.indent" })}
          >
            {indentLabel}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "filesWorkbench.statusBar.indentKind" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={snapshot.indentKind}
            onValueChange={(value) =>
              onSetIndentation({
                insertSpaces: value === "spaces",
                tabSize: snapshot.tabSize,
              })
            }
          >
            <DropdownMenuRadioItem value="spaces">
              {intl.formatMessage({ id: "filesWorkbench.statusBar.indentSpacesKind" })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="tabs">
              {intl.formatMessage({ id: "filesWorkbench.statusBar.indentTabsKind" })}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "filesWorkbench.statusBar.indentSize" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(snapshot.tabSize)}
            onValueChange={(value) =>
              onSetIndentation({
                insertSpaces: snapshot.indentKind === "spaces",
                tabSize: Number(value),
              })
            }
          >
            {FILES_EDITOR_INDENT_SIZES.map((size) => (
              <DropdownMenuRadioItem key={size} value={String(size)}>
                {size}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="flex h-5 shrink-0 items-center rounded px-1.5 text-ui-sm text-foreground-subtle"
              aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.encoding" })}
            >
              UTF-8
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {intl.formatMessage({ id: "filesWorkbench.statusBar.encodingTooltip" })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={itemClass}
            aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.eol" })}
          >
            {snapshot.eol}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "filesWorkbench.statusBar.eol" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={snapshot.eol}
            onValueChange={(value) => onSetEol(value === "CRLF" ? "CRLF" : "LF")}
          >
            <DropdownMenuRadioItem value="LF">LF</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="CRLF">CRLF</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover
        open={languageOpen}
        onOpenChange={(nextOpen) => {
          setLanguageOpen(nextOpen);
          if (!nextOpen) setLanguageQuery("");
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={itemClass}
            aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.language" })}
          >
            {/* 显示规范名而非原始 id：与浮层行同源，切换与关联仍以 id 为准。 */}
            {filesEditorLanguageLabelById(snapshot.languageId, languages)}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 gap-0 p-0">
          <div className="border-b border-border p-2">
            <Input
              size="sm"
              autoFocus
              value={languageQuery}
              onChange={(event) => setLanguageQuery(event.target.value)}
              placeholder={intl.formatMessage({ id: "filesWorkbench.statusBar.languageSearch" })}
              aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.languageSearch" })}
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filteredLanguages.length === 0 ? (
              <p className="px-2 py-1.5 text-ui-sm text-foreground-subtlest">
                {intl.formatMessage({ id: "filesWorkbench.statusBar.languageEmpty" })}
              </p>
            ) : (
              filteredLanguages.map((language) => {
                const description = filesEditorLanguageDescription(language);
                const isCurrent = language.id === snapshot.languageId;
                return (
                  <button
                    key={language.id}
                    type="button"
                    onClick={() => {
                      onSetLanguage(language.id);
                      setLanguageOpen(false);
                    }}
                    className="flex h-9 w-full flex-col justify-center gap-0.5 rounded-sm px-2 text-left hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
                  >
                    <span
                      className={cn(
                        "w-full truncate font-mono text-ui-sm",
                        isCurrent ? "font-medium text-foreground" : "text-foreground",
                      )}
                    >
                      {language.label}
                    </span>
                    {description ? (
                      <span className="w-full truncate text-ui-xs text-foreground-subtlest">
                        {description}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          {onSaveLanguageAssociation && filePath ? (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => {
                  onSaveLanguageAssociation(snapshot.languageId, "pattern");
                  setLanguageOpen(false);
                }}
                className="flex h-8 w-full items-center rounded-sm px-2 text-left text-ui-sm text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                {intl.formatMessage(
                  { id: "filesWorkbench.statusBar.languageSaveAsPattern" },
                  { pattern: filesEditorAssociationPatternForPath(filePath) },
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  onSaveLanguageAssociation(snapshot.languageId, "file");
                  setLanguageOpen(false);
                }}
                className="flex h-8 w-full items-center rounded-sm px-2 text-left text-ui-sm text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                {intl.formatMessage({ id: "filesWorkbench.statusBar.languageSaveAsFile" })}
              </button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      <Popover open={gotoLineOpen} onOpenChange={setGotoLineOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={itemClass}
            aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.gotoLine" })}
          >
            {cursorLabel}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 gap-2 p-2.5">
          <PopoverTitle>
            {intl.formatMessage({ id: "filesWorkbench.statusBar.gotoLine" })}
          </PopoverTitle>
          <Input
            size="sm"
            autoFocus
            value={gotoLineInput}
            inputMode="numeric"
            onChange={(event) => setGotoLineInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitGotoLine();
              }
            }}
            placeholder={intl.formatMessage({ id: "filesWorkbench.statusBar.gotoLinePlaceholder" })}
            aria-label={intl.formatMessage({ id: "filesWorkbench.statusBar.gotoLinePlaceholder" })}
          />
          <button
            type="button"
            className="flex h-7 items-center justify-center rounded-md bg-brand px-2 text-ui-sm text-foreground-inverse hover:bg-brand/80 focus-visible:outline-none"
            onClick={submitGotoLine}
          >
            {intl.formatMessage({ id: "filesWorkbench.statusBar.gotoLineSubmit" })}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

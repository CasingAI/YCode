import { useCallback, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { FILES_MONACO_LANGUAGE_OPTIONS } from "@/files-workbench/filesMonacoLanguage.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 文件语言关联设置分区。
 *
 * 关联表是「模式/路径 → 语言 id」，与 VS Code 的 files.associations 语义一致：
 * 精确路径优先于模式，模式取最长命中。本机存储，不随账号同步。
 */
export function FilesEditorLanguageSection() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const associations = settings?.fileLanguageAssociations;
  const entries = useMemo(() => Object.entries(associations ?? {}), [associations]);

  const [pattern, setPattern] = useState("");
  const [languageId, setLanguageId] = useState("typescript");
  const [saving, setSaving] = useState(false);

  const persist = useCallback(
    async (next: Record<string, string>) => {
      setSaving(true);
      try {
        await update({ fileLanguageAssociations: next });
      } catch (error) {
        logger.error("[FilesEditorLanguageSection] 保存文件语言关联失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.filesEditor.saveFailed" }));
      } finally {
        setSaving(false);
      }
    },
    [intl, update],
  );

  const handleAdd = useCallback(() => {
    const key = pattern.trim();
    if (!key) {
      toast(intl.formatMessage({ id: "settings.filesEditor.patternRequired" }));
      return;
    }
    void persist({ ...associations, [key]: languageId }).then(() => {
      setPattern("");
    });
  }, [associations, intl, languageId, pattern, persist]);

  const handleRemove = useCallback(
    (key: string) => {
      const next = { ...associations };
      delete next[key];
      void persist(next);
    },
    [associations, persist],
  );

  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.filesEditor.description" })}
      </div>
      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          {entries.length === 0 ? (
            <div className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.filesEditor.empty" })}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {entries.map(([key, value]) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="min-w-0 truncate font-mono text-ui-base text-foreground">
                    {key}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-ui-base text-foreground-subtle">{value}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "settings.filesEditor.remove" })}
                      disabled={saving}
                      onClick={() => handleRemove(key)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
              placeholder={intl.formatMessage({ id: "settings.filesEditor.patternPlaceholder" })}
              aria-label={intl.formatMessage({ id: "settings.filesEditor.patternLabel" })}
              className="w-64"
            />
            <Select value={languageId} onValueChange={setLanguageId}>
              <SelectTrigger size="lg" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILES_MONACO_LANGUAGE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={saving} onClick={handleAdd}>
              <Plus className="size-4" />
              {intl.formatMessage({ id: "settings.filesEditor.add" })}
            </Button>
          </div>
          <p className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.filesEditor.hint" })}
          </p>
        </div>
      </SettingsGroupCard>
    </div>
  );
}

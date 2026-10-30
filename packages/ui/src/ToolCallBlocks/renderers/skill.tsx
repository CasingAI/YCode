import { WandSparkles } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveSkillCardPrimaryLabel } from "@/lib/skillDisplayName.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SKILL_TOOL_ICON = <WandSparkles className="size-4 shrink-0 text-foreground-subtle" />;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function getSkillName(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  if (isPlainRecord(toolCall.input)) {
    const directSkill = readFirstStringField(toolCall.input, ["skill", "name"]);
    if (directSkill) {
      return directSkill;
    }
  }

  return undefined;
}

function extractSkillText(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => extractSkillText(item))
      .filter((item): item is string => item != null)
      .join("\n");
    return text.length > 0 ? text : null;
  }

  if (!isPlainRecord(value)) {
    return null;
  }

  const directText = readFirstStringField(value, [
    "output",
    "text",
    "content",
    "message",
    "rawOutput",
    "result",
  ]);
  if (directText) {
    return directText;
  }

  if (Array.isArray(value.content)) {
    const contentText = value.content
      .map((item) => {
        if (!isPlainRecord(item)) {
          return extractSkillText(item);
        }

        return extractSkillText(item.content ?? item);
      })
      .filter((item): item is string => item != null)
      .join("\n");
    return contentText.length > 0 ? contentText : null;
  }

  return null;
}

export function SkillToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const skillName = getSkillName(toolCall);
  // 展示名按 skill-title.md 从会话宿主下发的查找表解析；表为 undefined（目录未就绪/
  // 请求失败/只读视图）时主标题留空，不能先露出原始 ref；只有已完成的 authoritative
  // 目录未命中才回退原始输入。渲染器不发起请求。
  const displayName = useMemo(
    () =>
      skillName
        ? resolveSkillCardPrimaryLabel(skillName, context.skillDisplayNameByRef)
        : undefined,
    [context.skillDisplayNameByRef, skillName],
  );
  const outputText = extractSkillText(toolCall.output);
  const rawOutputText = isPlainRecord(toolCall.raw)
    ? extractSkillText(toolCall.raw.rawOutput)
    : null;
  const detailText =
    toolCall.status === "failed"
      ? (context.errorText ?? outputText ?? rawOutputText ?? undefined)
      : (outputText ?? rawOutputText ?? undefined);
  const skillFallbackLabel = intl.formatMessage({ id: "chat.toolCall.skill.label" });
  const skillUnknownLabel = intl.formatMessage({ id: "chat.toolCall.skill.unknown" });
  const skillNoOutputLabel = intl.formatMessage({ id: "chat.toolCall.skill.noOutput" });
  const primaryText = useMemo(() => {
    if (!skillName) {
      return (
        <span className="truncate font-mono text-foreground-subtlest">
          {toolCall.title ?? skillFallbackLabel}
        </span>
      );
    }
    // 目录未就绪/不可用时 displayName 为 undefined：折叠态省略名称，只保留本地化的
    // 类别标签与状态；展开详情仍显示原始 ID。不得在此回退原始 ref。
    if (!displayName) {
      return null;
    }
    return <span className="truncate font-mono text-foreground-subtlest">{displayName}</span>;
  }, [displayName, skillFallbackLabel, skillName, toolCall.title]);
  const renderContent = useCallback(
    () => (
      <div className="space-y-3 mb-2 rounded-xl border border-border bg-panel px-4 py-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-ui-base text-foreground">
            <span className="text-foreground-subtle">{skillFallbackLabel}</span>
            <code className="rounded-md bg-surface px-2 py-1 font-mono text-ui-base text-foreground">
              {skillName ?? toolCall.title ?? skillUnknownLabel}
            </code>
            {displayName && displayName !== skillName ? (
              <span className="text-ui-base text-foreground-subtle">{displayName}</span>
            ) : null}
          </div>
        </div>

        {detailText ? (
          <div className="space-y-1">
            <pre className="max-h-25 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base text-foreground-subtle">
              {detailText}
            </pre>
          </div>
        ) : (
          !context.isRunning && (
            <div className="space-y-1">
              <p className="font-mono text-ui-base text-foreground-subtle">{skillNoOutputLabel}</p>
            </div>
          )
        )}
      </div>
    ),
    [
      context.isRunning,
      detailText,
      displayName,
      skillFallbackLabel,
      skillName,
      skillNoOutputLabel,
      skillUnknownLabel,
      toolCall.title,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SKILL_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={
          context.kindLabelOverride ??
          intl.formatMessage({
            id: context.isRunning ? "chat.toolCall.skill.running" : "chat.toolCall.kind.skill",
          })
        }
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={toolCall.status === "failed" ? detailText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        // 悬停提示与主标题同源：目录未就绪时一并留空，避免通过 title 属性提前泄露原始 ref。
        title={skillName ? displayName : toolCall.title}
        renderContent={renderContent}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}

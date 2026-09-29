import { memo, useLayoutEffect, useRef, useState } from "react";
import { Bot, Cable, MessagesSquare, ScrollText, SquareSlash, WandSparkles } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { isTrustedPluginIconSource } from "@/lib/pluginIconSource.js";
import { usePluginReferenceIconProjection } from "@/v4/pluginReferenceIconContext.js";
import {
  getPromptMentionVariantClassName,
  PROMPT_MENTION_BASE_CLASS_NAME,
} from "@/mentions/mentionChip.js";
import { decoratePromptMention } from "@/mentions/nodes/promptMentionDecoration.js";
import {
  formatSkillMentionDisplayLabel,
  parseMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";
import {
  GOAL_ECHO_CHIP_STYLE,
  GOAL_ECHO_SCOPE_STYLE,
  goalEchoMentionId,
  isGoalCommandLabel,
  materializeGoalEchoParts,
  resolveGoalEchoScope,
} from "@/v4/goalQueryDisplay.js";

const EMPTY_ATTACHMENTS: readonly unknown[] = [];

type V4UserInputMentionPart = ReturnType<typeof parseMentionMarkdown>[number];

function normalizeCommandMentionLabel(label: string): string {
  return label.trim().replace(/^\/+/, "").toLowerCase();
}

function mentionClassName(category: Parameters<typeof getPromptMentionVariantClassName>[0]) {
  return cn(
    "mx-0.5 max-w-full",
    PROMPT_MENTION_BASE_CLASS_NAME,
    // userInput 正文使用 text-ui-base，与 assistant 消息体保持一致。
    "text-ui-base leading-6",
    getPromptMentionVariantClassName(category),
  );
}

function V4UserInputMention({
  part,
  authoritativeGoal,
  pluginIcon,
}: {
  part: Exclude<V4UserInputMentionPart, { type: "text" }>;
  authoritativeGoal: boolean;
  pluginIcon?: string;
}) {
  if (part.type === "file" || part.type === "directory") {
    return (
      <span className={mentionClassName("files")}>
        <FileDisplayInline
          path={part.label}
          options={{
            className: "inline-flex min-w-0 max-w-full items-center gap-1 align-middle",
            iconSize: 16,
            kind: part.type === "directory" ? "directory" : "file",
            fileNameClassName: "truncate text-ui-base leading-6 font-medium text-current",
          }}
        />
      </span>
    );
  }

  if (part.type === "skill") {
    return (
      <span className={mentionClassName("skills")}>
        <WandSparkles aria-hidden="true" className="size-4 shrink-0" />
        {formatSkillMentionDisplayLabel(part.label)}
      </span>
    );
  }

  if (part.type === "session") {
    return (
      <span className={mentionClassName("sessions")}>
        <MessagesSquare aria-hidden="true" className="size-4 shrink-0" />
        {part.label}
      </span>
    );
  }

  if (part.type === "plugin") {
    // Plugin 引用在气泡里渲染为 chip：不进 file 分支、不可作外链打开。
    return (
      <span className={mentionClassName("plugins")} data-plugin-mention-id={part.pluginId}>
        <PluginUserMessageIcon src={pluginIcon} />
        {part.label}
      </span>
    );
  }

  if (part.type === "subagent") {
    return (
      <span className={mentionClassName("subagents")}>
        <Bot aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
        {part.label}
      </span>
    );
  }

  if (isGoalCommandLabel(part.label)) {
    // 旧版纯文本嗅探会把带附件的 `/goal` 普通 prompt 也画成控制命令。
    // V4 只允许发送入口确认的首个 goal token 使用特殊 UI，其余情况必须保持用户原文。
    if (!authoritativeGoal) return `/${part.label}`;
    return <GoalEchoMentionChip label={part.label} />;
  }

  const commandName = normalizeCommandMentionLabel(part.label);
  return (
    <span className={mentionClassName("commands")}>
      {commandName === "compact" ? (
        <ScrollText aria-hidden="true" className="size-4 shrink-0" />
      ) : (
        <SquareSlash aria-hidden="true" className="size-4 shrink-0" />
      )}
      {part.label}
    </span>
  );
}

function GoalEchoMentionChip({ label }: { label: string }) {
  const command = label.trim().replace(/^\/+/, "").toLowerCase();
  const nodeRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // 与编辑器 PromptMentionNode 同一套 ::before 图标，气泡不得再插 Lucide SVG。
    decoratePromptMention(node, "commands", command);
  }, [command]);
  return (
    <span
      ref={nodeRef}
      className={cn(
        "prompt-mention",
        PROMPT_MENTION_BASE_CLASS_NAME,
        getPromptMentionVariantClassName("commands"),
      )}
      data-mention-category="commands"
      data-mention-id={goalEchoMentionId(label)}
      data-v4-user-input-command="goal"
      style={GOAL_ECHO_CHIP_STYLE}
    >
      {label}
    </span>
  );
}

function PluginUserMessageIcon({ src }: { src?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = isTrustedPluginIconSource(src) && failedSrc !== src;

  if (!showImage) {
    return <Cable aria-hidden="true" className="size-4 shrink-0" />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-plugin-mention-icon="true"
      className="inline-block size-4 shrink-0 rounded-sm object-contain align-middle"
      onError={() => setFailedSrc(src ?? null)}
    />
  );
}

export const ConversationUserInputContent = memo(function ConversationUserInputContent({
  text,
  attachments = EMPTY_ATTACHMENTS,
  contextAttachmentCount = 0,
}: {
  text: string;
  attachments?: readonly unknown[];
  contextAttachmentCount?: number;
}) {
  const pluginIconProjection = usePluginReferenceIconProjection();
  // 句号紧贴 `/goal` 时通用分词切不出芯片；发送端已认成 goal 时这里补上，再交给作用域判定。
  const parts = materializeGoalEchoParts(text);
  const goalEchoScope = resolveGoalEchoScope(text, parts, attachments, contextAttachmentCount);

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          if (goalEchoScope && index > goalEchoScope.commandPartIndex) {
            return (
              <span
                key={`goal-scope-${index}`}
                data-v4-user-input-goal-scope="true"
                // 颜色与字重都来自共享声明，这里只留选择器与验收钩子。
                style={GOAL_ECHO_SCOPE_STYLE}
              >
                {part.text}
              </span>
            );
          }
          return part.text;
        }

        return (
          <V4UserInputMention
            key={`${part.type}-${index}`}
            part={part}
            authoritativeGoal={goalEchoScope?.commandPartIndex === index}
            pluginIcon={
              part.type === "plugin" && part.pluginId
                ? pluginIconProjection?.iconByPluginId.get(part.pluginId)
                : undefined
            }
          />
        );
      })}
    </>
  );
});

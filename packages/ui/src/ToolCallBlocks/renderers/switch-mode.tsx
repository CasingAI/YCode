import { MessageResponse } from "@/components/ai-elements/message.js";
import { ToolOutput } from "@/components/ai-elements/tool.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { extractPlanToolCallContent, getPlanFileLabel } from "@/lib/planToolCall.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ArrowRightIcon, NotepadTextIcon } from "lucide-react";

export function SwitchModeToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  const { markdown, planFilePath } = extractPlanToolCallContent(toolCall, context.workspacePath);
  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );
  const hasMarkdown = typeof markdown === "string" && markdown.length > 0;

  const openDetail = () => {
    if (!markdown || !context.onOpenPlanDetail) return;
    context.onOpenPlanDetail({
      toolCallId: toolCall.toolId,
      markdown,
      ...(planFilePath ? { planFilePath } : {}),
    });
  };

  if (hasMarkdown) {
    return (
      <>
        {/* 计划卡是纯展示加两个动作入口：整卡不再是按钮（点正文不跳详情），
            「查看」在右侧开计划详情，「执行计划」由宿主切完全访问并继续对话。 */}
        <section className="w-full min-w-0 overflow-hidden rounded-xl border border-card-border bg-card text-foreground shadow-xs">
          <header className="flex h-10 min-w-0 items-start gap-2 px-4 pt-4">
            <div className="flex shrink-0 items-center gap-2">
              <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <h3 className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "planTool.panel.planTab" })}
              </h3>
            </div>
            {planFilePath ? (
              <code
                className="min-w-0 truncate text-ui-sm text-foreground-subtlest"
                title={planFilePath}
              >
                {getPlanFileLabel(planFilePath)}
              </code>
            ) : null}
            {context.onOpenPlanDetail ? (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={intl.formatMessage({ id: "planTool.panel.open" })}
                  onClick={openDetail}
                >
                  {intl.formatMessage({ id: "planTool.panel.view" })}
                </Button>
              </div>
            ) : null}
          </header>
          <div className="relative overflow-hidden">
            {/* max-height 与 mask 分层后，长正文会按完整内容高度计算渐变，
            导致实际可见区域没有底部渐隐；两者必须落在同一个裁切节点。 */}
            <div className="max-h-64 overflow-hidden px-4 pt-2 pb-12 [mask-image:linear-gradient(to_bottom,black_0%,black_30%,transparent_100%)]">
              <MessageResponse
                className="min-w-0 break-words text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_li]:text-foreground-subtle [&_p]:text-foreground-subtle"
                workspacePath={context.workspacePath}
                theme={context.theme}
                codePreviewSettings={context.codePreviewSettings}
                onOpenCodeViewer={context.onOpenCodeViewer}
                onOpenFileLink={context.onOpenFileLink}
                onOpenExternalUrl={context.onOpenBrowserUrl}
              >
                {markdown}
              </MessageResponse>
            </div>
            {context.onExecutePlan ? (
              <Button
                type="button"
                variant="default"
                size="lg"
                className="absolute bottom-6 left-1/2 h-10 -translate-x-1/2 rounded-full !pr-4.5 pl-6 shadow-xs"
                onClick={() => context.onExecutePlan?.()}
              >
                {intl.formatMessage({ id: "planTool.panel.execute" })}
                <ArrowRightIcon data-icon="inline-end" className="size-4" />
              </Button>
            ) : null}
          </div>
        </section>
        {snapshotNotice}
      </>
    );
  }

  // switch_mode 的有效信息通常就是那段 markdown 结果，不应该再套一层通用工具卡片。
  // 只有当 provider 没给出 markdown、或者当前是失败态时，才回退到最小输出块，避免 UI 彻底空白。
  if (toolCall.output !== undefined || errorText) {
    return (
      <>
        <ToolOutput errorText={errorText} output={errorText ? undefined : toolCall.output} />
        {snapshotNotice}
      </>
    );
  }

  return snapshotNotice;
}

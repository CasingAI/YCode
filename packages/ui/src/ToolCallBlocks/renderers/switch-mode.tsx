import { MessageResponse } from "@/components/ai-elements/message.js";
import { ToolOutput } from "@/components/ai-elements/tool.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  extractPlanToolCallContent,
  getPlanDirectoryTitle,
  isPlanToolCallInputStreaming,
  shouldRenderCollapsedPlanCard,
} from "@/lib/planToolCall.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ArrowRightIcon, LoaderIcon, NotepadTextIcon } from "lucide-react";

// 与下方折叠卡/全文预览卡头部同款，保证同一工具在成功态与失败态之间不换图标。
const PLAN_TOOL_ICON = (
  <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
);

export function SwitchModeToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  // planFilePath 不再渲染，只透传给详情面板作复制/打开的操作目标。
  const { markdown, overview, planFilePath, title } = extractPlanToolCallContent(
    toolCall,
    context.workspacePath,
  );
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
  // 折叠卡标题与运行时 frontmatter 同一条解析规则：显式输入优先，回退正文首个 H1/首个非空行。
  const cardTitle =
    title ?? (hasMarkdown && markdown ? getPlanDirectoryTitle(markdown) : undefined);
  const streaming = isPlanToolCallInputStreaming(toolCall);
  const collapsed = shouldRenderCollapsedPlanCard({
    hasMarkdown,
    hasTitleOrOverview: title !== undefined || overview !== undefined,
    overview,
    streaming,
  });

  // 失败优先：这条判据必须在折叠卡/全文预览两个内容分支之前。失败行的报错文本与
  // 计划正文共享 output.text/raw.content 字段，不先拦截，extract 会把报错回收成
  // markdown，全文预览分支抢先 return，失败分支永远不可达（线上已复现：报错渲染
  // 成带可点「执行计划」按钮的假计划卡）。计划批准拒绝到不了这里：桥接层已对它
  // 豁免失败标记（status=stopped、error 为空），这条分支只收真失败。
  if (errorText) {
    return <FallbackToolCallBlock {...context} iconOverride={PLAN_TOOL_ICON} />;
  }

  const openDetail = () => {
    if (!markdown || !context.onOpenPlanDetail) return;
    context.onOpenPlanDetail({
      toolCallId: toolCall.toolId,
      markdown,
      ...(planFilePath ? { planFilePath } : {}),
      // 详情面板头部优先读投影里的实时值，这两个只是打开时冻结的兜底（卡片已解析出的标题优先）。
      // 概述不传：面板不渲染它，它只在折叠卡上出现。
      ...(cardTitle ? { title: cardTitle } : {}),
    });
  };

  if (collapsed) {
    return (
      <>
        {/* 折叠卡（参考 Cursor 的 Created Plan）：只展示标题与概述，完整内容由「查看」打开详情侧栏。
            流式期间也走这条：ExitPlanMode 按 title → overview → plan 流出，正文没到时卡片已经能用
            前两个字段成形；任一字段未到就少渲染那一行，不因此改变卡片形态。 */}
        <section className="w-full min-w-0 overflow-hidden rounded-xl border border-card-border bg-card text-foreground shadow-xs">
          {/* 头部只留「计划」小标签：路径文本不再展示，planFilePath 只作详情面板复制/打开的操作目标。 */}
          <header className="flex min-h-10 min-w-0 items-center gap-2 px-4 pt-3.5">
            <div className="flex shrink-0 items-center gap-2">
              <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <h3 className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "planTool.panel.planTab" })}
              </h3>
            </div>
          </header>
          <div className="min-w-0 px-4 pt-1.5">
            {cardTitle ? (
              // 截断是兜底不是装饰：标题按定义是一行短标题，超过两行只可能是回退抓了正文首行
              // （模型不按 title → overview → plan 顺序输出时的兜底路径）。
              <h4 className="line-clamp-2 break-words text-ui-lg font-medium text-foreground">
                {cardTitle}
              </h4>
            ) : null}
            {overview ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
                {overview}
              </p>
            ) : null}
          </div>
          <footer className="flex items-center justify-end gap-1 px-4 pb-3 pt-2.5">
            {/* 正文没到之前不渲染「查看」：详情面板读的是计划正文，此时打开是空面板。 */}
            {context.onOpenPlanDetail && hasMarkdown ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={intl.formatMessage({ id: "planTool.panel.open" })}
                onClick={openDetail}
              >
                {intl.formatMessage({ id: "planTool.panel.view" })}
              </Button>
            ) : null}
            {context.onExecutePlan ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={streaming}
                aria-busy={streaming}
                onClick={() => context.onExecutePlan?.()}
              >
                {intl.formatMessage({ id: "planTool.panel.execute" })}
                {/* 流式期间置加载态：计划还没写完就谈不上执行。文案与位置都不变，只换图标，避免状态切换时按钮位移。 */}
                {streaming ? (
                  <LoaderIcon data-icon="inline-end" className="size-4 animate-spin" />
                ) : (
                  <ArrowRightIcon data-icon="inline-end" className="size-4" />
                )}
              </Button>
            ) : null}
          </footer>
        </section>
        {snapshotNotice}
      </>
    );
  }

  if (hasMarkdown) {
    return (
      <>
        {/* 旧计划的全文渐隐预览：走到这里只剩一种情况——调用已定稿、入参里确实没有
            overview（该字段之前的版本）。流式中的缺概述由上面的折叠卡承担，不落这里。
            计划卡是纯展示加两个动作入口：整卡不再是按钮（点正文不跳详情），
            「查看」在右侧开计划详情，「执行计划」由宿主切完全访问并继续对话。 */}
        <section className="w-full min-w-0 overflow-hidden rounded-xl border border-card-border bg-card text-foreground shadow-xs">
          {/* 头部只留「计划」小标签：路径文本不再展示，planFilePath 只作详情面板复制/打开的操作目标。 */}
          <header className="flex h-10 min-w-0 items-start gap-2 px-4 pt-4">
            <div className="flex shrink-0 items-center gap-2">
              <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <h3 className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "planTool.panel.planTab" })}
              </h3>
            </div>
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
  // 失败态已在上面委托出去，到这里 errorText 恒为空；只有 provider 没给出 markdown 时
  // 才回退到最小输出块，避免 UI 彻底空白。
  if (toolCall.output !== undefined) {
    return (
      <>
        <ToolOutput errorText={undefined} output={toolCall.output} />
        {snapshotNotice}
      </>
    );
  }

  return snapshotNotice;
}

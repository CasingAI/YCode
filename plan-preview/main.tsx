// 一次性预览入口（不入库）：用 packages/ui 的真实组件 + 真实 Tailwind 渲染
// 计划卡脱流在各个阶段的界面形态，不复刻任何样式。
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { NotepadTextIcon, SearchIcon, TerminalIcon, LightbulbIcon } from "lucide-react";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SwitchModeToolCallBlock } from "@/ToolCallBlocks/renderers/switch-mode.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import "./preview.css";

const TITLE = "计划卡脱流：末轮卡片移到轮末";
const OVERVIEW =
  "Agent / Ask 档下模型交完计划继续输出正文，原位留紧凑调用记录，完整卡片统一挪到该轮末尾。";
const PLAN_MD = `# 计划卡脱流：末轮卡片移到轮末

## 根因
计划行与思考、正文共用同一条行序列，分段按「段内最后一条正文」切一刀，
切点之前的行收进历史折叠区，于是计划卡被当成过程内容收起。

## 改法
末轮里把计划行从过程桶摘出，原位留记录，卡片在轮末渲染。
计划行本来就在段末时不触发，Plan 档因此不会出现重复。`;

function planRow(o: {
  status: ToolCallRow["status"];
  streaming?: boolean;
  title?: string;
  overview?: string;
  plan?: string;
}): ToolCallRow {
  const input: Record<string, string> = {};
  if (o.title !== undefined) input["title"] = o.title;
  if (o.overview !== undefined) input["overview"] = o.overview;
  if (o.plan !== undefined) input["plan"] = o.plan;
  return {
    rowId: 42,
    kind: "toolCall",
    createdAt: 1_700_000_000_000,
    turnId: "t",
    toolCallId: "call-plan",
    toolName: "CreatePlan",
    status: o.status,
    inputText: o.streaming ? JSON.stringify(input) : "",
    ...(input["title"] === undefined && input["plan"] === undefined ? {} : { input }),
    output:
      o.status === "success" ? { text: "Plan created. Waiting for user approval." } : undefined,
  } as unknown as ToolCallRow;
}

function ctxFor(row: ToolCallRow): ToolCallBlockRenderContext {
  const node = toolCallRowToLegacyNode(row);
  return {
    toolCallNode: node,
    workspacePath: "/Users/john/Documents/GitHub/YCode",
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: true,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: row.status === "inputStreaming" || row.status === "running",
    statusLabel: undefined,
    errorText: undefined,
    childToolList: null,
    canToggle: false,
    forceOpen: false,
    onExecutePlan: () => undefined,
    onOpenPlanDetail: () => undefined,
  } as unknown as ToolCallBlockRenderContext;
}

// —— 真实计划卡 ——
function PlanCard({ row }: { row: ToolCallRow }) {
  return <SwitchModeToolCallBlock {...ctxFor(row)} />;
}

// —— 真实紧凑调用记录（与 ConversationPlanCallRecordRow 同款 props）——
function PlanRecord({ row }: { row: ToolCallRow }) {
  const node = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  return (
    <ToolLayout
      toolId={node.toolCall.toolId}
      icon={
        <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
      }
      canToggle={false}
      kindLabel="计划"
      primaryText={TITLE}
      isRunning={row.status === "inputStreaming" || row.status === "running"}
    />
  );
}

// —— 真实过程行（同 ConversationProcessRow 的 props 形态）——
function ProcessRow({ summary }: { summary: string }) {
  return (
    <ToolLayout
      toolId={`process-${summary}`}
      icon={<SearchIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />}
      canToggle
      isRunning={false}
      kindLabel={null}
      primaryText={summary}
      expandedPrimaryText={summary}
    />
  );
}

function Reason({ text }: { text: string }) {
  return <div className="text-ui-sm text-foreground-subtle">{text}</div>;
}

function Body({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap break-words text-ui-base text-foreground">{text}</div>;
}

// 切分线标注（讲解用，非产品样式）
function Cut({ label }: { label: string }) {
  return (
    <div className="my-1 flex items-center gap-3 text-[11px] text-amber-600/80">
      <span className="h-px flex-1 bg-amber-600/25" />
      <span className="whitespace-nowrap">{label}</span>
      <span className="h-px flex-1 bg-amber-600/25" />
    </div>
  );
}

const TIGHT = "mt-0.5"; // WORK_ITEM_TIGHT_GAP_CLASS
const CARD = "mt-4"; // WORK_ITEM_CARD_GAP_CLASS

type Step = {
  t: string;
  note: string;
  tone: "blue" | "amber" | "green" | "red";
  visIdx: number;
  isLastTurn: boolean;
  rows: React.ReactNode[];
};

const STREAM = planRow({ status: "inputStreaming", streaming: true, title: TITLE, plan: PLAN_MD });
const DONE = planRow({ status: "success", title: TITLE, overview: OVERVIEW, plan: PLAN_MD });

const SCENES: { name: string; steps: Step[] }[] = [
  {
    name: "Agent 档 · 交完继续说",
    steps: [
      {
        t: "阶段 1 · 模型输出思考",
        note: "还没有正文，切分线的锚点不存在，整段都算历史区。",
        tone: "blue",
        visIdx: -1,
        isLastTurn: true,
        rows: [<Reason key="r" text="先确认计划卡现在落在哪一层……" />],
      },
      {
        t: "阶段 2 · 模型输出正文",
        note: "这段正文成为段内最后一条正文，切分线的锚点定在它身上。它之前的行落进历史区。",
        tone: "blue",
        visIdx: 1,
        isLastTurn: true,
        rows: [
          <Reason key="r" text="先确认计划卡现在落在哪一层……" />,
          <Body key="b" text="核对完了，可以写计划了。" />,
        ],
      },
      {
        t: "阶段 3 · CreatePlan 流式输出",
        note: "此刻计划行是段内最后一行，脱流第三条不成立 —— 卡片留在原位就地成形。title / plan / overview 在半截 JSON 里就能解析出来，所以第一个 chunk 之后就有标题了。",
        tone: "amber",
        visIdx: 1,
        isLastTurn: true,
        rows: [
          <Reason key="r" text="先确认计划卡现在落在哪一层……" />,
          <Body key="b" text="核对完了，可以写计划了。" />,
          <div key="p" className={TIGHT}>
            <PlanCard row={STREAM} />
          </div>,
        ],
      },
      {
        t: "阶段 4 · 入参定稿",
        note: "卡片形态不变（折叠卡），只是执行按钮从禁用转圈变成可点。位置仍在原位 —— 模型还没接着说话。",
        tone: "green",
        visIdx: 1,
        isLastTurn: true,
        rows: [
          <Reason key="r" text="先确认计划卡现在落在哪一层……" />,
          <Body key="b" text="核对完了，可以写计划了。" />,
          <div key="p" className={TIGHT}>
            <PlanCard row={DONE} />
          </div>,
        ],
      },
      {
        t: "阶段 5 · 模型开口的第一个字（卡片此刻已在轮末）",
        note: "这句正文刚开始流式输出、还只有几个字的时候，卡片就已经脱流到轮末了。切分线的锚点是「段内最后一条正文行」——这行一出现（text 非空即计入），锚点立刻右移到它，计划行当场脱流。后面这句话再写多久都不影响卡片位置，用户看到的就是卡片在模型开口的一瞬间跳下去。",
        tone: "amber",
        visIdx: 3,
        isLastTurn: true,
        rows: [
          <Reason key="r" text="先确认计划卡现在落在哪一层……" />,
          <Body key="b" text="核对完了，可以写计划了。" />,
          <div key="p" className={TIGHT}>
            <PlanRecord row={DONE} />
          </div>,
          <Body key="b2" text="计划写好了，…" />,
          <Cut key="cut" label="该轮末尾 · 完整卡片已经在这里了" />,
          <div key="pc" className={CARD}>
            <PlanCard row={DONE} />
          </div>,
        ],
      },
      {
        t: "阶段 6 · 这句正文说完",
        note: "位置和阶段 5 完全一样。说得再长也不影响 —— 卡片停在轮末，原位始终是那条紧凑记录。",
        tone: "blue",
        visIdx: 3,
        isLastTurn: true,
        rows: [
          <Reason key="r" text="先确认计划卡现在落在哪一层……" />,
          <Body key="b" text="核对完了，可以写计划了。" />,
          <div key="p" className={TIGHT}>
            <PlanRecord row={DONE} />
          </div>,
          <Body key="b2" text="计划写好了，等你批准。" />,
          <Cut key="cut" label="该轮末尾 · 完整卡片脱到这里" />,
          <div key="pc" className={CARD}>
            <PlanCard row={DONE} />
          </div>,
        ],
      },
      {
        t: "阶段 7 · 稳定态",
        note: "原位只留一条紧凑记录，完整卡片固定在该轮末尾，跟着后续内容一起往下滚。阅读流不再被计划正文打断。",
        tone: "green",
        visIdx: 4,
        isLastTurn: true,
        rows: [
          <Reason key="r" text="先确认计划卡现在落在哪一层……" />,
          <Body key="b" text="核对完了，可以写计划了。" />,
          <div key="p" className={TIGHT}>
            <PlanRecord row={DONE} />
          </div>,
          <div key="t" className={TIGHT}>
            <ProcessRow summary="查询了 3 次 · 思考 14 次" />
          </div>,
          <Body key="b2" text="计划写好了，等你批准。" />,
          <Cut key="cut" label="该轮末尾 · 完整卡片" />,
          <div key="pc" className={CARD}>
            <PlanCard row={DONE} />
          </div>,
        ],
      },
    ],
  },
  {
    name: "Plan 档 · 交完就停",
    steps: [
      {
        t: "CreatePlan 流式输出",
        note: "和主场景一样，卡片在原位就地成形。",
        tone: "amber",
        visIdx: 1,
        isLastTurn: true,
        rows: [
          <Body key="b" text="我先确认要改哪些地方，然后写计划。" />,
          <div key="p" className={TIGHT}>
            <PlanCard row={STREAM} />
          </div>,
        ],
      },
      {
        t: "提交成功 → plan_created 停轮",
        note: "模型不再接着说话，计划行始终是段内最后一行，第三条始终不成立 → 卡片停在原位，不脱流，也不会冒出第二张。",
        tone: "green",
        visIdx: 1,
        isLastTurn: true,
        rows: [
          <Body key="b" text="我先确认要改哪些地方，然后写计划。" />,
          <div key="p" className={TIGHT}>
            <PlanCard row={DONE} />
          </div>,
        ],
      },
    ],
  },
  {
    name: "历史轮（批准后回看）",
    steps: [
      {
        t: "批准后开新轮，上一轮变历史",
        note: "脱流只对末轮生效，历史轮保持原样 —— 计划行重新落回切分线之前，也就是历史区。收起过程时就看不到卡片了。这是当前已知且未修的缺口。",
        tone: "red",
        visIdx: 2,
        isLastTurn: false,
        rows: [
          <Body key="b" text="核对完了，可以写计划了。" />,
          <div key="p" className={TIGHT}>
            <PlanCard row={DONE} />
          </div>,
          <Body key="b2" text="计划写好了，等你批准。" />,
        ],
      },
    ],
  },
];

function App() {
  const [scene, setScene] = useState(0);
  const [step, setStep] = useState(0);
  const sc = SCENES[scene]!;
  const st = sc.steps[Math.min(step, sc.steps.length - 1)]!;
  const tone = {
    blue: "border-l-sky-500",
    amber: "border-l-amber-500",
    green: "border-l-emerald-500",
    red: "border-l-red-500",
  }[st.tone];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[760px] px-5 py-8">
        <h1 className="text-ui-xl font-semibold">计划卡脱流 · 真实组件预览</h1>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          下面每一张卡片、每一条紧凑记录都是 packages/ui 的真实组件 + 真实 Tailwind 渲染，
          间距也是真实数值（平铺 2px / 卡片 16px）。
        </p>

        <div className="mt-5 flex flex-wrap gap-1.5">
          {SCENES.map((s, i) => (
            <button
              key={s.name}
              onClick={() => {
                setScene(i);
                setStep(0);
              }}
              className={
                "rounded-md border px-2.5 py-1 text-ui-sm transition-colors " +
                (i === scene
                  ? "border-foreground-subtle bg-accent/15 text-foreground"
                  : "border-border text-foreground-subtle hover:text-foreground")
              }
            >
              {s.name}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className="rounded-md border border-border px-3 py-1 text-ui-sm disabled:opacity-35"
          >
            上一步
          </button>
          <button
            onClick={() => setStep(Math.min(sc.steps.length - 1, step + 1))}
            disabled={step >= sc.steps.length - 1}
            className="rounded-md border border-border px-3 py-1 text-ui-sm disabled:opacity-35"
          >
            下一步
          </button>
          <span className="ml-auto text-ui-sm text-foreground-subtle">
            {step + 1} / {sc.steps.length} · {st.isLastTurn ? "末轮" : "历史轮"}
          </span>
        </div>

        <div className={`mt-3 border-l-2 ${tone} bg-foreground-subtlest/40 px-3 py-2`}>
          <div className="text-ui-sm font-medium">{st.t}</div>
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">{st.note}</div>
        </div>

        {/* 模拟聊天区 */}
        <div className="mt-5 rounded-lg border border-border bg-background-subtle p-4">
          {st.rows.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-foreground-subtlest">
          黄色横线是讲解用的切分线标注，不属于产品界面。
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ZCodeIntlProvider initialLocale="zh-CN">
      <App />
    </ZCodeIntlProvider>
  </StrictMode>,
);

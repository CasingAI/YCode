/**
 * 时间线 fixture 页面源码（P0-3 修正）。
 *
 * 关键约束：
 * - 真实 `ConversationTimeline` + 真实 `ConversationProjectionStore`，不使用假 store、
 *   不加长超时、不 `flushSync`；
 * - 首窗只给最后 1 轮（不足一屏），由首绘 staging 补齐循环真实取整页；每页 10 轮，
 *   保证「铺满一屏」与「整轮到齐」都覆盖到，并且首绘后仍留有可前插的更早历史；
 * - 去掉旧的「每会话最多 6 页」上限：hasMore 由真实游标 `start > 0` 决定，历史取尽后
 *   自然收敛，不再出现「首绘 + 预取耗尽页数、wheel 时只能 retry」的假象；
 * - `handleCommit` 分开统计首绘提交与前插尝试 / 成功 / retry，`signals()` 不读几何
 *   （scroll 指标由 fixture 自己的 scroll 监听用探针 raw getter 缓存）。
 *
 * 受控历史长度：21 轮。首绘补齐消耗 1 页（11 轮 ≈ 一屏以上），剩余 10 轮正好是
 * 一次前插补齐所需的整页，提交后 hasMore=false，后续预取自然停止，场景可确定性收敛。
 */
import { installProductCssImport } from "./rendererLayoutCostFixtureCss.js";
import { TIMELINE_DATA_SOURCE } from "./rendererLayoutCostFixtureTimelineData.js";

export const TIMELINE_SOURCE = `${installProductCssImport()}
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { ConversationProjectionStore, hasOlderRows } from "@/v4/conversationProjectionStore.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

${TIMELINE_DATA_SOURCE}
let activeIndexValue = SESSION_IDS.length - 1;
let mountedRoot = null;

// 取值与 SessionPhase 完全一致（packages/shared/src/zcode-protocol-v4/snapshot.ts
// 的 sessionPhaseSchema）。restore 用例切到完成态：运行中会话在重挂载后会吸底，
// 把滚动记忆的落点盖掉，必须有真实完成态才能观测记忆恢复。
let phaseValue = "running";
let applyPhase = null;

const STATS = {
  pagesFetched: 0,
  rowsRangeCalls: 0,
  stagingFetchCount: 0,
  inFlight: 0,
  inFlightMax: 0,
  firstPaintCommitAttempts: 0,
  firstPaintCommits: 0,
  attemptedPrependCommits: 0,
  successfulPrependCommits: 0,
  commitRetries: 0,
  stagingPublishCount: 0,
  hiddenLayoutCount: 0,
  stagedCandidateCount: -1,
  stagingSeen: false,
  scrollTop: 0,
  clientHeight: 0,
  scrollHeight: 0,
  firstVisibleTurnId: null,
  restore: null,
  leftFromIndex: null,
  scrollTarget: null,
  observer: null,
};

function sampleStagingState() {
  const element = STATS.scrollTarget;
  if (!element) return;
  const staging = element.querySelector(STAGING_SELECTOR);
  if (staging) {
    const count = staging.querySelectorAll("[data-v4-staged-turn]").length;
    if (count !== STATS.stagedCandidateCount) {
      STATS.stagedCandidateCount = count;
      if (count > 0) STATS.hiddenLayoutCount += 1;
    }
    STATS.stagingSeen = true;
    return;
  }
  STATS.stagedCandidateCount = -1;
  if (STATS.stagingSeen) {
    STATS.stagingSeen = false;
    STATS.stagingPublishCount += 1;
  }
}

function watchRestoreReturn() {
  let frames = 0;
  let lastTop = null;
  let stable = 0;
  const tick = function () {
    frames += 1;
    const element = STATS.scrollTarget;
    if (!element) {
      if (frames < 240) requestAnimationFrame(tick);
      return;
    }
    if (element.querySelector(STAGING_SELECTOR) === null) {
      const top = rawGet(element, "scrollTop");
      if (lastTop !== null && Math.abs(top - lastTop) < 0.5) stable += 1;
      else stable = 0;
      lastTop = top;
      if (stable >= 2) {
        // 只在这里读一次几何：恢复落点与首可见轮必须来自同一帧的真实布局。
        STATS.restore = { scrollTop: top, firstVisibleTurnId: computeFirstVisibleTurn(element) };
        return;
      }
    } else {
      stable = 0;
      lastTop = null;
    }
    if (frames < 240) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function readTimelineSignals() {
  const element = timelineElement();
  const store = STORES[activeIndexValue];
  const state = store.getState();
  const windowRows = state.snapshot ? state.snapshot.rows.window : [];
  const staging = element ? element.querySelector(STAGING_SELECTOR) : null;
  let visible = 0;
  let staged = 0;
  let total = 0;
  if (element) {
    for (const section of element.querySelectorAll("section[data-turn-id]")) {
      total += 1;
      if ((staging && staging.contains(section)) || section.closest(STAGED_PREPEND_SELECTOR)) staged += 1;
      else visible += 1;
    }
  }
  return {
    activeIndex: activeIndexValue,
    sessionId: SESSION_IDS[activeIndexValue],
    phase: phaseValue,
    // 缓存值：signals() 在窗口内被按帧轮询，不能读几何。
    scrollTop: STATS.scrollTop,
    clientHeight: STATS.clientHeight,
    scrollHeight: STATS.scrollHeight,
    sectionCount: total,
    visibleSectionCount: visible,
    stagingSectionCount: staged,
    stagingPublishCount: STATS.stagingPublishCount,
    hiddenLayoutCount: STATS.hiddenLayoutCount,
    firstPaintStaging: staging !== null,
    pendingOlder: state.pendingOlder !== null,
    minRowId: windowRows.length > 0 ? windowRows[0].rowId : null,
    maxRowId: windowRows.length > 0 ? windowRows[windowRows.length - 1].rowId : null,
    rowCount: windowRows.length,
    inFlight: STATS.inFlight,
    inFlightMax: STATS.inFlightMax,
    firstVisibleTurnId: STATS.restore ? STATS.restore.firstVisibleTurnId : STATS.firstVisibleTurnId,
    restore: STATS.restore,
  };
}

function readTimelineGeometry() {
  const element = timelineElement();
  if (!element) return readTimelineSignals();
  const staging = element.querySelector(STAGING_SELECTOR);
  return {
    ...readTimelineSignals(),
    scrollTop: rawGet(element, "scrollTop"),
    clientHeight: rawGet(element, "clientHeight"),
    scrollHeight: rawGet(element, "scrollHeight"),
    firstVisibleTurnId: computeFirstVisibleTurn(element),
    firstPaintStaging: staging !== null,
  };
}

function TimelineHost() {
  const [ready, setReady] = useState(false);
  const [activeIndex, setActiveIndex] = useState(SESSION_IDS.length - 1);
  const [phase, setPhase] = useState(phaseValue);
  const state = useStoreState(STORES[activeIndex]);
  activeIndexValue = activeIndex;
  phaseValue = phase;
  applyPhase = setPhase;

  useEffect(function () {
    let cancelled = false;
    (async function () {
      await Promise.all(STORES.map(function (store) { return store.connect(); }));
      if (cancelled) return;
      for (let index = 0; index < MODELS.length; index += 1) {
        deliverSnapshot(MODELS[index], STORES[index]);
      }
      setReady(true);
    })();
    return function () { cancelled = true; };
  }, []);

  // 只更新缓存，不参与产品逻辑：scroll 指标走探针 raw getter，避免夹具读数进入计数。
  useEffect(function () {
    let frames = 0;
    let target = null;
    const syncMetrics = function () {
      if (!target) return;
      STATS.scrollTop = rawGet(target, "scrollTop");
      STATS.clientHeight = rawGet(target, "clientHeight");
      STATS.scrollHeight = rawGet(target, "scrollHeight");
      // 只在滚动事件里算首可见轮：signals() 在窗口内按帧轮询，不能读几何。
      STATS.firstVisibleTurnId = computeFirstVisibleTurn(target);
    };
    const onScroll = function () { syncMetrics(); };
    const attach = function () {
      const element = timelineElement();
      if (!element) {
        if (frames < 240) { frames += 1; requestAnimationFrame(attach); }
        return;
      }
      if (element === target) return;
      if (target) target.removeEventListener("scroll", onScroll);
      target = element;
      STATS.scrollTarget = element;
      element.addEventListener("scroll", onScroll, { passive: true });
      syncMetrics();
      const observer = new MutationObserver(function () { sampleStagingState(); });
      observer.observe(element, { childList: true, subtree: true });
      STATS.observer = observer;
      sampleStagingState();
    };
    attach();
    return function () {
      if (target) target.removeEventListener("scroll", onScroll);
      if (STATS.observer) { STATS.observer.disconnect(); STATS.observer = null; }
    };
  });

  const snapshot = state.snapshot;
  const rows = snapshot ? snapshot.rows.window : [];
  const totalCount = snapshot ? snapshot.rows.totalCount : 0;
  const sessionId = SESSION_IDS[activeIndex];
  const rowContext = useMemo(function () {
    return {
      logEpoch: "cost-epoch",
      workspacePath: "/workspace/cost",
      workspaceIdentity: "cost-workspace",
      theme: "zai-light",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId: sessionId,
      knownSessionIds: knownSessionIds,
    };
  }, [sessionId]);

  const handleLoadOlder = useCallback(function () { return STORES[activeIndex].loadOlder(); }, [activeIndex]);
  const handleCommit = useCallback(function () {
    const staging = document.querySelector(STAGING_SELECTOR) !== null;
    const result = STORES[activeIndex].commitPendingOlder();
    if (staging) {
      // 首绘补齐的落点是 runFirstPaintMount，不算前插；单独计数避免污染成功率。
      STATS.firstPaintCommitAttempts += 1;
      if (result.committed) STATS.firstPaintCommits += 1;
      return result;
    }
    STATS.attemptedPrependCommits += 1;
    if (result.committed) STATS.successfulPrependCommits += 1;
    else if (result.retry) STATS.commitRetries += 1;
    return result;
  }, [activeIndex]);

  return (
    <div
      data-cost-root="timeline"
      data-cost-host
      data-cost-ready={ready ? "1" : "0"}
      data-cost-staging={state.pendingOlder !== null ? "1" : "0"}
      data-cost-active-index={activeIndex}
      data-cost-active-session={sessionId}
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
    >
      <div style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: 0 }}>
        <ConversationTimeline
          // 真实产品里每个会话是独立的 SessionPane：切走即卸载，切回重新挂载，
          // 滚动记忆恢复走的是 mount 路径。共享实例只换 props 无法覆盖这条路径。
          key={sessionId}
          rows={rows}
          totalCount={totalCount}
          sessionKey={sessionId}
          scrollMemoryKey={"cost-memory/" + sessionId}
          rowContext={rowContext}
          sessionPhase={phase}
          canLoadOlder={snapshot ? hasOlderRows(snapshot) : false}
          loadingOlder={state.loadingOlder}
          hasMoreOlder={snapshot ? (state.pendingOlder ? state.pendingOlder.hasMoreOlder : hasOlderRows(snapshot)) : false}
          fetchingOlder={state.fetchingOlder}
          onLoadOlder={handleLoadOlder}
          onCommitPendingOlder={handleCommit}
          hasPendingOlder={state.pendingOlder !== null}
          olderFillInterruptedSeq={state.olderFillInterruptedSeq}
          olderFillInterruptKind={state.olderFillInterruptKind}
          pendingOlderRows={state.pendingOlder ? state.pendingOlder.rows : undefined}
          olderFillPageCount={state.olderFillPageCount}
          windowEpoch={state.windowEpoch}
        />
      </div>
      <div style={{ position: "fixed", left: 8, bottom: 8, zIndex: 100, display: "flex", gap: 4 }}>
        {SESSION_IDS.map(function (id, index) {
          return <button key={id} data-testid={"cost-session-" + (index + 1)} onClick={function () { setActiveIndex(index); }}>{"S" + (index + 1)}</button>;
        })}
      </div>
    </div>
  );
}

globalThis.__costTimeline = {
  mount: function () {
    if (mountedRoot) return;
    mountedRoot = createRoot(document.getElementById("root"));
    mountedRoot.render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <TooltipProvider>
          <ServiceProvider services={SERVICES}>
            <PlatformProvider platform={PLATFORM}>
              <TimelineHost />
            </PlatformProvider>
          </ServiceProvider>
        </TooltipProvider>
      </ZCodeIntlProvider>,
    );
  },
  switchTo: function (index) {
    const left = activeIndexValue;
    if (index === left) return;
    STATS.restore = null;
    STATS.firstVisibleTurnId = null;
    const returning = STATS.leftFromIndex === index;
    STATS.leftFromIndex = left;
    const button = document.querySelector('[data-testid="cost-session-' + (index + 1) + '"]');
    if (button) button.click();
    if (returning) watchRestoreReturn();
  },
  pushActive: function (count) { pushUpdates(activeIndexValue, count); },
  /**
   * 真实 SessionPhase 切换，只改 fixture 传给 ConversationTimeline 的 props。
   * restore 用例：先 setPhase("completedSuccess")，再真实滚轮读历史，然后切走切回。
   */
  setPhase: function (next) {
    if (!SESSION_PHASES.includes(next)) {
      throw new Error("未知 SessionPhase: " + String(next));
    }
    phaseValue = next;
    if (applyPhase) applyPhase(next);
  },
  scrollRatio: function (ratio) {
    const element = timelineElement();
    if (element) {
      rawSet(element, "scrollTop", Math.round((rawGet(element, "scrollHeight") - rawGet(element, "clientHeight")) * ratio));
    }
  },
  scrollTop: function () {
    const element = timelineElement();
    if (element) rawSet(element, "scrollTop", 0);
  },
  read: readTimelineGeometry,
  signals: readTimelineSignals,
  fill: function () {
    const state = STORES[activeIndexValue].getState();
    const rows = state.snapshot ? state.snapshot.rows.window : [];
    const element = timelineElement();
    const staging = element ? element.querySelector(STAGING_SELECTOR) : null;
    const stagedNodes = [];
    if (staging) stagedNodes.push(staging);
    if (element) {
      for (const node of element.querySelectorAll(STAGED_PREPEND_SELECTOR)) stagedNodes.push(node);
    }
    // 暗处暂存必须真的「量得到、看不见」：visibility:hidden + absolute 定位。
    let stagedHidden = true;
    for (const node of stagedNodes) {
      const style = getComputedStyle(node);
      if (style.visibility !== "hidden" || style.position !== "absolute") {
        stagedHidden = false;
        break;
      }
    }
    return {
      phase: phaseValue,
      pagesFetched: STATS.pagesFetched,
      rowsRangeCalls: STATS.rowsRangeCalls,
      stagingFetchCount: STATS.stagingFetchCount,
      inFlight: STATS.inFlight,
      inFlightMax: STATS.inFlightMax,
      firstPaintCommitAttempts: STATS.firstPaintCommitAttempts,
      firstPaintCommits: STATS.firstPaintCommits,
      attemptedPrependCommits: STATS.attemptedPrependCommits,
      successfulPrependCommits: STATS.successfulPrependCommits,
      commitRetries: STATS.commitRetries,
      olderFillPageCount: state.olderFillPageCount,
      // 首绘发布次数、隐藏 staging 的可见性、以及前插后的真实窗口读数。
      stagingPublishCount: STATS.stagingPublishCount,
      hiddenLayoutCount: STATS.hiddenLayoutCount,
      stagingPresent: staging !== null,
      stagedCount: stagedNodes.length,
      stagedHidden: stagedHidden,
      minRowId: rows.length > 0 ? rows[0].rowId : null,
      rowCount: rows.length,
    };
  },
  turnCounts: readTurnCounts,
};

globalThis.__costFixture = {
  version: 2,
  deferredMount: true,
  capabilities: [
    "deferred-mount",
    "timeline.signals",
    "timeline.first-paint",
    "timeline.prepend",
    "timeline.restore",
    "timeline.phase",
    "timeline.inflight",
  ],
  surfaces: ["timeline"],
};
`;

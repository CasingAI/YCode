/** fixture 页面源码第 3 段：React 挂载、shell/Files/Radix 与滚动观测入口。 */
export const conversationUpdateCostFixtureUiSource = String.raw`
// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------
function useStoreState(store) {
  const subscribe = useCallback((listener) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const PLATFORM = {
  onSettingsChanged: () => () => {},
  syncAppSettings: () => {},
};
const SERVICES = {
  broadcastService: { send: async () => ({}) },
  settingService: { get: async () => ({}), update: async () => ({}) },
  zcodeAgentService: { syncAppRuntimePreferences: async () => ({}) },
  fileService: { readMediaPreview: async () => ({ dataBase64: "", mimeType: "image/png" }) },
};

function FilesSurface({ isActiveView }) {
  const surfaceRef = useRef(null);
  const layoutRoot = useMemo(() => ({ kind: "group", id: "cost-files" }), []);
  useFilesWorkbenchTabChrome({ surfaceRef, layoutRoot, isDesktop: true, isActiveView });
  const className = resolveWorkspaceShellFilesSurfaceClassName({ isFilesPrimaryView: isActiveView });
  return (
    <div ref={surfaceRef} data-cost-layer="files" className={className} style={{ backgroundColor: "#ffffff" }}>
      <div
        data-files-workbench-window-controls
        style={{ position: "absolute", right: 0, top: 0, width: 96, height: 36 }}
      />
      <div
        role="tablist"
        data-cost-tablist="wide"
        style={{ position: "absolute", left: 0, top: 0, width: "100%", height: 36 }}
      >
        编辑器
      </div>
      <div
        role="tablist"
        data-cost-tablist="narrow"
        style={{ position: "absolute", left: 0, top: 0, width: 88, height: 36 }}
      >
        窄
      </div>
    </div>
  );
}

function RadixPanel() {
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("a");
  useEffect(() => {
    globalThis.__costRerenderRadix = (count) => {
      for (let index = 0; index < count; index += 1) {
        flushSync(() => setTick((current) => current + 1));
      }
    };
  }, []);
  return (
    <div
      data-cost-radix
      style={{ position: "fixed", right: 8, top: 8, zIndex: 90, background: "#fff", padding: 4 }}
    >
      <Select open={open} onOpenChange={setOpen} value={value} onValueChange={setValue}>
        <SelectTrigger data-cost-radix-trigger style={{ width: 120 }}>
          <SelectValue placeholder="选择" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">选项 A {tick}</SelectItem>
          <SelectItem value="b">选项 B</SelectItem>
          <SelectItem value="c">选项 C</SelectItem>
        </SelectContent>
      </Select>
      <ScrollArea style={{ height: 96, width: 180 }}>
        <div style={{ height: 400 }}>滚动内容 {tick}</div>
      </ScrollArea>
    </div>
  );
}

function Fixture() {
  const [ready, setReady] = useState(false);
  const [activeIndex, setActiveIndex] = useState(SESSION_IDS.length - 1);
  const [view, setView] = useState("tasks");

  const stateA = useStoreState(STORES[0]);
  const stateB = useStoreState(STORES[1]);
  const stateC = useStoreState(STORES[2]);
  const stateD = useStoreState(STORES[3]);
  const states = [stateA, stateB, stateC, stateD];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.all(STORES.map((store) => store.connect()));
      if (cancelled) return;
      for (let index = 0; index < MODELS.length; index += 1) {
        deliverSnapshot(MODELS[index], STORES[index]);
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [guideVersion, setGuideVersion] = useState(0);
  const [extraMember, setExtraMember] = useState(false);

  const activeSnapshot = states[activeIndex] ? states[activeIndex].snapshot : null;
  const rows = activeSnapshot ? activeSnapshot.rows.window : EMPTY_ROWS;
  const totalCount = activeSnapshot ? activeSnapshot.rows.totalCount : 0;
  const sessionId = SESSION_IDS[activeIndex];

  useEffect(() => {
    globalThis.__costSwapGuideItem = () => setGuideVersion((value) => value + 1);
    globalThis.__costToggleMember = () => setExtraMember((value) => !value);
  }, []);

  // 受控输入：每次 render 都换新数组/缓存对象，但成员与既有引用保持不变。
  // 与真实 metadata 更新一致，是否复用引用只由被验证的派生入口决定。
  const memberIds = extraMember ? SESSION_IDS.concat(["sess-cost-extra"]) : SESSION_IDS;
  const sessionIndexItems = memberIds.map((id, index) => ({
    taskId: id,
    title: "会话 " + id + " " + index,
  }));
  const taskMetaByEntityKey = {};
  for (let index = 0; index < memberIds.length; index += 1) {
    taskMetaByEntityKey["entity-" + memberIds[index]] = {
      taskId: memberIds[index],
      updatedAt: index,
    };
  }
  const archivedItems = memberIds.map((id) => ({ taskId: id }));
  const knownSessionIdSources = {
    sessionScopeReady: true,
    sessionIndexScopeCount: 1,
    hydratingEndpointCount: 1,
    archivedLoading: false,
    sessionIndexItems,
    taskMetaByEntityKey,
    archivedItems,
    sessionId,
  };

  // 受控 queue：wrapper 每次 render 新建；guide/普通 item 默认保持引用，
  // 页面 API 切换 guideVersion 时才替换 guide item。
  const guideItem = useMemo(
    () => ({
      queueItemId: "cost-guide-1",
      text: "第 " + guideVersion + " 版待引导内容",
      sourceCommandId: "cost-command-1",
      clientId: "cost-client-1",
      attachments: [],
      admittedAt: 1_700_000_000_000,
      order: { admissionSeq: 1 },
      dispatch: { state: "queued" },
      delivery: { admitted: "guide" },
    }),
    [guideVersion],
  );
  const regularItem = useMemo(
    () => ({
      queueItemId: "cost-queued-1",
      text: "普通排队输入",
      sourceCommandId: "cost-command-2",
      clientId: "cost-client-2",
      attachments: [],
      admittedAt: 1_700_000_000_001,
      order: { admissionSeq: 2 },
      dispatch: { state: "queued" },
      delivery: { admitted: "queue" },
    }),
    [],
  );
  const queue = { items: [guideItem, regularItem], autoDrain: guideVersion % 2 === 0 };
  // __COST_DERIVED_HOOKS__
  const pendingGuides = projection.pendingGuides;

  const derivedStatsRef = useRef(null);
  if (derivedStatsRef.current === null) {
    derivedStatsRef.current = {
      renders: 0,
      knownIdsUnstable: 0,
      pendingGuidesUnstable: 0,
      guideItemChanges: 0,
      knownIdsSize: 0,
      visibleQueueIsCurrent: false,
    };
    globalThis.__costDerivedStats = derivedStatsRef.current;
    globalThis.__costResetDerivedStats = () => {
      const stats = derivedStatsRef.current;
      stats.renders = 0;
      stats.knownIdsUnstable = 0;
      stats.pendingGuidesUnstable = 0;
      stats.guideItemChanges = 0;
    };
  }
  const previousDerived = useRef({ knownSessionIds: null, pendingGuides: null, guideItem: null });
  const previous = previousDerived.current;
  const firstGuide = pendingGuides.length > 0 ? pendingGuides[0] : null;
  if (previous.knownSessionIds !== null) {
    const stats = derivedStatsRef.current;
    stats.renders += 1;
    if (previous.knownSessionIds !== knownSessionIds) stats.knownIdsUnstable += 1;
    if (previous.pendingGuides !== pendingGuides) stats.pendingGuidesUnstable += 1;
    if (previous.guideItem !== null && previous.guideItem !== firstGuide) stats.guideItemChanges += 1;
  }
  const stats = derivedStatsRef.current;
  stats.knownIdsSize = knownSessionIds ? knownSessionIds.size : -1;
  stats.visibleQueueIsCurrent =
    projection.visibleQueue.items.length === 1 &&
    projection.visibleQueue.items[0] === regularItem &&
    projection.visibleQueue.autoDrain === queue.autoDrain;
  previousDerived.current = {
    knownSessionIds,
    pendingGuides,
    guideItem: firstGuide,
  };

  const rowContext = useMemo(
    () => ({
      logEpoch: "cost-epoch",
      workspacePath: "/workspace/cost",
      workspaceIdentity: "cost-workspace",
      theme: "zai-light",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId,
      knownSessionIds,
    }),
    [sessionId, knownSessionIds],
  );

  useEffect(() => {
    installTimelineScrollProbe();
    const timer = setTimeout(installTimelineScrollProbe, 50);
    return () => clearTimeout(timer);
  }, [ready]);

  const filesActive = view === "files";
  const tasksClass = resolveWorkspaceShellTasksKeepaliveClassName({
    isSettingsPrimaryView: false,
    isFilesPrimaryView: filesActive,
  });

  // reactCommitMs 是 flushSync 包围的同步 React 更新耗时（render + DOM commit +
  // 随后的 layout），不是 Profiler 的纯 commit 时长；字段名保留兼容。
  function selectSession(index) {
    const startedAt = performance.now();
    flushSync(() => setActiveIndex(index));
    globalThis.__costSync.push({
      step: "session-" + (index + 1),
      reactCommitMs: performance.now() - startedAt,
    });
  }
  function selectView(nextView) {
    const startedAt = performance.now();
    flushSync(() => setView(nextView));
    globalThis.__costSync.push({
      step: nextView,
      reactCommitMs: performance.now() - startedAt,
    });
  }

  return (
    <div
      data-cost-host
      data-cost-ready={ready ? "1" : "0"}
      data-cost-active-index={activeIndex}
      data-cost-active-session={sessionId}
      data-cost-view={view}
      data-workspace-shell
      style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}
    >
      <div
        data-workspace-caption-actions
        style={{ position: "absolute", left: 0, top: 0, width: 120, height: 36 }}
      />
      <div
        data-cost-layer="tasks"
        className={tasksClass}
        style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: 0 }}
      >
        <div style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: 0, height: "100%" }}>
          <ConversationTimeline
            rows={rows}
            totalCount={totalCount}
            sessionKey={sessionId}
            scrollMemoryKey={"cost-memory/" + sessionId}
            rowContext={rowContext}
            pendingGuides={pendingGuides}
            sessionPhase="running"
          />
        </div>
      </div>
      <FilesSurface isActiveView={filesActive} />
      <RadixPanel />
      <div style={{ position: "fixed", left: 8, bottom: 8, zIndex: 100, display: "flex", gap: 4 }}>
        {SESSION_IDS.map((id, index) => (
          <button key={id} data-testid={"cost-session-" + (index + 1)} onClick={() => selectSession(index)}>
            {"S" + (index + 1)}
          </button>
        ))}
        <button data-testid="cost-files" onClick={() => selectView("files")}>Files</button>
        <button data-testid="cost-tasks" onClick={() => selectView("tasks")}>Tasks</button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <ServiceProvider services={SERVICES}>
        <PlatformProvider platform={PLATFORM}>
          <Fixture />
        </PlatformProvider>
      </ServiceProvider>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
`;

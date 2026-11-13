/** 会话更新成本对照 fixture 的源码装配入口。 */
import { conversationUpdateCostFixtureModelSource } from "./conversationUpdateCostFixtureModel.js";
import { conversationUpdateCostFixtureApiSource } from "./conversationUpdateCostFixtureApi.js";
import { conversationUpdateCostFixtureUiSource } from "./conversationUpdateCostFixtureUi.js";

/** baseline = 修复前 SessionPane/pending 投影；current = 当前检出的真实生产入口。 */
export type ConversationUpdateCostDerivedMode = "baseline" | "current";

const DERIVED_IMPORTS: Record<ConversationUpdateCostDerivedMode, string> = {
  baseline:
    'import { useBaselineKnownSessionIds, useBaselinePendingGuideProjection } from "@/v4/sessionPaneDerivedBaseline.js";',
  current:
    'import { buildKnownSessionIdSet, useStableKnownSessionIdSet, useStablePendingGuideProjection } from "@/v4/sessionPaneDerivedInputs.js";',
};

const DERIVED_HOOKS: Record<ConversationUpdateCostDerivedMode, string> = {
  baseline: `  const knownSessionIds = useBaselineKnownSessionIds(knownSessionIdSources);
  const projection = useBaselinePendingGuideProjection(queue);`,
  current: `  const derivedInputScope = {
    workspaceIdentity: "cost-workspace",
    workspacePath: "/workspace/cost",
    remoteSessionId: null,
    sessionId,
  };
  const knownSessionIdSet = useMemo(
    () => buildKnownSessionIdSet(knownSessionIdSources),
    [knownSessionIdSources],
  );
  const knownSessionIds = useStableKnownSessionIdSet(derivedInputScope, knownSessionIdSet);
  const projection = useStablePendingGuideProjection(derivedInputScope, queue);`,
};

export function createConversationUpdateCostFixtureSource(
  derived: ConversationUpdateCostDerivedMode,
): string {
  return [
    conversationUpdateCostFixtureModelSource,
    conversationUpdateCostFixtureApiSource,
    conversationUpdateCostFixtureUiSource,
  ]
    .join("")
    .replace("// __COST_DERIVED_IMPORTS__", DERIVED_IMPORTS[derived])
    .replace("// __COST_DERIVED_HOOKS__", DERIVED_HOOKS[derived]);
}

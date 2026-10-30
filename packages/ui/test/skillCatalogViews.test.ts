import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  deriveSessionSkillCatalogViews,
  isSessionSkillCatalogEnabled,
} from "../src/lib/skillCatalogViews.js";

// skill-title.md 的就绪语义：只有当前 scope 的 authoritative 目录才产生查找表；
// pending/错误/只读视图返回 undefined，空目录也只有 ready=true 时才是 authoritative。

const TEAM_SKILL = {
  id: "glm:plugin:team:skill-hash",
  name: "team",
  description: "Team-mode dispatch handbook.",
  path: "C:/zcode-plugins-official/team/1.0.0/skills/team/SKILL.md",
  scope: "plugin" as const,
  pluginName: "team",
};

test("冷首帧/加载中不产生查找表，也不借用旧技能", () => {
  const views = deriveSessionSkillCatalogViews({
    enabled: true,
    ready: false,
    skills: [TEAM_SKILL],
    locale: "zh-CN",
  });
  assert.equal(views.skillDisplayNameByRef, undefined);
  assert.equal(views.knownSkillNames, undefined);
});

test("请求失败、只读视图或不可用同样返回 undefined，不伪装成空目录", () => {
  const failure = deriveSessionSkillCatalogViews({
    enabled: true,
    ready: false,
    skills: [],
    locale: "zh-CN",
  });
  assert.equal(failure.skillDisplayNameByRef, undefined);
  assert.equal(failure.knownSkillNames, undefined);

  const readOnly = deriveSessionSkillCatalogViews({
    enabled: false,
    ready: true,
    skills: [TEAM_SKILL],
    locale: "zh-CN",
  });
  assert.equal(readOnly.skillDisplayNameByRef, undefined);
  assert.equal(readOnly.knownSkillNames, undefined);
});

test("authoritative 空目录是确定的两张空表（未命中回退 raw 的依据）", () => {
  const views = deriveSessionSkillCatalogViews({
    enabled: true,
    ready: true,
    skills: [],
    locale: "zh-CN",
  });
  assert.equal(views.skillDisplayNameByRef?.size, 0);
  assert.equal(views.knownSkillNames?.size, 0);
});

test("authoritative 目录同时派生白名单与友好名查找表", () => {
  const views = deriveSessionSkillCatalogViews({
    enabled: true,
    ready: true,
    skills: [TEAM_SKILL],
    locale: "zh-CN",
  });
  assert.equal(views.knownSkillNames?.has("team"), true);
  assert.equal(views.skillDisplayNameByRef?.get("team:team"), "Team 派工手册");
});

test("会话目录只在 live 且 lease 属于当前 session 时启用", () => {
  const base = {
    sessionScopeReady: true,
    sessionId: "sess-A",
    conversationStatus: "live" as const,
    leaseSessionId: "sess-A",
  };
  assert.equal(isSessionSkillCatalogEnabled(base), true);
  // subscribe 尚未 ACK：cold restore 未完成，直接 requireSession 会失败。
  assert.equal(isSessionSkillCatalogEnabled({ ...base, conversationStatus: "connecting" }), false);
  assert.equal(isSessionSkillCatalogEnabled({ ...base, conversationStatus: "error" }), false);
  assert.equal(isSessionSkillCatalogEnabled({ ...base, conversationStatus: "closed" }), false);
  // 切会话后的过渡帧：旧 lease 仍 live，但 lease/session 已不一致。
  assert.equal(isSessionSkillCatalogEnabled({ ...base, leaseSessionId: "sess-OLD" }), false);
  assert.equal(
    isSessionSkillCatalogEnabled({ ...base, sessionId: "sess-NEW", leaseSessionId: "sess-OLD" }),
    false,
  );
  // 只读视图、无 session 或 workspace 不完整时不启用。
  assert.equal(isSessionSkillCatalogEnabled({ ...base, sessionScopeReady: false }), false);
  assert.equal(
    isSessionSkillCatalogEnabled({ ...base, sessionId: null, leaseSessionId: null }),
    false,
  );
});

// 以下仅校验结构约束（源码里只有一个合并 hook 调用、子卡收到查找表）。
// pending→ready、scope 切换与请求次数由 skillCatalogBrowser.test.ts 的真实渲染覆盖。
test("结构约束：SessionPane 只用合并 hook，子工具卡代码透传查找表（非生命周期验证）", () => {
  const sessionPane = readFileSync(
    fileURLToPath(new URL("../src/v4/SessionPane.tsx", import.meta.url)),
    "utf8",
  );
  assert.equal(sessionPane.match(/useSessionSkillCatalogViews\(/g)?.length, 1);
  assert.equal(sessionPane.includes("useSkillNameWhitelist("), false);
  assert.equal(sessionPane.includes("useSkillDisplayNameCatalog("), false);
  // live + 同 session/lease 的启用判断由纯函数拥有；这里只确认 pane 走同一判定。
  assert.equal(sessionPane.includes("isSessionSkillCatalogEnabled("), true);

  const toolBlocks = readFileSync(
    fileURLToPath(new URL("../src/ToolCallBlocks.tsx", import.meta.url)),
    "utf8",
  );
  const childStart = toolBlocks.indexOf("childToolCalls.map");
  assert.notEqual(childStart, -1);
  const childBlock = toolBlocks.slice(childStart, toolBlocks.indexOf("</div>", childStart));
  // 嵌套子工具卡必须收到同一张查找表，否则子代理里的 Skill 卡会回到未就绪占位。
  assert.equal(childBlock.includes("skillDisplayNameByRef={skillDisplayNameByRef}"), true);
});

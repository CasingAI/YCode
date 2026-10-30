import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProtocolMethods, type ZCodeSkillsReferenceCatalogResult } from "@zcode/shared";
import {
  buildSkillReferenceCatalogParams,
  requestSkillReferenceCatalog,
} from "../src/zcode-agent/skillReferenceCatalogRequest.js";

// docs/specs/skill-reference-catalog-title.md：title 是 capability 协商后的 opt-in。
// 旧 Agent 不认识 includeTitle；客户端只能在探测到 skillReferenceCatalogTitle 后发送。

const workspace = { workspacePath: "/ws", workspaceKey: "local:/ws" };

type CatalogCall = { method: string; params: unknown };

function createFakeClient(capabilities: unknown | (() => never)) {
  const calls: CatalogCall[] = [];
  const client = {
    async request(method: string, params: unknown) {
      calls.push({ method, params });
      if (method === zcodeProtocolMethods.runtimeCapabilities) {
        if (typeof capabilities === "function") capabilities();
        return capabilities;
      }
      return { authority: "workspace", skills: [] } satisfies ZCodeSkillsReferenceCatalogResult;
    },
  };
  return { calls, client };
}

function catalogCall(calls: CatalogCall[]): CatalogCall | undefined {
  return calls.find((call) => call.method === zcodeProtocolMethods.skillsReferenceCatalog);
}

test("capability 为 false 时不发送 includeTitle", async () => {
  const { calls, client } = createFakeClient({ skillReferenceCatalogTitle: false });
  const result = await requestSkillReferenceCatalog(client as never, workspace, undefined);

  assert.deepEqual(result, { authority: "workspace", skills: [] });
  assert.deepEqual(catalogCall(calls)?.params, { workspace });
});

test("capability 探测失败时按不支持处理并保持旧参数", async () => {
  const { calls, client } = createFakeClient(() => {
    throw new Error("method not found");
  });
  const result = await requestSkillReferenceCatalog(client as never, workspace, "session-1");

  assert.deepEqual(result, { authority: "workspace", skills: [] });
  assert.deepEqual(catalogCall(calls)?.params, { workspace, sessionId: "session-1" });
});

test("capability 为 true 时才发送 includeTitle", async () => {
  const { calls, client } = createFakeClient({ skillReferenceCatalogTitle: true });
  await requestSkillReferenceCatalog(client as never, workspace, undefined);

  assert.deepEqual(catalogCall(calls)?.params, { workspace, includeTitle: true });
});

test("纯参数构造保持既有字段并只按 capability 追加 opt-in", () => {
  assert.deepEqual(buildSkillReferenceCatalogParams(workspace, "s", undefined), {
    workspace,
    sessionId: "s",
  });
  assert.deepEqual(
    buildSkillReferenceCatalogParams(workspace, "s", { skillReferenceCatalogTitle: false }),
    { workspace, sessionId: "s" },
  );
  assert.deepEqual(
    buildSkillReferenceCatalogParams(workspace, undefined, { skillReferenceCatalogTitle: true }),
    { workspace, includeTitle: true },
  );
});

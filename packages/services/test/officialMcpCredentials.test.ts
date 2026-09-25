import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsView } from "@zcode/provider";
import type { ApiClient, ZCodeAccountAccess, ZCodeProviderAccountAccess } from "@zcode/shared";
import { resolveOfficialMcpCredentials } from "../src/official-mcp/officialMcpCredentials.js";
import { fetchMcpQuotaSnapshot } from "../src/usage-stats/providers/zcodeMcpQuotaProvider.js";

const BIGMODEL_PLAN_PROVIDER_ID = "account:bigmodel-individual-coding-plan";
const ZAI_PLAN_PROVIDER_ID = "account:zai-individual-coding-plan";

function planAccess(
  accountType: "zai" | "bigmodel",
  mode: "individual-coding-plan" | "team-coding-plan" = "individual-coding-plan",
): ZCodeProviderAccountAccess {
  return { type: "zhipu-account", accountType, entitled: true, mode };
}

interface FakeProviderInput {
  readonly providerId: string;
  readonly access: ZCodeProviderAccountAccess;
  /** 用户开关：false 表示 Provider 已关闭，不再进入执行 Registry。 */
  readonly enabled: boolean;
  readonly executable: boolean;
  readonly entitled?: boolean;
  readonly current?: boolean;
}

function createSettingsView(providers: readonly FakeProviderInput[]): ProviderSettingsView {
  return {
    revision: 7,
    providerTemplates: [],
    providerOrder: [],
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.providerId,
      templateId: provider.providerId,
      enabled: provider.enabled,
      executable: provider.executable,
      effectiveConfig: { access: provider.access },
      issues: [],
      models: [],
      accountState: {
        availability: provider.entitled === false ? "unavailable" : "available",
        entitled: provider.entitled ?? true,
        ...(provider.current === undefined ? {} : { current: provider.current }),
      },
    })),
  } as unknown as ProviderSettingsView;
}

function createDeps(options: {
  readonly view: ProviderSettingsView;
  readonly activeProvider?: "zai" | "bigmodel";
  readonly access?: ZCodeAccountAccess | null;
}) {
  return {
    accountRequestAuthService: {
      resolveAccessCurrent: async (): Promise<ZCodeAccountAccess | null> =>
        options.access ?? {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "individual-coding-plan",
        },
    },
    credentialService: {
      load: async (key: string): Promise<string | null> => {
        if (key === "oauth:active_provider") return options.activeProvider ?? "bigmodel";
        if (key === "zcodejwttoken") return "zcode-jwt";
        if (key === "oauth:bigmodel:access_token" || key === "oauth:zai:access_token") {
          return "maas-jwt";
        }
        return null;
      },
    },
    providerSettingsService: {
      getView: async () => options.view,
    },
  };
}

test("关闭 Provider 后官方 MCP 仍解析出套餐归属", async () => {
  const outcome = await resolveOfficialMcpCredentials(
    createDeps({
      view: createSettingsView([
        {
          providerId: BIGMODEL_PLAN_PROVIDER_ID,
          access: planAccess("bigmodel"),
          enabled: false,
          executable: false,
          current: true,
        },
      ]),
    }),
  );

  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  // 用户开关只阻断模型执行：套餐身份、personal scope 与 MaaS 通道都保持可用。
  assert.deepEqual(outcome.snapshot.planScope, { targetType: "PERSONAL" });
  assert.deepEqual(outcome.snapshot.wireScope, { targetType: "PERSONAL" });
  assert.equal(outcome.snapshot.providerFamily, "bigmodel");
  assert.equal(outcome.snapshot.codingPlanAuthorization, "maas-jwt");
});

test("Provider 开关状态不改变官方 MCP 凭证快照", async () => {
  const enabled = await resolveOfficialMcpCredentials(
    createDeps({
      view: createSettingsView([
        {
          providerId: BIGMODEL_PLAN_PROVIDER_ID,
          access: planAccess("bigmodel"),
          enabled: true,
          executable: true,
          current: true,
        },
      ]),
    }),
  );
  const disabled = await resolveOfficialMcpCredentials(
    createDeps({
      view: createSettingsView([
        {
          providerId: BIGMODEL_PLAN_PROVIDER_ID,
          access: planAccess("bigmodel"),
          enabled: false,
          executable: false,
          current: true,
        },
      ]),
    }),
  );

  assert.ok(enabled.ok && disabled.ok);
  assert.deepEqual(enabled.snapshot, disabled.snapshot);
});

test("两个 family 同时 current 时按激活的 family 收口", async () => {
  const outcome = await resolveOfficialMcpCredentials(
    createDeps({
      activeProvider: "bigmodel",
      view: createSettingsView([
        {
          providerId: ZAI_PLAN_PROVIDER_ID,
          access: planAccess("zai"),
          enabled: true,
          executable: true,
          current: true,
        },
        {
          providerId: BIGMODEL_PLAN_PROVIDER_ID,
          access: planAccess("bigmodel"),
          enabled: false,
          executable: false,
          current: true,
        },
      ]),
    }),
  );

  assert.ok(outcome.ok);
  assert.equal(outcome.snapshot.providerFamily, "bigmodel");
  assert.deepEqual(outcome.snapshot.planScope, { targetType: "PERSONAL" });
});

test("非当前连接或无权益的 Provider 仍降级为 identity-only", async () => {
  const notCurrent = await resolveOfficialMcpCredentials(
    createDeps({
      view: createSettingsView([
        {
          providerId: BIGMODEL_PLAN_PROVIDER_ID,
          access: planAccess("bigmodel"),
          enabled: false,
          executable: false,
          current: false,
        },
      ]),
    }),
  );
  const notEntitled = await resolveOfficialMcpCredentials(
    createDeps({
      view: createSettingsView([
        {
          providerId: BIGMODEL_PLAN_PROVIDER_ID,
          access: planAccess("bigmodel"),
          enabled: false,
          executable: false,
          entitled: false,
          current: true,
        },
      ]),
    }),
  );

  assert.ok(notCurrent.ok && notEntitled.ok);
  assert.equal(notCurrent.snapshot.planScope, null);
  assert.equal(notCurrent.snapshot.codingPlanAuthorization, undefined);
  assert.equal(notEntitled.snapshot.planScope, null);
});

function createMcpUsageApiClient(): { apiClient: ApiClient; requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    apiClient: {
      request: async (input) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              server_time: 1_700_000_000,
              level: "plus",
              total_usage: { used: 20, limit: 100, remaining: 80 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  };
}

test("Provider 关闭时 MCP 额度仍按请求发出并返回总额度", async () => {
  const { apiClient, requests } = createMcpUsageApiClient();
  const snapshot = await fetchMcpQuotaSnapshot({
    apiClient,
    credentialSource: {
      resolve: () =>
        resolveOfficialMcpCredentials(
          createDeps({
            view: createSettingsView([
              {
                providerId: BIGMODEL_PLAN_PROVIDER_ID,
                access: planAccess("bigmodel"),
                enabled: false,
                executable: false,
                current: true,
              },
            ]),
          }),
        ),
    },
    env: {},
    requestScope: { providerFamily: "bigmodel", organizationId: null, projectId: null },
  });

  assert.equal(requests.length, 1);
  assert.ok(snapshot);
  assert.equal(snapshot.aggregate.remaining, 80);
  assert.deepEqual(snapshot.scope, { providerFamily: "bigmodel", targetType: "PERSONAL" });
});

test("归属 family 或 Team scope 不一致时 MCP 额度仍不发请求", async () => {
  const { apiClient, requests } = createMcpUsageApiClient();
  const credentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials(
        createDeps({
          view: createSettingsView([
            {
              providerId: BIGMODEL_PLAN_PROVIDER_ID,
              access: planAccess("bigmodel"),
              enabled: false,
              executable: false,
              current: true,
            },
          ]),
        }),
      ),
  };

  const otherFamily = await fetchMcpQuotaSnapshot({
    apiClient,
    credentialSource,
    env: {},
    requestScope: { providerFamily: "zai", organizationId: null, projectId: null },
  });
  const otherTeam = await fetchMcpQuotaSnapshot({
    apiClient,
    credentialSource,
    env: {},
    requestScope: {
      providerFamily: "bigmodel",
      organizationId: "org-1",
      projectId: "proj-1",
    },
  });

  assert.equal(otherFamily, null);
  assert.equal(otherTeam, null);
  assert.equal(requests.length, 0);
});

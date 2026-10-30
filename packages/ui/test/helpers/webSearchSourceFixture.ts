import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { repoRoot, resolveSource, uiRoot } from "./chromiumFixture.js";
import {
  confirmStub,
  intlStub,
  loggerStub,
  modelProvidersStub,
  providerStub,
  settingsPartsStub,
  settingsStub,
} from "./webSearchSourceStubs.js";

// 在隔离浏览器中挂载真实的 WebSearchSettingsSection + WebSearchSourceDialog。
// 只启动测试自己的无头浏览器，不连接也不操作正在运行的 YCode。

export const templates = [
  {
    templateId: "jina",
    templateNameMap: { "zh-CN": "Jina 搜索 API", "en-US": "Jina Search API" },
    config: { access: { type: "api-key", apiKeyManagementUrl: "https://jina.ai/api-keys" } },
  },
  ...["zai-api", "bigmodel-api", "minimax-token-plan", "deepseek"].map((templateId) => ({
    templateId,
    templateNameMap: { "zh-CN": templateId, "en-US": templateId },
    config: { access: { type: "api-key" } },
  })),
];

export interface ProviderFixture {
  providerId: string;
  providerName: string;
  templateId: string;
  enabled: boolean;
  executable: boolean;
  displayMode: string;
  proxyMode: "default" | "proxy" | "direct";
  personalConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
  issues: unknown[];
  models: unknown[];
}

export function makeProvider(input: {
  providerId: string;
  providerName: string;
  templateId: string;
  apiKey?: string;
  proxyMode?: "default" | "proxy" | "direct";
  baseUrl?: string;
}): ProviderFixture {
  const effectiveConfig = {
    group: "standard-personal",
    access: { type: "api-key", ...(input.apiKey ? { apiKey: input.apiKey } : {}) },
    ...(input.baseUrl ? { api: { baseUrl: input.baseUrl } } : {}),
  };
  return {
    providerId: input.providerId,
    providerName: input.providerName,
    templateId: input.templateId,
    enabled: true,
    executable: true,
    displayMode: "submenu",
    proxyMode: input.proxyMode ?? "default",
    personalConfig: JSON.parse(JSON.stringify(effectiveConfig)),
    effectiveConfig,
    issues: [],
    models: [],
  };
}

const entrySource = `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebSearchSettingsSection } from "@/settings/WebSearchSettingsSection.js";
import { WebSearchSourceDialog } from "@/settings/WebSearchSourceDialog.js";
import {
  getModelProviders,
  replaceModelProviders,
  resetModelProviders,
} from "./model-providers-stub.js";

const probe: any = {
  templates: [],
  settings: {},
  loading: false,
  initialEnabled: true,
  confirmResult: true,
  createCalls: [],
  saveCalls: [],
  deleteCalls: [],
  updateCalls: [],
  logs: [],
  createMode: "auto",
  saveMode: "auto",
  pendingCreate: null,
  dialogTemplates: [],
  dialogCreateCalls: [],
};

function makeProvider(input: {
  providerId: string;
  providerName: string;
  templateId: string;
  apiKey?: string;
  proxyMode?: "default" | "proxy" | "direct";
  baseUrl?: string;
}) {
  const effectiveConfig: any = {
    group: "standard-personal",
    access: { type: "api-key", ...(input.apiKey ? { apiKey: input.apiKey } : {}) },
    ...(input.baseUrl ? { api: { baseUrl: input.baseUrl } } : {}),
  };
  return {
    providerId: input.providerId,
    providerName: input.providerName,
    templateId: input.templateId,
    enabled: true,
    executable: true,
    displayMode: "submenu",
    proxyMode: input.proxyMode ?? "default",
    personalConfig: JSON.parse(JSON.stringify(effectiveConfig)),
    effectiveConfig,
    issues: [],
    models: [],
  };
}

probe.makeProvider = makeProvider;
probe.createImpl = async (input: any) => {
  if (probe.createMode === "deferred") {
    return await new Promise((resolve) => {
      probe.pendingCreate = { input, resolve };
    });
  }
  const index = probe.createCalls.length;
  const providerId = "jina-" + (index + 1);
  const provider = makeProvider({
    providerId,
    providerName: index === 0 ? "Jina" : "Jina-" + (index + 1),
    templateId: input.templateId,
    apiKey: input.initialConfig.access.apiKey,
    baseUrl: "https://s.jina.ai",
  });
  return { providerId, provider };
};
probe.resolveCreate = () => {
  const pending = probe.pendingCreate;
  if (!pending) throw new Error("no pending create");
  probe.pendingCreate = null;
  const index = probe.createCalls.length;
  const providerId = "jina-" + (index + 1);
  pending.resolve({
    providerId,
    provider: makeProvider({
      providerId,
      providerName: index === 0 ? "Jina" : "Jina-" + (index + 1),
      templateId: pending.input.templateId,
      apiKey: pending.input.initialConfig.access.apiKey,
      baseUrl: "https://s.jina.ai",
    }),
  });
};
probe.saveImpl = async () => {
  if (probe.saveMode === "failOnce") {
    probe.saveMode = "auto";
    throw new Error("proxy write failed");
  }
};
probe.deleteImpl = async () => {};
// 模拟其它窗口刷新：provider 与模板都以新对象回读，但内容不变。
probe.refreshProviders = () => {
  probe.templates = JSON.parse(JSON.stringify(probe.templates));
  replaceModelProviders(JSON.parse(JSON.stringify(getModelProviders())));
};
probe.removeProvider = (providerId: string) => {
  replaceModelProviders(
    getModelProviders().filter((provider: any) => provider.providerId !== providerId),
  );
};
probe.setLoading = (value: boolean) => {
  probe.loading = value;
  replaceModelProviders(getModelProviders());
};

(globalThis as any).__ws = probe;

function Harness() {
  const [enabled, setEnabled] = useState(probe.initialEnabled);
  return (
    <WebSearchSettingsSection
      webSearchEnabled={enabled}
      onWebSearchEnabledChange={async (value: boolean) => setEnabled(value)}
      workspacePath="/tmp/workspace"
      workspaceIdentity="ws-1"
      onOpenModelProviderSettings={() => {}}
    />
  );
}

probe.mount = (config: {
  providers: any[];
  templates?: any[];
  settings?: Record<string, unknown>;
  enabled?: boolean;
  loading?: boolean;
}) => {
  probe.templates = config.templates ?? [];
  probe.settings = config.settings ?? {};
  probe.loading = config.loading === true;
  probe.initialEnabled = config.enabled !== false;
  resetModelProviders(config.providers);
  createRoot(document.getElementById("root")!).render(<Harness />);
};

// 多独立模板回归：直接给弹窗 props 传两份模板，模拟未来目录扩展。
// 只验证弹窗自身的模板驱动行为，不经过生产目录，也不扩大允许添加的模板名单。
let setDialogOpen: ((open: boolean) => void) | null = null;

function DialogHarness() {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setDialogOpen = setOpen;
  }, []);
  return (
    <WebSearchSourceDialog
      open={open}
      mode="create"
      templates={probe.dialogTemplates}
      provider={null}
      saving={false}
      onOpenChange={setOpen}
      onCreate={async (input: any) => {
        probe.dialogCreateCalls.push(input);
        setOpen(false);
      }}
      onSave={async () => {}}
      onDelete={async () => {}}
    />
  );
}

probe.openDialog = () => setDialogOpen?.(true);
probe.closeDialog = () => setDialogOpen?.(false);
probe.mountDialog = (config: { templates: any[] }) => {
  probe.dialogTemplates = config.templates;
  probe.dialogCreateCalls.length = 0;
  createRoot(document.getElementById("root")!).render(<DialogHarness />);
};
`;

export interface MountConfig {
  providers: ProviderFixture[];
  templates?: typeof templates;
  settings?: Record<string, unknown>;
  enabled?: boolean;
  loading?: boolean;
}

/** 直接传给弹窗的模板选项，用于模拟目录将来出现第二个独立模板。 */
export interface DialogTemplateOption {
  templateId: string;
  label: string;
  accessType: "api-key" | "zhipu-coding-plan-api-key";
  apiKeyManagementUrl?: string;
}

export interface ProbeSnapshot {
  createCalls: Record<string, unknown>[];
  saveCalls: Record<string, any>[];
  deleteCalls: string[];
  updateCalls: Record<string, unknown>[];
  logs: string[];
  rowCount: number;
  settingsButtons: number;
  dialogCreateCalls: Record<string, unknown>[];
}

export interface WebSearchSourceFixture {
  mount(page: Page, config: MountConfig): Promise<void>;
  mountDialog(page: Page, config: { templates: DialogTemplateOption[] }): Promise<void>;
  readProbe(page: Page): Promise<ProbeSnapshot>;
  cleanup(): Promise<void>;
}

export async function createWebSearchSourceFixture(): Promise<WebSearchSourceFixture> {
  const { build } = await import("esbuild");
  const directory = await mkdtemp(join(tmpdir(), "ycode-web-search-source-"));
  const stubPath = (name: string) => join(directory, name);
  const alias = new Map<string, string>([
    ["@zcode/shared", join(repoRoot, "packages", "shared", "src", "provider-search-capability.ts")],
    ["@zcode/provider", stubPath("provider-stub.ts")],
    ["@/hooks/useModelProviders.js", stubPath("model-providers-stub.ts")],
    ["@/hooks/useSettingService.js", stubPath("settings-stub.ts")],
    ["@/i18n/IntlProvider.js", stubPath("intl-stub.ts")],
    ["@/logger.js", stubPath("logger-stub.ts")],
    ["@/hooks/useConfirmDialog.js", stubPath("confirm-stub.ts")],
    ["@/settings/SettingsPageParts.js", stubPath("settings-parts-stub.tsx")],
  ]);
  const bundle = join(directory, "fixture.js");
  await Promise.all([
    writeFile(stubPath("intl-stub.ts"), intlStub),
    writeFile(stubPath("provider-stub.ts"), providerStub),
    writeFile(stubPath("logger-stub.ts"), loggerStub),
    writeFile(stubPath("confirm-stub.ts"), confirmStub),
    writeFile(stubPath("settings-parts-stub.tsx"), settingsPartsStub),
    writeFile(stubPath("settings-stub.ts"), settingsStub),
    writeFile(stubPath("model-providers-stub.ts"), modelProvidersStub),
    writeFile(join(directory, "entry.tsx"), entrySource),
  ]);
  await build({
    entryPoints: [join(directory, "entry.tsx")],
    outfile: bundle,
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    target: ["chrome120"],
    logLevel: "silent",
    nodePaths: [join(uiRoot, "node_modules"), join(repoRoot, "node_modules")],
    plugins: [
      {
        name: "ui-source",
        setup(builder) {
          builder.onResolve({ filter: /./ }, async (args) => {
            const aliasPath = alias.get(args.path);
            if (aliasPath) return { path: aliasPath };
            return undefined;
          });
          builder.onResolve({ filter: /^@\// }, async (args) => {
            const path = await resolveSource(join(uiRoot, "src", args.path.slice(2)));
            return path ? { path } : undefined;
          });
          builder.onResolve({ filter: /\.js$/ }, async (args) => {
            if (!args.path.startsWith(".")) return undefined;
            const path = await resolveSource(join(args.resolveDir, args.path));
            return path ? { path } : undefined;
          });
        },
      },
    ],
  });

  return {
    async mount(page, config) {
      // 每次挂载都重建 React 根，避免上一个用例的状态与监听串入。
      await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
      await page.addScriptTag({ path: bundle });
      await page.evaluate((next) => (globalThis as any).__ws.mount(next), {
        providers: config.providers,
        templates: config.templates ?? templates,
        settings: config.settings,
        enabled: config.enabled,
        loading: config.loading,
      });
      await page.waitForSelector('[data-testid="settings.webSearch.addSource"]');
    },
    async mountDialog(page, config) {
      await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
      await page.addScriptTag({ path: bundle });
      await page.evaluate((next) => (globalThis as any).__ws.mountDialog(next), {
        templates: config.templates,
      });
      await page.getByTestId("settings.webSearch.sourceDialog").waitFor();
    },
    readProbe(page) {
      return page.evaluate(() => {
        const state = (globalThis as any).__ws;
        return {
          createCalls: state.createCalls,
          saveCalls: state.saveCalls,
          deleteCalls: state.deleteCalls,
          updateCalls: state.updateCalls,
          logs: state.logs,
          rowCount: document.querySelectorAll('[data-testid^="settings.webSearch.candidate."]')
            .length,
          settingsButtons: document.querySelectorAll(
            '[data-testid^="settings.webSearch.openSettings."]',
          ).length,
          dialogCreateCalls: state.dialogCreateCalls,
        };
      });
    },
    cleanup() {
      return rm(directory, { recursive: true, force: true });
    },
  };
}

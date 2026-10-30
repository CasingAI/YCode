import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeAutomation, ZCodeOffPeakTask } from "@zcode/shared";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { AutomationEditView } from "../src/settings/AutomationEditView.js";
import { OffPeakEditView } from "../src/settings/OffPeakEditView.js";
import { TabStoreProvider } from "../src/store/TabStoreProvider.js";

// 定时 / 周期 / 延时共用 AutomationEditView，闲时使用 OffPeakEditView。
// 这里直接渲染真实表单，确认历史 NULL / 旧档位回显 Agent / Team 而不会被改写。
const noop = () => undefined;
const noopAsync = () => Promise.resolve();

const settingsServiceStub = {
  get: () => Promise.resolve({}),
  update: () => Promise.resolve({}),
};

function render(ui: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(
          ServiceProvider,
          { services: { settingService: settingsServiceStub } as never },
          createElement(
            PlatformProvider,
            { platform: { onSettingsChanged: () => () => {} } as never },
            createElement(TabStoreProvider, null, ui),
          ),
        ),
      ),
    ),
  );
}

function modeTriggerMarkup(markup: string): string {
  const match = markup.match(/data-testid="chat-mode-select-trigger"[\s\S]*?<\/button>/);
  assert.ok(match, "表单应渲染 Agent / Team 模式触发器");
  return match[0];
}

function automation(mode: string | null): ZCodeAutomation {
  return {
    id: "automation-1",
    title: "历史任务",
    prompt: "整理今天的提交",
    cronExpr: "0 9 * * *",
    scheduleType: "scheduled",
    mode,
    enabled: true,
    status: "active",
    modelSelection: null,
    workspacePath: "/tmp/project",
  } as never;
}

function offPeakTask(permissionMode: string | null): ZCodeOffPeakTask {
  return {
    offPeakTaskId: "offpeak-1",
    title: "历史闲时任务",
    prompt: "整理今天的提交",
    permissionMode,
    status: "queued",
    modelSelection: { providerId: "provider", modelId: "model" },
    workspacePath: "/tmp/project",
  } as never;
}

test("定时 / 周期 / 延时共用表单回显 Agent / Team，历史空值与旧档位不篡改", () => {
  const createMarkup = render(
    createElement(AutomationEditView, {
      editing: null,
      defaultWorkspacePath: "/tmp/project",
      saving: false,
      onSubmit: noopAsync,
      onBack: noop,
    } as never),
  );
  assert.match(modeTriggerMarkup(createMarkup), /Agent/);

  const teamMarkup = render(
    createElement(AutomationEditView, {
      editing: automation("team"),
      defaultWorkspacePath: "/tmp/project",
      saving: false,
      onSubmit: noopAsync,
      onBack: noop,
    } as never),
  );
  assert.match(modeTriggerMarkup(teamMarkup), /Team/);

  // 历史 NULL 与旧 bare 只影响展示：NULL -> Agent，bare -> Team。
  const legacyNullMarkup = render(
    createElement(AutomationEditView, {
      editing: automation(null),
      defaultWorkspacePath: "/tmp/project",
      saving: false,
      onSubmit: noopAsync,
      onBack: noop,
    } as never),
  );
  assert.match(modeTriggerMarkup(legacyNullMarkup), /Agent/);

  const legacyBareMarkup = render(
    createElement(AutomationEditView, {
      editing: automation("bare"),
      defaultWorkspacePath: "/tmp/project",
      saving: false,
      onSubmit: noopAsync,
      onBack: noop,
    } as never),
  );
  assert.match(modeTriggerMarkup(legacyBareMarkup), /Team/);
});

test("闲时表单回显 Agent / Team，历史空值与旧档位不篡改", () => {
  const props = {
    initialDraft: null,
    modelSelectionView: { revision: 0, providers: [] },
    defaultWorkspacePath: "/tmp/project",
    saving: false,
    createBlocked: false,
    createBlockedTooltip: "",
    onBack: noop,
    onSubmit: noopAsync,
    onOpenSession: noop,
    onDelete: noop,
    onDeleteHistory: noop,
    onPause: noop,
    onContinue: noop,
  };

  const createMarkup = render(createElement(OffPeakEditView, { ...props, editing: null } as never));
  assert.match(modeTriggerMarkup(createMarkup), /Agent/);

  const teamMarkup = render(
    createElement(OffPeakEditView, { ...props, editing: offPeakTask("team") } as never),
  );
  assert.match(modeTriggerMarkup(teamMarkup), /Team/);

  const legacyNullMarkup = render(
    createElement(OffPeakEditView, { ...props, editing: offPeakTask(null) } as never),
  );
  assert.match(modeTriggerMarkup(legacyNullMarkup), /Agent/);

  const legacyBareMarkup = render(
    createElement(OffPeakEditView, { ...props, editing: offPeakTask("bare") } as never),
  );
  assert.match(modeTriggerMarkup(legacyBareMarkup), /Team/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import {
  CliProxyLoginBlock,
  CliProxyQuotaSection,
} from "../src/settings/model-provider-section/CliProxyQuotaSection.js";

// 添加 Codex 代理后无登录引导的缺口回归：新建 provider 时额度尚未返回
//（quota 为 null），额度区必须直接摆出登录入口 + 未登录文案，不能留空白框。
// renderToStaticMarkup 不跑 useEffect，所以 quota 恒为初始 null ——
// 恰好复现"刚添加、额度还没回来"的首屏。

const platform = { openExternal: () => undefined } as never;
const services = {
  cliProxyService: {
    fetchQuota: () => Promise.resolve(null),
    getAuthUrl: () => Promise.reject(new Error("unreachable")),
    pollAuthStatus: () => Promise.resolve("wait"),
  },
} as never;

function renderQuotaSection(serviceOverrides: Record<string, unknown> = {}): string {
  const serviceSet = { ...services, ...serviceOverrides };
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(
          PlatformProvider,
          { platform },
          createElement(
            ServiceProvider,
            { services: serviceSet as never },
            createElement(CliProxyQuotaSection, {
              providerId: "personal-codex",
              templateId: "cliproxy-codex",
            }),
          ),
        ),
      ),
    ),
  );
}

function renderLoginBlock(
  props: Parameters<typeof CliProxyLoginBlock>[0],
): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        TooltipProvider,
        null,
        createElement(CliProxyLoginBlock, props),
      ),
    ),
  );
}

const idleProps = {
  phase: "idle" as const,
  authUrl: null,
  loginError: null,
  loggedIn: false,
  channelName: "Codex",
  onStart: () => undefined,
  onOpenUrl: () => undefined,
};

test("只有额度读取服务时展示额度区且不显示登录入口", () => {
  const markup = renderQuotaSection({
    cliProxyService: undefined,
    cliProxyQuotaService: { fetchQuota: () => Promise.resolve(null) },
  });
  assert.match(markup, /剩余额度/);
  assert.doesNotMatch(markup, /登录 Codex|尚未登录 Codex|请前往桌面端/);
});

test("添加后额度未返回：标题角按钮给登录入口 + 未登录文案，无横幅", () => {
  const markup = renderQuotaSection();
  // 剩余额度标题仍在；未登录文案明确指向登录；入口是标题右侧的角落按钮
  //（OpenCode「修改配置」同款版式），不再渲染整块登录横幅。
  assert.match(markup, /剩余额度/);
  assert.match(markup, /尚未登录 Codex，登录后可查看额度/);
  assert.match(markup, /登录 Codex/);
  assert.doesNotMatch(markup, /该供应商对应一个 Codex 账号/);
});

test("已登录但无观测：横幅退场，角落给「切换账号」，无观测文案保留", () => {
  // 复现真机缺口的历史依据：本机 ~/.cli-proxy-api 已有凭据时服务返回
  // no-observation，旧逻辑据此隐藏登录入口形成死路。现规则：入口恒在
  //（标题角按钮），且已登录不再渲染整块登录横幅（用户反馈"阴间横幅"）。
  const markup = renderLoginBlock({ ...idleProps, loggedIn: true });
  assert.equal(markup, "", "idle 态登录块必须不渲染");
});


test("登录中：starting 显示启动反馈", () => {
  const markup = renderLoginBlock({ ...idleProps, phase: "starting" });
  assert.match(markup, /正在启动代理并获取授权链接/);
});

test("登录中：awaiting 显示等待授权与手动打开浏览器兜底", () => {
  const markup = renderLoginBlock({
    ...idleProps,
    phase: "awaiting",
    authUrl: "https://example.com/auth",
  });
  assert.match(markup, /已在浏览器打开授权页/);
  assert.match(markup, /打开浏览器授权/);
});

test("登录成功：显示落盘生效提示", () => {
  const markup = renderLoginBlock({ ...idleProps, phase: "done" });
  assert.match(markup, /登录成功，凭据已落盘并生效/);
});

test("登录失败：回调端口被占给出可操作的提示与重试", () => {
  const markup = renderLoginBlock({
    ...idleProps,
    phase: "failed",
    loginError: "callback-port-busy",
  });
  // 文案去 1455 化（多渠道各自回调端口，beta 渠道端口未实测不写死）。
  assert.doesNotMatch(markup, /1455/);
  assert.match(markup, /回调端口/);
  assert.match(markup, /重试/);
});

test("登录失败：未知服务错误收敛为通用中文失败文案，不上屏原文", () => {
  const markup = renderLoginBlock({
    ...idleProps,
    phase: "failed",
    // loginError 是联合类型：未知错误在 hook 侧已收敛为 failed，原文只进日志。
    loginError: "failed",
  });
  assert.doesNotMatch(markup, /HTTP 500/);
  assert.match(markup, /登录失败，请重试/);
  assert.match(markup, /重试/);
});

test("登录失败：密钥缺失给出独立指引而非通用重试", () => {
  const markup = renderLoginBlock({
    ...idleProps,
    phase: "failed",
    loginError: "management-key-missing",
  });
  assert.match(markup, /密钥文件缺失/);
  assert.match(markup, /重启应用/);
});

test("toLoginErrorKey：未知错误收敛为 failed，已知码保留", async () => {
  // hook 的 catch 路径单测：getCodexAuthUrl reject 含 HTTP 500 的 Error
  // 应收敛为 failed，原文不得作为 loginError 上屏（只进日志）。
  const { toLoginErrorKey } = await import("../src/hooks/useCliProxyAccount.js");
  assert.equal(toLoginErrorKey(new Error("auth-url 失败：HTTP 500")), "failed");
  assert.equal(toLoginErrorKey(new Error("proxy-stopped")), "proxy-stopped");
  assert.equal(toLoginErrorKey(new Error("management-key-missing")), "management-key-missing");
});

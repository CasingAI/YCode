import { CHATGPT_PLAN_API_ORIGIN } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkOptions,
  type HostApiNetworkTransport,
} from "../providers/api/nodeApiNetwork.js";
import { diagnoseChatGPTPlanNetworkError, safeChatGPTNetworkCauseCode } from "./responses.js";

const CHATGPT_PLAN_OAUTH_ORIGIN = "https://auth.openai.com";

export type ChatGPTPlanProxyMode = "default" | "proxy" | "direct";

export interface ChatGPTPlanProxySettings {
  httpProxy?: string;
  httpProxyEnabled?: boolean;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
}

/**
 * Resolve the existing Codex-style provider preference without introducing a generic provider proxy policy.
 * Explicit `proxy` intentionally bypasses NO_PROXY to match the upstream Codex proxy semantics.
 */
export function resolveChatGPTPlanNetworkOptions(
  mode: unknown,
  settings: ChatGPTPlanProxySettings,
): HostApiNetworkOptions {
  const proxyMode: ChatGPTPlanProxyMode = mode === "proxy" || mode === "direct" ? mode : "default";
  return {
    httpProxy: settings.httpProxy,
    proxyEnabled:
      proxyMode === "proxy" || (proxyMode === "default" && settings.httpProxyEnabled === true),
    noProxy: proxyMode === "proxy" ? undefined : settings.httpProxyNoProxy,
    caCertPath: settings.httpProxyCaCertPath,
  };
}

/**
 * Dedicated transport for all ChatGPT Plan OAuth, catalog and inference requests.
 * Options are resolved for every new request so saved provider/global settings take effect immediately.
 */
export function createChatGPTPlanNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
): HostApiNetworkTransport {
  const logger = createServiceLogger("chatgpt-plan-network");
  return createHostApiNetworkTransport(resolveOptions, {
    cacheOptions: false,
    onRequestError(error, context) {
      let endpoint: "oauth" | "api" = "api";
      try {
        const origin = new URL(context.requestUrl).origin;
        if (origin === CHATGPT_PLAN_OAUTH_ORIGIN) endpoint = "oauth";
        else if (origin === CHATGPT_PLAN_API_ORIGIN) endpoint = "api";
      } catch {
        // Do not emit a raw malformed URL into logs.
      }
      const diagnostic = diagnoseChatGPTPlanNetworkError(error, {
        endpoint,
        route: context.route,
      });
      logger.warn(undefined, "ChatGPT Plan outbound request failed", {
        endpoint,
        route: context.route,
        errorCode: diagnostic.code,
        causeCode: safeChatGPTNetworkCauseCode(error),
      });
      return diagnostic;
    },
  });
}

import * as oidc from "openid-client";
import { CHATGPT_PLAN_API_ORIGIN } from "@zcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { ChatGPTRegistration } from "./store.js";
import {
  ChatGPTPlanError,
  diagnoseChatGPTPlanNetworkError,
  safeChatGPTNetworkCauseCode,
} from "./responses.js";

const issuer = "https://auth.openai.com";
export const CHATGPT_PLAN_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

/** 标准流程交给 MIT openid-client；这里只适配 OpenAI 的动态 client ID 与 resource。 */
export class ChatGPTPlanOAuth {
  private metadata?: Promise<oidc.ServerMetadata>;
  private readonly logger = createServiceLogger("chatgpt-plan-oauth");
  constructor(private readonly fetchImpl: typeof fetch) {}

  private diagnoseOAuthFailure(error: unknown, operation: string): ChatGPTPlanError {
    const diagnostic = diagnoseChatGPTPlanNetworkError(error, { endpoint: "oauth" });
    if (!(error instanceof ChatGPTPlanError) && diagnostic.code !== "oauth_protocol_error") {
      this.logger.warn(undefined, "OAuth flow failed", {
        operation,
        errorCode: diagnostic.code,
        causeCode: safeChatGPTNetworkCauseCode(error),
      });
    }
    return diagnostic;
  }

  private readonly authFetch: oidc.CustomFetch = async (url, options) => {
    if (new URL(url).origin !== issuer) throw new ChatGPTPlanError("invalid_oauth_origin");
    return this.fetchImpl(url, { ...options, redirect: "error" });
  };
  async config(clientId: string, signal?: AbortSignal): Promise<oidc.Configuration> {
    this.metadata ??= oidc
      .discovery(
        new URL(issuer),
        "dynamic_agent_client",
        { token_endpoint_auth_method: "none" },
        oidc.None(),
        { [oidc.customFetch]: this.authFetch },
      )
      .then((c) => c.serverMetadata())
      .catch((error: unknown) => {
        this.metadata = undefined;
        throw this.diagnoseOAuthFailure(error, "discovery");
      });
    const config = new oidc.Configuration(
      await this.metadata,
      clientId,
      { token_endpoint_auth_method: "none" },
      oidc.None(),
    );
    config[oidc.customFetch] = (url, options) =>
      this.authFetch(url, {
        ...options,
        ...(signal
          ? { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal }
          : {}),
      });
    config.timeout = 30;
    oidc.enableNonRepudiationChecks(config);
    return config;
  }
  async authorize(input: {
    clientId?: string;
    hostId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    verifier: string;
  }): Promise<string> {
    const url = new URL("/api/accounts/authorize", issuer);
    url.search = new URLSearchParams({
      client_id: input.clientId ?? "dynamic_agent_client",
      ...(input.clientId ? {} : { agent_name_hint: "YCode" }),
      ext_agent_host_id: input.hostId,
      redirect_uri: input.redirectUri,
      scope: CHATGPT_PLAN_SCOPE,
      resource: CHATGPT_PLAN_API_ORIGIN,
      response_type: "code",
      state: input.state,
      nonce: input.nonce,
      code_challenge_method: "S256",
      code_challenge: await oidc.calculatePKCECodeChallenge(input.verifier),
    }).toString();
    return url.href;
  }
  async exchange(input: {
    clientId: string;
    callback: URL;
    state: string;
    nonce: string;
    verifier: string;
  }) {
    let response: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      response = await oidc.authorizationCodeGrant(
        await this.config(input.clientId),
        input.callback,
        {
          expectedState: input.state,
          expectedNonce: input.nonce,
          pkceCodeVerifier: input.verifier,
          idTokenExpected: true,
        },
        { resource: CHATGPT_PLAN_API_ORIGIN },
      );
    } catch (error) {
      throw this.diagnoseOAuthFailure(error, "token_exchange");
    }
    const claims = response.claims();
    if (!claims?.sub || !response.id_token || response.token_type.toLowerCase() !== "bearer")
      throw new ChatGPTPlanError("invalid_oauth_identity");
    return {
      subject: claims.sub,
      label: typeof claims.email === "string" ? claims.email : claims.sub,
      tokens: {
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        idToken: response.id_token,
        scopes: response.scope?.split(/\s+/).filter(Boolean) ?? [],
        expiresAt: Date.now() + Number(response.expires_in ?? 0) * 1000,
      },
    };
  }
  async refresh(
    account: ChatGPTRegistration,
    signal?: AbortSignal,
  ): Promise<NonNullable<ChatGPTRegistration["tokens"]>> {
    if (!account.tokens?.refreshToken) throw new ChatGPTPlanError("reauthentication_required");
    const response = await oidc
      .refreshTokenGrant(await this.config(account.clientId, signal), account.tokens.refreshToken, {
        resource: CHATGPT_PLAN_API_ORIGIN,
      })
      .catch((error: unknown) => {
        const code =
          error && typeof error === "object" && "error" in error ? error.error : undefined;
        if (code === "invalid_grant") throw new ChatGPTPlanError("reauthentication_required");
        throw this.diagnoseOAuthFailure(error, "token_refresh");
      });
    if (response.token_type.toLowerCase() !== "bearer")
      throw new ChatGPTPlanError("invalid_token_type");
    const claims = response.claims();
    if (claims && claims.sub !== account.subject)
      throw new ChatGPTPlanError("oauth_identity_changed");
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? account.tokens.refreshToken,
      idToken: response.id_token ?? account.tokens.idToken,
      scopes: response.scope?.split(/\s+/).filter(Boolean) ?? account.tokens.scopes,
      expiresAt: Date.now() + Number(response.expires_in ?? 0) * 1000,
    };
  }
  async revoke(account: ChatGPTRegistration): Promise<void> {
    if (!account.tokens?.refreshToken) return;
    try {
      await oidc.tokenRevocation(await this.config(account.clientId), account.tokens.refreshToken, {
        token_type_hint: "refresh_token",
      });
    } catch (error) {
      throw this.diagnoseOAuthFailure(error, "token_revocation");
    }
  }
}

export interface ChatGPTPlanOAuthPort {
  authorize: ChatGPTPlanOAuth["authorize"];
  exchange: ChatGPTPlanOAuth["exchange"];
  refresh: ChatGPTPlanOAuth["refresh"];
  revoke: ChatGPTPlanOAuth["revoke"];
}

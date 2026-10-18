import { observeChatGPTAccounts } from "./accountObserver.js";
import { listChatGPTPlanModels } from "./catalog.js";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import { Emitter, type Event } from "@zcode/rpc";
import { chatGPTAccountIdSchema, type ChatGPTPlanState } from "@zcode/shared";
import type { IChatGPTPlanService } from "./contract.js";
import { ChatGPTPlanStore, type ChatGPTPrivateState, type ChatGPTRegistration } from "./store.js";
import { ChatGPTPlanOAuth, type ChatGPTPlanOAuthPort } from "./oauth.js";
import { ChatGPTPlanError, safeChatGPTErrorCode } from "./responses.js";

interface PendingLogin {
  server: Server;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  attemptGeneration: number;
  accountId?: string;
  generation?: number;
  clientId?: string;
  timer: ReturnType<typeof setTimeout>;
}
export interface ChatGPTPlanOwnerOptions {
  store: ChatGPTPlanStore;
  fetch: typeof fetch;
  oauth?: ChatGPTPlanOAuthPort;
  onAccountsChanged?: Event<void>;
  publish(state: ChatGPTPlanState): Promise<void>;
}

/** Host 唯一状态所有者；仅 rpc facade 注册到 ServiceCollection。 */
export class ChatGPTPlanOwner {
  readonly rpc: IChatGPTPlanService;
  private readonly emitter = new Emitter<ChatGPTPlanState>();
  private readonly oauth: ChatGPTPlanOAuthPort;
  private pending?: PendingLogin;
  private loginGeneration = 0;
  private errorCode?: string;
  private disposed = false;
  private loginCompletion?: Promise<void>;
  private observer?: ReturnType<typeof observeChatGPTAccounts>;
  private readonly requests = new Map<string, Set<AbortController>>();

  constructor(private readonly options: ChatGPTPlanOwnerOptions) {
    this.oauth = options.oauth ?? new ChatGPTPlanOAuth(options.fetch);
    const protect = async <T>(action: () => Promise<T>): Promise<T> => {
      if (this.disposed) throw new ChatGPTPlanError("host_disposed");
      try {
        return await action();
      } catch (error) {
        this.errorCode = safeChatGPTErrorCode(error);
        throw new ChatGPTPlanError(this.errorCode);
      }
    };
    this.rpc = {
      onDidChange: this.emitter.event,
      getState: () => protect(() => this.getState()),
      startLogin: (id) => protect(() => this.startLogin(id)),
      cancelLogin: async () => {
        this.cancelLogin();
        await this.changed();
      },
      selectAccount: (id) => protect(() => this.selectAccount(id)),
      logout: (id) => protect(() => this.logout(id, false)),
      deleteAccount: (id) => protect(() => this.logout(id, true)),
      refreshModels: () => protect(() => this.refreshModels()),
    };
  }
  private projection(state: ChatGPTPrivateState): ChatGPTPlanState {
    const active = state.accounts.find((a) => a.id === state.activeAccountId);
    return {
      available: !this.disposed,
      pending: Boolean(this.pending),
      activeAccountId: state.activeAccountId,
      accounts: state.accounts.map((a) => ({
        id: a.id,
        label: `${a.label} (${a.id.slice(0, 8)})`,
        connected: Boolean(a.tokens && a.authError !== "reauthentication_required"),
        sharing: Boolean(
          a.tokens?.scopes.includes("chatgpt.tokens.use.direct") &&
          a.authError !== "reauthentication_required",
        ),
        ...(a.authError ? { errorCode: a.authError } : {}),
      })),
      models:
        active?.tokens?.scopes.includes("chatgpt.tokens.use.direct") &&
        active.authError !== "reauthentication_required"
          ? active.models
          : [],
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
    };
  }
  async getState(): Promise<ChatGPTPlanState> {
    if (this.disposed) throw new ChatGPTPlanError("host_disposed");
    const result = await this.options.store.update(async (state) => {
      const projection = this.projection(state);
      await this.options.publish(projection);
      return projection;
    });
    this.ensureWatcher();
    return result;
  }
  private ensureWatcher(): void {
    if (this.observer || this.disposed || !this.options.onAccountsChanged) return;
    this.observer = observeChatGPTAccounts(this.options.onAccountsChanged, async () => {
      const state = await this.options.store.read();
      // 多窗口共用凭据仓储：另一个 Host 退出后，本窗口已绑定的请求也必须停止。
      for (const [id, controllers] of this.requests) {
        if (!state.accounts.some((account) => account.id === id && account.tokens))
          for (const controller of controllers) controller.abort();
      }
      if (!this.disposed) await this.changed();
    });
  }
  private async changed(): Promise<void> {
    if (!this.disposed) this.emitter.fire(await this.getState());
  }
  private cancelLogin(): void {
    this.loginGeneration += 1;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.server.close();
      pending.server.closeAllConnections();
    }
  }
  private async startLogin(accountId?: string): Promise<{ authorizeUrl: string }> {
    if (this.disposed) throw new ChatGPTPlanError("host_disposed");
    if (accountId !== undefined) chatGPTAccountIdSchema.parse(accountId);
    this.cancelLogin();
    this.errorCode = undefined;
    const attemptGeneration = this.loginGeneration;
    const state = await this.options.store.read();
    const account = accountId ? state.accounts.find((a) => a.id === accountId) : undefined;
    if (accountId && !account) throw new ChatGPTPlanError("account_not_found");
    if (attemptGeneration !== this.loginGeneration) throw new ChatGPTPlanError("oauth_cancelled");
    const server = createServer((request, response) => {
      const pending = this.pending;
      if (!pending || pending.server !== server || request.method !== "GET") {
        response.writeHead(400).end();
        return;
      }
      const callback = new URL(request.url ?? "/", pending.redirectUri);
      if (
        callback.origin !== new URL(pending.redirectUri).origin ||
        callback.pathname !== "/auth/callback" ||
        callback.searchParams.get("state") !== pending.state ||
        callback.searchParams.getAll("state").length !== 1
      ) {
        response.writeHead(400).end("Invalid authorization callback.");
        return;
      }
      // 回调 URL 与凭据仅在 Host 内使用，浏览器页不回显任何参数。
      response
        .writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        })
        .end("Return to YCode to check the connection.");
      this.pending = undefined;
      clearTimeout(pending.timer);
      server.close();
      this.loginCompletion = this.completeLogin(pending, callback).catch(async (error) => {
        if (pending.attemptGeneration !== this.loginGeneration || this.disposed) return;
        this.errorCode = safeChatGPTErrorCode(error);
        await this.changed().catch(() => {});
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new ChatGPTPlanError("callback_unavailable");
    }
    const pending: PendingLogin = {
      server,
      attemptGeneration,
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      verifier: oidc.randomPKCECodeVerifier(),
      redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
      ...(account
        ? { accountId: account.id, generation: account.generation, clientId: account.clientId }
        : {}),
      timer: setTimeout(() => {
        if (this.pending === pending) {
          this.cancelLogin();
          this.errorCode = "oauth_expired";
          void this.changed().catch(() => {});
        }
      }, 5 * 60_000),
    };
    pending.timer.unref();
    if (attemptGeneration !== this.loginGeneration) {
      clearTimeout(pending.timer);
      server.close();
      throw new ChatGPTPlanError("oauth_cancelled");
    }
    this.pending = pending;
    try {
      const authorizeUrl = await this.oauth.authorize({ ...pending, hostId: state.hostId });
      if (this.pending !== pending) throw new ChatGPTPlanError("oauth_cancelled");
      await this.changed();
      return { authorizeUrl };
    } catch (error) {
      if (this.pending === pending) this.cancelLogin();
      throw new ChatGPTPlanError(safeChatGPTErrorCode(error));
    }
  }
  private async completeLogin(pending: PendingLogin, callback: URL): Promise<void> {
    if (pending.attemptGeneration !== this.loginGeneration || this.disposed)
      throw new ChatGPTPlanError("stale_oauth_attempt");
    if (callback.searchParams.has("error")) throw new ChatGPTPlanError("oauth_access_denied");
    if (
      callback.searchParams.getAll("code").length !== 1 ||
      callback.searchParams.getAll("client_id").length > 1
    )
      throw new ChatGPTPlanError("invalid_oauth_callback");
    const issued = callback.searchParams.get("client_id") ?? pending.clientId;
    if (
      !issued ||
      issued === "dynamic_agent_client" ||
      (pending.clientId && issued !== pending.clientId)
    )
      throw new ChatGPTPlanError("invalid_oauth_client");
    const accountId = pending.accountId ?? randomUUID();
    // 先保留已签发 registration；换码失效后重试不能再次注册一个新 client。
    await this.options.store.update((state) => {
      const existing = state.accounts.find((a) => a.id === accountId);
      if (pending.attemptGeneration !== this.loginGeneration)
        throw new ChatGPTPlanError("stale_oauth_attempt");
      if (pending.accountId && (!existing || existing.generation !== pending.generation))
        throw new ChatGPTPlanError("stale_oauth_attempt");
      if (!existing)
        state.accounts.push({
          id: accountId,
          clientId: issued,
          subject: null,
          label: "ChatGPT",
          generation: 0,
          models: [],
        });
    });
    const identity = await this.oauth.exchange({ ...pending, clientId: issued, callback });
    await this.options.store.update(async (state) => {
      const account = state.accounts.find((a) => a.id === accountId);
      if (
        pending.attemptGeneration !== this.loginGeneration ||
        this.disposed ||
        !account ||
        account.generation !== (pending.generation ?? 0)
      )
        throw new ChatGPTPlanError("stale_oauth_attempt");
      if (account.subject && account.subject !== identity.subject)
        throw new ChatGPTPlanError("oauth_identity_changed");
      Object.assign(account, identity);
      delete account.authError;
      account.generation += 1;
      state.activeAccountId = account.id;
      account.models = [];
    });
    this.errorCode = undefined;
    await this.refreshModels();
  }
  private async selectAccount(id: string): Promise<void> {
    chatGPTAccountIdSchema.parse(id);
    this.errorCode = undefined;
    // 刷新后的旋转 token 先独立落盘；目录或 Registry 发布失败不能回滚有效凭据。
    const refreshed = await this.options.store.update(async (state) => {
      const account = state.accounts.find((a) => a.id === id);
      if (!account) throw new ChatGPTPlanError("account_not_found");
      const error = await this.refreshLocked(account);
      return error ? { error } : { account: structuredClone(account) };
    });
    if (!refreshed.account) {
      await this.changed();
      throw new ChatGPTPlanError(refreshed.error!);
    }
    const models = await listChatGPTPlanModels(this.options.fetch, refreshed.account);
    await this.options.store.update((state) => {
      const account = state.accounts.find((a) => a.id === id);
      if (!account?.tokens || account.generation !== refreshed.account!.generation)
        throw new ChatGPTPlanError("stale_account_selection");
      account.models = models;
      state.activeAccountId = id;
    });
    await this.changed();
  }
  async withAccount<T>(
    id: string,
    use: (account: ChatGPTRegistration) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) throw new ChatGPTPlanError("host_disposed");
    signal?.throwIfAborted();
    const result = await this.options.store.update(async (state) => {
      signal?.throwIfAborted();
      const account = state.accounts.find((a) => a.id === id);
      if (!account) throw new ChatGPTPlanError("account_not_found");
      const error = await this.refreshLocked(account, signal);
      if (error) return { error };
      if (!account.tokens?.scopes.includes("chatgpt.tokens.use.direct"))
        return { error: "plan_permission_required" };
      return { account: structuredClone(account) };
    });
    this.ensureWatcher();
    if (!result.account) {
      await this.changed();
      throw new ChatGPTPlanError(result.error!);
    }
    signal?.throwIfAborted();
    return use(result.account);
  }
  private async refreshLocked(
    account: ChatGPTRegistration,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!account.tokens || account.authError === "reauthentication_required")
      return "reauthentication_required";
    if (account.tokens.expiresAt <= Date.now() + 60_000) {
      try {
        account.tokens = await this.oauth.refresh(account, signal);
        if (account.tokens.expiresAt <= Date.now())
          throw new ChatGPTPlanError("invalid_token_expiry");
        delete account.authError;
      } catch (error) {
        // 用户停止不是授权失效，不能把取消写成需要重新登录的账户事实。
        if (signal?.aborted) return "request_cancelled";
        account.authError = safeChatGPTErrorCode(error);
        return account.authError;
      }
    }
    return undefined;
  }
  private async refreshModels(): Promise<void> {
    const state = await this.options.store.read();
    if (state.activeAccountId) await this.selectAccount(state.activeAccountId);
  }
  private async logout(id: string, remove: boolean): Promise<void> {
    chatGPTAccountIdSchema.parse(id);
    this.cancelLogin();
    this.errorCode = undefined;
    for (const controller of this.requests.get(id) ?? []) controller.abort();
    await this.options.store.update(async (state) => {
      const account = state.accounts.find((a) => a.id === id);
      if (!account) return;
      try {
        await this.oauth.revoke(account);
      } catch {
        this.errorCode = "remote_revocation_unconfirmed";
      }
      delete account.tokens;
      delete account.authError;
      account.models = [];
      account.generation += 1;
      if (remove) state.accounts = state.accounts.filter((a) => a.id !== id);
      if (remove && state.activeAccountId === id) state.activeAccountId = null;
    });
    await this.changed();
  }
  trackRequest(id: string, controller: AbortController): () => void {
    const controllers = this.requests.get(id) ?? new Set();
    controllers.add(controller);
    this.requests.set(id, controllers);
    return () => {
      controllers.delete(controller);
      if (!controllers.size) this.requests.delete(id);
    };
  }
  async disposeAndWait(): Promise<void> {
    this.dispose();
    await Promise.all([this.loginCompletion, this.observer?.settle()]);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.dispose();
    this.cancelLogin();
    for (const controllers of this.requests.values())
      for (const controller of controllers) controller.abort();
    this.requests.clear();
    this.emitter.dispose();
  }
}

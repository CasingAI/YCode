// 往活实例安装全局 fetch / Headers / Request / Response / AbortController。
// 真做走出站端口；重定向在宿主侧手动跟，每跳再过出口门。

import type { JSValueHandle, QuickJS } from "quickjs-wasi";
import type { HttpClientMethod, HttpClientPort, HttpClientResponse } from "@zcode/contracts";
import { SANDBOX_HEAP_LIMIT_BYTES } from "./constants.js";
import { assertSandboxFetchUrl } from "./fetch-egress.js";
import {
  fromHttpClientOrUnknown,
  SANDBOX_FETCH_REDIRECT,
  SandboxFetchError,
  sandboxFetchNoHostError,
} from "./fetch-errors.js";
import type { SandboxFetchHostLookup } from "./fetch-host-context.js";
import { hostAsyncFunction, type HostArg } from "./fs-host-bridge.js";

export type { SandboxFetchHostLookup, SandboxFetchCallContext, SandboxInstanceFetchHost } from "./fetch-host-context.js";

const MAX_SANDBOX_FETCH_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FETCH_METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function installSandboxFetch(vm: QuickJS, lookup: SandboxFetchHostLookup): void {
  const abortControllers = new Map<number, AbortController>();
  let nextAbortId = 1;

  using createAbort = vm.newFunction("__sandboxAbortCreate", () => {
    const id = nextAbortId++;
    abortControllers.set(id, new AbortController());
    return vm.newNumber(id);
  });
  vm.setProp(vm.global, "__sandboxAbortCreate", createAbort);

  using fireAbort = vm.newFunction("__sandboxAbortFire", (...args) => {
    const id = args[0]?.toNumber();
    if (typeof id === "number") abortControllers.get(id)?.abort();
    return vm.undefined;
  });
  vm.setProp(vm.global, "__sandboxAbortFire", fireAbort);

  using bytesToUtf8 = vm.newFunction("__sandboxBytesToUtf8", (...args) => {
    const handle = args[0];
    if (!handle || handle.isUndefined || handle.isNull) return vm.newString("");
    const bytes = handle.constructorName === "Uint8Array" ? handle.toUint8Array() : undefined;
    return vm.newString(bytes ? new TextDecoder("utf8").decode(bytes) : "");
  });
  vm.setProp(vm.global, "__sandboxBytesToUtf8", bytesToUtf8);

  using fetchFn = hostAsyncFunction(vm, "fetch", async (args) => {
    try {
      const result = await runSandboxFetch(lookup, abortControllers, args);
      return makeGuestResponse(vm, result);
    } catch (error) {
      throw fromHttpClientOrUnknown(error);
    }
  });
  vm.setProp(vm.global, "__sandboxFetch", fetchFn);

  vm.evalCode(FETCH_GUEST_BOOTSTRAP).dispose();
}

const FETCH_GUEST_BOOTSTRAP = `
(function () {
  function normalizeName(name) {
    return String(name).toLowerCase();
  }
  function Headers(init) {
    this._map = {};
    if (!init) return;
    if (init._map) {
      var copied = init._map;
      for (var key in copied) {
        if (Object.prototype.hasOwnProperty.call(copied, key)) this._map[key] = copied[key];
      }
      return;
    }
    if (typeof init === "object") {
      for (var name in init) {
        if (Object.prototype.hasOwnProperty.call(init, name)) this.set(name, init[name]);
      }
    }
  }
  Headers.prototype.get = function (name) {
    var value = this._map[normalizeName(name)];
    return value === undefined ? null : value;
  };
  Headers.prototype.set = function (name, value) {
    this._map[normalizeName(name)] = String(value);
  };
  Headers.prototype.append = function (name, value) {
    var key = normalizeName(name);
    var current = this._map[key];
    this._map[key] = current ? current + ", " + String(value) : String(value);
  };
  Headers.prototype.has = function (name) {
    return Object.prototype.hasOwnProperty.call(this._map, normalizeName(name));
  };
  Headers.prototype.delete = function (name) {
    delete this._map[normalizeName(name)];
  };

  function AbortSignal() {
    this.aborted = false;
    this._id = 0;
    this._listeners = [];
  }
  AbortSignal.prototype.addEventListener = function (type, fn) {
    if (type === "abort" && typeof fn === "function") this._listeners.push(fn);
  };

  function AbortController() {
    this.signal = new AbortSignal();
    this.signal._id = __sandboxAbortCreate();
  }
  AbortController.prototype.abort = function () {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    __sandboxAbortFire(this.signal._id);
    var listeners = this.signal._listeners;
    for (var i = 0; i < listeners.length; i++) listeners[i]();
  };

  function Request(input, init) {
    init = init || {};
    if (typeof input === "object" && input.url) {
      this.url = String(input.url);
      this.method = String(init.method || input.method || "GET").toUpperCase();
      this.headers = new Headers(init.headers || input.headers);
      this._body = init.body !== undefined ? init.body : input._body;
      this.signal = init.signal || input.signal;
      this.redirect = init.redirect || input.redirect || "follow";
    } else {
      this.url = String(input);
      this.method = String(init.method || "GET").toUpperCase();
      this.headers = new Headers(init.headers);
      this._body = init.body;
      this.signal = init.signal;
      this.redirect = init.redirect || "follow";
    }
  }

  function Response(body, init) {
    init = init || {};
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText || "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    this.url = init.url || "";
    this.redirected = init.redirected === true;
    this.bodyUsed = false;
    this._body = body || new Uint8Array(0);
  }
  Response.prototype.arrayBuffer = function () {
    this._consume();
    return this._body.buffer;
  };
  Response.prototype.text = function () {
    this._consume();
    return Promise.resolve(__sandboxBytesToUtf8(this._body));
  };
  Response.prototype.json = function () {
    return this.text().then(function (text) {
      return JSON.parse(text);
    });
  };
  Response.prototype._consume = function () {
    if (this.bodyUsed) throw new TypeError("Body already used");
    this.bodyUsed = true;
  };

  function fetch(input, init) {
    var req = new Request(input, init);
    return __sandboxFetch({
      url: req.url,
      method: req.method,
      headers: req.headers._map,
      signalId: req.signal && req.signal._id,
      redirect: req.redirect,
    }, req._body);
  }

  globalThis.__sandboxMakeResponse = function (status, statusText, url, redirected, headersJson, body) {
    return new Response(body, {
      status: status,
      statusText: statusText,
      url: url,
      redirected: redirected === true,
      headers: JSON.parse(headersJson),
    });
  };

  globalThis.Headers = Headers;
  globalThis.AbortSignal = AbortSignal;
  globalThis.AbortController = AbortController;
  globalThis.Request = Request;
  globalThis.Response = Response;
  globalThis.fetch = fetch;
})();
`;

function makeGuestResponse(vm: QuickJS, result: HttpClientResponse & { redirected: boolean }): JSValueHandle {
  using factory = vm.global.getProp("__sandboxMakeResponse");
  using status = vm.newNumber(result.status);
  using statusText = vm.newString(result.statusText);
  using url = vm.newString(result.url);
  const redirected = result.redirected ? vm.true : vm.false;
  using headersJson = vm.newString(JSON.stringify(result.headers));
  using body = vm.newUint8Array(result.body);
  return vm.callFunction(factory, vm.undefined, status, statusText, url, redirected, headersJson, body);
}

async function runSandboxFetch(
  lookup: SandboxFetchHostLookup,
  abortControllers: Map<number, AbortController>,
  args: HostArg[],
): Promise<HttpClientResponse & { redirected: boolean }> {
  const ctx = lookup();
  if (!ctx) throw sandboxFetchNoHostError();

  const meta = args[0];
  if (!meta || meta.kind !== "object") {
    throw new SandboxFetchError("EINVAL", "fetch requires a request");
  }
  const urlValue = meta.value.url;
  const methodValue = typeof meta.value.method === "string" ? meta.value.method.toUpperCase() : "GET";
  const redirect = typeof meta.value.redirect === "string" ? meta.value.redirect : "follow";
  const signalId = typeof meta.value.signalId === "number" ? meta.value.signalId : undefined;
  const headers = asStringRecord(meta.value.headers);
  const bodyArg = args[1];
  let body = bodyFromArg(bodyArg);

  if (typeof urlValue !== "string" || urlValue.length === 0) {
    throw new SandboxFetchError("EINVAL", "fetch URL is required");
  }
  if (!FETCH_METHODS.has(methodValue)) {
    throw new SandboxFetchError("EINVAL", `Unsupported fetch method: ${methodValue}`);
  }
  if ((methodValue === "GET" || methodValue === "HEAD") && body !== undefined) {
    throw new SandboxFetchError("EINVAL", "fetch GET/HEAD cannot have a body");
  }

  const signal = signalId === undefined ? undefined : abortControllers.get(signalId)?.signal;
  if (signalId !== undefined && signal === undefined) {
    throw new SandboxFetchError("EINVAL", "fetch signal is not from AbortController");
  }
  if (signal?.aborted) {
    throw new SandboxFetchError("ABORT_ERR", "The operation was aborted", "AbortError");
  }

  let method = methodValue as HttpClientMethod;
  let current = assertSandboxFetchUrl(urlValue);
  let redirected = false;

  for (let hop = 0; hop <= MAX_SANDBOX_FETCH_REDIRECTS; hop += 1) {
    current = assertSandboxFetchUrl(current.toString());
    const response = await ctx.httpClientPort.request(
      {
        url: current.toString(),
        method,
        headers,
        body,
        timeoutMs: 0,
        maxResponseBytes: SANDBOX_HEAP_LIMIT_BYTES,
        redirect: "manual",
        egressPolicy: "sandbox",
      },
      { signal },
    );

    if (redirect === "error" && REDIRECT_STATUSES.has(response.status)) {
      throw new SandboxFetchError(SANDBOX_FETCH_REDIRECT, `fetch redirect not allowed: ${response.status}`);
    }
    if (redirect !== "follow" || !REDIRECT_STATUSES.has(response.status)) {
      return { ...response, redirected };
    }

    const location = headerValue(response.headers, "location");
    if (location === undefined) return { ...response, redirected };

    current = new URL(location, current);
    redirected = true;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
  }

  throw new SandboxFetchError(SANDBOX_FETCH_REDIRECT, "Too many fetch redirects");
}

function bodyFromArg(arg: HostArg | undefined): Uint8Array | undefined {
  if (!arg || arg.kind === "undefined" || arg.kind === "null") return undefined;
  if (arg.kind === "bytes") return arg.value;
  if (arg.kind === "string") return new TextEncoder().encode(arg.value);
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") record[key] = entry;
  }
  return record;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

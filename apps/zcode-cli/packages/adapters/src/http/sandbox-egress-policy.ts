import http from "node:http";
import {
  createHttpClientError,
  getIpAddressVersion,
  normalizeIpAddressLiteral,
  sandboxEgressBlockedHostnameReason,
  sandboxEgressBlockedIpReason,
} from "@zcode/contracts";
import type { DnsLookup, DnsLookupAddress } from "./public-egress-policy.js";

type NodeLookupFunction = NonNullable<http.RequestOptions["lookup"]>;

interface SandboxEgressLookupOptions {
  signal?: AbortSignal;
}

export async function assertSandboxEgressDestination(
  url: URL,
  dnsLookup: DnsLookup,
  options: SandboxEgressLookupOptions = {},
): Promise<void> {
  await resolveSandboxEgressAddresses(url, url.hostname, dnsLookup, options);
}

export function createSandboxEgressLookup(
  url: string,
  dnsLookup: DnsLookup,
  egressOptions: SandboxEgressLookupOptions = {},
): NodeLookupFunction {
  return (hostname, lookupOptions, callback) => {
    const done = typeof lookupOptions === "function" ? lookupOptions : callback;
    const wantsAll =
      typeof lookupOptions === "object" &&
      lookupOptions !== null &&
      "all" in lookupOptions &&
      (lookupOptions as { all?: unknown }).all === true;

    if (!done) return;

    resolveSandboxEgressAddresses(new URL(url), hostname, dnsLookup, egressOptions).then(
      (addresses) => {
        if (wantsAll) {
          (
            done as (error: NodeJS.ErrnoException | null, addresses: DnsLookupAddress[]) => void
          )(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          (done as (error: NodeJS.ErrnoException) => void)(
            createSandboxEgressBlockedError(url, "HTTP sandbox egress DNS lookup returned no addresses"),
          );
          return;
        }
        (
          done as (
            error: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void
        )(null, first.address, first.family);
      },
      (error: unknown) => {
        (done as (error: NodeJS.ErrnoException) => void)(toLookupError(error));
      },
    );
  };
}

async function resolveSandboxEgressAddresses(
  url: URL,
  hostnameValue: string,
  dnsLookup: DnsLookup,
  options: SandboxEgressLookupOptions,
): Promise<DnsLookupAddress[]> {
  const hostname = normalizeIpAddressLiteral(hostnameValue);
  if (hostname.length === 0) {
    throw createSandboxEgressBlockedError(url.toString(), "HTTP sandbox egress requires a hostname");
  }

  const hostReason = sandboxEgressBlockedHostnameReason(hostname);
  if (hostReason) {
    throw createSandboxEgressBlockedError(url.toString(), `HTTP sandbox egress blocked ${hostname}: ${hostReason}`);
  }

  const ipVersion = getIpAddressVersion(hostname);
  const addresses =
    ipVersion === 0
      ? await lookupDnsAddresses(hostname, dnsLookup, options.signal)
      : [{ address: hostname, family: ipVersion }];

  if (addresses.length === 0) {
    throw createSandboxEgressBlockedError(
      url.toString(),
      `HTTP sandbox egress DNS lookup returned no addresses for ${hostname}`,
    );
  }

  for (const address of addresses) {
    const blockedAddress = sandboxEgressBlockedIpReason(address.address);
    if (blockedAddress) {
      throw createSandboxEgressBlockedError(
        url.toString(),
        `HTTP sandbox egress blocked ${hostname} because it resolved to ${blockedAddress}`,
      );
    }
  }

  return addresses;
}

function lookupDnsAddresses(
  hostname: string,
  dnsLookup: DnsLookup,
  signal: AbortSignal | undefined,
): Promise<DnsLookupAddress[]> {
  throwIfAborted(signal);
  const lookup = dnsLookup(hostname, { all: true, verbatim: true });
  if (!signal) return lookup;
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    lookup.then(
      (addresses) => {
        signal.removeEventListener("abort", onAbort);
        resolve(addresses);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("HTTP request was cancelled");
}

function createSandboxEgressBlockedError(url: string, message: string): Error {
  return createHttpClientError({
    code: "egress_blocked",
    url,
    message,
  });
}

function toLookupError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) return error as NodeJS.ErrnoException;
  return new Error(String(error)) as NodeJS.ErrnoException;
}

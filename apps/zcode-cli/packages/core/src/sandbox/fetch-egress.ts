import { sandboxEgressBlockedHostnameReason } from "@zcode/contracts";
import {
  SANDBOX_FETCH_EGRESS,
  SANDBOX_FETCH_UNSUPPORTED_PROTOCOL,
  SandboxFetchError,
} from "./fetch-errors.js";

export function assertSandboxFetchUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SandboxFetchError("EINVAL", `Invalid URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SandboxFetchError(
      SANDBOX_FETCH_UNSUPPORTED_PROTOCOL,
      `Sandbox fetch only supports http and https (got ${url.protocol}). Load the sandbox skill (references/fetch.md).`,
    );
  }

  const blocked = sandboxEgressBlockedHostnameReason(url.hostname);
  if (blocked) {
    throw new SandboxFetchError(
      SANDBOX_FETCH_EGRESS,
      `Sandbox fetch blocked ${url.hostname}: ${blocked}`,
    );
  }

  return url;
}

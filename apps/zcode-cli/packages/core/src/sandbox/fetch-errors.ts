import { isHttpClientPortError } from "@zcode/contracts";

export const SANDBOX_FETCH_EGRESS = "SANDBOX_FETCH_EGRESS";
export const SANDBOX_FETCH_NO_HOST = "SANDBOX_FETCH_NO_HOST";
export const SANDBOX_FETCH_UNSUPPORTED_PROTOCOL = "SANDBOX_FETCH_UNSUPPORTED_PROTOCOL";
export const SANDBOX_FETCH_TOO_LARGE = "SANDBOX_FETCH_TOO_LARGE";
export const SANDBOX_FETCH_REDIRECT = "SANDBOX_FETCH_REDIRECT";

export class SandboxFetchError extends Error {
  readonly code: string;
  constructor(code: string, message: string, name = "TypeError") {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export function sandboxFetchNoHostError(): SandboxFetchError {
  return new SandboxFetchError(SANDBOX_FETCH_NO_HOST, "Sandbox fetch host is not configured");
}

export function fromHttpClientOrUnknown(error: unknown): SandboxFetchError {
  if (error instanceof SandboxFetchError) return error;
  if (isHttpClientPortError(error)) {
    if (error.code === "egress_blocked") {
      return new SandboxFetchError(SANDBOX_FETCH_EGRESS, error.message);
    }
    if (error.code === "unsupported_protocol") {
      return new SandboxFetchError(SANDBOX_FETCH_UNSUPPORTED_PROTOCOL, error.message);
    }
    if (error.code === "cancelled") {
      return new SandboxFetchError("ABORT_ERR", error.message, "AbortError");
    }
    if (error.code === "too_large") {
      return new SandboxFetchError(SANDBOX_FETCH_TOO_LARGE, error.message);
    }
    return new SandboxFetchError("EIO", error.message);
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return new SandboxFetchError("ABORT_ERR", error.message, "AbortError");
    }
    return new SandboxFetchError("EIO", error.message);
  }
  return new SandboxFetchError("EIO", String(error));
}

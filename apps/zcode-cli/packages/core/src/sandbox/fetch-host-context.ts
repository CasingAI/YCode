import type { HttpClientPort, SessionId } from "@zcode/contracts";

export interface SandboxFetchCallContext {
  sessionId: SessionId;
  httpClientPort: HttpClientPort;
}

export type SandboxFetchHostLookup = () => SandboxFetchCallContext | undefined;

export interface SandboxInstanceFetchHost {
  sessionId: SessionId;
  resolve: SandboxFetchHostLookup;
}

import { useEffect, useRef, useState } from "react";
import type { WebSocketConnectionSnapshot } from "@zcode/client";
import { useZCodeIntl } from "@zcode/ui";

interface WebConnectionStatusProps {
  snapshot: WebSocketConnectionSnapshot;
  onRetry: () => void;
}

export function WebConnectionStatus({ snapshot, onRetry }: WebConnectionStatusProps) {
  const { intl } = useZCodeIntl();
  const [showRecovered, setShowRecovered] = useState(false);
  const previousStatus = useRef(snapshot.status);

  useEffect(() => {
    if (previousStatus.current === "reconnecting" && snapshot.status === "connected") {
      setShowRecovered(true);
      const timer = window.setTimeout(() => setShowRecovered(false), 2_500);
      previousStatus.current = snapshot.status;
      return () => window.clearTimeout(timer);
    }
    previousStatus.current = snapshot.status;
    return undefined;
  }, [snapshot.status]);

  if (snapshot.status === "closed") return null;
  if (snapshot.status === "connected" && !showRecovered) return null;

  const reconnecting = snapshot.status === "reconnecting";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="web-connection-status"
      className="fixed inset-x-3 top-3 z-[100] mx-auto flex max-w-lg items-center gap-2 rounded-xl border border-border bg-surface/95 px-3 py-2 text-ui-base text-foreground shadow-lg backdrop-blur-md"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${reconnecting ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`}
      />
      <p className="min-w-0 flex-1">
        {reconnecting
          ? intl.formatMessage({ id: "web.connection.reconnecting" }, { attempt: snapshot.attempt })
          : intl.formatMessage({ id: "web.connection.recovered" })}
      </p>
      {reconnecting ? (
        <button
          type="button"
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/80"
          onClick={onRetry}
        >
          {intl.formatMessage({ id: "common.retry" })}
        </button>
      ) : null}
    </div>
  );
}

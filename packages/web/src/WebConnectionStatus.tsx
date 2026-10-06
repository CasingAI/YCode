import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WebSocketConnectionSnapshot } from "@zcode/client";
import { useZCodeIntl } from "@zcode/ui";
import {
  RECOVERED_FLASH_MS,
  resolveConnectionTier,
  type ConnectionTier,
  type ConnectionTierResult,
} from "./connection/connectionStatusTier.js";

interface WebConnectionStatusProps {
  snapshot: WebSocketConnectionSnapshot;
  onRetry: () => void;
}

/** 胶囊高度。右内边距要由它和按钮高度推导，写死数值会让两段圆弧的圆心错开。 */
const PILL_HEIGHT_PX = 35;
const RETRY_BUTTON_HEIGHT_PX = 21;

/**
 * 进度条按「本次等待的峰值剩余时间」收缩：等待刚开始时满宽，随倒计时线性排空。
 * 连接管理器只发布剩余时刻、不发布整段延迟，按固定上限折算会让短等待显示成一小截。
 */
function useWaitProgress(nextRetryAt: number | null, now: number): number {
  const peakRef = useRef<{ nextRetryAt: number; peak: number } | null>(null);
  if (nextRetryAt === null) {
    peakRef.current = null;
    return 0;
  }
  const left = Math.max(0, nextRetryAt - now);
  const previous = peakRef.current;
  if (!previous || previous.nextRetryAt !== nextRetryAt || left > previous.peak) {
    peakRef.current = { nextRetryAt, peak: Math.max(left, 1) };
  }
  return Math.min(1, left / (peakRef.current?.peak ?? 1));
}

/** 只在断线期间每秒推进一次，用来刷新倒计时和断开时长。 */
function useDisconnectClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function messageIdFor(tier: ConnectionTier): string {
  return tier === "hidden" ? "restored" : tier;
}

export function WebConnectionStatus({ snapshot, onRetry }: WebConnectionStatusProps) {
  const { intl } = useZCodeIntl();
  const reconnecting = snapshot.status === "reconnecting";
  const now = useDisconnectClock(reconnecting);
  const resolved = resolveConnectionTier({
    status: snapshot.status,
    attempt: snapshot.attempt,
    disconnectedAt: snapshot.disconnectedAt,
    nextRetryAt: snapshot.nextRetryAt,
    now,
  });

  // 首次连接成功不算「恢复」，不闪提示；只有真的断过线才闪。
  const experiencedDisconnect = useRef(false);
  const [showRestored, setShowRestored] = useState(false);
  useEffect(() => {
    if (snapshot.status === "reconnecting") {
      experiencedDisconnect.current = true;
      return undefined;
    }
    if (snapshot.status !== "connected" || !experiencedDisconnect.current) return undefined;
    experiencedDisconnect.current = false;
    setShowRestored(true);
    const timer = window.setTimeout(() => setShowRestored(false), RECOVERED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot.status]);

  if (snapshot.status === "connected" && !showRestored) return null;
  if (resolved.tier === "hidden") return null;

  return (
    <ConnectionStatusPill
      resolved={resolved}
      nextRetryAt={snapshot.nextRetryAt}
      now={now}
      onRetry={onRetry}
    >
      {intl.formatMessage(
        { id: `web.connection.${messageIdFor(resolved.tier)}` },
        { seconds: resolved.seconds },
      )}
    </ConnectionStatusPill>
  );
}

interface ConnectionStatusPillProps {
  resolved: ConnectionTierResult;
  nextRetryAt: number | null;
  now: number;
  onRetry: () => void;
  children: ReactNode;
}

function ConnectionStatusPill({
  resolved,
  nextRetryAt,
  now,
  onRetry,
  children,
}: ConnectionStatusPillProps) {
  const { intl } = useZCodeIntl();
  const recovered = resolved.tier === "restored";
  const waitProgress = useWaitProgress(resolved.showProgress ? nextRetryAt : null, now);

  // 胶囊右端圆弧半径 R 与按钮右端圆弧半径 r 必须同心：按钮右边缘只能落在
  // 「胶囊右边缘 − (R − r)」上，而 R − r 正是两者高度之差的一半。
  // 写成别的数值，两段弧的圆心会错开，缝隙从中间往上下两端忽宽忽窄。
  const pillStyle: CSSProperties = {
    height: `${PILL_HEIGHT_PX}px`,
    borderColor: "var(--connection-banner-border)",
    paddingRight: resolved.showRetryAction
      ? `calc((${PILL_HEIGHT_PX}px - ${RETRY_BUTTON_HEIGHT_PX}px) / 2 - 1px)`
      : undefined,
  };

  return (
    <>
      {resolved.showProgress ? (
        <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-[101]">
          <div
            className="h-0.5 bg-amber-500 transition-[width] duration-1000 ease-linear"
            style={{ width: `${Math.round(waitProgress * 100)}%` }}
          />
        </div>
      ) : null}
      <div className="pointer-events-none fixed inset-x-3 top-3 z-[100] flex justify-center">
        <div
          role="status"
          aria-live="polite"
          data-testid="web-connection-status"
          style={pillStyle}
          className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-surface/95 px-3 text-ui-base text-foreground shadow-lg backdrop-blur-md"
        >
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${
              recovered ? "bg-emerald-500" : "animate-pulse bg-amber-500"
            }`}
          />
          <p className="min-w-0 truncate">{children}</p>
          {resolved.showRetryAction ? (
            <button
              type="button"
              style={{ height: `${RETRY_BUTTON_HEIGHT_PX}px` }}
              className="shrink-0 rounded-full bg-primary px-2.5 text-primary-foreground hover:bg-primary/80"
              onClick={onRetry}
            >
              {intl.formatMessage({ id: "web.connection.retryNow" })}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

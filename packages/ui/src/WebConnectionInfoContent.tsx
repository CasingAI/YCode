import {
  TID_WEB_CONNECTION_INFO_DIRECT,
  TID_WEB_CONNECTION_INFO_NETWORK_RTT,
  TID_WEB_CONNECTION_INFO_RECEIVED_BYTES,
  TID_WEB_CONNECTION_INFO_SENT_BYTES,
  TID_WEB_CONNECTION_INFO_SERVER_PROCESSING,
  TID_WEB_CONNECTION_INFO_STATUS,
  TID_WEB_CONNECTION_INFO_TRANSPORT,
  type WebConnectionInfo,
  type WebConnectionLatency,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ServiceConnectionStatus } from "@/root/types.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";

const STATUS_MESSAGE_IDS: Record<ServiceConnectionStatus, string> = {
  connecting: "webConnectionInfo.status.connecting",
  connected: "webConnectionInfo.status.connected",
  reconnecting: "webConnectionInfo.status.reconnecting",
  closed: "webConnectionInfo.status.closed",
};

const TRANSPORT_MESSAGE_IDS: Record<NonNullable<WebConnectionInfo["transport"]> | "none", string> =
  {
    websocket: "webConnectionInfo.transport.websocket",
    webrtc: "webConnectionInfo.transport.webrtc",
    none: "webConnectionInfo.transport.none",
  };

const DIRECT_STATE_MESSAGE_IDS: Record<WebConnectionInfo["directState"], string> = {
  disabled: "webConnectionInfo.direct.disabled",
  waiting: "webConnectionInfo.direct.waiting",
  connecting: "webConnectionInfo.direct.connecting",
  connected: "webConnectionInfo.direct.connected",
  fallback: "webConnectionInfo.direct.fallback",
};

/** 约束：不解析地址、不建连、不探测，也不展示 generation、重试次数或原始错误。延迟只展示 owner 已发布的最近样本。 */
export function WebConnectionInfoContent({
  status,
  connectionInfo,
  latency,
  traffic,
}: {
  status: ServiceConnectionStatus;
  connectionInfo?: WebConnectionInfo;
  latency?: WebConnectionLatency;
  traffic?: { sentBytes: number; receivedBytes: number };
}) {
  const { intl } = useZCodeIntl();
  const transport = connectionInfo?.transport ?? null;
  const directState = connectionInfo?.directState ?? "disabled";
  // 断连时代理可能仍持有上一份快照；这里按状态直接显示空值，不回显旧样本。
  const sample = status === "connected" ? latency : undefined;
  const unavailable = intl.formatMessage({ id: "webConnectionInfo.latencyUnavailable" });
  // 显示层取整，避免 performance.now 差值的长小数；owner 发布的原始样本保持不变。
  const networkRoundTripText = sample ? `${Math.round(sample.networkRoundTripMs)} ms` : unavailable;
  const serverProcessingText = sample ? `${Math.round(sample.serverProcessingMs)} ms` : unavailable;

  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 text-ui-base">
      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.status" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_STATUS} className="min-w-0 text-foreground">
        {intl.formatMessage({ id: STATUS_MESSAGE_IDS[status] })}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.transport" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_TRANSPORT} className="min-w-0 text-foreground">
        {intl.formatMessage({
          id: TRANSPORT_MESSAGE_IDS[transport ?? "none"],
        })}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.direct" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_DIRECT} className="min-w-0 text-foreground">
        {intl.formatMessage({ id: DIRECT_STATE_MESSAGE_IDS[directState] })}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.networkRoundTrip" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_NETWORK_RTT} className="min-w-0 text-foreground">
        {networkRoundTripText}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.serverProcessing" })}
      </dt>
      <dd
        data-testid={TID_WEB_CONNECTION_INFO_SERVER_PROCESSING}
        className="min-w-0 text-foreground"
      >
        {serverProcessingText}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.sentBytes" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_SENT_BYTES} className="min-w-0 text-foreground">
        {formatBytes(traffic?.sentBytes ?? 0)}
      </dd>

      <dt className="text-foreground-subtle">
        {intl.formatMessage({ id: "webConnectionInfo.receivedBytes" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_RECEIVED_BYTES} className="min-w-0 text-foreground">
        {formatBytes(traffic?.receivedBytes ?? 0)}
      </dd>
    </dl>
  );
}

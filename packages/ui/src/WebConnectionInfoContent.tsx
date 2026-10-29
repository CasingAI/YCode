import {
  TID_WEB_CONNECTION_INFO_DIRECT,
  TID_WEB_CONNECTION_INFO_ENDPOINT,
  TID_WEB_CONNECTION_INFO_RECEIVED_BYTES,
  TID_WEB_CONNECTION_INFO_SENT_BYTES,
  TID_WEB_CONNECTION_INFO_STATUS,
  TID_WEB_CONNECTION_INFO_TRANSPORT,
  type WebConnectionInfo,
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

/** 约束：不解析地址、不建连、不测速，也不展示 generation、重试次数或原始错误。 */
export function WebConnectionInfoContent({
  status,
  connectionInfo,
  traffic,
}: {
  status: ServiceConnectionStatus;
  connectionInfo?: WebConnectionInfo;
  traffic?: { sentBytes: number; receivedBytes: number };
}) {
  const { intl } = useZCodeIntl();
  const transport = connectionInfo?.transport ?? null;
  const directState = connectionInfo?.directState ?? "disabled";
  const endpoint = connectionInfo?.endpoint ?? null;

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
        {intl.formatMessage({ id: "webConnectionInfo.endpoint" })}
      </dt>
      <dd data-testid={TID_WEB_CONNECTION_INFO_ENDPOINT} className="min-w-0 text-foreground">
        {endpoint ? (
          <span className="block break-all">{endpoint}</span>
        ) : (
          <span className="text-foreground-subtle">
            {intl.formatMessage({ id: "webConnectionInfo.endpoint.unknown" })}
          </span>
        )}
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

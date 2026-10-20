import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { connectViaWebSocketManaged, type WebSocketConnection } from "@zcode/client";
import { ResourceManagerApp, ZCodeIntlProvider, useZCodeIntl } from "@zcode/ui";

/**
 * Web 端资源管理器页面。
 *
 * 独立页面而不是主应用里的一个视图：资源管理器只看宿主进程的资源快照，
 * 不需要 workspace、任务与设置那一整套应用状态。
 */
export function ResourceManagerPage({ wsUrl }: { wsUrl: string }) {
  const [connection, setConnection] = useState<WebSocketConnection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let created: WebSocketConnection | undefined;
    void connectViaWebSocketManaged(wsUrl)
      .then((established) => {
        if (disposed) {
          established.dispose();
          return;
        }
        created = established;
        setConnection(established);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      created?.dispose();
    };
  }, [wsUrl]);

  return (
    <ZCodeIntlProvider>
      <ResourceManagerContent connection={connection} error={error} />
    </ZCodeIntlProvider>
  );
}

function ResourceManagerContent({
  connection,
  error,
}: {
  connection: WebSocketConnection | null;
  error: string | null;
}) {
  const { intl } = useZCodeIntl();
  if (error) {
    return (
      <ResourceManagerNotice message={intl.formatMessage({ id: "resourceManager.unavailable" })} />
    );
  }
  if (!connection) {
    return (
      <ResourceManagerNotice message={intl.formatMessage({ id: "resourceManager.loading" })} />
    );
  }
  return <ResourceManagerWindow connection={connection} />;
}

function ResourceManagerWindow({ connection }: { connection: WebSocketConnection }) {
  const snapshot = useSyncExternalStore(
    (listener) => connection.subscribe(listener),
    () => connection.getSnapshot(),
    () => connection.getSnapshot(),
  );
  const services = snapshot.services;
  // 宿主没有注册资源采样服务时不给数据源，页面显示「资源管理器接口不可用」，
  // 不去调用一个注定失败的通道。
  const getSnapshot = useMemo(() => {
    const service = services?.resourceUsageService;
    if (!service) return undefined;
    return () => service.getSnapshot();
  }, [services]);

  return <ResourceManagerApp getSnapshot={getSnapshot} />;
}

function ResourceManagerNotice({ message }: { message: string }) {
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background text-foreground">
      <p className="text-ui-sm text-foreground-subtle">{message}</p>
    </main>
  );
}

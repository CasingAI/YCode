import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  WebSocketConnection,
  WebSocketConnectionSnapshot,
} from "@zcode/client";
import type { IPlatformService } from "@zcode/shared";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { createSwitchableServiceAccessor } from "./connection/switchableServiceAccessor.js";
import { projectServiceConnection } from "./connection/serviceConnectionProjection.js";
import { WebConnectionStatus } from "./WebConnectionStatus.js";
import { createWebStorageBridge } from "./connection/storageWebBridge.js";

type WebServices = NonNullable<WebSocketConnectionSnapshot["services"]>;

export interface WebAppBootstrap {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
}

interface WebAppProps {
  connection: WebSocketConnection;
  bootstrap: WebAppBootstrap;
  platform: IPlatformService;
}

export function WebApp({ connection, bootstrap, platform }: WebAppProps) {
  const snapshot = useSyncExternalStore(
    (listener) => connection.subscribe(listener),
    () => connection.getSnapshot(),
    () => connection.getSnapshot(),
  );
  const [serviceAccessor] = useState(createSwitchableServiceAccessor);
  const [appliedGeneration, setAppliedGeneration] = useState<number | null>(
    null,
  );

  // 在浏览器绘制前切换代际，避免重连状态已经 fail-closed 但 facade 仍短暂指向旧 transport。
  useLayoutEffect(() => {
    serviceAccessor.setTarget(snapshot.services, snapshot.generation);
    if (snapshot.services) {
      setAppliedGeneration(snapshot.generation);
    }
  }, [serviceAccessor, snapshot.generation, snapshot.services]);

  useEffect(() => {
    return () => {
      connection.dispose();
      serviceAccessor.dispose();
    };
  }, [connection, serviceAccessor]);

  // 重连新代更换桥身份：StorageSection 卸载旧订阅/请求，按新代重新读取宿主快照。
  const platformWithStorage = useMemo(
    () => ({
      ...platform,
      storage: snapshot.services?.storageService
        ? createWebStorageBridge(serviceAccessor.services.storageService!)
        : undefined,
    }),
    [platform, serviceAccessor, snapshot.generation, snapshot.services],
  );
  const hasRoot = appliedGeneration !== null;
  const rootReady =
    snapshot.status === "connected" &&
    snapshot.services !== null &&
    appliedGeneration === snapshot.generation;
  // 连接信息只从既有快照只读投影，不另建连接或 store。
  const serviceConnection = useMemo(
    () =>
      projectServiceConnection({
        status: snapshot.status,
        generation: snapshot.generation,
        rpcReady: rootReady,
        connectionInfo: snapshot.connectionInfo,
      }),
    [rootReady, snapshot.connectionInfo, snapshot.generation, snapshot.status],
  );
  if (!hasRoot) {
    return (
      <ZCodeIntlProvider>
        <WebConnectionStatus
          snapshot={snapshot}
          onRetry={() => connection.retryNow()}
        />
      </ZCodeIntlProvider>
    );
  }

  const services: WebServices = serviceAccessor.services;

  return (
    <ZCodeIntlProvider
      settingService={services.settingService}
      broadcastService={services.broadcastService}
    >
      <div
        className="h-dvh min-h-dvh w-screen overflow-hidden"
        aria-busy={!rootReady}
      >
        <WebConnectionStatus
          snapshot={snapshot}
          onRetry={() => connection.retryNow()}
        />
        <div className="h-full min-h-0 w-full">
          <AppErrorBoundary>
            <Root
              services={services}
              serviceConnection={serviceConnection}
              platform={platformWithStorage}
              isDesktop={false}
              initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
              initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
              initialTaskId={bootstrap.initialTaskId}
              restoreSession={bootstrap.restoreSession}
              allowOpenWorkspace={bootstrap.allowOpenWorkspace}
              preferDirectoryBrowser
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </AppErrorBoundary>
        </div>
      </div>
    </ZCodeIntlProvider>
  );
}

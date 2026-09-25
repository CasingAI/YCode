/**
 * useServices —— 通过 React Context 提供 IServiceAccessor
 *
 * 替代 props drilling，组件通过 useServices() 直接获取服务。
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ServiceConnectionState } from "@/root/types.js";

interface ServiceContextValue {
  services: IServiceAccessor;
  connection: ServiceConnectionState;
}

const DEFAULT_CONNECTION: ServiceConnectionState = {
  status: "connected",
  generation: 0,
  rpcReady: true,
};

const ServiceContext = createContext<ServiceContextValue | null>(null);

export function ServiceProvider({
  services,
  connection,
  children,
}: {
  services: IServiceAccessor;
  connection?: ServiceConnectionState;
  children: ReactNode;
}) {
  const parent = useContext(ServiceContext);
  const resolvedConnection = connection ?? parent?.connection ?? DEFAULT_CONNECTION;
  const value = useMemo(
    () => ({ services, connection: resolvedConnection }),
    [resolvedConnection, services],
  );
  return <ServiceContext.Provider value={value}>{children}</ServiceContext.Provider>;
}

export function useServices(): IServiceAccessor {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices 必须在 ServiceProvider 内使用");
  }
  return ctx.services;
}

export function useServiceConnection(): ServiceConnectionState {
  return useContext(ServiceContext)?.connection ?? DEFAULT_CONNECTION;
}

export function useOptionalServices(): IServiceAccessor | null {
  return useContext(ServiceContext)?.services ?? null;
}

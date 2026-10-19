import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * 模型设置页「页面级刷新」的共享信号。
 *
 * 顶部刷新按钮本来就是整页数据的刷新入口（模型列表、Team Plan 产品、Coding Plan
 * 权益都挂在它上面），卡片自己的数据源（OpenCode 用量、额度/余额卡片）通过订阅 tick
 * 变化重取，不必再让用户去点卡片里的按钮。
 *
 * tick 从 0 开始且只在点击刷新时递增：卡片挂载时读到的初始值不代表刷新请求，
 * 不能据此触发一次多余的网络往返。
 *
 * pendingCount 描述「在途查询」：额度/余额类卡片查询期间计数 +1，结束后 -1。
 * 页面级刷新按钮据此进入 Loading 态，让用户看得到查询正在进行——否则页面看起来
 * 已经刷新完了，卡片却还是空白的。
 */
export interface ModelProviderRefreshSignal {
  /** 页面级刷新的 tick：用户点顶部刷新时递增，订阅者据此重取。 */
  tick: number;
  /** 在途的额度/余额查询数量；>0 时顶部刷新按钮显示 Loading 态。 */
  pendingCount: number;
  /** 触发一次页面级刷新（tick +1）。 */
  triggerRefresh: () => void;
  /** 订阅者开始一次在途查询。 */
  beginPending: () => void;
  /** 订阅者结束一次在途查询。 */
  endPending: () => void;
}

/** Provider 之外（例如孤立渲染的组件）使用的空信号：所有动作都是空操作。 */
const EMPTY_REFRESH_SIGNAL: ModelProviderRefreshSignal = {
  tick: 0,
  pendingCount: 0,
  triggerRefresh: () => undefined,
  beginPending: () => undefined,
  endPending: () => undefined,
};

const ModelProviderRefreshSignalContext =
  createContext<ModelProviderRefreshSignal>(EMPTY_REFRESH_SIGNAL);

export function ModelProviderRefreshSignalProvider({
  value,
  children,
}: {
  value: ModelProviderRefreshSignal;
  children: ReactNode;
}) {
  return (
    <ModelProviderRefreshSignalContext.Provider value={value}>
      {children}
    </ModelProviderRefreshSignalContext.Provider>
  );
}

/** 页面级刷新信号（仅本模块内部消费，不对外暴露）。 */
function useRefreshSignalValue(): ModelProviderRefreshSignal {
  return useContext(ModelProviderRefreshSignalContext);
}

/** 当前页面级刷新的 tick；值变化即表示用户点了顶部刷新。 */
export function useModelProviderRefreshTick(): number {
  return useRefreshSignalValue().tick;
}

/**
 * 页面级刷新的状态所有者：tick 驱动卡片重取，pendingCount 描述在途查询。
 * 由设置页布局持有，再通过 Provider 下发给订阅卡片。
 */
export function useModelProviderRefreshController(): ModelProviderRefreshSignal {
  const [tick, setTick] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const triggerRefresh = useCallback(() => setTick((value) => value + 1), []);
  const beginPending = useCallback(() => setPendingCount((count) => count + 1), []);
  // 计数不能为负：卸载与重入可能让配对关系短暂失衡，下限兜底避免按钮卡在加载态。
  const endPending = useCallback(() => setPendingCount((count) => Math.max(0, count - 1)), []);
  return useMemo(
    () => ({ tick, pendingCount, triggerRefresh, beginPending, endPending }),
    [tick, pendingCount, triggerRefresh, beginPending, endPending],
  );
}

/**
 * 把「查询在途」上报给页面级刷新信号：顶部刷新按钮据此进入 Loading 态。
 *
 * 计数必须成对增减：查询结束归还一次，组件在查询途中卸载时也要归还，
 * 否则顶部刷新按钮会永久停在加载态。
 */
export function useReportModelProviderPending(loading: boolean): void {
  const { beginPending, endPending } = useRefreshSignalValue();
  const pendingRef = useRef(false);
  useEffect(() => {
    if (loading === pendingRef.current) return;
    pendingRef.current = loading;
    if (loading) {
      beginPending();
    } else {
      endPending();
    }
  }, [loading, beginPending, endPending]);
  useEffect(
    () => () => {
      if (!pendingRef.current) return;
      pendingRef.current = false;
      endPending();
    },
    [endPending],
  );
}

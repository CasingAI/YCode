import { useCallback, useEffect, useRef, useState } from "react";
import { chatGPTPlanStateSchema, type ChatGPTPlanState } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

export function useChatGPTPlan(enabled: boolean) {
  const { chatGPTPlanService: service } = useServices();
  const [projection, setProjection] = useState<{ service: object; state: ChatGPTPlanState }>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    setFailed(false);
    if (!enabled || !service) return;
    let active = true;
    const apply = (state: ChatGPTPlanState) => {
      if (active) {
        setProjection({ service, state: chatGPTPlanStateSchema.parse(state) });
        setFailed(false);
      }
    };
    const subscription = service.onDidChange(apply);
    void service
      .getState()
      .then(apply)
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      subscription.dispose();
    };
  }, [enabled, service]);
  const run = useCallback(
    async <T>(
      action: (target: NonNullable<typeof service>) => Promise<T>,
    ): Promise<T | undefined> => {
      if (!enabled || !service) return;
      const current = ++generation.current;
      setBusy(true);
      setFailed(false);
      try {
        const result = await action(service);
        const state = chatGPTPlanStateSchema.parse(await service.getState());
        if (current === generation.current) setProjection({ service, state });
        return result;
      } catch {
        if (current === generation.current) setFailed(true);
        return undefined;
      } finally {
        if (current === generation.current) setBusy(false);
      }
    },
    [enabled, service],
  );
  return {
    available: enabled && Boolean(service),
    // Web 缺少 Host 服务时，两侧 undefined 也会相等；必须先确认投影存在再读取。
    state: enabled && projection && projection.service === service ? projection.state : undefined,
    busy,
    failed,
    run,
  };
}

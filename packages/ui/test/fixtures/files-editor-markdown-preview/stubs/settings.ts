type Probe = {
  updateCalls: unknown[];
} & Record<string, unknown>;

function probe(): Probe {
  const root = globalThis as typeof globalThis & { __filesE2E?: Probe };
  root.__filesE2E ??= { updateCalls: [] } as Probe;
  root.__filesE2E.updateCalls ??= [];
  return root.__filesE2E;
}

// 只替换设置服务边界；组件内的 settings 读取逻辑保持真实。
const value = {
  settings: {
    fileLanguageAssociations: {} as Record<string, string>,
  },
  update: async (patch: unknown) => {
    probe().updateCalls.push(patch);
  },
};

export function useSettings() {
  return value;
}

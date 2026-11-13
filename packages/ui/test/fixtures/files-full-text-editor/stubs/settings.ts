// 只替换设置服务边界；组件内的 settings 读取逻辑保持真实。
const value = {
  settings: {
    fileLanguageAssociations: {} as Record<string, string>,
  },
  update: async (_patch: unknown) => {},
};

export function useSettings() {
  return value;
}

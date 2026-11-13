// 只替换宿主平台边界：夹具没有 Desktop/Web 宿主，外链回调保持 undefined。
export function useOptionalPlatform() {
  return undefined;
}

export function usePlatform() {
  return undefined;
}

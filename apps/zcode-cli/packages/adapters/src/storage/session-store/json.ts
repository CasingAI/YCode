export function encodeJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function decodeJson<T>(value: string | null): T | undefined {
  return value ? (JSON.parse(value) as T) : undefined;
}

/** 读取历史 JSON 列时容错：损坏或非对象内容返回 undefined，不打断 Fork 边界校验。 */
export function tryDecodeJsonObject(value: string): Record<string, any> | undefined {
  try {
    const decoded = JSON.parse(value) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, any>)
      : undefined;
  } catch {
    return undefined;
  }
}

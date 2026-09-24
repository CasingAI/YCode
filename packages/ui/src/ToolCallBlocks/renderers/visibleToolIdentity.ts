const INTERNAL_RUNTIME_IDENTITY_PATTERN = /^(?:agent|background|exec|subagent|task|workflow)_/iu;

export function isInternalRuntimeIdentity(value: string | undefined): boolean {
  return value !== undefined && INTERNAL_RUNTIME_IDENTITY_PATTERN.test(value.trim());
}

export function isSafeVisibleToolTitle(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !isInternalRuntimeIdentity(value);
}

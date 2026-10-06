export const CLI_VERSION_SIDECAR_FILE_NAME = "cli-version.json";

const CLI_BUILD_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function isBoundCliBuildVersion(version: string | undefined): version is string {
  return typeof version === "string" && CLI_BUILD_VERSION_PATTERN.test(version.trim());
}

export function parseCliVersionSidecar(value: unknown): string | undefined {
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const version = (value as { version?: unknown }).version;
  return typeof version === "string" && isBoundCliBuildVersion(version)
    ? version.trim()
    : undefined;
}

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLI_VERSION_SIDECAR_NAME = "cli-version.json";
export const CLI_BUILD_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function isBoundCliBuildVersion(version) {
  return typeof version === "string" && CLI_BUILD_VERSION_PATTERN.test(version.trim());
}

export function parseCliVersionSidecar(value) {
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const version = value.version;
  return isBoundCliBuildVersion(version) ? version.trim() : undefined;
}

export function readCliVersionSidecar(directory) {
  if (typeof directory !== "string" || directory.trim() === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CLI_VERSION_SIDECAR_NAME), "utf8"));
    return parseCliVersionSidecar(parsed);
  } catch {
    return undefined;
  }
}

export function writeCliVersionSidecar(directory, version) {
  if (!isBoundCliBuildVersion(version)) {
    throw new Error(
      `CLI sidecar version must match <major>.<minor>.<patch>, received ${JSON.stringify(version)}`,
    );
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, CLI_VERSION_SIDECAR_NAME),
    `${JSON.stringify({ version: version.trim() }, null, 2)}\n`,
    "utf8",
  );
}

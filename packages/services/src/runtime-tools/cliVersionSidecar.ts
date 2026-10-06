import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI_VERSION_SIDECAR_FILE_NAME, parseCliVersionSidecar } from "@zcode/shared";

export function readCliVersionSidecarAt(directory: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(directory, CLI_VERSION_SIDECAR_FILE_NAME), "utf8"),
    );
    return parseCliVersionSidecar(parsed);
  } catch {
    return undefined;
  }
}

export function readCliVersionSidecarForBundle(bundlePath: string): string | undefined {
  return readCliVersionSidecarAt(dirname(bundlePath));
}

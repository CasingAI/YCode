import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { HISTORY_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/history-read-lane-worker-bundle.mjs";
import { SQLITE_READ_LANE_WORKER_BUNDLE_NAME } from "../apps/zcode-cli/packages/cli/scripts/sqlite-read-lane-worker-bundle.mjs";
import { resolveAgentBundlePaths } from "../packages/desktop/scripts/stage-agent-bundle.mjs";

export function buildRequiredPrebuiltArtifacts({ repoRoot, desktopRoot, platformKey }) {
  const agentBundlePaths = resolveAgentBundlePaths({ repoRoot, platformKey });
  return [
    { label: "desktop main bundle", path: resolve(desktopRoot, "out/main/index.js") },
    { label: "desktop host bundle", path: resolve(desktopRoot, "out/host/index.js") },
    { label: "desktop scheduler bundle", path: resolve(desktopRoot, "out/scheduler/index.js") },
    { label: "desktop preload bundle", path: resolve(desktopRoot, "out/preload/index.cjs") },
    { label: "desktop renderer", path: resolve(desktopRoot, "out/renderer/index.html") },
    { label: "mobile web bundle", path: resolve(repoRoot, "packages/web/dist/index.html") },
    { label: "agent CLI bundle (bundled-agents)", path: agentBundlePaths.stagedBundlePath },
    {
      label: "agent CLI version sidecar (bundled-agents)",
      path: agentBundlePaths.stagedVersionSidecarPath,
    },
    {
      label: "History read lane worker (bundled-agents)",
      path: join(agentBundlePaths.glmDir, HISTORY_READ_LANE_WORKER_BUNDLE_NAME),
    },
    {
      label: "SQLite read lane worker (bundled-agents)",
      path: join(agentBundlePaths.glmDir, SQLITE_READ_LANE_WORKER_BUNDLE_NAME),
    },
    {
      label: "official plugin asset browser-use (bundled-agents)",
      path: join(
        agentBundlePaths.glmDir,
        "packages",
        "browser-use-plugin",
        ".zcode-plugin",
        "plugin.json",
      ),
    },
    {
      label: "official plugin asset node-repl-host (bundled-agents)",
      path: join(
        agentBundlePaths.glmDir,
        "packages",
        "node-repl-host",
        ".zcode-plugin",
        "plugin.json",
      ),
    },
  ];
}

export function findMissingPrebuiltArtifacts(artifacts, exists = existsSync) {
  return artifacts.filter((artifact) => !exists(artifact.path));
}

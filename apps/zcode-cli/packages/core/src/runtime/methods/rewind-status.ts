import type { AgentRuntimeInternal } from "../internal.js";

export async function formatRewindStatus(this: AgentRuntimeInternal): Promise<string> {
  const projection = await this.rebuildProjection();
  const checkpoint = projection.lastCheckpoint;
  if (!checkpoint) {
    return "No workspace checkpoint is available yet.";
  }

  const fileText =
    checkpoint.fileCount === undefined
      ? "unknown files"
      : `${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? "" : "s"}`;
  const compactText = checkpoint.coveredByCompact
    ? `, covered by compact ${checkpoint.compactBoundaryId ?? "boundary"}`
    : "";
  return `Latest checkpoint: ${checkpoint.checkpointId} (${fileText}${compactText}). Run /rewind latest to restore workspace files from it.`;
}

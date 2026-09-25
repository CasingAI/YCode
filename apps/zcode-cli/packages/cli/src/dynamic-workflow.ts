const DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE";

/** 直接 CLI 默认关闭；只有显式合法模式才把 Workflow 工具交给 Runtime。 */
export function resolveDirectCliDynamicWorkflowEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const mode = env[DYNAMIC_WORKFLOW_MODE_ENV]?.trim();
  return mode === "onDemand" || mode === "alwaysOn";
}

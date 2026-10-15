import { CoreErrorType, createCoreError, isCoreError } from "@zcode/contracts";
import type { RuntimeInputValidationIssue } from "../input-normalization.js";
import { projectInitialModelValidationContent } from "../input-validation-model-content.js";
import { validateJsonSchemaValue } from "../json-schema.js";
import type { ToolEntry } from "../types.js";

const INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY = "initialInputValidationModelContent";

export function validateOutput(output: unknown, entry: ToolEntry): void {
  const runtimeSchemaValidation = validateRuntimeSchema(output, entry.runtimeOutputSchema);
  if (runtimeSchemaValidation === true) return;
  if (Array.isArray(runtimeSchemaValidation)) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Tool output failed runtimeOutputSchema validation",
      {
        context: {
          errors: runtimeSchemaValidation.slice(0, 20),
          toolName: entry.metadata.name,
        },
        recoverable: false,
      },
    );
  }

  const validation = validateJsonSchemaValue(output, entry.outputSchema);
  if (validation.valid) return;

  throw createCoreError(
    CoreErrorType.ToolExecutionFailed,
    "Tool output failed outputSchema validation",
    {
      context: {
        errors: validation.errors.slice(0, 20),
        toolName: entry.metadata.name,
      },
      recoverable: false,
    },
  );
}

function validateRuntimeSchema(output: unknown, schema: unknown): true | string[] | undefined {
  if (!isSafeParseSchema(schema)) return undefined;
  const parsed = schema.safeParse(output);
  if (parsed.success) return true;
  return parsed.error.issues.map((issue) => issue.message);
}

function isSafeParseSchema(schema: unknown): schema is {
  safeParse: (
    value: unknown,
  ) =>
    | { success: true; data: unknown }
    | { success: false; error: { issues: Array<{ message: string }> } };
} {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "safeParse" in schema &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

export function validateInput(input: unknown, entry: ToolEntry): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  if (validation.valid) return undefined;

  return createInputValidationError(entry, validation.errors);
}

export function validateInitialModelToolInput(
  input: unknown,
  entry: ToolEntry,
  runtimeValidationIssues?: readonly RuntimeInputValidationIssue[],
): Error | undefined {
  const validation = validateJsonSchemaValue(input, entry.inputSchema);
  // 原因与修复依据：superRefine/refine 等运行时专属约束表达不进 JSON Schema，
  // 粗检通过不代表运行时 schema 通过。此前在这里提前 return 把 runtime issues
  // 整批丢弃，调用穿透到 handler 内的裸 parse 抛出 ZodError，模型和 UI 只能
  // 收到未翻译的内部 issue JSON（Sandbox「code/filePath 二选一」即因此漏出）。
  // runtime-only 失败必须同样走投影机制生成可读错误。
  const hasRuntimeIssues = (runtimeValidationIssues?.length ?? 0) > 0;
  if (validation.valid && !hasRuntimeIssues) return undefined;

  // 模型原始参数的首次 schema 失败需要把具体问题回传给模型；Hook 或权限
  // 修改后的输入属于不同生命周期，不能复用这段 provider-visible 内容。
  const { modelContent, readableMessage } = projectInitialModelValidationContent(
    entry,
    validation.issues,
    runtimeValidationIssues,
  );
  return createInputValidationError(entry, validation.errors, modelContent, readableMessage);
}

export function getInitialInputValidationModelContent(error: Error): string | undefined {
  if (!isCoreError(error) || error.type !== CoreErrorType.ToolExecutionFailed) {
    return undefined;
  }
  const modelContent = error.context?.[INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY];
  return typeof modelContent === "string" ? modelContent : undefined;
}

function createInputValidationError(
  entry: ToolEntry,
  errors: string[],
  modelContent?: string,
  readableMessage?: string,
): Error {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    // message 是 UI hover 与错误行的共同来源：优先用投影后的具体文案，
    // 不再笼统显示校验失败占位；模型通道仍由 modelContent 的包装形式承担。
    readableMessage ?? "Tool input failed inputSchema validation",
    {
      context: {
        errors: errors.slice(0, 20),
        toolName: entry.metadata.name,
        ...(modelContent === undefined
          ? {}
          : { [INITIAL_INPUT_VALIDATION_MODEL_CONTENT_KEY]: modelContent }),
      },
      recoverable: true,
    },
  );
}

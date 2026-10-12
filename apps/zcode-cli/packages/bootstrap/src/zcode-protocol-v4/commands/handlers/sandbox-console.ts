// 沙盒控制台可交互命令组：sandboxEval / sandboxReset（阶段8）。
//
// - sandboxEval：控制台用户输入一行立刻 eval，不受工具必填说明 / return 协议
//   约束；仍进同一活实例。用户 eval 也塞展示行（实例表 source=user，样式与模型
//   来源区分）。不写聊天 transcript，不给模型新实例类提示。
// - sandboxReset：销毁实例、LocalStorage 留下；在途 Sandbox 按失败结算，
//   后台 ID 全失效（实例表 dispose 已收口）。
// - 失败态用协议 kind（result.kind），不靠抛错：handler 只在会话缺席/能力缺席
//   时抛（V4SessionNotFoundError / V4CapabilityUnsupportedError），eval 本身的
//   失败走 result kind 回 ACK result。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4CapabilityUnsupportedError } from "./interaction-background.js";

async function sandboxEval(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sandboxEval"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.evalSandboxForUser) {
    throw new V4CapabilityUnsupportedError(
      "evalSandboxForUser",
      record.app.sessionId ?? envelope.sessionId ?? "(unknown)",
    );
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.evalSandboxForUser(payload.code, record.app.sessionId);
  // 新实例诞生即推投影：控制台/状态面板订阅者在下一帧看到 alive=true，
  // 不再等 sandboxStatus 轮询节拍（docs/specs/sandbox-projection-push.md）。
  // 失败态不推——投影只表达存在性事实，eval 失败不写成死亡。
  // 原因与修复依据：envelope.sessionId 与 record 同一会话（requireRecord 已校验），
  // 直接用它做投影键，不依赖 app.sessionId 的可选类型。
  if (result.kind === "completed" && result.isNewInstance === true && envelope.sessionId) {
    host.refreshSandboxProjection?.(envelope.sessionId, true);
  }
  return { type: "sandboxEval", result };
}

async function sandboxReset(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.resetSandboxInstance) {
    throw new V4CapabilityUnsupportedError(
      "resetSandboxInstance",
      record.app.sessionId ?? envelope.sessionId ?? "(unknown)",
    );
  }
  // 注意：方法必须经 app 调用（不可解构，实现可能依赖 this 绑定）。
  const result = await record.app.resetSandboxInstance(record.app.sessionId);
  // 实例销毁即推投影：订阅者在下一帧看到 alive=false，左侧卡片与已开 tab 的
  // 死亡覆盖同帧收敛，不再等 sandboxStatus 轮询节拍
  // （docs/specs/sandbox-projection-push.md）。失败态不推——投影只表达存在性
  // 事实，reset 失败（unavailable/unsupported）不写成死亡。
  if (result.kind === "reset" && envelope.sessionId) {
    host.refreshSandboxProjection?.(envelope.sessionId, false);
  }
  return { type: "sandboxReset", result };
}

export const sandboxConsoleHandlers = {
  sandboxEval,
  sandboxReset,
} as const;

// resumeSuspendedTurn handler 的契约（docs/specs/session-error-banner-continue.md §4.3）。
//
// 这是「用户点继续」到「core 续跑」之间的唯一一跳：UI 点按钮 → dispatchCommand →
// 本 handler → runtime.beginResumeFailedTurn。前面投影测试只锁了 TurnResumed 的投影归约，
// core 测试只锁了续跑执行；中间这跳若断掉，表现就是用户点「继续」毫无反应，
// 所以这里锁三件事：
//   1. 透传：failedTurnId 原样交给 core，不被改写、不被替换成新输入。
//   2. ack 形状：成功返回 inputAccepted + startNow，横幅据此消失。
//   3. 拒绝可见：core 拒绝时抛带 reasonCode 的错误，UI 才能显示 chat.error.continueFailed；
//      同时保证「整轮跑失败」不会污染这次请求的 ack（它已被转成 TurnError 事件）。
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";
import { resumeSuspendedHandlers } from "../src/zcode-protocol-v4/commands/handlers/resume-suspended.js";

const SESSION_ID = "session-resume-handler";

interface Call {
  failedTurnId?: string;
  inputId?: string;
}

/**
 * 造 host。core 行为由 options 决定：接受 / 起跑前拒绝 / 起跑后整轮失败。
 * 返回 resumeArgs 供断言 core 到底收到了什么。
 */
function fakeHost(options: {
  accept?: boolean;
  /** 起跑之后整轮失败（ack 已发出，completion 才 reject）。 */
  completionRejects?: boolean;
}): { host: V4CommandCoreHost; calls: Call[] } {
  const calls: Call[] = [];
  const host = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    // requireRecord 走 host.getRecord（见 commands/record-access.ts）。
    getRecord: () => ({
      app: {
        sessionId: SESSION_ID,
        runtime: {
          beginResumeFailedTurn: async (args: {
            failedTurnId: string;
            inputId?: string;
          }) => {
            calls.push({ failedTurnId: args.failedTurnId, inputId: args.inputId });
            if (options.accept === false) {
              throw new Error(`No failed turn to resume (${args.failedTurnId})`);
            }
            return {
              completion: options.completionRejects
                ? Promise.reject(new Error("turn failed again"))
                : Promise.resolve(),
            };
          },
        },
      },
      traceContext: { traceId: "trace-handler" },
    }),
  } as unknown as V4CommandCoreHost;
  return { host, calls };
}

function envelope(payload: unknown, commandId = "cmd-resume-1"): CommandEnvelope {
  return {
    commandId,
    payload,
    sessionId: SESSION_ID,
  } as unknown as CommandEnvelope;
}

const HANDLER = resumeSuspendedHandlers.resumeSuspendedTurn;

test("failedTurnId 原样透传给 core，不被改写成新输入", async () => {
  const { host, calls } = fakeHost({});
  const result = await HANDLER(host, envelope({ failedTurnId: "msg_user_abc" }));

  assert.deepEqual(calls, [{ failedTurnId: "msg_user_abc", inputId: "cmd-resume-1" }]);
  assert.equal(result?.type, "inputAccepted");
  assert.equal((result as { delivery?: string }).delivery, "startNow");
});

test("起跑后整轮失败不污染 ack：仍返回 accepted，失败由 TurnError 事件表达", async () => {
  const { host } = fakeHost({ completionRejects: true });
  // 若 handler 等整轮结果，rejection 会冒泡成 unhandled / 请求失败；
  // 这里必须照常 ack，且 rejection 已被 handler 内部消化。
  const result = await HANDLER(host, envelope({ failedTurnId: "msg_user_abc" }));
  assert.equal(result?.type, "inputAccepted");
  // 给 handler 内部的 catch 一个微任务机会，确保没有逃逸的 rejection。
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("core 拒绝 → 抛带 reasonCode 的错误，UI 能显示「继续失败」", async () => {
  const { host } = fakeHost({ accept: false });
  await assert.rejects(
    () => HANDLER(host, envelope({ failedTurnId: "msg_not_failed" })),
    (error: Error) => {
      assert.equal(error.name, "V4ResumeSuspendedRejectedError");
      assert.match(error.message, /notResumable|No failed turn to resume/u);
      return true;
    },
  );
});
import assert from "node:assert/strict";
import test from "node:test";
import { BOT_SEND_MESSAGE_TOOL_NAME } from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { botSendMessageToolEntry } from "../src/tool/handlers/bot-send-message.js";

test("bot_send_message 不因 sideEffectScope 落入 tool.userInteraction ask", () => {
  const service = new PermissionService();
  const capability = {
    readOnly: botSendMessageToolEntry.metadata.readOnly,
    sideEffectScope: botSendMessageToolEntry.metadata.sideEffectScope,
    needsApproval: botSendMessageToolEntry.metadata.needsApproval,
    permission: botSendMessageToolEntry.permission,
  };
  // userInteraction 短路在 mode 分支之前；即便 yolo 也挡不住旧声明。修后必须放行。
  const decision = service.checkPermission(
    {
      toolName: BOT_SEND_MESSAGE_TOOL_NAME,
      input: { text: "在的" },
      riskLevel: "low",
      mode: "yolo",
    },
    capability,
  );
  assert.equal(decision.decision, "allow");
  assert.notEqual(decision.ruleId, "tool.userInteraction");
});

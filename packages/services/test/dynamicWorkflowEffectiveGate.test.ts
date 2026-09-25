import test from "node:test";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

test("Dynamic Workflow service 只同步用户设置", async () => {
  const service = createZCodeAgentService();

  try {
    await service.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: true,
      dynamicWorkflowEnabled: true,
    });
    await service.syncAppRuntimePreferences({
      askUserQuestionAutoResolutionEnabled: true,
      dynamicWorkflowEnabled: false,
    });
  } finally {
    await service.disposeAllAndWait();
  }
});

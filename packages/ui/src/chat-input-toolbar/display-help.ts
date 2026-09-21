import type { ZCodeProvider } from "@zcode/shared";

export const ZCODE_MODE_OPTION_LABEL_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    plan: "mode.label.glm.plan",
    readonly: "mode.label.glm.readonly",
    yolo: "mode.label.glm.yolo",
  },
};

export const ZCODE_MODE_OPTION_DESCRIPTION_IDS: Record<ZCodeProvider, Record<string, string>> = {
  glm: {
    plan: "mode.description.glm.plan",
    readonly: "mode.description.glm.readonly",
    yolo: "mode.description.glm.yolo",
  },
};

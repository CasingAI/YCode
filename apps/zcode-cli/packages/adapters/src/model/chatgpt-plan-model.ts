import type { createOpenAI } from "@ai-sdk/openai";

type ResponsesModel = ReturnType<ReturnType<typeof createOpenAI>["responses"]>;

/** 必须在 SDK 序列化历史之前关闭 store，否则 SDK 会生成依赖服务端存储的 item_reference。 */
export function withChatGPTPlanHistory(model: ResponsesModel): ResponsesModel {
  return new Proxy(model, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "doGenerate" || property === "doStream") {
        return (options: Parameters<ResponsesModel["doStream"]>[0]) =>
          value.call(target, {
            ...options,
            providerOptions: {
              ...options.providerOptions,
              openai: {
                ...options.providerOptions?.openai,
                store: false,
                previousResponseId: undefined,
                conversation: undefined,
              },
            },
          });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/* eslint-disable max-lines -- 模型供应商 schema、迁移和运行时投影 helper 需要共享同一套类型边界，暂时集中在单文件避免契约分散。 */
// 智谱剥离：account:* 内置 Provider 身份定义已删除，仅保留模板 ID 与连通性结果。
// 删除原因：Zhipu account 供应商体系下线，shared 定义层不再维护 account:* 身份与分支判断。
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
} as const;

/** 一个正式 Model 的连通性测试结果。 */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** 设置连接测试边界已确认的资格失败；其他执行错误保留原消息。 */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };

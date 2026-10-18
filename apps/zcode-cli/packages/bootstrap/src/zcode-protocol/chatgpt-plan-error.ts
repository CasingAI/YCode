import { CHATGPT_PLAN_USAGE_URL } from "@zcode/shared";

export function createChatGPTPlanRequestError(code: string): Error {
  const quota =
    code === "subscription_sharing_usage_limit_exceeded" ||
    code === "subscription_sharing_usage_unavailable" ||
    code === "responses_http_429";
  const message = quota
    ? `ChatGPT plan usage is unavailable. Manage usage: ${CHATGPT_PLAN_USAGE_URL} (${code})`
    : code === "reauthentication_required"
      ? "Sign in to your ChatGPT account again (reauthentication_required)."
      : code === "plan_permission_required"
        ? "Authorize ChatGPT plan usage in account settings (plan_permission_required)."
        : `ChatGPT plan request failed (${code}).`;
  const httpStatus = /_http_(\d{3})$/.exec(code)?.[1];
  return Object.assign(new Error(message), {
    name: "ChatGPTPlanRequestError",
    code,
    ...(httpStatus ? { statusCode: Number(httpStatus) } : quota ? { statusCode: 429 } : {}),
  });
}

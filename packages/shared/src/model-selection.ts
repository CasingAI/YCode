import { z } from "zod";

const modelGroupTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const modelGroupEndTimeSchema = z.union([modelGroupTimeSchema, z.literal("24:00")]);
const modelGroupWindowSchema = z
  .object({
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
    startTime: modelGroupTimeSchema,
    endTime: modelGroupEndTimeSchema,
  })
  .strict()
  .refine((window) => window.startTime !== window.endTime, {
    message: "模型组降优先级窗口起止时间不能相同",
    path: ["endTime"],
  });

/** 成员降优先级窗口。星期使用 ISO 1..7；24:00 仅允许作为结束时间。 */
export const modelGroupDeprioritizeScheduleSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .refine((timeZone) => !/^[+-]/.test(timeZone), "必须使用 IANA 时区，不能使用数值 UTC 偏移")
      .refine((timeZone) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
          return true;
        } catch {
          return false;
        }
      }, "必须是有效的 IANA 时区"),
    windows: z.array(modelGroupWindowSchema).min(1),
  })
  .strict();

export type ModelGroupDeprioritizeSchedule = z.infer<typeof modelGroupDeprioritizeScheduleSchema>;

/** 用户对后续模型执行的完整选择；不表达已经创建的 Active Model。 */
export const modelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/**
 * 配置面的组意图（docs/specs/model-group.md）：身份只有组 ID + 选中当下的组名快照。
 * 与 ModelSelection 互斥（命令 payload superRefine 校验）；不带思考档位——
 * 档位跟会话钉死成员走，不跟组意图走。
 */
export const modelGroupIntentSchema = z
  .object({
    groupId: z.string().trim().min(1),
    groupNameSnapshot: z.string(),
  })
  .strict();

export type ModelGroupIntent = z.infer<typeof modelGroupIntentSchema>;

/** 组意图类型守卫：与 ModelSelection 共用联合值时的窄化入口。 */
export function isModelGroupIntent(value: unknown): value is ModelGroupIntent {
  return modelGroupIntentSchema.safeParse(value).success;
}

/** 组意图等值比较：组 ID 即身份；名快照是展示事实，不参与意图相等判定。 */
export function sameModelGroupIntent(
  left: ModelGroupIntent | undefined,
  right: ModelGroupIntent | undefined,
): boolean {
  return left?.groupId === right?.groupId;
}

/** 组成员身份与可选思考深度绑定；结构类型供 provider/core 双侧使用，不引入包依赖。 */
export interface ModelGroupMemberRef {
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevel?: string;
  readonly selectable?: boolean;
  readonly deprioritizeSchedule?: ModelGroupDeprioritizeSchedule;
}

const weekdayNumber: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function isInDeprioritizeWindow(schedule: ModelGroupDeprioritizeSchedule, now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const day = weekdayNumber[values.weekday ?? ""];
  const minuteOfDay = Number(values.hour) * 60 + Number(values.minute);
  if (!day || !Number.isFinite(minuteOfDay)) return false;

  return schedule.windows.some((window) => {
    const [startHour, startMinute] = window.startTime.split(":").map(Number);
    const [endHour, endMinute] = window.endTime.split(":").map(Number);
    const start = startHour! * 60 + startMinute!;
    const end = endHour! * 60 + endMinute!;
    if (end > start) {
      return window.daysOfWeek.includes(day) && minuteOfDay >= start && minuteOfDay < end;
    }
    if (end < start) {
      const previousDay = day === 1 ? 7 : day - 1;
      return (
        (window.daysOfWeek.includes(day) && minuteOfDay >= start) ||
        (window.daysOfWeek.includes(previousDay) && minuteOfDay < end)
      );
    }
    return false;
  });
}

/**
 * 只为新钉死/重钉选择候选，不改成员快照。缺省 selectable 视为 true；
 * 若至少有一个成员当前未命中降级时段，仅返回正常池，否则回退到降级池。
 */
export function selectModelGroupCandidates<T extends ModelGroupMemberRef>(
  members: readonly T[],
  now: Date,
): T[] {
  const normal: T[] = [];
  const deprioritized: T[] = [];
  for (const member of members) {
    if (member.selectable === false) continue;
    if (member.deprioritizeSchedule && isInDeprioritizeWindow(member.deprioritizeSchedule, now)) {
      deprioritized.push(member);
    } else {
      normal.push(member);
    }
  }
  return normal.length > 0 ? normal : deprioritized;
}

/** FNV-1a 32 位：零依赖、跨进程一致，成员抽选的均匀度足够。 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 哈希抽选（docs/specs/model-group.md）：输入 = 抽选种子 + 组 ID，对**当时仍可用**的
 * 成员按组配置顺序取下标。调用方负责先过滤可用成员；空名单返回 undefined（失败语义
 * 由 admission 裁决，这里不抛）。同一颗种子 + 同一份可用名单必然抽回同一成员——
 * A→B→A 抽回原成员、父子会话接到同一新成员都靠这条纯函数保证。
 */
export function pickModelGroupMember(input: {
  readonly pickSeed: string;
  readonly groupId: string;
  readonly availableMembers: readonly ModelGroupMemberRef[];
}): ModelGroupMemberRef | undefined {
  const { pickSeed, groupId, availableMembers } = input;
  if (availableMembers.length === 0) return undefined;
  const index = fnv1a32(`${pickSeed}\u0000${groupId}`) % availableMembers.length;
  return availableMembers[index];
}

/**
 * 显式选择的三字段等值比较：providerId / modelId / reasoningLevel。
 * 必须按「稀疏的显式 Selection」比较，不能用补全默认值后的完整选项比——
 * 否则一边带默认档位、一边不带时永不相等。
 */
export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.providerId === right?.providerId &&
    left?.modelId === right?.modelId &&
    left?.options?.reasoningLevel === right?.options?.reasoningLevel
  );
}

/** 公共解析结果。页面可以展示不完整选择，执行入口必须同时检查 selectionIssue。 */
export interface EffectiveModelSelectionResult {
  readonly effectiveSelection: ModelSelection | null;
  readonly selectionIssue?:
    | "selection-missing"
    | "account-connection-unavailable"
    | "provider-not-found"
    | "model-not-found"
    | "reasoning-level-missing"
    | "reasoning-level-not-supported";
}

export const ZCODE_MODEL_REASONING_SEPARATOR = "$";

/** UI Picker/legacy CLI 的展示值；不是可逆的 ModelSelection 序列化格式。 */
export function formatModelPickerValue(selection: ModelSelection | undefined): string {
  // 只在显示边界把未绑定表示为空；实际执行仍校验完整 ModelSelection。
  if (!selection) return "";
  const base = `${selection.providerId}/${selection.modelId}`;
  const reasoningLevel = selection.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

/** 只解析 Picker/legacy 字符串边界；领域状态与协议必须直接保存 ModelSelection。 */
export function parseModelPickerValue(value: string): ModelSelection {
  const normalized = value.trim();
  const providerSeparatorIndex = normalized.indexOf("/");
  if (providerSeparatorIndex <= 0) {
    throw new Error(`模型选择缺少 Provider: ${normalized}`);
  }
  const providerId = normalized.slice(0, providerSeparatorIndex);
  const rawModelId = normalized.slice(providerSeparatorIndex + 1);
  const reasoningSeparatorIndex = rawModelId.indexOf(ZCODE_MODEL_REASONING_SEPARATOR);
  if (reasoningSeparatorIndex <= 0 || reasoningSeparatorIndex >= rawModelId.length - 1) {
    return modelSelectionSchema.parse({ providerId, modelId: rawModelId });
  }
  return modelSelectionSchema.parse({
    providerId,
    modelId: rawModelId.slice(0, reasoningSeparatorIndex),
    options: { reasoningLevel: rawModelId.slice(reasoningSeparatorIndex + 1) },
  });
}

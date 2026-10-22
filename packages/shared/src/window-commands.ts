import { z } from "zod";

/**
 * 窗口结构命令的广播 channel。
 *
 * 手机远控端与桌面 renderer 在同一 Host 内共享同一个广播服务实例，
 * 消息会直达同 Host 的所有订阅者。命令只由镜像端发出，快照只由权威端发出，
 * 两条方向不交叉，因此不需要额外的来源标记来防回环。
 */
export const WINDOW_COMMAND_BROADCAST_CHANNEL = "state:window-command" as const;

/**
 * 命令回执的广播 channel。
 *
 * 命令没有单独的 ACK 通道就不能判断"权威端是否执行了这条命令"：
 * 靠"有没有收到更大的快照 revision"来推断会在无副作用的命令上误报
 * （例如切换到已经激活的会话，工作区结构不变，也就没有新快照）。
 * 权威端执行完命令后回一条回执，镜像端据此判断桌面端是否还活着。
 *
 * 回执走独立 channel，权威端的命令监听器因此不会把自己的回执当成命令再执行一次。
 */
export const WINDOW_COMMAND_ACK_BROADCAST_CHANNEL = "state:window-command-ack" as const;

/**
 * 命令的执行结果。
 *
 * `applied` 表示命令已在本窗口生效；`opened-in-other-window` 表示该工作区
 * 已经在另一个桌面窗口打开，桌面端沿用既有 `activateOrSetWorkspace` 语义
 * 激活了那个窗口，本窗口（以及镜像它的手机端）不会出现这个工作区。
 * 镜像端据此提示"已在其它窗口打开"，而不是让用户以为命令没生效。
 */
export const windowCommandOutcomeSchema = z.enum(["applied", "opened-in-other-window"]);
export type WindowCommandOutcome = z.infer<typeof windowCommandOutcomeSchema>;

export const windowCommandAckSchema = z
  .object({
    /** 对应命令的幂等键。 */
    commandId: z.string().trim().min(1),
    /** 权威端是否成功执行。 */
    ok: z.boolean(),
    /** 失败原因（仅用于日志与提示，不做本地回滚）。 */
    error: z.string().trim().min(1).optional(),
    /** 执行结果；缺省视为 applied。 */
    outcome: windowCommandOutcomeSchema.optional(),
  })
  .strict();
export type WindowCommandAck = z.infer<typeof windowCommandAckSchema>;

const windowCommandBaseSchema = z.object({
  /** 幂等键：同一次用户操作的重试复用同一个 id。 */
  commandId: z.string().trim().min(1),
});

export const windowCommandSchema = z.discriminatedUnion("type", [
  windowCommandBaseSchema
    .extend({
      type: z.literal("open-workspace"),
      workspacePath: z.string().trim().min(1),
      workspaceIdentity: z.string().trim().min(1).optional(),
      /**
       * 打开后立刻激活的会话。
       *
       * 打开工作区本身是 "workspace-only" 意图（会清掉该工作区当前会话），
       * 深链到某个会话时必须把两件事合成一条命令，否则两条命令之间的顺序
       * 竞争会让"打开"落在"激活"之后，把刚激活的会话又清回草稿。
       */
      activateTaskId: z.string().trim().min(1).optional(),
    })
    .strict(),
  windowCommandBaseSchema
    .extend({
      type: z.literal("ensure-workspace"),
      workspacePath: z.string().trim().min(1),
      workspaceIdentity: z.string().trim().min(1).optional(),
    })
    .strict(),
  windowCommandBaseSchema
    .extend({
      type: z.literal("close-workspace"),
      entryId: z.string().trim().min(1),
    })
    .strict(),
  windowCommandBaseSchema
    .extend({
      type: z.literal("activate-workspace"),
      entryId: z.string().trim().min(1),
    })
    .strict(),
  windowCommandBaseSchema
    .extend({
      type: z.literal("reorder-workspaces"),
      fromIndex: z.number().int().nonnegative(),
      toIndex: z.number().int().nonnegative(),
    })
    .strict(),
  windowCommandBaseSchema
    .extend({
      type: z.literal("set-workspace-expanded"),
      workspacePath: z.string().trim().min(1),
      expanded: z.boolean(),
    })
    .strict(),
  windowCommandBaseSchema
    .extend({
      type: z.literal("activate-task"),
      workspacePath: z.string().trim().min(1),
      workspaceIdentity: z.string().trim().min(1).optional(),
      taskId: z.string().trim().min(1).nullable(),
    })
    .strict(),
]);
export type WindowCommand = z.infer<typeof windowCommandSchema>;

/**
 * 不含幂等键的命令体；发送方负责补上 `commandId`。
 *
 * 这里必须用分配式 Omit：直接 `Omit<WindowCommand, "commandId">` 会把联合类型
 * 压成只保留公共字段的单对象类型，各分支自己的字段（workspacePath、entryId…）全部丢失。
 */
export type WindowCommandBody = WindowCommand extends infer Command
  ? Command extends { commandId: string }
    ? Omit<Command, "commandId">
    : never
  : never;

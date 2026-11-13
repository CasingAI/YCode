/**
 * Windows Host 生命周期 Job Object：给 Host 的全部后代一个不随父进程退出而消失的成员身份。
 *
 * 为什么要它：资源管理器按 PPID 找 Host 后代，但中间 shell 退出后，
 * 孙进程的 PPID 仍指向已消失的 PID，向下遍历在该处断开，存活进程就统计不到。
 * Job 成员身份由内核维护，后代创建时自动继承，中间层退出也不脱离。
 *
 * 职责边界（docs/specs/host-process-containment-cleanup.md）：
 * - 成员枚举只提供存活成员 PID，不提供 CPU/内存；指标仍来自进程表采样。
 * - 默认不设置 KILL_ON_JOB_CLOSE，保持纯统计语义；Host 初始化时显式传
 *   `killOnJobClose: true`，让句柄随 Host 进程退出由内核关闭并回收残留进程树。
 * - 必须在 CLI、Bash 等后代创建之前把 Host 自身加入作业。
 * - 原生能力不可用时返回 undefined，调用方回退到 PPID 树；清理保证同时降级，
 *   由 `onDiagnostic` 回调一次显式告知，不静默。
 */
import type * as Koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const ERROR_MORE_DATA = 234;
const ERROR_BAD_LENGTH = 24;
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION 在 x64 上为 144 字节，LimitFlags 位于 offset 16。
const EXTENDED_LIMIT_INFO_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const MAX_PID_LIST_BYTES = 16 * 1024 * 1024;
const PID_SIZE = process.arch === "ia32" ? 4 : 8;

type JobHandle = object;

export interface WindowsJobMembership {
  /** 当前仍存活的作业成员；查询失败返回 undefined，调用方交给 PPID 树兜底。 */
  listPids(): number[] | undefined;
  close(): void;
}

interface WindowsJobMembershipApi {
  createJob(options: { killOnJobClose: boolean }): JobHandle | undefined;
  assignSelf(job: JobHandle): boolean;
  queryPids(job: JobHandle): number[];
  close(job: JobHandle): void;
}

/**
 * 原生能力降级诊断。创建/加入作业失败时各调用一次；首次成员枚举失败也告警一次，
 * 由调用方决定日志级别，不在后续查询等高频路径上重复输出。
 */
export interface WindowsJobMembershipDiagnostic {
  stage: "create" | "assign" | "query";
  /** 底层失败原因摘要：仅错误码或异常名，不含原生库内部路径或凭据。 */
  reason: string;
}

interface CreateWindowsJobMembershipOptions {
  platform?: NodeJS.Platform;
  /**
   * 是否以 KILL_ON_JOB_CLOSE 创建。默认 false 保持统计用途不改变清理语义；
   * Host 生命周期容器显式传 true，句柄只在 Host 真正退出时由内核关闭并回收整棵派生树。
   * 绝不能在 Host 仍然存活时主动 close 该 Job，否则会先杀掉 Host 自己。
   */
  killOnJobClose?: boolean;
  /** 测试注入；默认动态加载 koffi。 */
  api?: WindowsJobMembershipApi;
  /** 降级诊断回调；缺省静默，调用方可接到 Host/service logger。 */
  onDiagnostic?: (diagnostic: WindowsJobMembershipDiagnostic) => void;
}

let nativeApiPromise: Promise<WindowsJobMembershipApi | undefined> | undefined;

export async function createWindowsJobMembership(
  options: CreateWindowsJobMembershipOptions = {},
): Promise<WindowsJobMembership | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const killOnJobClose = options.killOnJobClose === true;
  const report = options.onDiagnostic;
  const api = options.api ?? (await loadWindowsJobMembershipApi());
  if (!api) {
    // 原生模块不可用时仍回退 PPID 树，但要明确告知清理保证已降级。
    report?.({ stage: "create", reason: "native-module-unavailable" });
    return undefined;
  }

  let job: JobHandle | undefined;
  try {
    job = api.createJob({ killOnJobClose });
    // 允许显式 CREATE_BREAKAWAY_FROM_JOB 的进程照常启动；逃出作业的进程不再计入统计。
    if (!job) {
      report?.({ stage: "create", reason: "create-job-failed" });
      return undefined;
    }
    if (!api.assignSelf(job)) {
      report?.({ stage: "assign", reason: "assign-self-failed" });
      api.close(job);
      return undefined;
    }
  } catch (error) {
    report?.({ stage: job ? "assign" : "create", reason: describeError(error) });
    // 分配阶段抛错不代表内核没有把 Host 加进作业：原生桥接可能在 AssignProcessToJobObject
    // 成功后（返回值转换等）才抛出。此时 close kill-on-close 容器会立即终止 Host 自身，
    // 因此保留句柄直到进程退出，由 OS 关闭并安全回收；纯统计 Job 与“内核明确返回未加入”
    // 的路径仍按原语义关闭，避免句柄泄漏。
    if (job && !killOnJobClose) {
      try {
        api.close(job);
      } catch {
        // 纯统计句柄关闭失败不能阻断 Host 启动。
      }
    }
    return undefined;
  }

  let closed = false;
  let queryFailureReported = false;
  return {
    listPids() {
      if (closed) return undefined;
      try {
        return api.queryPids(job);
      } catch (error) {
        // 首次成员枚举失败说明容器可能已不可用（清理保证存疑），只告警一次；
        // 之后继续按 PPID 树兜底，避免每个采样 tick 重复刷同一条日志。
        if (!queryFailureReported) {
          queryFailureReported = true;
          report?.({ stage: "query", reason: describeError(error) });
        }
        return undefined;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      // kill-on-close 作业关闭即终止全体成员（含 Host 自身）。调用方只能在 Host 即将
      // 退出、或明确接受“关句柄即清树”的语义时调用，不能在存活期的资源回收阶段调用。
      api.close(job);
    },
  };
}

/** 只保留错误名/错误码，避免把原生库内部路径或凭据写进日志。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "unknown";
}

async function loadWindowsJobMembershipApi(): Promise<WindowsJobMembershipApi | undefined> {
  nativeApiPromise ??= createWindowsJobMembershipApi();
  return nativeApiPromise;
}

async function createWindowsJobMembershipApi(): Promise<WindowsJobMembershipApi | undefined> {
  try {
    const koffiModule = await import("koffi");
    const koffi = ("default" in koffiModule ? koffiModule.default : koffiModule) as typeof Koffi;
    const kernel32 = koffi.load("kernel32.dll");

    const createJobObject = kernel32.func(
      "void *CreateJobObjectW(void *lpJobAttributes, str16 lpName)",
    );
    const assignProcessToJobObject = kernel32.func(
      "int AssignProcessToJobObject(void *hJob, void *hProcess)",
    );
    const setInformationJobObject = kernel32.func(
      "int SetInformationJobObject(void *hJob, int JobObjectInformationClass, void *lpJobObjectInformation, uint32 cbJobObjectInformationLength)",
    );
    const queryInformationJobObject = kernel32.func(
      "int QueryInformationJobObject(void *hJob, int JobObjectInformationClass, void *lpJobObjectInformation, uint32 cbJobObjectInformationLength, _Out_ uint32 *lpReturnLength)",
    );
    const getCurrentProcess = kernel32.func("void *GetCurrentProcess()");
    const getLastError = kernel32.func("uint32 GetLastError()");
    const closeHandle = kernel32.func("int CloseHandle(void *hObject)");

    return {
      createJob({ killOnJobClose }) {
        const job = createJobObject(null, null) as JobHandle | null;
        if (!job) return undefined;
        const limits = Buffer.alloc(EXTENDED_LIMIT_INFO_SIZE);
        const limitFlags =
          JOB_OBJECT_LIMIT_BREAKAWAY_OK | (killOnJobClose ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0);
        limits.writeUInt32LE(limitFlags, LIMIT_FLAGS_OFFSET);
        if (
          !setInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            limits,
            limits.length,
          )
        ) {
          closeHandle(job);
          return undefined;
        }
        return job;
      },
      assignSelf(job) {
        return Boolean(assignProcessToJobObject(job, getCurrentProcess()));
      },
      queryPids(job) {
        let size = 8 + PID_SIZE * 64;
        for (;;) {
          const buffer = Buffer.alloc(size);
          const returned = Buffer.alloc(4);
          const ok = queryInformationJobObject(
            job,
            JOB_OBJECT_BASIC_PROCESS_ID_LIST,
            buffer,
            buffer.length,
            returned,
          );
          if (ok) {
            const count = buffer.readUInt32LE(4);
            const available = Math.floor((buffer.length - 8) / PID_SIZE);
            const limit = Math.min(count, available);
            const pids: number[] = [];
            for (let index = 0; index < limit; index += 1) {
              const offset = 8 + index * PID_SIZE;
              pids.push(
                PID_SIZE === 8
                  ? Number(buffer.readBigUInt64LE(offset))
                  : buffer.readUInt32LE(offset),
              );
            }
            return pids;
          }
          const error = getLastError();
          if (error === ERROR_MORE_DATA) {
            const needed = returned.readUInt32LE(0);
            size = Math.max(needed, size * 2);
          } else if (error === ERROR_BAD_LENGTH) {
            size *= 2;
          } else {
            throw new Error(`QueryInformationJobObject failed: ${error}`);
          }
          if (size > MAX_PID_LIST_BYTES) {
            throw new Error("Job process list exceeds buffer limit");
          }
        }
      },
      close(job) {
        closeHandle(job);
      },
    } satisfies WindowsJobMembershipApi;
  } catch {
    // 原生模块加载失败只是没有成员种子，PPID 树归属继续工作。
    return undefined;
  }
}

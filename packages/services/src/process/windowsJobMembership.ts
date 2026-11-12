/**
 * Windows 统计用 Job Object：给 Host 的全部后代一个不随父进程退出而消失的成员身份。
 *
 * 为什么要它：资源管理器按 PPID 找 Host 后代，但中间 shell 退出后，
 * 孙进程的 PPID 仍指向已消失的 PID，向下遍历在该处断开，存活进程就统计不到。
 * Job 成员身份由内核维护，后代创建时自动继承，中间层退出也不脱离。
 *
 * 边界：
 * - 只提供存活成员 PID，不提供 CPU/内存；指标仍来自进程表采样。
 * - 不设置 KILL_ON_JOB_CLOSE，不改变任何清理语义。
 * - 必须在 CLI、Bash 等后代创建之前把 Host 自身加入作业。
 * - 原生能力不可用时返回 undefined，调用方回退到 PPID 树。
 */
import type * as Koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3;
const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800;
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
  createJob(): JobHandle | undefined;
  assignSelf(job: JobHandle): boolean;
  queryPids(job: JobHandle): number[];
  close(job: JobHandle): void;
}

interface CreateWindowsJobMembershipOptions {
  platform?: NodeJS.Platform;
  /** 测试注入；默认动态加载 koffi。 */
  api?: WindowsJobMembershipApi;
}

let nativeApiPromise: Promise<WindowsJobMembershipApi | undefined> | undefined;

export async function createWindowsJobMembership(
  options: CreateWindowsJobMembershipOptions = {},
): Promise<WindowsJobMembership | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const api = options.api ?? (await loadWindowsJobMembershipApi());
  if (!api) return undefined;

  let job: JobHandle | undefined;
  try {
    job = api.createJob();
    // 允许显式 CREATE_BREAKAWAY_FROM_JOB 的进程照常启动；逃出作业的进程不再计入统计。
    if (!job || !api.assignSelf(job)) {
      if (job) api.close(job);
      return undefined;
    }
  } catch {
    if (job) {
      try {
        api.close(job);
      } catch {
        // 句柄关闭失败不能阻断 Host 启动。
      }
    }
    return undefined;
  }

  let closed = false;
  return {
    listPids() {
      if (closed) return undefined;
      try {
        return api.queryPids(job);
      } catch {
        // 查询失败只是本轮缺少成员种子，已有 PPID 归属仍然有效。
        return undefined;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      api.close(job);
    },
  };
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
      createJob() {
        const job = createJobObject(null, null) as JobHandle | null;
        if (!job) return undefined;
        const limits = Buffer.alloc(EXTENDED_LIMIT_INFO_SIZE);
        limits.writeUInt32LE(JOB_OBJECT_LIMIT_BREAKAWAY_OK, LIMIT_FLAGS_OFFSET);
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

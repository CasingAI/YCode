// 沙盒 FS 方法名表：真做 / 只读档拒绝 / 同步支持 / 同步不支持 / 回调空壳 /
// 未实现空壳共用，测试按名字锁「挂得上、行为对」。

export const SANDBOX_FS_PROMISE_IMPLEMENTED = [
  "readFile",
  "writeFile",
  "appendFile",
  "readdir",
  "stat",
  "lstat",
  "access",
  "mkdir",
  "unlink",
  "rmdir",
  "rm",
  "rename",
  "copyFile",
] as const;

export const SANDBOX_FS_WRITE_METHODS = [
  "writeFile",
  "appendFile",
  "mkdir",
  "unlink",
  "rmdir",
  "rm",
  "rename",
  "copyFile",
] as const;

/**
 * 同步支持白名单：13 个异步映射 + existsSync / realpathSync。
 * 经 Worker → 主线程同步桥复用同一端口、路径解析与档位检查。
 */
export const SANDBOX_FS_SYNC_IMPLEMENTED = [
  "readFileSync",
  "writeFileSync",
  "appendFileSync",
  "readdirSync",
  "statSync",
  "lstatSync",
  "accessSync",
  "mkdirSync",
  "unlinkSync",
  "rmdirSync",
  "rmSync",
  "renameSync",
  "copyFileSync",
  "existsSync",
  "realpathSync",
] as const;

/** 同步不支持名单：调用即 SANDBOX_FS_UNSUPPORTED，不创建 fd / 句柄 / 流。 */
export const SANDBOX_FS_SYNC_UNSUPPORTED = [
  "openSync",
  "closeSync",
  "readSync",
  "readvSync",
  "writeSync",
  "writevSync",
  "fstatSync",
  "ftruncateSync",
  "fsyncSync",
  "fdatasyncSync",
  "truncateSync",
  "globSync",
  "cpSync",
  "linkSync",
  "symlinkSync",
  "readlinkSync",
  "chmodSync",
  "lchmodSync",
  "fchmodSync",
  "chownSync",
  "lchownSync",
  "fchownSync",
  "utimesSync",
  "lutimesSync",
  "futimesSync",
  "statfsSync",
  "mkdtempSync",
  "mkdtempDisposableSync",
  "opendirSync",
] as const;

/** 全部 Node 同步 FS I/O 导出（支持 + 不支持），测试据此锁覆盖。 */
export const SANDBOX_FS_SYNC_METHODS = [
  ...SANDBOX_FS_SYNC_IMPLEMENTED,
  ...SANDBOX_FS_SYNC_UNSUPPORTED,
] as const;

export const SANDBOX_FS_CALLBACK_IMPLEMENTED = SANDBOX_FS_PROMISE_IMPLEMENTED;

export const SANDBOX_FS_CALLBACK_METHODS = [
  "open",
  "close",
  "read",
  "readv",
  "write",
  "writev",
  "truncate",
  "watch",
  "watchFile",
  "unwatchFile",
  "cp",
  "glob",
  "link",
  "symlink",
  "readlink",
  "realpath",
  "chmod",
  "lchmod",
  "chown",
  "lchown",
  "utimes",
  "lutimes",
  "statfs",
  "mkdtemp",
  "opendir",
  "exists",
  "fstat",
  "fsync",
  "fdatasync",
  "ftruncate",
  "fchmod",
  "fchown",
  "futimes",
] as const;

export const SANDBOX_FS_UNSUPPORTED_ROOT = [
  "createReadStream",
  "createWriteStream",
  "openAsBlob",
] as const;

export const SANDBOX_FS_UNSUPPORTED_PROMISE = [
  "open",
  "truncate",
  "cp",
  "glob",
  "link",
  "symlink",
  "readlink",
  "realpath",
  "chmod",
  "lchmod",
  "chown",
  "lchown",
  "utimes",
  "lutimes",
  "statfs",
  "mkdtemp",
  "mkdtempDisposable",
  "opendir",
  "watch",
] as const;

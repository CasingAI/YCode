import type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  WorkspaceFileEntry,
  FileTextSlice,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface WorkspaceFileSearchParams {
  rootPath: string;
  workspaceIdentity?: string;
  query: string;
  limit?: number;
  /** 无命中补扫：绕过尚未过期的文件索引。 */
  refresh?: boolean;
  /**
   * 只返回指定类型的条目。不传表示不过滤（既有调用方仍可拿到目录）。
   * 过滤在 Host 的 top-K 截断之前生效：先过滤再排序，避免目录把文件候选挤掉。
   */
  types?: Array<WorkspaceFileEntry["type"]>;
}

/**
 * 文件索引用途。缺省（undefined）保持文件引用 / 快速打开语义；
 * `file-browser` 供文件浏览器搜索，放宽 .env、编译产物与隐藏条目的硬过滤。
 */
export type WorkspaceFileListPurpose = "file-browser";

export interface WorkspaceFileListOptions {
  /** 身份 key，缺省回退 rootPath；与 workspacePath 分离。 */
  workspaceIdentity?: string;
  /** 缺省为旧文件引用用途，不注入任何浏览状态。 */
  purpose?: WorkspaceFileListPurpose;
  /** 仅 file-browser 生效：跳过 .zcodeignore，不创建也不改写规则文件。 */
  includeIgnored?: boolean;
}

export interface WorkspaceFileListLengthParams extends WorkspaceFileListOptions {
  rootPath: string;
  /** 显式刷新：绕过 60s TTL 重扫；只暴露在 Length，分块 Range 复用同一次索引。 */
  refresh?: boolean;
}

export interface WorkspaceFileListRangeParams extends WorkspaceFileListOptions {
  rootPath: string;
  offset: number;
  length: number;
}

export type WorkspaceFileMutation =
  | { kind: "create-file"; parentPath: string; name: string }
  | { kind: "create-directory"; parentPath: string; name: string }
  | { kind: "rename"; path: string; name: string }
  | { kind: "delete"; path: string }
  | { kind: "copy"; path: string; targetDirectory: string }
  | { kind: "move"; path: string; targetDirectory: string };

export interface WorkspaceFileMutationParams {
  rootPath: string;
  workspaceIdentity?: string;
  mutation: WorkspaceFileMutation;
}

export interface WorkspaceFileMutationResult {
  path: string;
  previousPath?: string;
  type: "file" | "directory";
  changed: boolean;
}

export interface IFileService {
  /** Host 匹配并返回有界候选，避免 Renderer 下载完整文件索引。 */
  searchWorkspaceFiles(params: WorkspaceFileSearchParams): Promise<WorkspaceFileEntry[]>;
  readdir(params: { path: string; includeHidden?: boolean }): Promise<FileEntry[]>;
  stat(params: { path: string }): Promise<FileStat>;
  checkFilesExist(params: { paths: string[] }): Promise<Array<{ path: string; exists: boolean }>>;
  resolvePath(params: { path: string }): Promise<string>;
  ensureConversationWorkspace(): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  createDefaultWorkspace(): Promise<{ path: string }>;
  createScratchWorkspace(params: { name: string }): Promise<{ path: string }>;
  readTextFile(params: { path: string; offset?: number; length?: number }): Promise<FileTextSlice>;
  /**
   * 按路径覆盖或新建文本文件。父目录必须已存在；不创建中间目录。
   * 远程调用必须落在该工作区的 file 通道上，不得只靠路径。
   */
  writeTextFile(params: { path: string; content: string }): Promise<void>;
  /** 同一服务串行执行，校验工作区边界；删除为永久删除，不覆盖已有目标。 */
  mutateWorkspaceEntry(params: WorkspaceFileMutationParams): Promise<WorkspaceFileMutationResult>;
  readMediaPreview(params: { path: string; maxBytes?: number }): Promise<FileMediaPreview>;
  /**
   * 按偏移读取文件的一段原始字节，供大二进制文件（如 PDF）按需分段加载。
   * 返回值必须保持顶层 Uint8Array：RPC 序列化只对顶层二进制走原始字节通道，
   * 嵌套在对象字段里会退化成 JSON+base64。EOF 时返回短数组。
   */
  readFileRange(params: { path: string; offset: number; length: number }): Promise<Uint8Array>;
  readBinaryPreview(params: { path: string; maxBytes?: number }): Promise<FileBinaryPreview>;
  /**
   * workspace 文件索引的列式打包长度（字符数）。与 listWorkspaceFilesRange 配对，
   * 调用方按长度分块拉取（见 fetchWorkspaceFileEntriesPacked）。
   * 返回 number：RPC Int 快速路径。
   */
  listWorkspaceFilesLength(params: WorkspaceFileListLengthParams): Promise<number>;
  /**
   * 分块返回列式打包字符串（workspaceFileEntriesCodec 格式，[offset, offset+length)）。
   * 必须是裸 string 顶层返回：RPC String 快速路径（长度前缀+原始字节）；Object 会
   * JSON 转义大字符串（实测 6-9s 主线程长任务）。单块不超过 ~4MB：大消息在
   * renderer 接收端的分帧重组是秒级长任务（实测 4.6-6.3s），分块 + 块间让出后
   * 主线程每次只处理一小块（~50ms），输入永不冻结。
   * Host 侧有 60s TTL + .zcodeignore 指纹签名的整包缓存，分块只是切片。
   * 传入 file-browser 用途与 includeIgnored 时，分块必须与 Length 使用同一组选项，
   * 否则会命中不同用途的索引；显式 refresh 只在 Length 传一次。
   *
   * 一致性边界：Range 本身没有 refresh 或版本 token。同一轮常规分块在 60s TTL
   * 内复用同一份 packed；若分块跨越 TTL 过期或期间另有 refresh 替换缓存，
   * 当前接口无法把后续块钉在旧索引上，不保证该场景的跨块快照一致性。
   */
  listWorkspaceFilesRange(params: WorkspaceFileListRangeParams): Promise<string>;
  /**
   * workspace 搜索忽略规则（.zcodeignore）的读写，供设置页编辑使用。
   * source: "file" 已存在文件内容；"template" 尚未创建时的初始内容预览（保存时才落盘）。
   */
  readWorkspaceFileSearchIgnore(params: {
    rootPath: string;
  }): Promise<{ content: string; source: "file" | "template" }>;
  /**
   * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
   * "sync-gitignore" 只重写 gitignore 同步区（保留默认段与自定义区）；
   * "reset-defaults" 只重置默认排除段（保留 gitignore 区与自定义区）。
   */
  applyWorkspaceFileSearchIgnoreTransform(params: {
    rootPath: string;
    transform: "sync-gitignore" | "reset-defaults";
  }): Promise<{ content: string }>;
  writeWorkspaceFileSearchIgnore(params: { rootPath: string; content: string }): Promise<void>;
}

export const IFileService = createServiceDescriptor<IFileService>(ServiceChannels.File);

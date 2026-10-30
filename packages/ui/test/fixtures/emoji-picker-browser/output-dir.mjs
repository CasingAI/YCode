import { tmpdir } from "node:os";
import { join } from "node:path";

// 构建产物默认写到系统临时目录，避免仓库内出现可被 oxlint/CI 扫描的生成文件。
// build、serve、verify 必须使用同一个值；需要固定目录时显式设置 EMOJI_E2E_DIST。
export const outputDir = process.env.EMOJI_E2E_DIST || join(tmpdir(), "zcode-emoji-picker-e2e");

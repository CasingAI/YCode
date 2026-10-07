// 冻结本次加列 SQL：不能改旧 migration 或引用会随发布变化的实时目录。
// 只为 task_groups 加 emoji 列；坏值不影响启动（读侧按空处理）。
export const GROUP_EMOJI_MIGRATION_SQL = `
ALTER TABLE task_groups ADD COLUMN emoji TEXT;
`;

// 冻结本次加列 SQL：不能改旧 migration 或引用会随发布变化的实时目录。
// last_seen_activity_at 只增不减的已读水位；unread_activity_at 记录当前自动未读
// 对应的终态活动版本，手动/存量未读为 NULL。
export const TASK_READ_WATERMARK_MIGRATION_SQL = `
ALTER TABLE tasks ADD COLUMN last_seen_activity_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN unread_activity_at INTEGER;
`;

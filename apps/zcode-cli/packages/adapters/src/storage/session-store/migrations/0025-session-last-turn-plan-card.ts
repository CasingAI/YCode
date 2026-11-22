export const SESSION_LAST_TURN_PLAN_CARD_MIGRATION_SQL = `
  -- 会话列表计划卡描边的冷启动提示：NULL = 未写过（旧会话视为未知，不显示描边）。
  -- 值由 v4 gateway 在描边事实翻转时窄写，实时投影仍是唯一权威事实源。
  alter table session add column last_turn_has_plan_card integer;
`;

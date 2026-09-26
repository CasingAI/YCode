// Subagent 的持久化身份索引：agent_id → child_session_id 绑定。
//
// 这张表只保存不可变身份和恢复新 execution 所需的最小配置，刻意不存 status、output、
// error 或完成时间——任务状态继续由 child transcript、父 transcript 和当前
// RuntimeTaskRegistry 投影，避免出现第二套任务状态机。
//
// 历史 child session 不在这里回填：符合 subagent_${agentId} 命名约定的旧记录由
// resolveSubagentIdentity 首次命中时校验并 lazy backfill，不做全库批量扫描。
export const SUBAGENT_IDENTITY_MIGRATION_SQL = `
      create table if not exists subagent_identity (
        agent_id text primary key,
        child_session_id text not null unique
          references session(id) on delete cascade,
        agent_type text not null,
        profile text not null default '{}',
        workspace_identity text,
        workspace_root text,
        context_reset_generation integer not null default 0,
        time_created integer not null,
        time_updated integer not null
      );

      create index if not exists subagent_identity_child_idx
        on subagent_identity(child_session_id);
`;

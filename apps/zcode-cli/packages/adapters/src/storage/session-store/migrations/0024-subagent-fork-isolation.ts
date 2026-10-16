export const SUBAGENT_FORK_ISOLATION_MIGRATION_SQL = `
  create table if not exists subagent_fork_checkpoint (
    checkpoint_id text primary key,
    parent_session_id text not null references session(id) on delete cascade,
    agent_id text not null,
    -- Snapshot is immutable provenance; deleting the source child must not delete or block fork copies.
    child_session_id text not null,
    parent_tool_call_id text not null,
    boundary_message_id text not null,
    payload_json text not null,
    message_ids_json text not null,
    time_created integer not null,
    unique(parent_session_id, agent_id, checkpoint_id)
  );
  create index if not exists subagent_fork_checkpoint_parent_idx
    on subagent_fork_checkpoint(parent_session_id, boundary_message_id);
  create table if not exists subagent_fork_alias (
    parent_session_id text not null references session(id) on delete cascade,
    historical_agent_id text not null,
    physical_agent_id text not null,
    child_session_id text not null references session(id) on delete cascade,
    source_checkpoint_id text not null,
    primary key(parent_session_id, historical_agent_id)
  );
  create table if not exists subagent_execution_claim (
    child_session_id text primary key references session(id) on delete cascade,
    owner_runtime_id text not null,
    fencing_epoch integer not null,
    expires_at integer not null
  );
`;

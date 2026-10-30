ALTER TABLE results ADD COLUMN digest TEXT;

ALTER TABLE approvals ADD COLUMN decision_id TEXT UNIQUE;
ALTER TABLE approvals ADD COLUMN key_id TEXT;
ALTER TABLE approvals ADD COLUMN envelope_digest TEXT;
ALTER TABLE approvals ADD COLUMN gate_id TEXT;
ALTER TABLE approvals ADD COLUMN envelope JSONB;

CREATE TABLE review_gates (
  gate_id    TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (run_id),
  revision   INTEGER NOT NULL,
  artifacts  JSONB NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, revision)
);

-- Durable record of one agent execution per (run, role, stage). `attempts` counts actual executor invocations.
-- invoked_at is set (fenced) immediately BEFORE the external call: if it is set and no result was persisted,
-- the outcome is unknown and the execution is never silently re-run.
CREATE TABLE agent_executions (
  execution_id     TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs (run_id),
  role             TEXT NOT NULL,
  stage            TEXT NOT NULL,
  input_digest     TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'running', 'succeeded', 'uncertain')),
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  fence            BIGINT NOT NULL DEFAULT 0,
  invoked_at       TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0,
  result_id        TEXT,
  output           JSONB,
  executed_by      TEXT,
  cost_usd         NUMERIC(12, 6),
  steps            INTEGER,
  uncertain_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (run_id, role, stage)
);

ALTER TABLE cost_entries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;

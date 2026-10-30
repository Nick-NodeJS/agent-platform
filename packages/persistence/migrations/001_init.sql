CREATE TABLE runs (
  run_id       TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL UNIQUE,
  task_id      TEXT NOT NULL UNIQUE,
  goal         TEXT NOT NULL,
  constraints  JSONB NOT NULL,
  status       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE results (
  result_id   TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs (run_id),
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  produced_by TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, kind)
);

-- One final decision per run; duplicates are ignored via ON CONFLICT.
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL UNIQUE REFERENCES runs (run_id),
  task_id     TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  source      TEXT NOT NULL CHECK (source IN ('human', 'agent')),
  actor       TEXT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE execution_events (
  event_id   TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (run_id),
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE cost_entries (
  entry_id   TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs (run_id),
  role       TEXT NOT NULL,
  cost_usd   NUMERIC(12, 6) NOT NULL,
  steps      INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

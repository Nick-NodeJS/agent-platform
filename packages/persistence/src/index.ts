import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import type { Approval, ExecutionEvent, Result, Run, Status } from '@platform/contracts';

export type Db = pg.Pool;

export const createPool = (databaseUrl: string): Db =>
  new pg.Pool({ connectionString: databaseUrl });

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** Simple forward-only migration runner; applied files are tracked in schema_migrations. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
  return applied;
}

/** All writes are idempotent (ON CONFLICT) so Activity retries never duplicate records. */
export class RunRepository {
  constructor(private readonly db: Db) {}

  async insertRun(run: Run): Promise<void> {
    await this.db.query(
      `INSERT INTO runs (run_id, workflow_id, task_id, goal, constraints, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id) DO NOTHING`,
      [
        run.runId,
        run.workflowId,
        run.taskId,
        run.goal,
        JSON.stringify(run.constraints),
        run.status,
        run.createdAt,
        run.updatedAt,
      ],
    );
  }

  async updateStatus(runId: string, status: Status): Promise<void> {
    await this.db.query('UPDATE runs SET status = $2, updated_at = now() WHERE run_id = $1', [
      runId,
      status,
    ]);
  }

  async insertResult(result: Result): Promise<void> {
    await this.db.query(
      `INSERT INTO results (result_id, run_id, task_id, kind, produced_by, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        result.resultId,
        result.runId,
        result.taskId,
        result.kind,
        result.producedBy,
        JSON.stringify(result.payload),
        result.createdAt,
      ],
    );
  }

  /** Returns true only if this call stored the decision (first decision wins). */
  async insertApproval(a: Approval): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO approvals (approval_id, run_id, task_id, decision, source, actor, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        a.approvalId,
        a.runId,
        a.taskId,
        a.decision,
        a.source,
        a.actor,
        a.reason ?? null,
        a.createdAt,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async insertEvent(e: ExecutionEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO execution_events (event_id, run_id, type, data, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [e.eventId, e.runId, e.type, JSON.stringify(e.data), e.createdAt],
    );
  }

  async insertCost(entry: {
    entryId: string;
    runId: string;
    role: string;
    costUsd: number;
    steps: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO cost_entries (entry_id, run_id, role, cost_usd, steps, created_at)
       VALUES ($1,$2,$3,$4,$5, now()) ON CONFLICT DO NOTHING`,
      [entry.entryId, entry.runId, entry.role, entry.costUsd, entry.steps],
    );
  }

  async getRunSummary(runId: string) {
    const run = await this.db.query('SELECT * FROM runs WHERE run_id = $1', [runId]);
    if (run.rowCount === 0) return undefined;
    const [results, approvals, events, costs] = await Promise.all([
      this.db.query(
        'SELECT result_id, kind, produced_by FROM results WHERE run_id = $1 ORDER BY created_at',
        [runId],
      ),
      this.db.query(
        'SELECT approval_id, decision, source, actor FROM approvals WHERE run_id = $1',
        [runId],
      ),
      this.db.query(
        'SELECT event_id, type, created_at FROM execution_events WHERE run_id = $1 ORDER BY created_at',
        [runId],
      ),
      this.db.query(
        'SELECT COALESCE(SUM(cost_usd),0)::float AS total FROM cost_entries WHERE run_id = $1',
        [runId],
      ),
    ]);
    return {
      run: run.rows[0] as { run_id: string; task_id: string; status: Status },
      results: results.rows,
      approvals: approvals.rows,
      events: events.rows,
      totalCostUsd: (costs.rows[0] as { total: number }).total,
    };
  }
}

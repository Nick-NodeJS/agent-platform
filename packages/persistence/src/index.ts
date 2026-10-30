import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import type {
  Approval,
  ApprovalEnvelope,
  ArtifactRef,
  ExecutionEvent,
  Result,
  ReviewGate,
  Run,
  Status,
} from '@platform/contracts';

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

export type ExecutionState = 'pending' | 'running' | 'succeeded' | 'uncertain';

export interface ExecutionRecord {
  executionId: string;
  runId: string;
  role: string;
  stage: string;
  inputDigest: string;
  state: ExecutionState;
  leaseOwner: string | null;
  leaseExpired: boolean;
  fence: number;
  invokedAt: Date | null;
  attempts: number;
  resultId: string | null;
  output: Record<string, unknown> | null;
  executedBy: string | null;
  costUsd: number | null;
  steps: number | null;
  uncertainReason: string | null;
}

export class StaleExecutionError extends Error {}
export class ExecutionInputMismatchError extends Error {}

const EXEC_COLUMNS = `execution_id, run_id, role, stage, input_digest, state, lease_owner,
  (lease_expires_at IS NULL OR lease_expires_at < now()) AS lease_expired, fence::int AS fence,
  invoked_at, attempts, result_id, output, executed_by, cost_usd::float AS cost_usd, steps, uncertain_reason`;

const toExecution = (r: Record<string, unknown>): ExecutionRecord => ({
  executionId: r['execution_id'] as string,
  runId: r['run_id'] as string,
  role: r['role'] as string,
  stage: r['stage'] as string,
  inputDigest: r['input_digest'] as string,
  state: r['state'] as ExecutionState,
  leaseOwner: r['lease_owner'] as string | null,
  leaseExpired: r['lease_expired'] as boolean,
  fence: r['fence'] as number,
  invokedAt: r['invoked_at'] as Date | null,
  attempts: r['attempts'] as number,
  resultId: r['result_id'] as string | null,
  output: r['output'] as Record<string, unknown> | null,
  executedBy: r['executed_by'] as string | null,
  costUsd: r['cost_usd'] as number | null,
  steps: r['steps'] as number | null,
  uncertainReason: r['uncertain_reason'] as string | null,
});

/** Canonical records live here. All writes are idempotent or fenced so Activity retries are safe. */
export class RunRepository {
  constructor(protected readonly db: Db) {}

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

  /** Forward-only (same ordering as the task store); terminal statuses are never overwritten. */
  async updateStatus(runId: string, status: Status): Promise<void> {
    const rank = (col: string) =>
      `CASE ${col} WHEN 'CREATED' THEN 0 WHEN 'RESEARCHING' THEN 1 WHEN 'EVALUATING' THEN 2 WHEN 'WAITING_FOR_HUMAN_APPROVAL' THEN 3 ELSE 4 END`;
    await this.db.query(
      `UPDATE runs SET status = $2, updated_at = now()
       WHERE run_id = $1 AND ${rank('status')} < ${rank('$2::text')}`,
      [runId, status],
    );
  }

  async insertResult(result: Result): Promise<void> {
    await this.db.query(
      `INSERT INTO results (result_id, run_id, task_id, kind, produced_by, payload, digest, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        result.resultId,
        result.runId,
        result.taskId,
        result.kind,
        result.producedBy,
        JSON.stringify(result.payload),
        result.digest ?? null,
        result.createdAt,
      ],
    );
  }

  async getResult(resultId: string): Promise<Result | undefined> {
    const r = await this.db.query('SELECT * FROM results WHERE result_id = $1', [resultId]);
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      resultId: row.result_id,
      taskId: row.task_id,
      runId: row.run_id,
      kind: row.kind,
      producedBy: row.produced_by,
      payload: row.payload,
      ...(row.digest ? { digest: row.digest } : {}),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async hasDecisionId(decisionId: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM approvals WHERE decision_id = $1', [decisionId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Returns true only if this call stored the decision (first decision wins). */
  async insertApproval(
    a: Approval,
    envelope?: ApprovalEnvelope,
    gateId?: string,
  ): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO approvals (approval_id, run_id, task_id, decision, source, actor, reason, created_at,
                              decision_id, key_id, envelope_digest, gate_id, envelope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [
        a.approvalId,
        a.runId,
        a.taskId,
        a.decision,
        a.source,
        a.actor,
        a.reason ?? null,
        a.createdAt,
        a.decisionId ?? null,
        a.keyId ?? null,
        a.envelopeDigest ?? null,
        gateId ?? null,
        envelope ? JSON.stringify(envelope) : null,
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
    attempts?: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO cost_entries (entry_id, run_id, role, cost_usd, steps, attempts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now()) ON CONFLICT DO NOTHING`,
      [entry.entryId, entry.runId, entry.role, entry.costUsd, entry.steps, entry.attempts ?? 1],
    );
  }

  async openGate(gate: ReviewGate, revision = 1): Promise<ReviewGate> {
    await this.db.query(
      `INSERT INTO review_gates (gate_id, run_id, revision, artifacts, created_at)
       VALUES ($1,$2,$3,$4, now()) ON CONFLICT DO NOTHING`,
      [gate.gateId, gate.runId, revision, JSON.stringify(gate.artifacts)],
    );
    const r = await this.db.query(
      'SELECT gate_id, run_id, artifacts FROM review_gates WHERE run_id=$1 AND revision=$2',
      [gate.runId, revision],
    );
    const row = r.rows[0] as { gate_id: string; run_id: string; artifacts: ArtifactRef[] };
    return { gateId: row.gate_id, runId: row.run_id, artifacts: row.artifacts };
  }

  async closeGate(gateId: string): Promise<void> {
    await this.db.query("UPDATE review_gates SET status='decided' WHERE gate_id=$1", [gateId]);
  }

  // ---- durable agent executions -------------------------------------------------------------

  async ensureExecution(e: {
    executionId: string;
    runId: string;
    role: string;
    stage: string;
    inputDigest: string;
  }): Promise<ExecutionRecord> {
    await this.db.query(
      `INSERT INTO agent_executions (execution_id, run_id, role, stage, input_digest)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [e.executionId, e.runId, e.role, e.stage, e.inputDigest],
    );
    const rec = (await this.getExecution(e.executionId))!;
    if (rec.inputDigest !== e.inputDigest)
      throw new ExecutionInputMismatchError(
        `execution ${e.executionId} already exists with different input; use a new stage/revision`,
      );
    return rec;
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    const r = await this.db.query(
      `SELECT ${EXEC_COLUMNS} FROM agent_executions WHERE execution_id=$1`,
      [executionId],
    );
    return r.rows[0] ? toExecution(r.rows[0]) : undefined;
  }

  /**
   * Atomically claim an execution. Only a 'pending' execution, or a 'running' one whose lease expired and whose
   * external call was never started (invoked_at IS NULL), can be claimed. Each claim increments the fence.
   */
  async claimExecution(
    executionId: string,
    token: string,
    ttlMs: number,
  ): Promise<ExecutionRecord | undefined> {
    const r = await this.db.query(
      `UPDATE agent_executions
          SET state='running', lease_owner=$2, fence=fence+1,
              lease_expires_at = now() + ($3::int * interval '1 millisecond'), updated_at=now()
        WHERE execution_id=$1
          AND (state='pending' OR (state='running' AND lease_expires_at < now() AND invoked_at IS NULL))
        RETURNING ${EXEC_COLUMNS}`,
      [executionId, token, ttlMs],
    );
    return r.rows[0] ? toExecution(r.rows[0]) : undefined;
  }

  async renewLease(
    executionId: string,
    token: string,
    fence: number,
    ttlMs: number,
  ): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE agent_executions SET lease_expires_at = now() + ($4::int * interval '1 millisecond'), updated_at=now()
        WHERE execution_id=$1 AND lease_owner=$2 AND fence=$3 AND state='running'`,
      [executionId, token, fence, ttlMs],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Fenced; records that the external call is about to start and counts the attempt. */
  async markInvoked(executionId: string, token: string, fence: number): Promise<void> {
    const r = await this.db.query(
      `UPDATE agent_executions SET invoked_at = COALESCE(invoked_at, now()), attempts = attempts + 1, updated_at=now()
        WHERE execution_id=$1 AND lease_owner=$2 AND fence=$3 AND state='running' AND lease_expires_at >= now()`,
      [executionId, token, fence],
    );
    if ((r.rowCount ?? 0) === 0)
      throw new StaleExecutionError('lost claim before invoking executor');
  }

  /** The executor definitively did not run (e.g. rejected before any external call): undo the invocation. */
  async abortInvocation(executionId: string, token: string, fence: number): Promise<void> {
    await this.db.query(
      `UPDATE agent_executions SET state='pending', lease_owner=NULL, lease_expires_at=NULL, invoked_at=NULL,
              attempts = GREATEST(attempts - 1, 0), updated_at=now()
        WHERE execution_id=$1 AND lease_owner=$2 AND fence=$3 AND state='running'`,
      [executionId, token, fence],
    );
  }

  async markUncertainOwned(
    executionId: string,
    token: string,
    fence: number,
    reason: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_executions SET state='uncertain', uncertain_reason=$4, updated_at=now()
        WHERE execution_id=$1 AND lease_owner=$2 AND fence=$3 AND state='running'`,
      [executionId, token, fence, reason],
    );
  }

  /** Lease expired after the external call started and nothing was persisted: outcome unknown. */
  async markUncertainIfAbandoned(executionId: string, reason: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE agent_executions SET state='uncertain', uncertain_reason=$2, updated_at=now()
        WHERE execution_id=$1 AND state='running' AND lease_expires_at < now() AND invoked_at IS NOT NULL`,
      [executionId, reason],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Operator reconciliation: after confirming out-of-band that no run happened (or accepting the risk of a re-run),
   * make an 'uncertain' execution claimable again. Attempts already made stay counted.
   */
  async resetUncertain(executionId: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE agent_executions SET state='pending', lease_owner=NULL, lease_expires_at=NULL, invoked_at=NULL,
              uncertain_reason=NULL, updated_at=now()
        WHERE execution_id=$1 AND state='uncertain'`,
      [executionId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * One transaction: fenced state change to 'succeeded' + validated output + canonical result + cost entry.
   * Throws StaleExecutionError if this attempt no longer owns the execution (stale attempts cannot overwrite).
   */
  async completeExecution(args: {
    executionId: string;
    token: string;
    fence: number;
    output: Record<string, unknown>;
    executedBy: string;
    costUsd: number;
    steps: number;
    result: Result;
  }): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE agent_executions
            SET state='succeeded', output=$4, executed_by=$5, cost_usd=$6, steps=$7, result_id=$8,
                lease_owner=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now()
          WHERE execution_id=$1 AND lease_owner=$2 AND fence=$3 AND state='running'
          RETURNING run_id, role, attempts`,
        [
          args.executionId,
          args.token,
          args.fence,
          JSON.stringify(args.output),
          args.executedBy,
          args.costUsd,
          args.steps,
          args.result.resultId,
        ],
      );
      const row = upd.rows[0] as { run_id: string; role: string; attempts: number } | undefined;
      if (!row) throw new StaleExecutionError('execution no longer owned by this attempt');
      const r = args.result;
      await client.query(
        `INSERT INTO results (result_id, run_id, task_id, kind, produced_by, payload, digest, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [
          r.resultId,
          r.runId,
          r.taskId,
          r.kind,
          r.producedBy,
          JSON.stringify(r.payload),
          r.digest ?? null,
          r.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO cost_entries (entry_id, run_id, role, cost_usd, steps, attempts, created_at)
         VALUES ($1,$2,$3,$4,$5,$6, now()) ON CONFLICT DO NOTHING`,
        [args.executionId, row.run_id, row.role, args.costUsd, args.steps, row.attempts],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async listExecutions(runId: string): Promise<ExecutionRecord[]> {
    const r = await this.db.query(
      `SELECT ${EXEC_COLUMNS} FROM agent_executions WHERE run_id=$1 ORDER BY created_at`,
      [runId],
    );
    return r.rows.map(toExecution);
  }

  async getRunSummary(runId: string) {
    const run = await this.db.query('SELECT * FROM runs WHERE run_id = $1', [runId]);
    if (run.rowCount === 0) return undefined;
    const [results, approvals, events, costs, executions] = await Promise.all([
      this.db.query(
        'SELECT result_id, kind, produced_by FROM results WHERE run_id = $1 ORDER BY created_at',
        [runId],
      ),
      this.db.query(
        'SELECT approval_id, decision, source, actor, key_id FROM approvals WHERE run_id = $1',
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
      this.listExecutions(runId),
    ]);
    return {
      run: run.rows[0] as { run_id: string; task_id: string; status: Status },
      results: results.rows,
      approvals: approvals.rows,
      events: events.rows,
      executions,
      totalCostUsd: (costs.rows[0] as { total: number }).total,
    };
  }
}

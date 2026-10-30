import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import {
  artifactRefSchema,
  resultKindSchema,
  statusSchema,
  type Approval,
  type ApprovalEnvelope,
  type ExecutionEvent,
  type Result,
  type ReviewGate,
  type Run,
  type Status,
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
      if (done.has(file)) {
        continue;
      }
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

const executionStateSchema = z.enum(['pending', 'running', 'succeeded', 'uncertain']);
export type ExecutionState = z.infer<typeof executionStateSchema>;

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
/** A different human decision (or decision id) already exists for the logical run, or the decision id was used elsewhere. */
export class DecisionConflictError extends Error {}

const UNIQUE_VIOLATION = '23505';

// Database rows are an untrusted boundary for the compiler: parse them instead of asserting types.
const executionRowSchema = z.object({
  execution_id: z.string(),
  run_id: z.string(),
  role: z.string(),
  stage: z.string(),
  input_digest: z.string(),
  state: executionStateSchema,
  lease_owner: z.string().nullable(),
  lease_expired: z.boolean(),
  fence: z.number(),
  invoked_at: z.date().nullable(),
  attempts: z.number(),
  result_id: z.string().nullable(),
  output: z.record(z.unknown()).nullable(),
  executed_by: z.string().nullable(),
  cost_usd: z.number().nullable(),
  steps: z.number().nullable(),
  uncertain_reason: z.string().nullable(),
});

const resultRowSchema = z.object({
  result_id: z.string(),
  task_id: z.string(),
  run_id: z.string(),
  kind: resultKindSchema,
  produced_by: z.enum(['mock', 'agent']),
  payload: z.record(z.unknown()),
  digest: z.string().nullable(),
  created_at: z.date(),
});

const gateRowSchema = z.object({
  gate_id: z.string(),
  run_id: z.string(),
  artifacts: z.array(artifactRefSchema),
});

const runSummaryRowSchema = z.object({
  run_id: z.string(),
  task_id: z.string(),
  status: statusSchema,
});

const approvalRowSchema = z.object({
  approval_id: z.string(),
  run_id: z.string(),
  task_id: z.string(),
  decision: z.enum(['approve', 'reject']),
  source: z.enum(['human', 'agent']),
  actor: z.string(),
  reason: z.string().nullable(),
  created_at: z.date(),
  decision_id: z.string().nullable(),
  key_id: z.string().nullable(),
  envelope_digest: z.string().nullable(),
  gate_id: z.string().nullable(),
});

const runDecisionStateRowSchema = z.object({ status: statusSchema, has_approval: z.boolean() });

const completedRowSchema = z.object({ run_id: z.string(), role: z.string(), attempts: z.number() });

const costTotalRowSchema = z.object({ total: z.number() });

const EXEC_COLUMNS = `execution_id, run_id, role, stage, input_digest, state, lease_owner,
  (lease_expires_at IS NULL OR lease_expires_at < now()) AS lease_expired, fence::int AS fence,
  invoked_at, attempts, result_id, output, executed_by, cost_usd::float AS cost_usd, steps, uncertain_reason`;

function toExecution(row: unknown): ExecutionRecord {
  const r = executionRowSchema.parse(row);
  return {
    executionId: r.execution_id,
    runId: r.run_id,
    role: r.role,
    stage: r.stage,
    inputDigest: r.input_digest,
    state: r.state,
    leaseOwner: r.lease_owner,
    leaseExpired: r.lease_expired,
    fence: r.fence,
    invokedAt: r.invoked_at,
    attempts: r.attempts,
    resultId: r.result_id,
    output: r.output,
    executedBy: r.executed_by,
    costUsd: r.cost_usd,
    steps: r.steps,
    uncertainReason: r.uncertain_reason,
  };
}

/** An approval as stored by this system: always carries the signer identity and the envelope digest. */
export type StoredApproval = Approval & {
  decisionId: string;
  keyId: string;
  envelopeDigest: string;
};

const storedApprovalRowSchema = approvalRowSchema.extend({
  decision_id: z.string(),
  key_id: z.string(),
  envelope_digest: z.string(),
});

function approvalFromRow(source: z.infer<typeof approvalRowSchema>): StoredApproval {
  const row = storedApprovalRowSchema.parse(source);
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    runId: row.run_id,
    decision: row.decision,
    source: row.source,
    actor: row.actor,
    ...(row.reason ? { reason: row.reason } : {}),
    decisionId: row.decision_id,
    keyId: row.key_id,
    envelopeDigest: row.envelope_digest,
    createdAt: row.created_at.toISOString(),
  };
}

/** Compares canonical fields (not timestamps). The envelope digest covers the signed payload and signature. */
function isSameDecision(
  row: z.infer<typeof approvalRowSchema>,
  incoming: StoredApproval,
  gateId: string,
): boolean {
  return (
    row.decision === incoming.decision &&
    row.source === incoming.source &&
    row.actor === incoming.actor &&
    row.decision_id === incoming.decisionId &&
    row.key_id === incoming.keyId &&
    row.envelope_digest === incoming.envelopeDigest &&
    row.gate_id === gateId &&
    row.reason === (incoming.reason ?? null)
  );
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === UNIQUE_VIOLATION;

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
    const found = await this.db.query('SELECT * FROM results WHERE result_id = $1', [resultId]);
    if (found.rows.length === 0) {
      return undefined;
    }
    const row = resultRowSchema.parse(found.rows[0]);
    return {
      resultId: row.result_id,
      taskId: row.task_id,
      runId: row.run_id,
      kind: row.kind,
      producedBy: row.produced_by,
      payload: row.payload,
      ...(row.digest ? { digest: row.digest } : {}),
      createdAt: row.created_at.toISOString(),
    };
  }

  async hasDecisionId(decisionId: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM approvals WHERE decision_id = $1', [decisionId]);
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Whether a logical run already has an immutable outcome: a stored human decision or a terminal status.
   * Postgres, not Temporal history, is the authority (histories expire; run ids are logical).
   */
  async getDecisionState(
    runId: string,
  ): Promise<{ status: Status; hasDecision: boolean; terminal: boolean } | undefined> {
    const found = await this.db.query(
      `SELECT r.status, EXISTS (SELECT 1 FROM approvals a WHERE a.run_id = r.run_id) AS has_approval
         FROM runs r WHERE r.run_id = $1`,
      [runId],
    );
    if (found.rows.length === 0) {
      return undefined;
    }
    const row = runDecisionStateRowSchema.parse(found.rows[0]);
    return {
      status: row.status,
      hasDecision: row.has_approval,
      terminal: row.status === 'APPROVED' || row.status === 'REJECTED',
    };
  }

  /**
   * Stores the one human decision of a logical run and closes its gate in ONE transaction, serialized per run by a
   * row lock. Returns the canonical stored decision: `created` is true only for the call that inserted it.
   * An identical decision (same decision, decision id, signer, envelope digest, gate, reason) is an idempotent retry;
   * anything else for that run, or a decision id already used by another run, is a DecisionConflictError.
   */
  async recordDecision(args: {
    approval: StoredApproval;
    envelope: ApprovalEnvelope;
    gateId: string;
  }): Promise<{ approval: StoredApproval; created: boolean }> {
    const { approval, envelope, gateId } = args;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT 1 FROM runs WHERE run_id = $1 FOR UPDATE', [
        approval.runId,
      ]);
      if (locked.rows.length === 0) {
        throw new Error(`run ${approval.runId} does not exist`);
      }
      const existing = await client.query('SELECT * FROM approvals WHERE run_id = $1', [
        approval.runId,
      ]);
      let stored: StoredApproval;
      let created = false;
      if (existing.rows.length > 0) {
        const row = approvalRowSchema.parse(existing.rows[0]);
        if (!isSameDecision(row, approval, gateId)) {
          throw new DecisionConflictError(
            `run ${approval.runId} already has a different human decision (${row.decision}, decision id ${row.decision_id})`,
          );
        }
        stored = approvalFromRow(row);
      } else {
        const inserted = await client.query(
          `INSERT INTO approvals (approval_id, run_id, task_id, decision, source, actor, reason, created_at,
                                  decision_id, key_id, envelope_digest, gate_id, envelope)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            approval.approvalId,
            approval.runId,
            approval.taskId,
            approval.decision,
            approval.source,
            approval.actor,
            approval.reason ?? null,
            approval.createdAt,
            approval.decisionId,
            approval.keyId,
            approval.envelopeDigest,
            gateId,
            JSON.stringify(envelope),
          ],
        );
        stored = approvalFromRow(approvalRowSchema.parse(inserted.rows[0]));
        created = true;
      }
      await client.query("UPDATE review_gates SET status='decided' WHERE gate_id=$1", [gateId]);
      await client.query('COMMIT');
      return { approval: stored, created };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        // The original failure is what matters; a failed rollback leaves the connection to be discarded.
      });
      if (isUniqueViolation(error)) {
        throw new DecisionConflictError(
          `decision id ${approval.decisionId} was already used by another run`,
        );
      }
      throw error;
    } finally {
      client.release();
    }
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
    const row = gateRowSchema.parse(r.rows[0]);
    return { gateId: row.gate_id, runId: row.run_id, artifacts: row.artifacts };
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
    const rec = await this.getExecution(e.executionId);
    if (!rec) {
      throw new Error(`execution ${e.executionId} vanished after insert`);
    }
    if (rec.inputDigest !== e.inputDigest) {
      throw new ExecutionInputMismatchError(
        `execution ${e.executionId} already exists with different input; use a new stage/revision`,
      );
    }
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
    if ((r.rowCount ?? 0) === 0) {
      throw new StaleExecutionError('lost claim before invoking executor');
    }
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
      if (upd.rows.length === 0) {
        throw new StaleExecutionError('execution no longer owned by this attempt');
      }
      const row = completedRowSchema.parse(upd.rows[0]);
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
    if (run.rowCount === 0) {
      return undefined;
    }
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
      run: runSummaryRowSchema.parse(run.rows[0]),
      results: results.rows,
      approvals: approvals.rows,
      events: events.rows,
      executions,
      totalCostUsd: costTotalRowSchema.parse(costs.rows[0]).total,
    };
  }
}

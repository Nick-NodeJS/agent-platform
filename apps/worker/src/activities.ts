import { ApplicationFailure } from '@temporalio/activity';
import {
  DEFAULT_AGENT_LEASE_TTL_MS,
  approvalEnvelopeSchema,
  businessEvaluationSchema,
  researchProposalSchema,
  sameArtifacts,
  type AgentExecutor,
  type ApprovalEnvelope,
  type ArtifactRef,
  type ResourceConstraints,
  type Result,
  type ReviewGate,
  type Status,
  type WorkflowStatus,
  type TaskStore,
} from '@platform/contracts';
import {
  ApprovalRejectedError,
  digestPayload,
  loadTrustedSigners,
  sha256Hex,
  verifyApproval,
} from '@platform/contracts/node';
import { DecisionConflictError, type RunRepository } from '@platform/persistence';
import { runAgentStage } from './agent-stage.js';

export interface ActivityDeps {
  repo: RunRepository;
  tasks: TaskStore;
  executor: AgentExecutor;
  /** Path to the PUBLIC trusted-signers file. The worker never receives private keys. */
  trustedSignersFile?: string | undefined;
  leaseTtlMs?: number;
  persistAttempts?: number;
  now?: () => Date;
}

export const RUN_ALREADY_DECIDED = 'RunAlreadyDecided';
export const DECISION_CONFLICT = 'DecisionConflict';

/** The human decision exactly as stored in Postgres; the workflow derives its final status from this. */
export type CanonicalDecision = NonNullable<WorkflowStatus['decision']>;

const RESEARCH_STAGE = 'research';
const EVALUATION_STAGE = 'evaluation';
export const researchResultId = (runId: string) => `${runId}-research-proposal`;
export const evaluationResultId = (runId: string) => `${runId}-business-evaluation`;
export const gateIdFor = (runId: string, revision = 1) =>
  `gate-${sha256Hex(runId).slice(0, 20)}-r${revision}`;

export function createActivities(deps: ActivityDeps) {
  const { repo, tasks, executor } = deps;
  const now = deps.now ?? (() => new Date());
  const stageDeps = {
    repo,
    tasks,
    executor,
    leaseTtlMs: deps.leaseTtlMs ?? DEFAULT_AGENT_LEASE_TTL_MS,
    ...(deps.persistAttempts !== undefined && { persistAttempts: deps.persistAttempts }),
    now,
  };
  const event = (runId: string, eventId: string, type: string, data: Record<string, unknown>) =>
    repo.insertEvent({
      eventId: `${runId}:${eventId}`,
      runId,
      type,
      data,
      createdAt: now().toISOString(),
    });

  /**
   * One logical run id has one immutable human decision. Postgres (not Temporal history) is the authority, so this
   * also protects ids whose histories expired or that are started directly, bypassing the CLI.
   */
  const assertRunNotDecided = async (runId: string): Promise<void> => {
    const state = await repo.getDecisionState(runId);
    if (state && (state.hasDecision || state.terminal)) {
      throw ApplicationFailure.nonRetryable(
        `run ${runId} is already decided (${state.status}); use a new run id for a new evaluation`,
        RUN_ALREADY_DECIDED,
      );
    }
  };

  /** The two results a gate covers, always read from canonical storage (Postgres), never from caller input. */
  const storedGateResults = async (runId: string): Promise<Result[]> => {
    const results: Result[] = [];
    for (const id of [researchResultId(runId), evaluationResultId(runId)]) {
      const stored = await repo.getResult(id);
      if (!stored) {
        throw ApplicationFailure.nonRetryable(`result ${id} is not saved yet`, 'GateNotReady');
      }
      results.push(stored);
    }
    return results;
  };

  const artifactRefs = (results: Result[]): ArtifactRef[] =>
    results.map((result) => ({
      resultId: result.resultId,
      digest: result.digest ?? digestPayload(result.payload),
    }));

  /**
   * Verifies a signed decision against the CURRENT canonical artifacts. Identity comes from the trusted-signers
   * file, never from the caller. `alreadyConsumedOk` is for the re-check inside recordDecision, after the decision id
   * was legitimately consumed by this very run.
   */
  async function verifyAgainstCurrent(
    rawEnvelope: unknown,
    gate: ReviewGate,
    at: Date,
    alreadyConsumedOk = false,
  ) {
    const reject = (m: string): never => {
      throw ApplicationFailure.nonRetryable(m, 'ApprovalRejected');
    };
    if (!deps.trustedSignersFile) {
      return reject('approval verification is not configured (APPROVAL_TRUSTED_SIGNERS_FILE)');
    }
    const parsed = approvalEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) {
      return reject('malformed approval envelope');
    }

    const current = artifactRefs(await storedGateResults(gate.runId));
    if (!sameArtifacts(current, gate.artifacts)) {
      return reject('gate artifacts are no longer current');
    }

    let trusted;
    try {
      trusted = loadTrustedSigners(deps.trustedSignersFile);
    } catch {
      return reject('trusted signers file is unreadable or invalid');
    }
    let verified;
    try {
      verified = verifyApproval(parsed.data, { gate, trusted, now: at });
    } catch (e) {
      if (e instanceof ApprovalRejectedError) {
        return reject(e.message);
      }
      throw e;
    }
    const consumed = await repo.hasDecisionId(parsed.data.payload.decisionId);
    if (consumed && !alreadyConsumedOk) {
      return reject('decision id was already used (replay)');
    }
    return {
      actor: verified.actor,
      keyId: verified.keyId,
      envelopeDigest: verified.envelopeDigest,
      verifiedAt: at.toISOString(),
    };
  }

  return {
    async createTaskAndRun(args: {
      runId: string;
      goal: string;
      constraints: ResourceConstraints;
    }): Promise<{ taskId: string; taskLocation: string }> {
      const { runId, goal, constraints } = args;
      await assertRunNotDecided(runId);
      const taskId = `task-${runId}`;
      const ts = now().toISOString();
      await repo.insertRun({
        runId,
        workflowId: runId,
        taskId,
        goal,
        constraints,
        status: 'CREATED',
        createdAt: ts,
        updatedAt: ts,
      });
      await tasks.createTask({
        taskId,
        runId,
        title: `Research proposal: ${goal}`.slice(0, 200),
        description: `Goal: ${goal}\n\nConstraints: ${JSON.stringify(constraints)}`,
        status: 'CREATED',
        resultIds: [],
        approvalIds: [],
        createdAt: ts,
        updatedAt: ts,
      });
      await event(runId, 'created', 'run.created', { taskId });
      return { taskId, taskLocation: tasks.locate(taskId) };
    },

    async markStage(args: { runId: string; taskId: string; stage: Status }): Promise<void> {
      await repo.updateStatus(args.runId, args.stage);
      await tasks.changeStatus(args.taskId, args.stage);
      await event(args.runId, `stage-${args.stage}`, 'stage.changed', { stage: args.stage });
    },

    async runResearcher(args: {
      runId: string;
      taskId: string;
      goal: string;
      constraints: ResourceConstraints;
    }): Promise<{ resultId: string; title: string; reused: boolean }> {
      const res = await runAgentStage(stageDeps, {
        runId: args.runId,
        taskId: args.taskId,
        role: 'researcher',
        stage: RESEARCH_STAGE,
        kind: 'research-proposal',
        resultId: researchResultId(args.runId),
        input: { goal: args.goal, constraints: args.constraints },
        validateOutput: (output) => researchProposalSchema.parse(output),
      });
      return { resultId: res.resultId, title: res.output.title, reused: res.reused };
    },

    async runBusinessOwner(args: {
      runId: string;
      taskId: string;
      constraints: ResourceConstraints;
    }): Promise<{ resultId: string; recommendation: string; reused: boolean }> {
      const stored = await repo.getResult(researchResultId(args.runId));
      if (!stored) {
        throw ApplicationFailure.nonRetryable('research proposal result not found', 'MissingInput');
      }
      const res = await runAgentStage(stageDeps, {
        runId: args.runId,
        taskId: args.taskId,
        role: 'business-owner',
        stage: EVALUATION_STAGE,
        kind: 'business-evaluation',
        resultId: evaluationResultId(args.runId),
        input: {
          proposal: researchProposalSchema.parse(stored.payload),
          constraints: args.constraints,
        },
        validateOutput: (output) => businessEvaluationSchema.parse(output),
      });
      return {
        resultId: res.resultId,
        recommendation: res.output.recommendation,
        reused: res.reused,
      };
    },

    /**
     * Opens the review gate. Runs only after both results are canonically saved; projects the waiting status
     * to Postgres and the task store first. The workflow exposes the gate only after this Activity returns.
     */
    async openReviewGate(args: { runId: string; taskId: string }): Promise<ReviewGate> {
      await assertRunNotDecided(args.runId);
      const results = await storedGateResults(args.runId);
      const artifacts = artifactRefs(results);
      for (const result of results) {
        await tasks.attachResult(args.taskId, result);
      }
      await repo.updateStatus(args.runId, 'WAITING_FOR_HUMAN_APPROVAL');
      await tasks.changeStatus(args.taskId, 'WAITING_FOR_HUMAN_APPROVAL');
      const gate = await repo.openGate({
        gateId: gateIdFor(args.runId),
        runId: args.runId,
        artifacts,
      });
      await event(args.runId, 'gate-opened', 'gate.opened', { gateId: gate.gateId });
      return gate;
    },

    /**
     * Verifies a signed human decision against the CURRENT gate and canonical artifacts.
     * Returns identity derived from the trusted signer configuration (never from caller claims).
     */
    async verifyApproval(args: {
      // Activity arguments cross a process boundary; the envelope is parsed again here.
      envelope: unknown;
      gate: ReviewGate;
    }): Promise<{ actor: string; keyId: string; envelopeDigest: string; verifiedAt: string }> {
      return verifyAgainstCurrent(args.envelope, args.gate, now());
    },

    /**
     * Persists the run's one human decision (decision + gate closure in one transaction) and projects the CANONICAL stored
     * approval. An identical retry is idempotent; a different decision for the run is a non-retryable DecisionConflict.
     */
    async recordDecision(args: {
      runId: string;
      taskId: string;
      gate: ReviewGate;
      envelope: ApprovalEnvelope;
      verifiedAt: string;
    }): Promise<CanonicalDecision> {
      // Defense in depth: only a fully verified envelope can be persisted as a human decision.
      const verified = await verifyAgainstCurrent(
        args.envelope,
        args.gate,
        new Date(args.verifiedAt),
        true,
      );
      const { payload } = args.envelope;
      let stored;
      try {
        stored = await repo.recordDecision({
          approval: {
            approvalId: `${args.runId}-final-decision`,
            taskId: args.taskId,
            runId: args.runId,
            decision: payload.decision,
            source: 'human',
            actor: verified.actor,
            ...(payload.reason ? { reason: payload.reason } : {}),
            decisionId: payload.decisionId,
            keyId: verified.keyId,
            envelopeDigest: verified.envelopeDigest,
            createdAt: now().toISOString(),
          },
          envelope: args.envelope,
          gateId: args.gate.gateId,
        });
      } catch (error) {
        if (error instanceof DecisionConflictError) {
          throw ApplicationFailure.nonRetryable(error.message, DECISION_CONFLICT);
        }
        throw error;
      }
      const { approval } = stored;
      await tasks.recordApproval(args.taskId, approval);
      await event(args.runId, 'decision', 'approval.recorded', {
        decision: approval.decision,
        source: 'human',
        decisionId: approval.decisionId,
        keyId: approval.keyId,
      });
      return {
        decision: approval.decision,
        source: 'human',
        actor: approval.actor,
        keyId: approval.keyId,
        decisionId: approval.decisionId,
        ...(approval.reason ? { reason: approval.reason } : {}),
      };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

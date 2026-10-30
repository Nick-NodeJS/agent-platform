import { ApplicationFailure } from '@temporalio/activity';
import {
  approvalEnvelopeSchema,
  businessEvaluationSchema,
  researchProposalSchema,
  sameArtifacts,
  type AgentExecutor,
  type ApprovalEnvelope,
  type ArtifactRef,
  type BusinessEvaluation,
  type ResearchProposal,
  type ResourceConstraints,
  type ReviewGate,
  type Status,
  type TaskStore,
} from '@platform/contracts';
import {
  ApprovalRejectedError,
  digestPayload,
  loadTrustedSigners,
  sha256Hex,
  verifyApproval,
} from '@platform/contracts/node';
import type { RunRepository } from '@platform/persistence';
import type { BusinessOwnerInput, ResearcherInput } from '@platform/integrations';
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
    leaseTtlMs: deps.leaseTtlMs ?? 120_000,
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

  /** Gate artifacts always come from canonical stored results (Postgres), never from caller input. */
  const currentArtifacts = async (runId: string): Promise<ArtifactRef[]> => {
    const refs: ArtifactRef[] = [];
    for (const id of [researchResultId(runId), evaluationResultId(runId)]) {
      const r = await repo.getResult(id);
      if (!r)
        throw ApplicationFailure.nonRetryable(`result ${id} is not saved yet`, 'GateNotReady');
      refs.push({ resultId: id, digest: r.digest ?? digestPayload(r.payload) });
    }
    return refs;
  };

  return {
    async createTaskAndRun(args: {
      runId: string;
      goal: string;
      constraints: ResourceConstraints;
    }): Promise<{ taskId: string; taskLocation: string }> {
      const { runId, goal, constraints } = args;
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
      const input: ResearcherInput = { goal: args.goal, constraints: args.constraints };
      const res = await runAgentStage<ResearcherInput, ResearchProposal>(stageDeps, {
        runId: args.runId,
        taskId: args.taskId,
        role: 'researcher',
        stage: RESEARCH_STAGE,
        kind: 'research-proposal',
        resultId: researchResultId(args.runId),
        input,
        validateOutput: (o) => researchProposalSchema.parse(o),
      });
      return { resultId: res.resultId, title: res.output.title, reused: res.reused };
    },

    async runBusinessOwner(args: {
      runId: string;
      taskId: string;
      constraints: ResourceConstraints;
    }): Promise<{ resultId: string; recommendation: string; reused: boolean }> {
      const stored = await repo.getResult(researchResultId(args.runId));
      if (!stored)
        throw ApplicationFailure.nonRetryable('research proposal result not found', 'MissingInput');
      const input: BusinessOwnerInput = {
        proposal: researchProposalSchema.parse(stored.payload),
        constraints: args.constraints,
      };
      const res = await runAgentStage<BusinessOwnerInput, BusinessEvaluation>(stageDeps, {
        runId: args.runId,
        taskId: args.taskId,
        role: 'business-owner',
        stage: EVALUATION_STAGE,
        kind: 'business-evaluation',
        resultId: evaluationResultId(args.runId),
        input,
        validateOutput: (o) => businessEvaluationSchema.parse(o),
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
      const artifacts = await currentArtifacts(args.runId);
      for (const id of artifacts.map((a) => a.resultId)) {
        const r = await repo.getResult(id);
        if (r) await tasks.attachResult(args.taskId, r);
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
      envelope: ApprovalEnvelope;
      gate: ReviewGate;
    }): Promise<{ actor: string; keyId: string; envelopeDigest: string; verifiedAt: string }> {
      return verifyAgainstCurrent(args.envelope, args.gate, now());
    },

    async recordDecision(args: {
      runId: string;
      taskId: string;
      gate: ReviewGate;
      envelope: ApprovalEnvelope;
      verifiedAt: string;
    }): Promise<{ stored: boolean }> {
      // Defense in depth: only a fully verified envelope can be persisted as a human decision.
      const v = await verifyAgainstCurrent(
        args.envelope,
        args.gate,
        new Date(args.verifiedAt),
        true,
      );
      const p = args.envelope.payload;
      const approval = {
        approvalId: `${args.runId}-final-decision`,
        taskId: args.taskId,
        runId: args.runId,
        decision: p.decision,
        source: 'human' as const,
        actor: v.actor,
        ...(p.reason ? { reason: p.reason } : {}),
        decisionId: p.decisionId,
        keyId: v.keyId,
        envelopeDigest: v.envelopeDigest,
        createdAt: now().toISOString(),
      };
      const stored = await repo.insertApproval(approval, args.envelope, args.gate.gateId);
      await tasks.recordApproval(args.taskId, approval);
      await repo.closeGate(args.gate.gateId);
      await event(args.runId, 'decision', 'approval.recorded', {
        decision: p.decision,
        source: 'human',
        decisionId: p.decisionId,
        keyId: v.keyId,
      });
      return { stored };
    },
  };

  async function verifyAgainstCurrent(
    rawEnvelope: unknown,
    gate: ReviewGate,
    at: Date,
    alreadyConsumedOk = false,
  ) {
    const reject = (m: string): never => {
      throw ApplicationFailure.nonRetryable(m, 'ApprovalRejected');
    };
    if (!deps.trustedSignersFile)
      return reject('approval verification is not configured (APPROVAL_TRUSTED_SIGNERS_FILE)');
    const parsed = approvalEnvelopeSchema.safeParse(rawEnvelope);
    if (!parsed.success) return reject('malformed approval envelope');

    const current = await currentArtifacts(gate.runId);
    if (!sameArtifacts(current, gate.artifacts))
      return reject('gate artifacts are no longer current');

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
      if (e instanceof ApprovalRejectedError) return reject(e.message);
      throw e;
    }
    const consumed = await repo.hasDecisionId(parsed.data.payload.decisionId);
    if (consumed && !alreadyConsumedOk) return reject('decision id was already used (replay)');
    return {
      actor: verified.actor,
      keyId: verified.keyId,
      envelopeDigest: verified.envelopeDigest,
      verifiedAt: at.toISOString(),
    };
  }
}

export type Activities = ReturnType<typeof createActivities>;

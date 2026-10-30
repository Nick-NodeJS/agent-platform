import {
  ApplicationFailure,
  allHandlersFinished,
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import {
  approvalEnvelopeSchema,
  sameArtifacts,
  type ApprovalEnvelope,
  type DecisionAck,
  type ResearchProposalInput,
  type ReviewGate,
  type Status,
  type WorkflowStatus,
} from '@platform/contracts';
import type { Activities } from '../activities.js';

// Names must match DECISION_UPDATE / STATUS_QUERY in @platform/contracts.
export const submitDecisionUpdate = defineUpdate<DecisionAck, [unknown]>('submitDecision');
export const statusQuery = defineQuery<WorkflowStatus>('getStatus');

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    nonRetryableErrorTypes: ['ApprovalRejected'],
  },
});

const reject = (message: string, type = 'DecisionRejected'): never => {
  throw ApplicationFailure.nonRetryable(message, type);
};

/**
 * Researcher -> business owner (agent recommendation only) -> review gate -> human decision.
 *
 * Versioning note: the approval mechanism changed from an unsigned Signal to a signed Update. Workflows started by
 * the previous code (local mock-only runs) are NOT replay-compatible; start new runs and leave old histories alone.
 */
export async function researchProposalWorkflow(
  input: ResearchProposalInput,
): Promise<WorkflowStatus> {
  const state: WorkflowStatus = {
    runId: input.runId,
    status: 'CREATED',
    stages: [],
    resultIds: [],
  };
  const enter = (status: Status) => {
    state.status = status;
    state.stages.push({ stage: status, at: new Date().toISOString() });
  };
  // The gate exists only after results are saved and the waiting projection succeeded. Decisions are never buffered.
  let gate = undefined as ReviewGate | undefined;
  let accepted:
    { envelope: ApprovalEnvelope; actor: string; keyId: string; verifiedAt: string } | undefined;

  /** Deterministic structural checks; used by the update validator and re-run after the async verification. */
  const assertAccepting = (raw: unknown): ApprovalEnvelope => {
    if (!gate)
      return reject('review gate is not open yet; submit a fresh decision once the run is waiting');
    if (accepted) return reject('a decision was already accepted for this gate');
    const parsed = approvalEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return reject('malformed approval envelope');
    const p = parsed.data.payload;
    if (p.runId !== input.runId) return reject('decision is for a different run');
    if (p.gateId !== gate.gateId) return reject('decision is for a different (stale) gate');
    if (!sameArtifacts(p.artifacts, gate.artifacts))
      return reject('decision is for different artifacts than the current gate');
    return parsed.data;
  };

  setHandler(statusQuery, () => state);
  setHandler(
    submitDecisionUpdate,
    async (raw) => {
      const envelope = assertAccepting(raw);
      const openGate = gate as ReviewGate;
      let verified;
      try {
        verified = await acts.verifyApproval({ envelope, gate: openGate });
      } catch (e) {
        const cause = (e as { cause?: { message?: string } }).cause;
        return reject(cause?.message ?? 'approval verification failed', 'ApprovalRejected');
      }
      // The gate may have been decided/changed while verification was awaiting: re-check, first valid decision wins.
      if (gate !== openGate) return reject('review gate changed during verification');
      assertAccepting(envelope);
      accepted = {
        envelope,
        actor: verified.actor,
        keyId: verified.keyId,
        verifiedAt: verified.verifiedAt,
      };
      return {
        accepted: true,
        gateId: openGate.gateId,
        decision: envelope.payload.decision,
        decisionId: envelope.payload.decisionId,
      };
    },
    { validator: (raw) => void assertAccepting(raw) },
  );

  enter('CREATED');
  const { taskId } = await acts.createTaskAndRun({
    runId: input.runId,
    goal: input.goal,
    constraints: input.constraints,
  });
  state.taskId = taskId;

  enter('RESEARCHING');
  await acts.markStage({ runId: input.runId, taskId, stage: 'RESEARCHING' });
  const research = await acts.runResearcher({
    runId: input.runId,
    taskId,
    goal: input.goal,
    constraints: input.constraints,
  });
  state.resultIds.push(research.resultId);

  enter('EVALUATING');
  await acts.markStage({ runId: input.runId, taskId, stage: 'EVALUATING' });
  const evaluation = await acts.runBusinessOwner({
    runId: input.runId,
    taskId,
    constraints: input.constraints,
  });
  state.resultIds.push(evaluation.resultId);

  // Results are canonical and saved; open the gate (persists the waiting status) and only then expose it.
  const openedGate = await acts.openReviewGate({ runId: input.runId, taskId });
  enter('WAITING_FOR_HUMAN_APPROVAL');
  state.gate = openedGate;
  gate = openedGate;

  await condition(() => accepted !== undefined);
  const final = accepted as NonNullable<typeof accepted>;
  const payload = final.envelope.payload;

  await acts.recordDecision({
    runId: input.runId,
    taskId,
    gate: openedGate,
    envelope: final.envelope,
    verifiedAt: final.verifiedAt,
  });
  const finalStatus: Status = payload.decision === 'approve' ? 'APPROVED' : 'REJECTED';
  await acts.markStage({ runId: input.runId, taskId, stage: finalStatus });
  enter(finalStatus);
  state.decision = {
    decision: payload.decision,
    source: 'human',
    actor: final.actor,
    keyId: final.keyId,
    decisionId: payload.decisionId,
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
  await condition(allHandlersFinished);
  return state;
}

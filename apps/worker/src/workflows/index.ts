import {
  ActivityFailure,
  ApplicationFailure,
  allHandlersFinished,
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import {
  checkDecisionAgainstGate,
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

const ACTIVITY_TIMEOUT = '1 minute';
const ACTIVITY_MAX_ATTEMPTS = 5;
const ACTIVITY_RETRY_INITIAL_INTERVAL = '1s';
const ACTIVITY_RETRY_BACKOFF_COEFFICIENT = 2;
const ACTIVITY_RETRY_MAX_INTERVAL = '30s';

const activities = proxyActivities<Activities>({
  startToCloseTimeout: ACTIVITY_TIMEOUT,
  retry: {
    maximumAttempts: ACTIVITY_MAX_ATTEMPTS,
    initialInterval: ACTIVITY_RETRY_INITIAL_INTERVAL,
    backoffCoefficient: ACTIVITY_RETRY_BACKOFF_COEFFICIENT,
    maximumInterval: ACTIVITY_RETRY_MAX_INTERVAL,
    nonRetryableErrorTypes: ['ApprovalRejected'],
  },
});

const rejectDecision = (message: string, type = 'DecisionRejected'): never => {
  throw ApplicationFailure.nonRetryable(message, type);
};

const verificationFailureMessage = (error: unknown): string => {
  if (error instanceof ActivityFailure && error.cause instanceof ApplicationFailure) {
    return error.cause.message;
  }
  return 'approval verification failed';
};

interface AcceptedDecision {
  envelope: ApprovalEnvelope;
  actor: string;
  keyId: string;
  verifiedAt: string;
}

/**
 * Researcher -> business owner (agent recommendation only) -> review gate -> human decision.
 *
 * Versioning note: the approval mechanism changed from an unsigned Signal to a signed Update. Workflows started
 * by the previous code (local mock-only runs) are NOT replay-compatible; start new runs and leave old histories alone.
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
  const enterStage = (status: Status) => {
    state.status = status;
    state.stages.push({ stage: status, at: new Date().toISOString() });
  };

  // The gate exists only after results are saved and the waiting projection succeeded.
  // Decisions are never buffered: anything submitted earlier was rejected by the validator.
  const review: { gate?: ReviewGate; accepted?: AcceptedDecision } = {};

  /** Structural gate check shared by the Update validator and the re-check after asynchronous verification. */
  const checkDecision = (raw: unknown) => {
    const check = checkDecisionAgainstGate(raw, {
      runId: input.runId,
      gate: review.gate,
      alreadyAccepted: review.accepted !== undefined,
    });
    return check.ok ? check : rejectDecision(check.reason);
  };

  setHandler(statusQuery, () => state);
  setHandler(
    submitDecisionUpdate,
    async (raw) => {
      const { envelope, gate } = checkDecision(raw);
      let verified;
      try {
        verified = await activities.verifyApproval({ envelope, gate });
      } catch (error) {
        return rejectDecision(verificationFailureMessage(error), 'ApprovalRejected');
      }
      // Another decision may have been accepted while verification was awaiting: first valid decision wins.
      checkDecision(envelope);
      review.accepted = {
        envelope,
        actor: verified.actor,
        keyId: verified.keyId,
        verifiedAt: verified.verifiedAt,
      };
      return {
        accepted: true,
        gateId: gate.gateId,
        decision: envelope.payload.decision,
        decisionId: envelope.payload.decisionId,
      };
    },
    {
      validator: (raw) => {
        checkDecision(raw);
      },
    },
  );

  enterStage('CREATED');
  const { taskId } = await activities.createTaskAndRun({
    runId: input.runId,
    goal: input.goal,
    constraints: input.constraints,
  });
  state.taskId = taskId;

  enterStage('RESEARCHING');
  await activities.markStage({ runId: input.runId, taskId, stage: 'RESEARCHING' });
  const research = await activities.runResearcher({
    runId: input.runId,
    taskId,
    goal: input.goal,
    constraints: input.constraints,
  });
  state.resultIds.push(research.resultId);

  enterStage('EVALUATING');
  await activities.markStage({ runId: input.runId, taskId, stage: 'EVALUATING' });
  const evaluation = await activities.runBusinessOwner({
    runId: input.runId,
    taskId,
    constraints: input.constraints,
  });
  state.resultIds.push(evaluation.resultId);

  // Results are canonical and saved; open the gate (persists the waiting status) and only then expose it.
  const reviewGate = await activities.openReviewGate({ runId: input.runId, taskId });
  enterStage('WAITING_FOR_HUMAN_APPROVAL');
  state.gate = reviewGate;
  review.gate = reviewGate;

  await condition(() => review.accepted !== undefined);
  const { accepted } = review;
  if (accepted === undefined) {
    throw ApplicationFailure.nonRetryable('decision gate released without a decision');
  }
  const { envelope, actor, keyId, verifiedAt } = accepted;
  const { payload } = envelope;

  await activities.recordDecision({
    runId: input.runId,
    taskId,
    gate: reviewGate,
    envelope,
    verifiedAt,
  });
  const finalStatus: Status = payload.decision === 'approve' ? 'APPROVED' : 'REJECTED';
  await activities.markStage({ runId: input.runId, taskId, stage: finalStatus });
  enterStage(finalStatus);
  state.decision = {
    decision: payload.decision,
    source: 'human',
    actor,
    keyId,
    decisionId: payload.decisionId,
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
  await condition(allHandlersFinished);
  return state;
}

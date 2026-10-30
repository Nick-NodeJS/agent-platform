import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  DecisionSignal,
  ResearchProposalInput,
  Status,
  WorkflowStatus,
} from '@platform/contracts';
import type { Activities } from '../activities.js';

// Names must match DECISION_SIGNAL / STATUS_QUERY in @platform/contracts.
export const decisionSignal = defineSignal<[DecisionSignal]>('decision');
export const statusQuery = defineQuery<WorkflowStatus>('getStatus');

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
  retry: {
    maximumAttempts: 5,
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
  },
});

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
  let decision: DecisionSignal | undefined;

  setHandler(statusQuery, () => state);
  setHandler(decisionSignal, (signal) => {
    // Only a human decision can complete the approval gate; agent-sourced signals are ignored.
    // First human decision wins; duplicates are ignored.
    if (signal.source === 'human' && !decision) decision = signal;
  });

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

  enter('WAITING_FOR_HUMAN_APPROVAL');
  await acts.markStage({ runId: input.runId, taskId, stage: 'WAITING_FOR_HUMAN_APPROVAL' });

  await condition(() => decision !== undefined);
  const final = decision as DecisionSignal;

  await acts.recordDecision({
    runId: input.runId,
    taskId,
    decisionId: final.decisionId,
    decision: final.decision,
    actor: final.actor,
    ...(final.reason ? { reason: final.reason } : {}),
  });
  const finalStatus: Status = final.decision === 'approve' ? 'APPROVED' : 'REJECTED';
  enter(finalStatus);
  await acts.markStage({ runId: input.runId, taskId, stage: finalStatus });
  state.decision = {
    decision: final.decision,
    source: 'human',
    actor: final.actor,
    ...(final.reason ? { reason: final.reason } : {}),
  };
  return state;
}

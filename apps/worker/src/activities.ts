import { ApplicationFailure } from '@temporalio/activity';
import {
  businessEvaluationSchema,
  researchProposalSchema,
  type AgentExecutor,
  type BusinessEvaluation,
  type ResearchProposal,
  type ResourceConstraints,
  type Status,
  type TaskStore,
} from '@platform/contracts';
import { RunRepository } from '@platform/persistence';
import type { BusinessOwnerInput, ResearcherInput } from '@platform/integrations';
import { RealExecutionNotImplementedError } from '@platform/integrations';

export interface ActivityDeps {
  repo: RunRepository;
  tasks: TaskStore;
  executor: AgentExecutor;
}

const now = () => new Date().toISOString();

export function createActivities({ repo, tasks, executor }: ActivityDeps) {
  const event = (runId: string, eventId: string, type: string, data: Record<string, unknown>) =>
    repo.insertEvent({ eventId: `${runId}:${eventId}`, runId, type, data, createdAt: now() });

  const callAgent = async <I, O>(
    role: 'researcher' | 'business-owner',
    runId: string,
    input: I,
  ) => {
    try {
      return await executor.run<I, O>({
        role,
        runId,
        idempotencyKey: `${runId}:${role}`,
        input,
      });
    } catch (e) {
      if (e instanceof RealExecutionNotImplementedError)
        throw ApplicationFailure.nonRetryable(e.message, 'RealExecutionNotImplemented');
      throw e;
    }
  };

  return {
    async createTaskAndRun(args: {
      runId: string;
      goal: string;
      constraints: ResourceConstraints;
    }): Promise<{ taskId: string; taskLocation: string }> {
      const { runId, goal, constraints } = args;
      const taskId = `task-${runId}`;
      const ts = now();
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
    }): Promise<{ resultId: string; title: string }> {
      const input: ResearcherInput = { goal: args.goal, constraints: args.constraints };
      const res = await callAgent<ResearcherInput, ResearchProposal>(
        'researcher',
        args.runId,
        input,
      );
      const proposal = researchProposalSchema.parse(res.output);
      const result = {
        resultId: `${args.runId}-research-proposal`,
        taskId: args.taskId,
        runId: args.runId,
        kind: 'research-proposal' as const,
        producedBy: res.executedBy,
        payload: proposal as unknown as Record<string, unknown>,
        createdAt: now(),
      };
      await repo.insertResult(result);
      await tasks.attachResult(args.taskId, result);
      await repo.insertCost({
        entryId: `${args.runId}:researcher`,
        runId: args.runId,
        role: 'researcher',
        costUsd: res.usage.costUsd,
        steps: res.usage.steps,
      });
      return { resultId: result.resultId, title: proposal.title };
    },

    async runBusinessOwner(args: {
      runId: string;
      taskId: string;
      constraints: ResourceConstraints;
    }): Promise<{ resultId: string; recommendation: string }> {
      const stored = (await tasks.getResults(args.taskId)).find(
        (r) => r.kind === 'research-proposal',
      );
      if (!stored)
        throw ApplicationFailure.nonRetryable('research proposal result not found', 'MissingInput');
      const input: BusinessOwnerInput = {
        proposal: researchProposalSchema.parse(stored.payload),
        constraints: args.constraints,
      };
      const res = await callAgent<BusinessOwnerInput, BusinessEvaluation>(
        'business-owner',
        args.runId,
        input,
      );
      const evaluation = businessEvaluationSchema.parse(res.output);
      const result = {
        resultId: `${args.runId}-business-evaluation`,
        taskId: args.taskId,
        runId: args.runId,
        kind: 'business-evaluation' as const,
        producedBy: res.executedBy,
        payload: evaluation as unknown as Record<string, unknown>,
        createdAt: now(),
      };
      await repo.insertResult(result);
      await tasks.attachResult(args.taskId, result);
      await repo.insertCost({
        entryId: `${args.runId}:business-owner`,
        runId: args.runId,
        role: 'business-owner',
        costUsd: res.usage.costUsd,
        steps: res.usage.steps,
      });
      return { resultId: result.resultId, recommendation: evaluation.recommendation };
    },

    async recordDecision(args: {
      runId: string;
      taskId: string;
      decisionId: string;
      decision: 'approve' | 'reject';
      actor: string;
      reason?: string;
    }): Promise<{ stored: boolean }> {
      const approval = {
        approvalId: `${args.runId}-final-decision`,
        taskId: args.taskId,
        runId: args.runId,
        decision: args.decision,
        source: 'human' as const,
        actor: args.actor,
        ...(args.reason ? { reason: args.reason } : {}),
        createdAt: now(),
      };
      const stored = await repo.insertApproval(approval);
      await tasks.recordApproval(args.taskId, approval);
      await event(args.runId, 'decision', 'approval.recorded', {
        decision: args.decision,
        source: 'human',
        decisionId: args.decisionId,
      });
      return { stored };
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

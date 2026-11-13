import {
  ExecutorNotStartedError,
  checkProposalAgainstConstraints,
  type AgentExecutor,
  type AgentRoleIO,
  type AgentRunRequest,
  type AgentRunResponse,
  type ExecutableRole,
} from '@platform/contracts';

type MockHandlers = {
  [R in ExecutableRole]: (input: AgentRoleIO[R]['input']) => AgentRoleIO[R]['output'];
};

const MOCK_COST_USD = 0;
const MOCK_STEPS = 1;
const MOCK_EVALUATION_SCORE = 5;
// Fictional estimates chosen to fit the owner-agreed default limits (see config/platform-constraints.json).
const MOCK_BUILD_USD = 30;
const MOCK_MONTHLY_RUN_USD = 20;
const MOCK_MONTHLY_REVENUE_USD = 100;
const MOCK_WEEKS_TO_LAUNCH = 3;

const mockHandlers: MockHandlers = {
  researcher: (input) => ({
    fictionalExample: true,
    title: 'FICTIONAL EXAMPLE: Neighborhood tool-sharing API',
    summary: `Mock output for goal "${input.goal}". This is placeholder text, not market research.`,
    productType: 'api',
    domain: 'consumer marketplace',
    market: 'FICTIONAL: urban neighborhoods',
    customer: 'FICTIONAL: households that rarely use tools they own',
    problem: 'FICTIONAL: tools are bought, used once and stored',
    valueProposition: 'FICTIONAL: borrow nearby instead of buying',
    demand: {
      evidence: [{ kind: 'assumption', description: 'Mock assumption: no real data was used.' }],
      validationPlan: 'FICTIONAL: a waitlist page and ten customer interviews before building.',
      willingnessToPay: 'FICTIONAL: a small monthly fee',
    },
    hosting: {
      provider: 'aws',
      services: ['managed-container-service', 'managed-database'],
      productionGrade: true,
      productionNotes: 'FICTIONAL: separate environments, automated backups, basic monitoring.',
    },
    delivery: {
      weeksToLaunch: MOCK_WEEKS_TO_LAUNCH,
      deployableUnits: ['api-service', 'managed-database'],
    },
    cost: {
      buildUsd: MOCK_BUILD_USD,
      monthlyRunUsd: MOCK_MONTHLY_RUN_USD,
      expectedMonthlyRevenueUsd: MOCK_MONTHLY_REVENUE_USD,
      breakEvenMonths: 1,
    },
    assumptions: ['Mock assumption: none were derived from real data.'],
    unknowns: Object.entries(input.constraints.limits)
      .filter(([, value]) => value === 'unknown')
      .map(([name]) => `limits.${name} was not provided by the human owner`),
  }),
  'business-owner': (input) => {
    const constraintChecks = checkProposalAgainstConstraints(input.proposal, input.constraints);
    const failed = constraintChecks.filter((check) => check.status === 'fail');
    return {
      recommendation: failed.length === 0 ? 'proceed' : 'do-not-proceed',
      score: MOCK_EVALUATION_SCORE,
      rationale: `Mock evaluation of "${input.proposal.title}". Not based on real analysis and not a human approval.`,
      isHumanApproval: false,
      constraintChecks,
    };
  },
};

/** Deterministic, offline, free. Outputs are visibly fictional and are NOT market research. */
export class MockAgentExecutor implements AgentExecutor {
  async run<R extends ExecutableRole>(
    request: AgentRunRequest<R>,
  ): Promise<AgentRunResponse<AgentRoleIO[R]['output']>> {
    const handler: MockHandlers[R] = mockHandlers[request.role];
    return {
      output: handler(request.input),
      usage: { costUsd: MOCK_COST_USD, steps: MOCK_STEPS },
      executedBy: 'mock',
    };
  }
}

export class RealExecutionNotImplementedError extends ExecutorNotStartedError {}

/**
 * OpenHands execution boundary (deferred). No requests are implemented in milestone 1,
 * and this executor must never fall back to the mock.
 */
export class OpenHandsAgentExecutor implements AgentExecutor {
  async run<R extends ExecutableRole>(
    _request: AgentRunRequest<R>,
  ): Promise<AgentRunResponse<AgentRoleIO[R]['output']>> {
    throw new RealExecutionNotImplementedError(
      'Real agent execution is not implemented in milestone 1; use EXECUTION_MODE=mock.',
    );
  }
}

export function createExecutor(mode: 'mock' | 'openhands'): AgentExecutor {
  return mode === 'mock' ? new MockAgentExecutor() : new OpenHandsAgentExecutor();
}

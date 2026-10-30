import {
  ExecutorNotStartedError,
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

const mockHandlers: MockHandlers = {
  researcher: (input) => ({
    fictionalExample: true,
    title: 'FICTIONAL EXAMPLE: Neighborhood tool-sharing app',
    summary: `Mock output for goal "${input.goal}". This is placeholder text, not market research.`,
    assumptions: ['Mock assumption: none were derived from real data.'],
    unknowns: Object.entries(input.constraints)
      .filter(([, value]) => value === 'unknown')
      .map(([name]) => `${name} was not provided by the human owner`),
  }),
  'business-owner': (input) => ({
    recommendation: 'proceed',
    score: MOCK_EVALUATION_SCORE,
    rationale: `Mock evaluation of "${input.proposal.title}". Not based on real analysis and not a human approval.`,
    isHumanApproval: false,
  }),
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

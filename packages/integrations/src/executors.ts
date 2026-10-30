import type {
  AgentExecutor,
  AgentRunRequest,
  AgentRunResponse,
  BusinessEvaluation,
  ResearchProposal,
  ResourceConstraints,
} from '@platform/contracts';

export interface ResearcherInput {
  goal: string;
  constraints: ResourceConstraints;
}
export interface BusinessOwnerInput {
  proposal: ResearchProposal;
  constraints: ResourceConstraints;
}

/** Deterministic, offline, free. Outputs are visibly fictional and are NOT market research. */
export class MockAgentExecutor implements AgentExecutor {
  async run<I, O>(request: AgentRunRequest<I>): Promise<AgentRunResponse<O>> {
    let output: unknown;
    switch (request.role) {
      case 'researcher': {
        const input = request.input as ResearcherInput;
        const proposal: ResearchProposal = {
          fictionalExample: true,
          title: 'FICTIONAL EXAMPLE: Neighborhood tool-sharing app',
          summary: `Mock output for goal "${input.goal}". This is placeholder text, not market research.`,
          assumptions: ['Mock assumption: none were derived from real data.'],
          unknowns: Object.entries(input.constraints)
            .filter(([, v]) => v === 'unknown')
            .map(([k]) => `${k} was not provided by the human owner`),
        };
        output = proposal;
        break;
      }
      case 'business-owner': {
        const input = request.input as BusinessOwnerInput;
        const evaluation: BusinessEvaluation = {
          recommendation: 'proceed',
          score: 5,
          rationale: `Mock evaluation of "${input.proposal.title}". Not based on real analysis and not a human approval.`,
          isHumanApproval: false,
        };
        output = evaluation;
        break;
      }
      default:
        throw new Error(`MockAgentExecutor does not implement role: ${request.role}`);
    }
    return { output: output as O, usage: { costUsd: 0, steps: 1 }, executedBy: 'mock' };
  }
}

export class RealExecutionNotImplementedError extends Error {}

/**
 * OpenHands execution boundary (deferred). No requests are implemented in milestone 1,
 * and this executor must never fall back to the mock.
 */
export class OpenHandsAgentExecutor implements AgentExecutor {
  async run<I, O>(_request: AgentRunRequest<I>): Promise<AgentRunResponse<O>> {
    throw new RealExecutionNotImplementedError(
      'Real agent execution is not implemented in milestone 1; use EXECUTION_MODE=mock.',
    );
  }
}

export function createExecutor(mode: 'mock' | 'openhands'): AgentExecutor {
  return mode === 'mock' ? new MockAgentExecutor() : new OpenHandsAgentExecutor();
}

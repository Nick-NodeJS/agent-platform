import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import {
  businessEvaluationSchema,
  platformConstraintsSchema,
  researchProposalSchema,
  type AgentSpendLimit,
  type PlatformConstraints,
} from '@platform/contracts';
import { loadModelProfiles, loadPlatformConstraints } from '@platform/contracts/node';
import { OpenAiAgentExecutor } from '@platform/integrations';
import { executionIdFor } from '../../apps/worker/src/agent-stage.js';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.js';
import {
  createEnv,
  startRun,
  startWorker,
  terminateQuietly,
  waitForGate,
  type Env,
  type RunningWorker,
} from './harness.js';

const configFile = (name: string) =>
  fileURLToPath(new URL(`../../config/${name}`, import.meta.url));
const profiles = loadModelProfiles(configFile('model-profiles.json'));
const agreed = loadPlatformConstraints(configFile('platform-constraints.json'));

const researchOutput = {
  title: 'Invoice reminder API',
  summary: 'Polite payment reminders for small shops.',
  productType: 'api',
  domain: 'small business finance',
  market: 'small shops',
  customer: 'shop owners',
  problem: 'late payments',
  valueProposition: 'automatic reminders',
  demand: {
    evidence: [{ kind: 'test', description: 'ten interviews', url: null }],
    validationPlan: 'two-week waitlist page',
    willingnessToPay: 'about 15 USD a month',
  },
  hosting: {
    provider: 'aws',
    services: ['managed-container-service', 'managed-database'],
    productionGrade: true,
    productionNotes: 'two environments, backups, alarms',
  },
  delivery: {
    weeksToLaunch: 3,
    deployableUnits: ['api-service', 'managed-database'],
    complexityJustification: null,
  },
  cost: { buildUsd: 30, monthlyRunUsd: 20, expectedMonthlyRevenueUsd: 120, breakEvenMonths: 1 },
  assumptions: ['2% conversion'],
  unknowns: [],
};
const evaluationOutput = { recommendation: 'proceed', score: 7, rationale: 'Plausible and cheap.' };

const providerReply = (text: unknown, usage: Record<string, unknown>, searches: number) => ({
  id: `resp_${searches}`,
  status: 'completed',
  output: [
    ...Array.from({ length: searches }, (_unused, index) => ({
      type: 'web_search_call',
      id: `ws_${index}`,
    })),
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: JSON.stringify(text),
          annotations: [{ type: 'url_citation', url: 'https://example.com/a', title: 'Source A' }],
        },
      ],
    },
  ],
  usage,
});

// 0.16 + 0.002 + 0.1 + 2 searches x 0.01 = 0.282, and 0.01 + 0.01 = 0.02
const RESEARCH_COST_USD = 0.282;
const EVALUATION_COST_USD = 0.02;

function respond(body: unknown): unknown {
  const format = z
    .object({ text: z.object({ format: z.object({ name: z.string() }) }) })
    .parse(body).text.format.name;
  return format === 'research_proposal'
    ? providerReply(
        researchOutput,
        {
          input_tokens: 100_000,
          input_tokens_details: { cached_tokens: 20_000 },
          output_tokens: 10_000,
        },
        2,
      )
    : providerReply(evaluationOutput, { input_tokens: 5_000, output_tokens: 1_000 }, 0);
}

describe('real OpenAI executor through Temporal, Postgres and the spending guard (fake provider)', () => {
  let env: Env;
  let provider: FakeOpenAi;
  let worker: RunningWorker | undefined;
  const startedRuns: string[] = [];

  beforeAll(async () => {
    env = await createEnv();
  });
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
    await provider?.close();
  });
  afterAll(async () => {
    for (const runId of startedRuns) {
      await terminateQuietly(env, runId);
    }
    await env?.cleanup();
  });

  const withLimit = (agentSpend: AgentSpendLimit): PlatformConstraints =>
    platformConstraintsSchema.parse({ ...agreed, limits: { ...agreed.limits, agentSpend } });

  const launch = async (runConstraints: PlatformConstraints) => {
    provider = await startFakeOpenAi(respond);
    const executor = new OpenAiAgentExecutor({
      apiKey: 'sk-test-0123456789abcdefghijklmnop',
      profiles,
      baseUrl: provider.baseUrl,
    });
    worker = await startWorker(env, { executor, spendPolicy: profiles.spend });
    const runId = await startRun(env, undefined, runConstraints);
    startedRuns.push(runId);
    return runId;
  };

  const rootCauseType = async (runId: string) => {
    const outcome = await env.client.workflow
      .getHandle(runId)
      .result()
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (!(outcome instanceof WorkflowFailedError)) {
      throw new Error('expected the workflow to fail');
    }
    let cause: Error = outcome;
    while (cause.cause instanceof Error) {
      cause = cause.cause;
    }
    return cause instanceof ApplicationFailure ? cause.type : undefined;
  };

  it('runs both stages against the provider, stores real-looking results, cost and call details', async () => {
    const runId = await launch(agreed);

    await waitForGate(env, runId);

    const summary = await env.repo.getRunSummary(runId);
    expect(summary?.totalCostUsd).toBeCloseTo(RESEARCH_COST_USD + EVALUATION_COST_USD, 6);
    const proposal = researchProposalSchema.parse(
      (await env.repo.getResult(`${runId}-research-proposal`))?.payload,
    );
    const evaluation = businessEvaluationSchema.parse(
      (await env.repo.getResult(`${runId}-business-evaluation`))?.payload,
    );
    expect(proposal.fictionalExample).toBe(false);
    expect(proposal.demand.evidence.map((entry) => entry.url)).toContain('https://example.com/a');
    expect(evaluation).toMatchObject({ recommendation: 'proceed', isHumanApproval: false });
    expect(evaluation.constraintChecks.filter((check) => check.status === 'fail')).toEqual([]);
    const logged = await env.db.query(
      `SELECT count(*)::int AS n FROM execution_events WHERE run_id=$1 AND type='agent.call.completed'`,
      [runId],
    );
    expect(z.object({ n: z.number() }).parse(logged.rows[0]).n).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.map((request) => request.url)).toEqual([
      '/v1/responses',
      '/v1/responses',
    ]);
    for (const role of ['researcher', 'business-owner']) {
      const execution = await env.repo.getExecution(
        executionIdFor(runId, role, role === 'researcher' ? 'research' : 'evaluation'),
      );
      expect(execution).toMatchObject({ state: 'succeeded', executedBy: 'agent' });
    }
  });

  it('never calls the provider when the run has no agent allowance (fail closed)', async () => {
    const runId = await launch(withLimit('unknown'));

    expect(await rootCauseType(runId)).toBe('BudgetNotConfigured');
    expect(provider.requests).toEqual([]);
  });

  it('stops before the second paid call when the per-run budget is used up', async () => {
    // After the researcher (0.282 USD) only 0.318 of 0.6 is left, below the 0.5 minimum.
    const runId = await launch(withLimit({ unit: 'usd', perRunUsd: 0.6, perMonthUsd: 20 }));

    expect(await rootCauseType(runId)).toBe('BudgetExceeded');
    expect(provider.requests).toHaveLength(1);
    const evaluation = await env.repo.getExecution(
      executionIdFor(runId, 'business-owner', 'evaluation'),
    );
    expect(evaluation).toMatchObject({ state: 'pending', attempts: 0 });
    expect((await env.repo.getRunSummary(runId))?.totalCostUsd).toBeCloseTo(RESEARCH_COST_USD, 6);
  });
});

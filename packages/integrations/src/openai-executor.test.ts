import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecutorNotStartedError,
  businessEvaluationSchema,
  researchProposalSchema,
  type ModelProfiles,
  type ModelPricing,
  type PlatformConstraints,
  type ResearchProposal,
} from '@platform/contracts';
import { loadModelProfiles, loadPlatformConstraints } from '@platform/contracts/node';
import {
  EVALUATION_JSON_SCHEMA,
  OpenAiAgentExecutor,
  RESEARCH_JSON_SCHEMA,
  computeCallCostUsd,
  evaluationModelOutputSchema,
  researchModelOutputSchema,
} from './index.js';

const configFile = (name: string) =>
  fileURLToPath(new URL(`../../../config/${name}`, import.meta.url));
const profiles = loadModelProfiles(configFile('model-profiles.json'));
const constraints: PlatformConstraints = loadPlatformConstraints(
  configFile('platform-constraints.json'),
);
const pricing: ModelPricing = profiles.pricing['gpt-6.1-sol'] ?? failTest('pricing missing');

function portOf(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  return address.port;
}

function failTest(message: string): never {
  throw new Error(message);
}

const API_KEY = 'sk-test-0123456789abcdefghijklmnop';

const modelResearch = {
  title: 'Invoice reminder API',
  summary: 'Sends polite payment reminders for small shops.',
  productType: 'api',
  domain: 'small business finance',
  market: 'small shops in the EU',
  customer: 'shop owners',
  problem: 'late payments',
  valueProposition: 'automatic reminders',
  demand: {
    evidence: [
      { kind: 'assumption', description: 'shop owners dislike chasing payments', url: null },
      { kind: 'source', description: 'late payment survey', url: 'https://example.com/survey' },
      { kind: 'source', description: 'broken link', url: 'not a url' },
    ],
    validationPlan: 'waitlist page for two weeks, ten interviews',
    willingnessToPay: 'about 15 USD per month',
  },
  hosting: {
    provider: 'aws',
    services: ['managed-container-service', 'managed-database'],
    productionGrade: true,
    productionNotes: 'two environments, daily backups, alarms',
  },
  delivery: {
    weeksToLaunch: 3,
    deployableUnits: ['api-service', 'managed-database'],
    complexityJustification: null,
  },
  cost: { buildUsd: 30, monthlyRunUsd: 20, expectedMonthlyRevenueUsd: null, breakEvenMonths: null },
  assumptions: ['conversion of 2%'],
  unknowns: ['limits.minimumMonthlyMarginUsd was not provided by the human owner'],
};

const USAGE = {
  input_tokens: 100_000,
  input_tokens_details: { cached_tokens: 20_000 },
  output_tokens: 10_000,
};

function responseBody(text: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp_1',
    status: 'completed',
    output: [
      { type: 'web_search_call', id: 'ws_1' },
      { type: 'web_search_call', id: 'ws_2' },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify(text),
            annotations: [
              { type: 'url_citation', url: 'https://example.com/a', title: 'Source A' },
              { type: 'url_citation', url: 'https://example.com/a', title: 'Source A again' },
              { type: 'url_citation', url: 'https://example.com/b', title: 'Source B' },
            ],
          },
        ],
      },
    ],
    usage: USAGE,
    ...overrides,
  };
}

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

type Handler = (response: http.ServerResponse) => void;

describe('OpenAiAgentExecutor against a fake provider', () => {
  let server: http.Server;
  let baseUrl: string;
  let requests: RecordedRequest[];
  let handler: Handler;

  const reply =
    (status: number, body: unknown): Handler =>
    (response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

  beforeEach(async () => {
    requests = [];
    handler = reply(200, responseBody(modelResearch));
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: parsed,
        });
        handler(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${portOf(server)}/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const executor = (override: ModelProfiles = profiles, url = baseUrl) =>
    new OpenAiAgentExecutor({ apiKey: API_KEY, profiles: override, baseUrl: url });

  const researcherRequest = {
    role: 'researcher',
    runId: 'run-1',
    idempotencyKey: 'run-1:researcher:research:abcd',
    input: { goal: 'find a small B2B API', constraints },
  } as const;

  const proposal = (): ResearchProposal =>
    researchProposalSchema.parse({
      fictionalExample: false,
      title: 'p',
      summary: 's',
      productType: 'api',
      domain: 'd',
      market: 'm',
      customer: 'c',
      problem: 'p',
      valueProposition: 'v',
      demand: { evidence: [], validationPlan: '', willingnessToPay: 'w' },
      hosting: { provider: 'aws', services: ['x'], productionGrade: true, productionNotes: 'n' },
      delivery: { weeksToLaunch: 3, deployableUnits: ['u'] },
      cost: { buildUsd: 1, monthlyRunUsd: 1, expectedMonthlyRevenueUsd: 5, breakEvenMonths: 1 },
      assumptions: [],
      unknowns: [],
    });

  it('researcher: sends a restricted, strict, bounded request and keeps secrets out of it', async () => {
    await executor().run(researcherRequest);

    const [sent] = requests;
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/responses' });
    expect(sent?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(sent?.body).toMatchObject({
      model: 'gpt-6.1-sol',
      store: false,
      reasoning: { effort: 'medium' },
      max_output_tokens: 24_000,
      max_tool_calls: 12,
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
      text: { format: { type: 'json_schema', strict: true, schema: RESEARCH_JSON_SCHEMA } },
      metadata: {
        run_id: 'run-1',
        role: 'researcher',
        idempotency_key: researcherRequest.idempotencyKey,
      },
    });
    const serialized = JSON.stringify(sent?.body);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).toContain('find a small B2B API');
    expect(serialized).toContain('buildBudgetUsd');
    expect(serialized).not.toContain('perRunUsd');
    expect(serialized).toContain('untrusted');
  });

  it('business owner: no tools at all', async () => {
    handler = reply(200, responseBody({ recommendation: 'proceed', score: 7, rationale: 'ok' }));

    await executor().run({
      role: 'business-owner',
      runId: 'run-1',
      idempotencyKey: 'k',
      input: { proposal: proposal(), constraints },
    });

    const body = z
      .object({ tools: z.unknown().optional(), max_tool_calls: z.unknown().optional() })
      .passthrough()
      .parse(requests[0]?.body);
    expect(body.tools).toBeUndefined();
    expect(body.max_tool_calls).toBeUndefined();
    expect(requests[0]?.body).toMatchObject({
      text: { format: { strict: true, schema: EVALUATION_JSON_SCHEMA } },
    });
  });

  it('researcher output is mapped to a valid proposal with observed citations, cost and usage details', async () => {
    const response = await executor().run(researcherRequest);

    const parsed = researchProposalSchema.parse(response.output);
    expect(parsed.fictionalExample).toBe(false);
    expect(parsed.cost.expectedMonthlyRevenueUsd).toBe('unknown');
    expect(parsed.cost.breakEvenMonths).toBe('unknown');
    expect(parsed.delivery.complexityJustification).toBeUndefined();
    expect(parsed.demand.evidence).toEqual([
      { kind: 'assumption', description: 'shop owners dislike chasing payments' },
      { kind: 'source', description: 'late payment survey', url: 'https://example.com/survey' },
      { kind: 'source', description: 'broken link' },
      { kind: 'source', description: 'Source A', url: 'https://example.com/a' },
      { kind: 'source', description: 'Source B', url: 'https://example.com/b' },
    ]);
    expect(response.executedBy).toBe('agent');
    expect(response.usage.costUsd).toBe(0.282); // 2 searches
    expect(response.usage.steps).toBe(3);
    expect(response.usage.details).toMatchObject({
      model: 'gpt-6.1-sol',
      responseId: 'resp_1',
      inputTokens: 100_000,
      cachedInputTokens: 20_000,
      outputTokens: 10_000,
      webSearchCalls: 2,
    });
  });

  it('business owner output is never a human approval and carries no model-made checks', async () => {
    handler = reply(200, responseBody({ recommendation: 'proceed', score: 7, rationale: 'ok' }));

    const response = await executor().run({
      role: 'business-owner',
      runId: 'run-1',
      idempotencyKey: 'k',
      input: { proposal: proposal(), constraints },
    });

    expect(businessEvaluationSchema.parse(response.output)).toMatchObject({
      recommendation: 'proceed',
      isHumanApproval: false,
      constraintChecks: [],
    });
  });

  it.each([400, 401, 403, 429])(
    'HTTP %i means the provider refused before doing work: not started, key never echoed',
    async (status) => {
      handler = reply(status, { error: { message: `Incorrect API key provided: ${API_KEY}` } });

      const outcome = await executor()
        .run(researcherRequest)
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      if (!(outcome instanceof ExecutorNotStartedError)) {
        throw new Error(`expected ExecutorNotStartedError, got ${String(outcome)}`);
      }
      expect(outcome.message).toContain(`(${status})`);
      expect(outcome.message).not.toContain(API_KEY);
    },
  );

  const mayHaveRun = async (attempt: Promise<unknown>) => {
    const outcome = await attempt.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(outcome instanceof Error) || outcome instanceof ExecutorNotStartedError) {
      throw new Error(`expected a plain "may have run" error, got ${String(outcome)}`);
    }
    return outcome;
  };

  it.each([500, 502, 503])(
    'HTTP %i may have been billed: treated as "may have run"',
    async (status) => {
      handler = reply(status, { error: { message: 'overloaded' } });
      await mayHaveRun(executor().run(researcherRequest));
    },
  );

  it.each([
    [
      'an incomplete response',
      responseBody(modelResearch, {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    ],
    [
      'a refusal',
      responseBody(modelResearch, {
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      }),
    ],
    [
      'text that is not JSON',
      {
        ...responseBody(modelResearch),
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'sorry' }] }],
      },
    ],
    ['JSON missing required fields', responseBody({ title: 'only a title' })],
    ['a response without usage', { id: 'resp_2', status: 'completed', output: [] }],
  ])('%s is "may have run", never silently accepted', async (_name, body) => {
    handler = reply(200, body);
    await mayHaveRun(executor().run(researcherRequest));
  });

  it('a provider that never answers ends at the profile time limit as "may have run"', async () => {
    handler = () => undefined; // never responds
    const quick: ModelProfiles = {
      ...profiles,
      roles: { ...profiles.roles, researcher: { ...profiles.roles.researcher, timeoutMs: 150 } },
    };
    await mayHaveRun(executor(quick).run(researcherRequest));
  });

  it('cancellation through the abort signal stops the call and counts as "may have run"', async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const attempt = executor().run(researcherRequest, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await mayHaveRun(attempt);
  });

  it('an unreachable provider means nothing was sent: not started', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${portOf(closed)}/v1`;
    await new Promise((resolve) => closed.close(resolve));

    const outcome = await executor(profiles, url)
      .run(researcherRequest)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(ExecutorNotStartedError);
  });

  it('refuses a model that has no price instead of running it unmetered', async () => {
    const unpriced: ModelProfiles = { ...profiles, pricing: {} };
    const outcome = await executor(unpriced)
      .run(researcherRequest)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(ExecutorNotStartedError);
    expect(requests).toEqual([]);
  });
});

describe('computeCallCostUsd', () => {
  it('prices uncached, cached and output tokens plus search calls', () => {
    const usage = { inputTokens: 100_000, cachedInputTokens: 20_000, outputTokens: 10_000 };
    expect(computeCallCostUsd(usage, 3, pricing)).toBe(0.292);
  });

  it('applies the long-context multipliers to the whole request', () => {
    const usage = { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 10_000 };
    expect(computeCallCostUsd(usage, 0, pricing)).toBe(1.35);
  });

  it('is free for an empty call and never counts more cached tokens than input tokens', () => {
    expect(
      computeCallCostUsd({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, 0, pricing),
    ).toBe(0);
    const clamped = { inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 0 };
    expect(computeCallCostUsd(clamped, 0, pricing)).toBe(0.1 * 1 * 2); // all cached, long-context 2x
  });
});

interface JsonNode {
  type?: string | undefined;
  properties?: Record<string, JsonNode> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
  items?: JsonNode | undefined;
  anyOf?: JsonNode[] | undefined;
}
const jsonNodeSchema: z.ZodType<JsonNode> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      properties: z.record(jsonNodeSchema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.boolean().optional(),
      items: jsonNodeSchema.optional(),
      anyOf: z.array(jsonNodeSchema).optional(),
    })
    .passthrough(),
);

describe('model-facing JSON schemas', () => {
  const jsonShape = (raw: unknown): unknown => {
    const node = jsonNodeSchema.parse(raw);
    if (node.anyOf) {
      return jsonShape(node.anyOf.find((option) => option.type !== 'null'));
    }
    if (node.type === 'object') {
      const properties = node.properties ?? {};
      expect(node.required).toEqual(Object.keys(properties));
      expect(node.additionalProperties).toBe(false);
      return Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, jsonShape(value)]),
      );
    }
    return node.type === 'array' ? [jsonShape(node.items)] : 'leaf';
  };
  /** The shape of a sample value: object keys, the first array element, and one leaf for everything else. */
  const sampleShape = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return [sampleShape(value[0])];
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, sampleShape(entry)]),
      );
    }
    return 'leaf';
  };

  it('describe exactly the fields the Zod schemas accept, all required and closed', () => {
    const evaluation = { recommendation: 'proceed', score: 7, rationale: 'ok' };
    // The samples pass the strict Zod schemas (no extra keys) and have every key the JSON schemas require.
    expect(researchModelOutputSchema.safeParse(modelResearch).success).toBe(true);
    expect(evaluationModelOutputSchema.safeParse(evaluation).success).toBe(true);
    expect(jsonShape(RESEARCH_JSON_SCHEMA)).toEqual(sampleShape(modelResearch));
    expect(jsonShape(EVALUATION_JSON_SCHEMA)).toEqual(sampleShape(evaluation));
  });
});

import { z } from 'zod';
import {
  ExecutorNotStartedError,
  type AgentExecutor,
  type AgentRoleIO,
  type AgentRunOptions,
  type AgentRunRequest,
  type AgentRunResponse,
  type ExecutableRole,
  type ModelProfiles,
  type OpenAiRoleProfile,
} from '@platform/contracts';
import { redactString } from '../redact.js';
import { computeCallCostUsd } from './cost.js';
import {
  EVALUATION_JSON_SCHEMA,
  RESEARCH_JSON_SCHEMA,
  evaluationModelOutputSchema,
  researchModelOutputSchema,
  toBusinessEvaluation,
  toResearchProposal,
  type Citation,
} from './model-output.js';
import {
  BUSINESS_OWNER_INSTRUCTIONS,
  RESEARCHER_INSTRUCTIONS,
  businessOwnerInput,
  researcherInput,
} from './prompts.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MAX_ERROR_MESSAGE_CHARS = 300;

/** HTTP statuses where the provider refused the request before doing (or billing) any work. */
const REJECTED_BEFORE_WORK = new Set([400, 401, 403, 404, 422, 429]);
/** Socket error codes meaning the request never reached the provider. */
const NEVER_CONNECTED = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);

const errorBodySchema = z.object({ error: z.object({ message: z.string() }).partial() }).partial();

const annotationSchema = z
  .object({ type: z.string(), url: z.string().optional(), title: z.string().optional() })
  .passthrough();
const outputItemSchema = z
  .object({
    type: z.string(),
    content: z
      .array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
            annotations: z.array(annotationSchema).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const responseSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullish(),
    output: z.array(outputItemSchema),
    usage: z
      .object({
        input_tokens: z.number(),
        input_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
        output_tokens: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

interface CallResult {
  text: string;
  citations: Citation[];
  webSearchCalls: number;
  costUsd: number;
  details: Record<string, string | number>;
}

interface RoleSpec<R extends ExecutableRole> {
  profile: (profiles: ModelProfiles) => OpenAiRoleProfile;
  request: (input: AgentRoleIO[R]['input']) => {
    instructions: string;
    input: string;
    schemaName: string;
    schema: Record<string, unknown>;
  };
  output: (text: string, citations: Citation[]) => AgentRoleIO[R]['output'];
}

type RoleSpecs = { [R in ExecutableRole]: RoleSpec<R> };

const ROLE_SPECS: RoleSpecs = {
  researcher: {
    profile: (profiles) => profiles.roles.researcher,
    request: (input) => ({
      instructions: RESEARCHER_INSTRUCTIONS,
      input: researcherInput(input.goal, input.constraints),
      schemaName: 'research_proposal',
      schema: RESEARCH_JSON_SCHEMA,
    }),
    output: (text, citations) =>
      toResearchProposal(researchModelOutputSchema.parse(JSON.parse(text)), citations),
  },
  'business-owner': {
    profile: (profiles) => profiles.roles['business-owner'],
    request: (input) => ({
      instructions: BUSINESS_OWNER_INSTRUCTIONS,
      input: businessOwnerInput(input.proposal, input.constraints),
      schemaName: 'business_evaluation',
      schema: EVALUATION_JSON_SCHEMA,
    }),
    output: (text) => toBusinessEvaluation(evaluationModelOutputSchema.parse(JSON.parse(text))),
  },
};

export interface OpenAiExecutorOptions {
  apiKey: string;
  profiles: ModelProfiles;
  baseUrl?: string;
  /** Replaceable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Calls the OpenAI Responses API directly (no agent framework). Per role it uses only the tools its profile allows
 * (web search for the researcher, none for the business owner), a strict JSON schema, hard token and tool-call
 * ceilings, `store: false`, and a time limit below the stage timeout. Failures follow the executor contract:
 * `ExecutorNotStartedError` only where the provider refused before doing work, anything else means "may have run".
 */
export class OpenAiAgentExecutor implements AgentExecutor {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiExecutorOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run<R extends ExecutableRole>(
    request: AgentRunRequest<R>,
    runOptions?: AgentRunOptions,
  ): Promise<AgentRunResponse<AgentRoleIO[R]['output']>> {
    const spec: RoleSpec<R> = ROLE_SPECS[request.role];
    const profile = spec.profile(this.options.profiles);
    const call = await this.call(request, spec, profile, runOptions?.signal);
    return {
      output: spec.output(call.text, call.citations),
      usage: {
        costUsd: call.costUsd,
        steps: call.webSearchCalls + 1,
        details: call.details,
      },
      executedBy: 'agent',
    };
  }

  private async call<R extends ExecutableRole>(
    request: AgentRunRequest<R>,
    spec: RoleSpec<R>,
    profile: OpenAiRoleProfile,
    signal: AbortSignal | undefined,
  ): Promise<CallResult> {
    const pricing = this.options.profiles.pricing[profile.model];
    if (!pricing) {
      throw new ExecutorNotStartedError(`no pricing configured for model ${profile.model}`);
    }
    const parts = spec.request(request.input);
    const body = {
      model: profile.model,
      instructions: parts.instructions,
      input: parts.input,
      reasoning: { effort: profile.reasoningEffort },
      max_output_tokens: profile.maxOutputTokens,
      ...(profile.tools.length > 0 && {
        tools: [{ type: 'web_search', search_context_size: profile.searchContextSize }],
        max_tool_calls: profile.maxToolCalls,
      }),
      text: {
        format: { type: 'json_schema', name: parts.schemaName, strict: true, schema: parts.schema },
      },
      store: false,
      metadata: {
        run_id: request.runId,
        role: request.role,
        idempotency_key: request.idempotencyKey,
      },
    };
    const timeout = AbortSignal.timeout(profile.timeoutMs);
    const startedAt = Date.now();
    const response = await this.send(body, signal ? AbortSignal.any([signal, timeout]) : timeout);
    const parsed = responseSchema.parse(await response.json());
    if (parsed.status !== 'completed') {
      throw new Error(
        `OpenAI response ${parsed.id} ended as ${parsed.status}${parsed.incomplete_details?.reason ? ` (${parsed.incomplete_details.reason})` : ''}`,
      );
    }
    const messageParts = parsed.output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? []);
    if (messageParts.some((part) => part.type === 'refusal')) {
      throw new Error(`OpenAI response ${parsed.id} contains a refusal`);
    }
    const text = messageParts
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
    const webSearchCalls = parsed.output.filter((item) => item.type === 'web_search_call').length;
    const usage = {
      inputTokens: parsed.usage.input_tokens,
      cachedInputTokens: parsed.usage.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: parsed.usage.output_tokens,
    };
    return {
      text,
      citations: collectCitations(messageParts),
      webSearchCalls,
      costUsd: computeCallCostUsd(usage, webSearchCalls, pricing),
      details: {
        model: profile.model,
        responseId: parsed.id,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        webSearchCalls,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  private async send(body: unknown, signal: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const message = `OpenAI request failed: ${describeError(error)}`;
      if (neverConnected(error)) {
        throw new ExecutorNotStartedError(message);
      }
      throw new Error(`${message} (it may have been received and billed)`);
    }
    if (response.ok) {
      return response;
    }
    const message = await providerMessage(response);
    if (REJECTED_BEFORE_WORK.has(response.status)) {
      throw new ExecutorNotStartedError(
        `OpenAI rejected the request (${response.status}): ${message}`,
      );
    }
    throw new Error(`OpenAI failed with status ${response.status}: ${message}`);
  }
}

function collectCitations(
  messageParts: { annotations?: { type: string; url?: string; title?: string }[] | undefined }[],
): Citation[] {
  const byUrl = new Map<string, Citation>();
  for (const part of messageParts) {
    for (const annotation of part.annotations ?? []) {
      if (annotation.type === 'url_citation' && annotation.url && !byUrl.has(annotation.url)) {
        byUrl.set(annotation.url, { url: annotation.url, title: annotation.title ?? '' });
      }
    }
  }
  return [...byUrl.values()];
}

async function providerMessage(response: Response): Promise<string> {
  const raw = await response.text().catch(() => '');
  let message = raw;
  try {
    message = errorBodySchema.parse(JSON.parse(raw)).error?.message ?? raw;
  } catch {
    // Not a JSON error body: keep the raw text.
  }
  return redactString(message).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

const describeError = (error: unknown): string =>
  redactString(error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function neverConnected(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && NEVER_CONNECTED.has(code);
}

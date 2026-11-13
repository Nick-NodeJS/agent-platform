// Opt-in check of the real OpenAI executor. It SPENDS REAL MONEY (a few cents to about 1 USD) and needs network access.
// Nothing is persisted: no database, Temporal or task files are touched. Run it yourself:
//   pnpm build && pnpm openai:check --confirm-spend [--goal "<text>"] [--max-usd 1.5]
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  enforceConstraintChecks,
  modelProfilesSchema,
  researchProposalSchema,
  businessEvaluationSchema,
} from '@platform/contracts';
import { loadModelProfiles, loadPlatformConstraints } from '@platform/contracts/node';
import { OpenAiAgentExecutor, resolveRepositoryPath } from '@platform/integrations';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const CHECK_MAX_TOOL_CALLS = 3;
const DEFAULT_MAX_USD = 1.5;
const DEFAULT_GOAL = 'Find one small API product a solo developer could launch within four weeks.';

const { values } = parseArgs({
  options: {
    'confirm-spend': { type: 'boolean' },
    goal: { type: 'string' },
    'max-usd': { type: 'string' },
  },
});

if (!values['confirm-spend']) {
  console.error('This check calls the paid OpenAI API. Re-run with --confirm-spend to continue.');
  process.exit(1);
}

const profiles = loadModelProfiles(
  resolveRepositoryPath(process.env['MODEL_PROFILES_FILE'] ?? 'config/model-profiles.json'),
);
const apiKey = process.env[profiles.apiKeyEnvVar];
if (!apiKey) {
  console.error(`${profiles.apiKeyEnvVar} is not set in the environment.`);
  process.exit(1);
}

// Fewer searches than production, so the check stays cheap.
const checkProfiles = modelProfilesSchema.parse({
  ...profiles,
  roles: {
    ...profiles.roles,
    researcher: { ...profiles.roles.researcher, maxToolCalls: CHECK_MAX_TOOL_CALLS },
  },
});
const constraints = loadPlatformConstraints(
  resolveRepositoryPath('config/platform-constraints.json'),
);
const maxUsd = Number(values['max-usd'] ?? DEFAULT_MAX_USD);
const executor = new OpenAiAgentExecutor({ apiKey, profiles: checkProfiles });

const researcher = await executor.run({
  role: 'researcher',
  runId: 'live-check',
  idempotencyKey: 'live-check:researcher',
  input: { goal: values.goal ?? DEFAULT_GOAL, constraints },
});
const proposal = researchProposalSchema.parse(researcher.output);
console.log('researcher', researcher.usage);
console.log(`proposal: ${proposal.title} (${proposal.productType}, ${proposal.hosting.provider})`);
console.log('cost estimate', proposal.cost, 'weeks', proposal.delivery.weeksToLaunch);
console.log(`evidence entries: ${proposal.demand.evidence.length}`);

if (researcher.usage.costUsd > maxUsd) {
  console.error(
    `researcher call already cost more than --max-usd ${maxUsd}; skipping the evaluation`,
  );
  process.exit(1);
}

const owner = await executor.run({
  role: 'business-owner',
  runId: 'live-check',
  idempotencyKey: 'live-check:business-owner',
  input: { proposal, constraints },
});
const evaluation = enforceConstraintChecks(
  businessEvaluationSchema.parse(owner.output),
  proposal,
  constraints,
);
console.log('business owner', owner.usage);
console.log(`recommendation: ${evaluation.recommendation} (score ${evaluation.score})`);
for (const check of evaluation.constraintChecks) {
  console.log(`  ${check.status.padEnd(14)} ${check.rule}: ${check.detail}`);
}
const total = researcher.usage.costUsd + owner.usage.costUsd;
console.log(
  `total cost: ${total.toFixed(4)} USD (calculated from reported usage and config/model-profiles.json prices)`,
);

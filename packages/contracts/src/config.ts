import { z } from 'zod';

const baseSchema = z.object({
  EXECUTION_MODE: z.enum(['mock', 'openhands']).default('mock'),
  TEMPORAL_ADDRESS: z.string().default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  TASK_QUEUE: z.string().default('agent-platform'),
  TASK_STORE_DIR: z.string().default('.task-data/tasks'),
  LOG_LEVEL: z.string().default('info'),
});

export const dbConfigSchema = z.object({ DATABASE_URL: z.string().url() });

const openhandsSchema = z.object({
  OPENHANDS_AGENT_SERVER_URL: z.string().url(),
  OPENHANDS_SESSION_API_KEY: z.string().min(1),
});

export type PlatformConfig = z.infer<typeof baseSchema> & z.infer<typeof dbConfigSchema>;

/** Validates only what the selected mode needs; mock mode needs no API keys. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const base = baseSchema.parse(env);
  const db = dbConfigSchema.parse(env);
  if (base.EXECUTION_MODE === 'openhands') openhandsSchema.parse(env);
  return { ...base, ...db };
}

/** Same as loadConfig but without requiring the database (e.g. `doctor` reports DB problems itself). */
export function loadBaseConfig(env: NodeJS.ProcessEnv = process.env) {
  return baseSchema.parse(env);
}

export const WORKFLOW_NAME = 'researchProposalWorkflow';
export const DECISION_SIGNAL = 'decision';
export const STATUS_QUERY = 'getStatus';

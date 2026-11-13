import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import pino from 'pino';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadConfig, MAX_HEARTBEAT_THROTTLE_MS } from '@platform/contracts';
import { loadModelProfiles } from '@platform/contracts/node';
import {
  createExecutor,
  LocalTaskStore,
  resolveRepositoryPath,
  resolveTaskStoreDir,
} from '@platform/integrations';
import { createPool, RunRepository } from '@platform/persistence';
import { createActivities } from './activities.js';
import { temporalActivityRuntime } from './temporal-activity-runtime.js';
import {
  assertNoPrivateSigningKey,
  assertSupportedExecutionMode,
  readProviderApiKey,
} from './worker-env.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
assertNoPrivateSigningKey(process.env);
const config = loadConfig();
assertSupportedExecutionMode(config.EXECUTION_MODE);
const log = pino({
  level: config.LOG_LEVEL,
  redact: ['*.apiKey', '*.password', '*.DATABASE_URL', 'DATABASE_URL'],
});

if (!config.APPROVAL_TRUSTED_SIGNERS_FILE) {
  log.warn(
    'APPROVAL_TRUSTED_SIGNERS_FILE is not set: runs will pause at review but no decision can be verified (run "pnpm cli approval-keygen").',
  );
}

// Real execution: profiles (models, ceilings, prices) from a file, the API key only from the environment. The
// spending guard is switched on for every paid executor; the mock costs nothing and needs neither.
const profiles =
  config.EXECUTION_MODE === 'openai'
    ? loadModelProfiles(resolveRepositoryPath(config.MODEL_PROFILES_FILE))
    : undefined;
const executor = createExecutor(
  config.EXECUTION_MODE,
  profiles && { apiKey: readProviderApiKey(profiles.apiKeyEnvVar, process.env), profiles },
);

const db = createPool(config.DATABASE_URL);
const activities = createActivities({
  repo: new RunRepository(db),
  tasks: new LocalTaskStore({ rootDir: resolveTaskStoreDir(config.TASK_STORE_DIR) }),
  executor,
  ...(profiles && { spendPolicy: profiles.spend }),
  trustedSignersFile: config.APPROVAL_TRUSTED_SIGNERS_FILE || undefined,
  leaseTtlMs: config.AGENT_LEASE_TTL_MS,
  runtime: temporalActivityRuntime,
});

const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
const worker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL('./workflows/index.js', import.meta.url)),
  activities,
  maxHeartbeatThrottleInterval: MAX_HEARTBEAT_THROTTLE_MS,
});

log.info(
  { taskQueue: config.TASK_QUEUE, temporal: config.TEMPORAL_ADDRESS, mode: config.EXECUTION_MODE },
  'worker started',
);
try {
  await worker.run();
} finally {
  await connection.close();
  await db.end();
}

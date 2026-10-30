import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import pino from 'pino';
import { NativeConnection, Worker } from '@temporalio/worker';
import { loadConfig } from '@platform/contracts';
import { createExecutor, LocalTaskStore } from '@platform/integrations';
import { createPool, RunRepository } from '@platform/persistence';
import { createActivities } from './activities.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const log = pino({
  level: config.LOG_LEVEL,
  redact: ['*.apiKey', '*.password', '*.DATABASE_URL', 'DATABASE_URL'],
});

if (config.EXECUTION_MODE !== 'mock')
  log.warn(
    'EXECUTION_MODE is not "mock": real execution is not implemented; agent activities will fail.',
  );

const db = createPool(config.DATABASE_URL);
const activities = createActivities({
  repo: new RunRepository(db),
  tasks: new LocalTaskStore({ rootDir: config.TASK_STORE_DIR }),
  executor: createExecutor(config.EXECUTION_MODE),
});

const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
const worker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TASK_QUEUE,
  workflowsPath: fileURLToPath(new URL('./workflows/index.js', import.meta.url)),
  activities,
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

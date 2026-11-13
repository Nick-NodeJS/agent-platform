import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_HEARTBEAT_TIMEOUT_MS,
  AGENT_STAGE_MAX_ATTEMPTS,
  AGENT_STAGE_TIMEOUT_MS,
  MIN_AGENT_LEASE_TTL_MS,
  AGENT_HEARTBEAT_INTERVAL_MS,
  EXECUTOR_CALL_LIMIT_MS,
  MAX_HEARTBEAT_THROTTLE_MS,
} from '@platform/contracts';
import { executionIdFor } from '../../apps/worker/src/agent-stage.js';
import {
  CountingExecutor,
  createEnv,
  startRun,
  startWorker,
  terminateQuietly,
  waitForGate,
  waitUntil,
  type Env,
  type RunningWorker,
} from './harness.js';

const MS_PER_SECOND = 1000;

describe('agent stage time limits through real Temporal (F2)', () => {
  let env: Env;
  let worker: RunningWorker | undefined;
  const startedRuns: string[] = [];

  beforeAll(async () => {
    env = await createEnv();
  });
  afterEach(async () => {
    await worker?.stop();
    worker = undefined;
  });
  afterAll(async () => {
    for (const runId of startedRuns) {
      await terminateQuietly(env, runId);
    }
    await worker?.stop();
    await env?.cleanup();
  });

  const startTracked = async () => {
    const runId = await startRun(env);
    startedRuns.push(runId);
    return runId;
  };

  it('the limits keep their required relations', () => {
    expect(AGENT_HEARTBEAT_INTERVAL_MS).toBeLessThan(AGENT_HEARTBEAT_TIMEOUT_MS);
    expect(MIN_AGENT_LEASE_TTL_MS).toBeGreaterThanOrEqual(2 * AGENT_HEARTBEAT_INTERVAL_MS);
    expect(EXECUTOR_CALL_LIMIT_MS).toBeLessThan(AGENT_STAGE_TIMEOUT_MS);
    expect(MAX_HEARTBEAT_THROTTLE_MS).toBeLessThan(AGENT_HEARTBEAT_TIMEOUT_MS);
  });

  it('agent stages are scheduled with the long timeout, a heartbeat timeout and more attempts than other Activities', async () => {
    worker = await startWorker(env, { executor: new CountingExecutor() });
    const runId = await startTracked();
    await waitForGate(env, runId);

    const history = await env.client.workflow.getHandle(runId).fetchHistory();
    const scheduled = new Map(
      (history.events ?? []).flatMap((event) => {
        const attributes = event.activityTaskScheduledEventAttributes;
        return attributes?.activityType?.name
          ? [[attributes.activityType.name, attributes] as const]
          : [];
      }),
    );
    const seconds = (
      duration: { seconds?: number | { toNumber(): number } | null } | null | undefined,
    ) => {
      const raw = duration?.seconds;
      return typeof raw === 'object' && raw !== null ? raw.toNumber() : (raw ?? undefined);
    };

    for (const name of ['runResearcher', 'runBusinessOwner']) {
      const attributes = scheduled.get(name);
      expect(seconds(attributes?.startToCloseTimeout)).toBe(AGENT_STAGE_TIMEOUT_MS / MS_PER_SECOND);
      expect(seconds(attributes?.heartbeatTimeout)).toBe(
        AGENT_HEARTBEAT_TIMEOUT_MS / MS_PER_SECOND,
      );
      expect(attributes?.retryPolicy?.maximumAttempts).toBe(AGENT_STAGE_MAX_ATTEMPTS);
    }
    const other = scheduled.get('createTaskAndRun');
    expect(seconds(other?.startToCloseTimeout)).toBe(60);
    expect(seconds(other?.heartbeatTimeout) ?? 0).toBe(0);
  });

  it('a long-running agent call heartbeats to Temporal, and cancelling the run stops the executor and marks the execution uncertain', async () => {
    const executor = new CountingExecutor();
    executor.gate = new Promise<void>(() => undefined); // an external call that never returns by itself
    worker = await startWorker(env, { executor });
    const runId = await startTracked();
    const handle = env.client.workflow.getHandle(runId);
    await waitUntil(() => executor.count('researcher') === 1, 'the researcher call is running');

    // The Activity keeps telling Temporal it is alive while the call is in flight.
    await waitUntil(async () => {
      const description = await handle.describe();
      return Boolean(description.raw.pendingActivities?.[0]?.lastHeartbeatTime);
    }, 'the Activity has heartbeated');

    await handle.cancel();

    await waitUntil(() => executor.sawAbort, 'the executor was interrupted by the cancellation');
    const executionId = executionIdFor(runId, 'researcher', 'research');
    await waitUntil(
      async () => (await env.repo.getExecution(executionId))?.state === 'uncertain',
      'the interrupted execution is marked uncertain',
    );
    // Nothing was stored for a call that was cut off, and the executor was started exactly once.
    expect(executor.count()).toBe(1);
    expect((await env.db.query('SELECT 1 FROM results WHERE run_id=$1', [runId])).rowCount).toBe(0);
  });
});

/**
 * Time limits of one agent stage, shared by the workflow (Activity options), the stage runner (heartbeats, lease
 * renewal) and configuration validation. They only make sense together; the relations are:
 *
 *   heartbeat interval  <  heartbeat timeout        a live attempt always beats before Temporal gives up on it
 *   2 x heartbeat interval  <=  lease TTL           one missed renewal never expires the lease of a live attempt
 *   executor call limit  <  stage timeout           the executor stops itself before Temporal times the Activity out
 *
 * A dead worker is noticed after the heartbeat timeout (seconds), not after the stage timeout (minutes).
 */
export const AGENT_HEARTBEAT_INTERVAL_MS = 10_000;
export const AGENT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const AGENT_STAGE_TIMEOUT_MS = 10 * 60_000;

/**
 * The Temporal SDK batches heartbeats (by default to 80% of the heartbeat timeout, here 24 s) and learns about
 * cancellation only when one reaches the server. Capping the batching interval bounds how long a cancelled or
 * timed-out Activity keeps its external call running.
 */
export const MAX_HEARTBEAT_THROTTLE_MS = 5_000;

/** Upper bound an executor should apply to a single provider call; it must stay below the stage timeout. */
export const EXECUTOR_CALL_LIMIT_MS = 8 * 60_000;

/** The lease must outlive one missed renewal. */
export const MIN_AGENT_LEASE_TTL_MS = 2 * AGENT_HEARTBEAT_INTERVAL_MS;

/** A retry that finds another attempt still running waits this long before looking again. */
export const EXECUTION_IN_PROGRESS_RETRY_DELAY_MS = 15_000;

/** Attempts for agent stages: enough in-progress waits to outlast the default lease (120 s) before giving up. */
export const AGENT_STAGE_MAX_ATTEMPTS = 10;

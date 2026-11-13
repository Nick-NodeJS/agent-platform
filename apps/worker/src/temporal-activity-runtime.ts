import { Context } from '@temporalio/activity';
import type { ActivityRuntime } from './agent-stage.js';

/** Binds the stage runner to the Temporal Activity that is currently executing. Only call inside an Activity. */
export const temporalActivityRuntime: ActivityRuntime = {
  heartbeat: () => {
    Context.current().heartbeat();
  },
  cancellationSignal: () => Context.current().cancellationSignal,
};

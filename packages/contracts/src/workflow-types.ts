import { z } from 'zod';
import { reviewGateSchema } from './approval.js';
import { idSchema, timestampSchema } from './ids.js';
import { statusSchema, type ResourceConstraints } from './records.js';

export interface ResearchProposalInput {
  runId: string;
  goal: string;
  constraints: ResourceConstraints;
}

/** Query result of the workflow. Parsed by clients because Temporal returns untyped JSON. */
export const workflowStatusSchema = z
  .object({
    runId: idSchema,
    status: statusSchema,
    taskId: idSchema.optional(),
    stages: z.array(z.object({ stage: statusSchema, at: timestampSchema }).strict()),
    resultIds: z.array(idSchema),
    gate: reviewGateSchema.optional(),
    decision: z
      .object({
        decision: z.enum(['approve', 'reject']),
        source: z.literal('human'),
        actor: z.string(),
        keyId: idSchema,
        decisionId: idSchema,
        reason: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type StageEntry = WorkflowStatus['stages'][number];

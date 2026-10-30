import { z } from 'zod';
import { idSchema, timestampSchema } from './ids.js';

export const STATUSES = [
  'CREATED',
  'RESEARCHING',
  'EVALUATING',
  'WAITING_FOR_HUMAN_APPROVAL',
  'APPROVED',
  'REJECTED',
] as const;
export const statusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof statusSchema>;

const orUnknown = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.literal('unknown')]).default('unknown' as never);

/** Real-world constraints are never guessed: anything not supplied is the literal 'unknown'. */
export const resourceConstraintsSchema = z
  .object({
    budgetUsd: orUnknown(z.number().nonnegative()),
    teamSize: orUnknown(z.number().int().nonnegative()),
    timelineWeeks: orUnknown(z.number().positive()),
    notes: orUnknown(z.string()),
  })
  .strict();
export type ResourceConstraints = z.infer<typeof resourceConstraintsSchema>;

export const runSchema = z
  .object({
    runId: idSchema,
    workflowId: idSchema,
    taskId: idSchema,
    goal: z.string().min(1),
    constraints: resourceConstraintsSchema,
    status: statusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type Run = z.infer<typeof runSchema>;

export const taskSchema = z
  .object({
    taskId: idSchema,
    runId: idSchema,
    title: z.string().min(1),
    description: z.string(),
    status: statusSchema,
    resultIds: z.array(idSchema),
    approvalIds: z.array(idSchema),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type Task = z.infer<typeof taskSchema>;

export const resultKindSchema = z.enum(['research-proposal', 'business-evaluation']);
export type ResultKind = z.infer<typeof resultKindSchema>;

export const resultSchema = z
  .object({
    resultId: idSchema,
    taskId: idSchema,
    runId: idSchema,
    kind: resultKindSchema,
    producedBy: z.enum(['mock', 'agent']),
    payload: z.record(z.unknown()),
    createdAt: timestampSchema,
  })
  .strict();
export type Result = z.infer<typeof resultSchema>;

export const approvalSchema = z
  .object({
    approvalId: idSchema,
    taskId: idSchema,
    runId: idSchema,
    decision: z.enum(['approve', 'reject']),
    source: z.enum(['human', 'agent']),
    actor: z.string().min(1),
    reason: z.string().optional(),
    createdAt: timestampSchema,
  })
  .strict();
export type Approval = z.infer<typeof approvalSchema>;

export const executionEventSchema = z
  .object({
    eventId: idSchema,
    runId: idSchema,
    type: z.string().min(1),
    data: z.record(z.unknown()),
    createdAt: timestampSchema,
  })
  .strict();
export type ExecutionEvent = z.infer<typeof executionEventSchema>;

export const researchProposalSchema = z
  .object({
    fictionalExample: z.literal(true),
    title: z.string(),
    summary: z.string(),
    assumptions: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .strict();
export type ResearchProposal = z.infer<typeof researchProposalSchema>;

export const businessEvaluationSchema = z
  .object({
    recommendation: z.enum(['proceed', 'do-not-proceed']),
    score: z.number().min(0).max(10),
    rationale: z.string(),
    isHumanApproval: z.literal(false),
  })
  .strict();
export type BusinessEvaluation = z.infer<typeof businessEvaluationSchema>;

export const humanDecisionSignalSchema = z
  .object({
    decisionId: idSchema,
    decision: z.enum(['approve', 'reject']),
    source: z.enum(['human', 'agent']),
    actor: z.string().min(1),
    reason: z.string().optional(),
  })
  .strict();
export type DecisionSignal = z.infer<typeof humanDecisionSignalSchema>;

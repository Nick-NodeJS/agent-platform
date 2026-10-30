import type { ResourceConstraints, Status } from './records.js';

export interface ResearchProposalInput {
  runId: string;
  goal: string;
  constraints: ResourceConstraints;
}

export interface StageEntry {
  stage: Status;
  at: string;
}

export interface WorkflowStatus {
  runId: string;
  status: Status;
  taskId?: string;
  stages: StageEntry[];
  resultIds: string[];
  decision?: { decision: 'approve' | 'reject'; source: 'human'; actor: string; reason?: string };
}

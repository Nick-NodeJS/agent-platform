import { randomUUID } from 'node:crypto';
import { WorkflowUpdateFailedError } from '@temporalio/client';
import {
  APPROVAL_VERSION,
  DECISION_UPDATE,
  MAX_APPROVAL_VALIDITY_MS,
  STATUS_QUERY,
  decisionAckSchema,
  idSchema,
  workflowStatusSchema,
  type ApprovalPayload,
} from '@platform/contracts';
import { loadSignerFile, signApproval } from '@platform/contracts/node';
import { optionalNumber, requirePositional, type ParsedArgs } from '../args.js';
import { openTemporal, signerFilePath, type CliContext } from '../context.js';

const DEFAULT_APPROVAL_TTL_MINUTES = 10;
const MS_PER_MINUTE = 60_000;
const DECISION_ID_RANDOM_CHARS = 16;

function updateFailureMessage(error: unknown): string {
  if (error instanceof WorkflowUpdateFailedError) {
    return error.cause?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Signs a decision for the CURRENT review gate and submits it as a Temporal Update.
 * Returns the process exit code: non-zero when the decision was not accepted.
 */
export async function decideCommand(
  ctx: CliContext,
  args: ParsedArgs,
  decision: 'approve' | 'reject',
): Promise<number> {
  const runId = idSchema.parse(requirePositional(args, 0, 'runId'));
  const signer = loadSignerFile(signerFilePath(ctx));
  const ttlMinutes = optionalNumber(args.flags['ttl-minutes'], 'ttl-minutes');
  const ttlMs = Math.min(
    (ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES) * MS_PER_MINUTE,
    MAX_APPROVAL_VALIDITY_MS,
  );

  const { client, connection } = await openTemporal(ctx);
  try {
    const handle = client.workflow.getHandle(runId);
    const status = workflowStatusSchema.parse(await handle.query(STATUS_QUERY));
    if (status.decision) {
      ctx.out(
        `run already decided: ${status.decision.decision}; final status ${status.status} (no change made)`,
      );
      return 0;
    }
    if (!status.gate) {
      ctx.err(
        `not ready: run ${runId} is ${status.status}; the review gate is not open yet. Nothing was submitted; retry once it is WAITING_FOR_HUMAN_APPROVAL.`,
      );
      return 1;
    }

    const issuedAt = new Date();
    const payload: ApprovalPayload = {
      version: APPROVAL_VERSION,
      decisionId: `dec-${randomUUID().slice(0, DECISION_ID_RANDOM_CHARS)}`,
      runId,
      gateId: status.gate.gateId,
      artifacts: status.gate.artifacts,
      decision,
      keyId: signer.keyId,
      actor: signer.actor,
      ...(args.flags['reason'] ? { reason: args.flags['reason'] } : {}),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
    };

    let ack;
    try {
      ack = decisionAckSchema.parse(
        await handle.executeUpdate(DECISION_UPDATE, { args: [signApproval(payload, signer)] }),
      );
    } catch (error) {
      ctx.err(`decision NOT accepted: ${updateFailureMessage(error)}`);
      return 1;
    }
    ctx.out(
      `accepted ${ack.decision} (human-controlled signer ${signer.keyId}, actor ${signer.actor}) for gate ${ack.gateId}; waiting for completion...`,
    );
    const final = workflowStatusSchema.parse(await handle.result());
    ctx.out(`final status: ${final.status}`);
    return 0;
  } finally {
    await connection.close();
  }
}

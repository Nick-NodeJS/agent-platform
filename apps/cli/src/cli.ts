import { parseArgs } from './args.js';
import { decideCommand } from './commands/decide.js';
import { doctorCommand } from './commands/doctor.js';
import { executionsCommand, reconcileCommand } from './commands/executions.js';
import { keygenCommand } from './commands/keygen.js';
import { migrateCommand } from './commands/migrate.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import type { CliContext } from './context.js';

export const USAGE = `Usage: agent-platform <command>

  start --goal <text> [--run-id <id>] [--budget-usd <n>] [--team-size <n>] [--timeline-weeks <n>] [--notes <text>]
  status <runId>
  approve <runId> [--reason <text>] [--ttl-minutes <n>]     (signed with your approval signer key)
  reject <runId> [--reason <text>] [--ttl-minutes <n>]
  approval-keygen --actor <name> [--key-id <id>] [--dir <dir outside the repo>]
  executions <runId>
  reconcile <runId> <researcher|business-owner> --confirm-no-external-run
  migrate
  doctor
`;

/** Runs one CLI invocation and returns the process exit code. Expected user errors never throw. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  try {
    const args = parseArgs(rest);
    switch (command) {
      case 'start':
        await startCommand(ctx, args);
        return 0;
      case 'status':
        await statusCommand(ctx, args);
        return 0;
      case 'approve':
      case 'reject':
        return await decideCommand(ctx, args, command);
      case 'approval-keygen':
        keygenCommand(ctx, args);
        return 0;
      case 'executions':
        await executionsCommand(ctx, args);
        return 0;
      case 'reconcile':
        await reconcileCommand(ctx, args);
        return 0;
      case 'migrate':
        await migrateCommand(ctx);
        return 0;
      case 'doctor':
        return await doctorCommand(ctx);
      default:
        ctx.out(USAGE);
        return command ? 1 : 0;
    }
  } catch (error) {
    ctx.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

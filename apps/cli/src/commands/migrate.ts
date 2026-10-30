import { loadConfig } from '@platform/contracts';
import { createPool, migrate } from '@platform/persistence';
import type { CliContext } from '../context.js';

export async function migrateCommand(ctx: CliContext): Promise<void> {
  const db = createPool(loadConfig(ctx.env).DATABASE_URL);
  try {
    const applied = await migrate(db);
    ctx.out(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations');
  } finally {
    await db.end();
  }
}

import { existsSync } from 'node:fs';
import { runCli } from './cli.js';
import { defaultContext } from './context.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

process.exitCode = await runCli(process.argv.slice(2), defaultContext());

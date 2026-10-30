import { CliError } from './context.js';

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

/** Flags that take no value. They are recorded with an empty string. */
const BOOLEAN_FLAGS = new Set(['confirm-no-external-run']);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = '';
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CliError(`missing value for ${arg}`);
    }
    flags[name] = value;
    index++;
  }
  return { positional, flags };
}

export function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positional[index];
  if (value === undefined) {
    throw new CliError(`${name} required`);
  }
  return value;
}

export function optionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliError(`${name} must be a number`);
  }
  return parsed;
}

import { z } from 'zod';

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const idSchema = z
  .string()
  .regex(ID_PATTERN, 'id must be 1-64 chars of [A-Za-z0-9_-] and start alphanumeric');

export const timestampSchema = z.string().datetime();

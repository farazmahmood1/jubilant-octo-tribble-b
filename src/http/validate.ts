import type { z } from 'zod';

import { HttpError } from './middleware/errors.js';

/** Parses a body, query or params object, or answers 400 with the first problem. */
export const parse = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'Invalid request');
  }
  return parsed.data;
};

/** Database ids are bigints; they travel as decimal strings. */
export const ID = /^[1-9]\d{0,18}$/;

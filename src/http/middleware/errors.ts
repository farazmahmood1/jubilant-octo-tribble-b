import type { ErrorRequestHandler, RequestHandler } from 'express';

import { config } from '../../config.js';
import { logger } from '../../logger.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.originalUrl}` } });
};

/** Express 5 forwards rejected promises here, so async handlers need no wrapper. */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unexpected error';

  if (status >= 500) logger.error({ err: error, path: req.originalUrl }, 'Request failed');
  else logger.warn({ path: req.originalUrl, message }, 'Request rejected');

  res.status(status).json({
    error: {
      message: status >= 500 && config.isProduction ? 'Internal server error' : message,
      ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
    },
  });
};

import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/**
 * Generates a UUID v4 per request and:
 * 1. Attaches it to `req.traceId` so downstream code (filters, services,
 *    logger) can include it in error bodies and log lines.
 * 2. Sets the `X-Trace-Id` response header so clients (and DevTools) can
 *    correlate a request with server logs.
 *
 * Runs FIRST in the request pipeline (before guards, interceptors,
 * exception filters), so by the time anything else executes the value
 * is guaranteed present.
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceId = randomUUID();
    req.traceId = traceId;
    res.setHeader('X-Trace-Id', traceId);
    next();
  }
}
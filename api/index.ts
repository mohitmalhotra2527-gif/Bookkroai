/**
 * VERCEL SERVERLESS ENTRY (Step: Vercel deployment support).
 *
 * Vercel routes every /api/* request here (see vercel.json). This is a thin
 * adapter over the EXISTING server routing — same ToolGate, ProviderRouter,
 * safety rules and graceful degradation; nothing is duplicated.
 *
 * Note (honest limitation): serverless instances recycle, so in-memory
 * conversation state persists only per warm instance — single questions and
 * live data are unaffected; long multi-turn chats may occasionally restart.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHandleDeps, handleRequest } from './server.js';

// Init once per instance (keys arrive as server-side env vars on Vercel).
const deps = createHandleDeps();

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handleRequest(req, res, deps);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    }
    res.end(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' }));
  }
}

/**
 * Minimal Step 1 HTTP server (node:http, zero runtime dependencies).
 *
 * Routes:
 *   GET  /api/health → liveness + honest NOT_IMPLEMENTED status of all subsystems
 *   POST /api/chat   → 501 NOT_IMPLEMENTED (the AI orchestrator arrives in Step 2;
 *                       nothing is executed, no AI call is made)
 *   GET  /*          → static minimal UI shell from /app (or dist/public)
 *
 * Security posture: JSON-only API responses, no-store + nosniff headers, 32KB
 * body limit, path-traversal-safe static serving, error messages scrubbed via
 * redactSecrets, and Authorization headers are never logged.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_NAME, APP_VERSION, describeSecretState, getSecret, redactSecrets } from './config.js';
import { createDefaultRailwayRouter, createRailwayDiagnostics } from '../railway/index.js';
import type { RailwayProviderRouter } from '../railway/index.js';
import { DeterministicNLUProvider } from '../ai/index.js';
import type { OrchestratorDependencies } from '../ai/orchestrator.js';
import { createModelProvider } from './ai/model-provider.js';
import { runAiOrchestrator } from './ai/orchestrator.js';
import { createProductionToolRegistry } from '../tools/executors/index.js';
import { handleRailwayApi } from './routes/railway.js';
import { handleChatRoute } from './routes/chat.js';
import { createInMemoryConversationStore } from './conversations.js';

const MAX_BODY_BYTES = 32 * 1024;

export interface BookKaroServerOptions {
  /** Injected in tests; defaults to RailCore→RailKit built from server-side secrets. */
  railwayRouter?: RailwayProviderRouter;
  /** Injected in tests; defaults to the env-configured provider + deterministic NLU fallback. */
  orchestrator?: OrchestratorDependencies;
  /** Diagnostic log sink (already secret-free by construction; redacted again here). */
  diagnosticsSink?: (line: string) => void;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(),
  });
  res.end(body);
}

/**
 * CORS support: the static chat page may be hosted on a DIFFERENT origin
 * (e.g. GitHub Pages) than this API server. Allowed origins default to "*"
 * (public read/chat API, no cookies) or a comma-separated CORS_ORIGIN list.
 */
function corsHeaders(): Record<string, string> {
  const origin = process.env.CORS_ORIGIN?.trim();
  return {
    'access-control-allow-origin': origin && origin.length > 0 ? origin : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function sendCors(res: ServerResponse, statusCode = 204): void {
  res.writeHead(statusCode, corsHeaders());
  res.end();
}

function publicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../public'), // dist layout: dist/api → dist/public
    join(here, '../../app'), // dist layout: dist/api → <root>/app
    join(here, '../app'), // source layout (tests): api → app
    join(process.cwd(), 'app'), // started from project root
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1] ?? join(process.cwd(), 'app');
}

async function serveStatic(pathName: string, res: ServerResponse): Promise<void> {
  const root = publicDir();
  const relative = pathName === '/' ? 'index.html' : pathName === '/chat' ? 'chat.html' : pathName.replace(/^\/+/, '');
  const resolved = normalize(join(root, relative));
  if (!resolved.startsWith(normalize(root) + sep) && resolved !== normalize(root)) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    return;
  }
  if (!existsSync(resolved) || !resolved.endsWith('.html') && !MIME_TYPES[extname(resolved)]) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    return;
  }
  try {
    const content = await readFile(resolved);
    res.writeHead(200, {
      'content-type': MIME_TYPES[extname(resolved)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
  }
}

interface HandleDeps {
  railwayRouter: RailwayProviderRouter;
  chatContext: { orchestrator: import('../ai/orchestrator.js').OrchestratorDependencies; toolRegistry: import('../tools/index.js').ToolRegistry; conversations: import('./conversations.js').ConversationStore };
  aiName: string;
}

/** Serverless entry point (Vercel adapter reuses this — same routing, same safety). */
export async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: HandleDeps): Promise<void> {
  return handle(req, res, deps);
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HandleDeps): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  // CORS preflight — must be answered before any routing.
  if (method === 'OPTIONS') {
    sendCors(res);
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathName = decodeURIComponent(url.pathname);

  if (pathName === '/api/health' && method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      app: APP_NAME,
      version: APP_VERSION,
      step: 'STEP_9_AI_RAILWAY_AGENT',
      aiOrchestrator: 'IMPLEMENTED',
      aiProvider: deps.aiName,
      aiFallback: 'deterministic-nlu',
      railwayProviders: 'IMPLEMENTED_REAL_ADAPTERS',
      booking: 'NOT_IMPLEMENTED',
      wallet: 'NOT_IMPLEMENTED',
      secretsConfigured: describeSecretState(),
      serverTime: new Date().toISOString(),
    });
    return;
  }

  if (pathName === '/api/chat' && method === 'POST') {
    await handleChatRoute(req, res, deps.chatContext);
    return;
  }

  if (pathName.startsWith('/api/railway/')) {
    await handleRailwayApi(res, pathName, url.searchParams, { router: deps.railwayRouter });
    return;
  }

  if (pathName.startsWith('/api/')) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    return;
  }

  if (method === 'GET' || method === 'HEAD') {
    await serveStatic(pathName, res);
    return;
  }

  sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
}

/** Builds the shared request dependencies once (used by both the long-running server and the serverless adapter). */
export function createHandleDeps(options: BookKaroServerOptions = {}): HandleDeps {
  const diagnostics = createRailwayDiagnostics({
    sink: options.diagnosticsSink ?? ((line) => console.log(redactSecrets(line))),
  });
  const railwayRouter =
    options.railwayRouter ??
    createDefaultRailwayRouter({
      railCore: { apiKey: getSecret('RAILCORE_API_KEY') },
      railKit: { apiKey: getSecret('RAILKIT_API_KEY') },
      onDiagnostic: diagnostics.log,
    });

  const activeAi = createModelProvider(); // env: AI_PROVIDER / AI_MODEL / AI_API_KEY / AI_BASE_URL
  const toolRegistry = createProductionToolRegistry({ router: railwayRouter });
  const orchestrator: OrchestratorDependencies =
    options.orchestrator ??
    {
      ai: activeAi.provider,
      fallbackNlu: new DeterministicNLUProvider(),
      toolRegistry,
      aiTimeoutMs: 6_000,
    };
  const conversations = createInMemoryConversationStore();
  const chatContext = { orchestrator, toolRegistry, conversations };

  return { railwayRouter, chatContext, aiName: activeAi.name };
}

/** The original long-running server (local / Render / Docker) — same deps, wrapped in node:http. */
export function createBookKaroServer(options: BookKaroServerOptions = {}) {
  const deps = createHandleDeps(options);
  return createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      // Never log headers (Authorization!) — scrub message and fail closed.
      console.error(`[${APP_NAME}] request error:`, redactSecrets(String(error)));
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, code: 'INTERNAL_ERROR', message: 'Something went wrong.' });
      } else {
        res.end();
      }
    });
  });
}

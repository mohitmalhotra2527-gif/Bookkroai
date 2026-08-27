/**
 * POST /api/chat — the AI-first conversation endpoint (Step 3).
 *
 * Server-side only: message → orchestrator (validated structured AI output →
 * deterministic tool selection → ToolRegistry → provider router) → safe
 * Hinglish reply. No secrets, no raw payloads, no booking execution here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { orchestrateTurn } from '../../ai/orchestrator.js';
import { runAiOrchestrator } from '../ai/orchestrator.js';
import type { OrchestratorDependencies } from '../../ai/orchestrator.js';
import type { ToolRegistry } from '../../tools/index.js';
import type { ConversationStore } from '../conversations.js';

export interface ChatRouteContext {
  orchestrator: OrchestratorDependencies;
  toolRegistry: ToolRegistry;
  conversations: ConversationStore;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export async function handleChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  context: ChatRouteContext,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    respond(res, 400, { ok: false, code: 'INVALID_JSON_BODY', message: String(error instanceof Error ? error.message : error) });
    return;
  }

  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
  if (message.length === 0) {
    respond(res, 400, { ok: false, code: 'INVALID_MESSAGE', message: 'message (non-empty string) is required' });
    return;
  }
  const userId = typeof body.userId === 'string' && body.userId.trim().length > 0 ? body.userId.trim().slice(0, 64) : 'guest';
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim().slice(0, 64) : null;

  const conversation = context.conversations.getOrCreate(conversationId, userId);

  // Step-6 envelope: AI selects tools dynamically; the server validates +
  // executes them and returns the structured orchestration output.
  // A conversational client must never receive a stack-trace 500 — any
  // unexpected failure degrades to an honest apology (§23).
  let orchestrated;
  let turn;
  try {
    orchestrated = await runAiOrchestrator(
      { message, conversationId: conversation.id, context: conversation },
      { ai: context.orchestrator.ai, registry: context.toolRegistry, aiTimeoutMs: context.orchestrator.aiTimeoutMs, now: context.orchestrator.now },
    );
    turn = orchestrated.turn ?? (await orchestrateTurn(context.orchestrator, conversation, message));
  } catch {
    respond(res, 200, {
      ok: true,
      conversationId: conversation.id,
      reply: 'Abhi railway data available nahi ho raha. Thodi der baad try karein.',
      intent: 'UNKNOWN',
      usedFallbackNlu: true,
      executedTools: [],
      safetyRejections: [],
      cards: null,
      panel: null,
      slots: {
        origin: conversation.origin?.code ?? null,
        destination: conversation.destination?.code ?? null,
        journeyDate: conversation.journeyDate,
        passengerCount: conversation.passengerCount,
        selectedTrain: conversation.selectedTrain?.number ?? null,
        selectedClass: conversation.selectedClass,
      },
      orchestration: {
        intent: 'UNKNOWN',
        entities: {},
        requiredTools: [],
        toolArguments: {},
        missingSlots: [],
        interrupt: false,
        resumeContext: null,
        safety: { rejections: [], aiCanBook: false, aiCanMoveMoney: false, providersChosenBy: 'server-router', toolCallBudget: 5 },
        toolEnvelopes: [],
      },
    });
    return;
  }
  context.conversations.save(turn.context);

  respond(res, 200, {
    ok: true,
    conversationId: turn.context.id,
    reply: turn.reply,
    intent: turn.intent,
    usedFallbackNlu: turn.usedFallbackNlu,
    executedTools: turn.executedTools,
    safetyRejections: turn.safetyRejections,
    cards: turn.cards,
    panel: turn.panel,
    orchestration: {
      intent: orchestrated.intent,
      entities: orchestrated.entities,
      requiredTools: orchestrated.requiredTools,
      toolArguments: orchestrated.toolArguments,
      missingSlots: orchestrated.missingSlots,
      interrupt: orchestrated.interrupt,
      resumeContext: orchestrated.resumeContext,
      safety: orchestrated.safety,
      toolEnvelopes: orchestrated.toolEnvelopes,
        sourceClass: orchestrated.turn?.sourceClass ?? null,
    },
    slots: {
      origin: turn.context.origin?.code ?? null,
      destination: turn.context.destination?.code ?? null,
      journeyDate: turn.context.journeyDate,
      passengerCount: turn.context.passengerCount,
      selectedTrain: turn.context.selectedTrain?.number ?? null,
      selectedClass: turn.context.selectedClass,
    },
  });
}

function respond(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

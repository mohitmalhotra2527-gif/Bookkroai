/**
 * NVIDIA AI provider (REAL REST adapter, activated only when AI_API_KEY is
 * configured server-side). Talks to the NVIDIA integrate API with a
 * JSON-constrained prompt and returns STRICT structured output which the
 * orchestrator validates before use.
 *
 * The key arrives via constructor injection (never read from the environment in this module), is sent
 * only in the Authorization header to the NVIDIA endpoint, and is never
 * logged. Timeout bounded by the caller (orchestrator) + a transport-level
 * AbortController.
 */

import { NotImplementedError } from '../../shared/index.js';
import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
  AISlotExtraction,
  Intent,
} from '../../shared/index.js';
import type { AIProvider } from '../AIProvider.js';

export interface NvidiaAIProviderOptions {
  /** Primary key — answers always prefer this one. */
  apiKey: string;
  /** Backup keys, tried in order when the primary fails with 401/402/403/429. */
  fallbackApiKeys?: string[];
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export class NvidiaAIProvider implements AIProvider {
  readonly providerId = 'nvidia';

  private readonly apiKeys: string[];
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly disableThinking: boolean;

  constructor(options: NvidiaAIProviderOptions) {
    this.apiKeys = [options.apiKey, ...(options.fallbackApiKeys ?? [])].filter((key) => key.trim().length > 0);
    this.model = options.model ?? 'meta/llama-3.1-70b-instruct';
    this.disableThinking = /nemotron-3/i.test(this.model);
    this.baseUrl = (options.baseUrl ?? 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    const body = await this.chat(
      [
        { role: 'system', content: nluSystemPrompt(input.availableIntents as readonly string[]) },
        { role: 'user', content: input.userMessage },
      ],
      0.0, // NLU selection must be near-deterministic
    );
    // The orchestrator's validator sanitizes this — the provider never trusts its own model.
    const parsed = extractJson(body);
    return {
      intent: parsed.intent as Intent, // sanitized + whitelisted by the orchestrator validator
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      slots: { ...emptySlots(), ...((parsed.slots ?? parsed.entities ?? {}) as Partial<AISlotExtraction>) },
      missingFields: Array.isArray(parsed.missingFields ?? parsed.missing)
        ? ((parsed.missingFields ?? parsed.missing) as AIUnderstandingResult['missingFields'])
        : [],
      toolRequest: null,
    };
  }

  async generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
    const body = await this.chat([
      {
        role: 'system',
        content:
          'You phrase booking-assistant replies in friendly Hinglish. Use ONLY the facts present in the tool results JSON. Never invent train numbers, times, fares, availability or stations. If data is missing, say it is unavailable. No URLs.',
      },
      { role: 'user', content: `Tool results JSON:\n${JSON.stringify(input.toolResults).slice(0, 4_000)}\n\nWrite the reply.` },
    ]);
    return { message: typeof body === 'string' ? body : String(body), askForField: null };
  }

  /** Auth/quota failures that justify rotating to the NEXT key. */
  private static readonly KEY_ROTATION_STATUSes = [401, 402, 403, 429];

  private async chat(messages: Array<{ role: string; content: string }>, temperature = 0.2): Promise<unknown> {
    let lastError: unknown = null;
    for (const apiKey of this.apiKeys) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            // Server-side only; never logged, never exposed to the browser.
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            messages,
            temperature,
            max_tokens: 1600, // headroom when thinking is enabled
            stream: false,
            // Nemotron 3.x reasoning models: structured NLU extraction does not need
            // thinking tokens — disabling them cuts latency from ~25s to ~1s.
            ...(this.disableThinking ? { chat_template_kwargs: { thinking: false } } : {}),
          }),
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
          return payload.choices?.[0]?.message?.content ?? null;
        }
        if (!NvidiaAIProvider.KEY_ROTATION_STATUSes.includes(response.status)) {
          throw new NotImplementedError(`NVIDIA API error ${response.status}`); // not a key problem — do not rotate
        }
        lastError = new NotImplementedError(`NVIDIA API error ${response.status} (key rotated)`); // try next key
      } catch (error) {
        if (error instanceof NotImplementedError && NvidiaAIProvider.KEY_ROTATION_STATUSes.some((status) => error.message.includes(String(status)))) {
          lastError = error; // rotation case — continue to the next key
          continue;
        }
        throw error; // timeout/network — not a key problem
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new NotImplementedError('NVIDIA API error: all keys exhausted');
  }
}

// ── shared prompt/parse helpers (used by NVIDIA and Gemini) ──────────────────

export function nluSystemPrompt(intents: readonly string[]): string {
  return [
    'You are the NLU of BookKaro, an Indian railway assistant. Reply with ONLY a JSON object, no markdown:',
    '{"intent": "<one of: ' + intents.join(', ') + '>", "confidence": 0..1,',
    ' "entities": {"origin": str|null, "destination": str|null, "dateText": "aaj|kal|parso|YYYY-MM-DD|null",',
    ' "passengerCount": 1-6|null, "trainNumber": str|null, "secondTrainNumber": str|null, "travelClass": "SL|3A|2A|1A|CC|EC|2S|3E"|null,',
    ' "pnr": 10-digits|null, "resultReference": "pehli|doosri|last|<trainNumber>"|null, "isCorrection": bool,',
    ' "mentionedStations": [..], "glossaryTerm": str|null}, "missing": ["origin","destination","journeyDate","passengerCount"]}',
    'Rules: extract only what the user literally said; never invent stations, codes, dates or numbers;',
  'Intent hints: seats/available/milegi/milega/WL questions → GET_AVAILABILITY; fare/price/paisa/paisa lagenge questions → GET_FARE;',
    '"kal"=tomorrow "parso"=day-after-tomorrow "aaj"=today only when the user says so;',
    'a bare short answer (just a date/count/class/ordinal like "pehli wali") gets intent UNKNOWN with the entity filled.',
  ].join('\n');
}

export function emptySlots(): AISlotExtraction {
  return {
    originQuery: null,
    destinationQuery: null,
    journeyDate: null,
    dateText: null,
    passengerCount: null,
    trainNumber: null,
    secondTrainNumber: null,
    travelClass: null,
    pnr: null,
    resultReference: null,
    isCorrection: false,
    mentionedStations: [],
    glossaryTerm: null,
  };
}

export function extractJson(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') return {};
  const withoutFences = content.replace(/```json|```/g, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return {};
  try {
    const parsed: unknown = JSON.parse(withoutFences.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

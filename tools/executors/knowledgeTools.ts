/**
 * RESTRICTED RAILWAY KNOWLEDGE TOOL (Step 9 §10/§11).
 *
 * Resolution order:
 *   1. APPROVED deterministic glossary/composition (source: "deterministic") —
 *      zero network, covers classes/quotas/RAC/WL/tatkal/coach types/speed.
 *   2. ALLOWLISTED official web retrieval (source: "web") — only for general
 *      concept queries the glossary cannot answer, only from approved railway
 *      domains, with a hard timeout and sanitized output.
 *
 * Safety:
 *  - Arbitrary URLs/domains are REJECTED (hostname must match the allowlist,
 *    including after redirects — we never follow redirects to other domains).
 *  - Live-data queries (train number / live / availability / PNR / fare) are
 *    REFUSED web access — web is never used for live railway data.
 *  - Retrieval failures return honest unavailable. Nothing is fabricated.
 */

import { composeKnowledgeAnswer } from '../../shared/railwayKnowledge.js';
import type { ToolResult } from '../../shared/index.js';
import type { ToolExecutionContext, ToolExecutor } from '../registry.js';
import { toolFailure, toolUnavailable } from '../results.js';

export const RAILWAY_WEB_ALLOWLIST: readonly string[] = [
  'indianrail.gov.in',
  'www.indianrail.gov.in',
  'indianrailways.gov.in',
  'www.indianrailways.gov.in',
  'cris.org.in',
  'www.cris.org.in',
];

const KNOWLEDGE_FETCH_TIMEOUT_MS = 6_000;
const MAX_RETRIEVED_TEXT_CHARS = 1_200;

/** Live-data markers — web is NEVER consulted for these (providers only). */
const LIVE_DATA_MARKER =
  /\b\d{5}\b|\blive\b|\babhi\b|\blocation\b|\bdelay|late\b|\bavailab|seat|waitlist|\bwl\b|\brac\b|\bfare\b|\bpnr\b|\bcancel|running|status/i;

function isAllowlisted(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^www\./, '');
  return RAILWAY_WEB_ALLOWLIST.some((domain) => {
    const bare = domain.toLowerCase().replace(/^www\./, '');
    return normalized === bare || normalized.endsWith(`.${bare}`);
  });
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RETRIEVED_TEXT_CHARS);
}

export interface KnowledgeFetch {
  (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }): Promise<{
    ok: boolean;
    status: number;
    url?: string;
    text(): Promise<string>;
  }>;
}

export interface KnowledgeToolOptions {
  /** Injectable transport for tests (defaults to global fetch with redirect:'error'). */
  fetchImpl?: KnowledgeFetch;
  now?: () => Date;
}

function callOf(context: ToolExecutionContext): { id: string | null; tool: string } {
  return { id: context.call?.id ?? null, tool: 'getRailwayKnowledge' };
}

export function createKnowledgeToolExecutor(options: KnowledgeToolOptions = {}): Record<string, ToolExecutor> {
  const fetchImpl: KnowledgeFetch =
    options.fetchImpl ??
    ((globalThis.fetch as unknown) as KnowledgeFetch);
  const now = options.now ?? (() => new Date());

  return {
    getRailwayKnowledge: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx);
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length < 3) return toolFailure(call, 'INVALID_INPUT', 'query is required.');

      // Optional explicit allowlisted URL (AI may propose one — it is validated, never trusted).
      const proposedUrl = typeof input.url === 'string' ? input.url.trim() : null;
      if (proposedUrl !== null) {
        let hostname = '';
        try {
          hostname = new URL(proposedUrl).hostname;
        } catch {
          return toolFailure(call, 'URL_REJECTED', 'Invalid URL.');
        }
        if (!isAllowlisted(hostname)) {
          return toolFailure(call, 'URL_REJECTED', `Domain "${hostname}" is not on the railway knowledge allowlist.`);
        }
      }

      // 1. Approved deterministic knowledge first.
      const composed = composeKnowledgeAnswer(query);
      if (composed) {
        return {
          callId: call.id,
          tool: call.tool,
          ok: true,
          data: {
            source: 'deterministic',
            title: composed.matchedTerms.join(' + '),
            url: null,
            retrievedText: composed.answer,
            timestamp: now().toISOString(),
          },
          unavailableReason: null,
          error: null,
          executedBy: 'SERVER',
          provider: null,
        };
      }

      // 2. Allowlisted web — ONLY for general concepts, never live data.
      if (LIVE_DATA_MARKER.test(query)) {
        return toolUnavailable(
          call,
          'NO_DATA',
          'Live railway data (status/availability/fare/PNR) web se nahi aata — sirf railway providers se aata hai.',
        );
      }
      const target = proposedUrl ?? 'https://www.indianrail.gov.in/';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), KNOWLEDGE_FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(target, {
          headers: { accept: 'text/html' },
          signal: controller.signal,
          redirect: 'error', // never follow redirects to unlisted domains
        });
        const finalHostname = response.url ? new URL(response.url).hostname : new URL(target).hostname;
        if (!response.ok || !isAllowlisted(finalHostname)) {
          return toolUnavailable(call, 'NO_DATA', 'Approved railway knowledge source se jawab nahi mila.');
        }
        const text = sanitizeHtml(await response.text());
        if (text.length < 40) {
          return toolUnavailable(call, 'NO_DATA', 'Approved railway knowledge source se jawab nahi mila.');
        }
        return {
          callId: call.id,
          tool: call.tool,
          ok: true,
          data: {
            source: 'web',
            title: finalHostname,
            url: `https://${finalHostname}/`,
            retrievedText: text,
            timestamp: now().toISOString(),
          },
          unavailableReason: null,
          error: null,
          executedBy: 'SERVER',
          provider: null,
        };
      } catch {
        return toolUnavailable(call, 'NO_DATA', 'Railway knowledge source abhi reachable nahi hai — main guess nahi karunga.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

# BookKaro (RAILBOOK) 🚆

**AI-first railway assistant.** Conversational, Hinglish-friendly, fact-safe:
the AI understands and explains — deterministic server code fetches every
railway fact, moves every rupee and executes every booking.

> **Steps 1–7** — now with the full conversational experience: pronoun
> follow-ups ("uska fare", "CC mein?"), result-detail questions, weekday
> dates, glossary interrupts with resume, multi-question parallel tools, and
> tighter confirmation phrasing. Previous:
>  now with the AI tool-orchestration layer (`api/ai/`):
> catalog-validated dynamic tool selection, parallel multi-tool execution,
> MAX_TOOL_CALLS_PER_TURN=5, and env-driven model providers (NVIDIA / Gemini /
> any OpenAI-compatible AI_BASE_URL). Previous:
>  foundation, real railway provider layer, AI orchestrator,
> foundation, providers, orchestrator, assistant, conversational booking with
> passenger details, fare review and a clearly-labelled DEMO booking boundary.
> Previous summary: foundation, real railway provider layer (RailCore → RailKit),
> AI-first orchestrator, and the customer-facing conversational assistant:
> multi-intent messages, station disambiguation, natural dates, corrections with
> stale-result invalidation, train cards, fare/service-fee transparency, and a
> fully gated confirmation flow (review → explicit yes → still no execution).
> Deterministic NLU works with zero keys; NVIDIA/Gemini via env config.
> Still no booking execution, no wallet movement, no deployment.

## Quickstart

```bash
npm install
npm test          # 500 tests, 35 suites — Step 9 adds the AI gateway (GPT-OSS primary → Nemotron), source classes, deterministic comparison and allowlisted railway knowledge
npm run typecheck # strict TypeScript across source + tests
npm run build     # production build → dist/ (+ copies app/ → dist/public)
npm start         # serve API + shell on http://localhost:3000
```

## Structure

```
/app      minimal UI shell (no railway calls, no secrets)
/api      node:http server — /api/health, /api/chat (501 NOT_IMPLEMENTED)
/ai       AIProvider abstraction, deterministic NLU, NVIDIA/Gemini adapters, orchestrator
/tools    tool registry + validation boundary (15 tools, executors deferred)
/railway  RailwayProvider interface, REAL RailCore REST + RailKit SDK adapters, provider router, safe diagnostics
/booking  booking state machine + execution guards
/wallet   wallet interface + guards (implementation deliberately inert)
/shared   contracts, conversation context engine, intent registry, validators
/tests    129 tests covering every layer + security & boundary invariants
```

## Safety invariants (all test-enforced)

- AI can **request** tools; only validated deterministic **server code executes** them.
- `confirmBooking` is `DETERMINISTIC_ONLY` — AI requests are rejected by construction.
- Zero-result searches and unknown data are honest answers (`NO_RESULTS`, `UNAVAILABLE`, `UNKNOWN`) — never fallback triggers, never fabricated.
- Wallet: AI is read-only; all mutations require SERVER actor + idempotency key; nothing can move money in Step 1.
- Secrets (`RAILCORE_API_KEY`, `RAILKIT_API_KEY`, `AI_API_KEY`) are placeholders in `.env.example`, server-side only, scrubbed from logs.
- Railway data flows ONLY through `RailwayProviderRouter` → normalized `ProviderResult`s; missing fields are null/UNKNOWN, never invented.
- Developer diagnostics: open the shell's "Railway provider diagnostics" section or hit `/api/railway/provider-config`.

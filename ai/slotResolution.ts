/**
 * Deterministic slot resolution — dates, stations, result references and
 * correction merges. Pure functions, no AI, no provider calls (station name →
 * code resolution is done by the orchestrator via the lookupStation tool).
 */

import type {
  ContextSlotField,
  ConversationContext,
  Station,
  TrainSearchResult,
} from '../shared/index.js';
import { setContextSlots } from '../shared/context.js';
import type { ContextSlots } from '../shared/context.js';

/** aaj → today, kal → tomorrow, parso → day after tomorrow; explicit dates pass through. */
export function resolveDateText(dateText: string | null, now: Date = new Date()): string | null {
  if (!dateText) return null;
  const text = dateText.trim().toLowerCase();
  if (text === 'aaj' || text === 'today') return isoShift(now, 0);
  if (text === 'kal' || text === 'tomorrow') return isoShift(now, 1);
  if (text === 'parso' || text === 'parsu' || text === 'day after tomorrow') return isoShift(now, 2);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const time = Date.parse(`${text}T00:00:00Z`);
    return Number.isNaN(time) ? null : text;
  }
  // weekday tokens from the NLU: next-<day> (strictly future) or weekday-<day> (this week, else next)
  const weekdayToken = text.match(/^(?:next|weekday)-(\d)$/);
  if (weekdayToken) {
    const target = Number(weekdayToken[1]);
    const todayDow = now.getUTCDay();
    let diff = (target - todayDow + 7) % 7;
    if (diff === 0) diff = 7; // "next Monday" on a Monday → next week; bare weekday today → next week (never silently today)
    return isoShift(now, diff);
  }
  // "27-08" (day-month, unambiguous in the current year); past dates → null (ask for the year)
  const dayMonth = text.match(/^(\d{1,2})-(\d{1,2})$/);
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = Number(dayMonth[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const iso = `${now.getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return iso >= now.toISOString().slice(0, 10) ? iso : null; // ambiguous year → caller asks
  }
  return null;
}

function isoShift(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export interface StationResolution {
  station: Station | null;
  /** true when the user typed a station CODE directly (no lookup invention). */
  fromCode: boolean;
  error: string | null;
}

// A direct code is what the USER TYPED in caps (ASR, NDLS, BCT…). Mixed-case
// words ("Jammu", "Amritsar") are NAMES and must be resolved by the lookup
// tool — codes are never guessed from names.
const TYPED_STATION_CODE = /^[A-Z]{2,6}\d{0,2}$/;

/** A user-typed code is user-provided (allowed, name stays null); names need the provider. */
export function stationFromDirectInput(query: string): StationResolution | null {
  const trimmed = query.trim();
  if (TYPED_STATION_CODE.test(trimmed)) {
    return { station: { code: trimmed, name: null, zone: null, state: null, latitude: null, longitude: null }, fromCode: true, error: null };
  }
  return null;
}

/** Pick the station for a query when it is UNIQUE (exact name/code or single match); ambiguous → choice. */
export function stationFromLookup(query: string, stations: Station[]): { station: Station | null; choiceNeeded: Station[] | null } {
  if (stations.length === 0) return { station: null, choiceNeeded: null };
  const lowered = query.trim().toLowerCase();
  const byCode = stations.filter((station) => station.code.toLowerCase() === lowered);
  if (byCode.length === 1 && byCode[0]) return { station: byCode[0], choiceNeeded: null };
  const byExactName = stations.filter((station) => station.name?.toLowerCase() === lowered);
  if (byExactName.length === 1 && byExactName[0]) return { station: byExactName[0], choiceNeeded: null };
  if (stations.length === 1 && stations[0]) return { station: stations[0], choiceNeeded: null };
  // multiple plausible stations → the USER chooses (never silently pick the first)
  return { station: null, choiceNeeded: stations.slice(0, 4) };
}

/** Match a user's disambiguation reply ("New Delhi", "pehla", "NZM") against the offered options. */
export function resolveStationChoice(reply: string, options: readonly Station[]): Station | null {
  const text = reply.trim().toLowerCase();
  if (options.length === 0) return null;
  const ordinalWords: Record<string, number> = { pehla: 0, pehli: 0, first: 0, doosra: 1, doosri: 1, second: 1, teesra: 2, teesri: 2, third: 2 };
  for (const [word, index] of Object.entries(ordinalWords)) {
    if (text === word && options[index]) return options[index] ?? null;
  }
  if (/^\d$/.test(text) && options[Number(text) - 1]) return options[Number(text) - 1] ?? null;
  for (const option of options) {
    const name = option.name?.toLowerCase() ?? '';
    if (name === text || option.code.toLowerCase() === text || name.includes(text)) return option;
  }
  return null;
}

/**
 * Result references: "pehli wali"(0) "doosri wali"(1) "third train"(2)
 * "last wali"(n-1) "upar wali"(0) "12014 wali"(match by number)
 * "Shatabdi wali"(match by train NAME substring).
 * Never returns a train that is not in the provided list.
 */
export function resolveResultReference(reference: string, results: readonly TrainSearchResult[]): TrainSearchResult | null {
  if (results.length === 0) return null;
  const normalized = reference.trim().toLowerCase();
  if (normalized === 'last' || normalized === 'aakhri' || normalized === 'antim') return results[results.length - 1] ?? null;
  if (/^\d+$/.test(normalized)) {
    if (/^\d{4,6}$/.test(normalized)) {
      return results.find((entry) => entry.train.number === normalized) ?? null; // train-number reference
    }
    const index = Number(normalized) - 1;
    return index >= 0 && index < results.length ? (results[index] ?? null) : null;
  }
  // name-based reference ("Shatabdi wali") — substring match against the CURRENT list only
  const byName = results.find((entry) => entry.train.name?.toLowerCase().includes(normalized));
  return byName ?? null;
}

/**
 * CORRECTION MERGE (§11): correct ONE slot, never wipe the other.
 *  - "Nahi, Ludhiana se jaana hai" → origin=Ludhiana, destination preserved
 *  - "Delhi nahi, Chandigarh"      → destination=Chandigarh, origin preserved
 * The old value is identified by matching mentioned stations against the
 * CURRENT context slots; the unmatched station becomes the new value.
 */
export function mergeCorrection(
  context: ConversationContext,
  mentionedStations: readonly string[],
  originCandidate: string | null,
  destinationCandidate: string | null,
): { context: ConversationContext; changedFields: ContextSlotField[] } {
  const changed: ContextSlotField[] = [];

  // Case A: explicit "X se …" → origin correction only.
  if (originCandidate && !destinationCandidate) {
    const next = setContextSlots(context, { origin: stationForCandidate(originCandidate) }, 'CORRECT');
    return { context: next, changedFields: ['origin'] };
  }

  // Case B: two stations mentioned — figure out which slot the OLD value belongs to.
  if (mentionedStations.length >= 2) {
    const [first, second] = mentionedStations;
    const originText = context.origin?.name?.toLowerCase() ?? context.origin?.code.toLowerCase() ?? '';
    const destinationText = context.destination?.name?.toLowerCase() ?? context.destination?.code.toLowerCase() ?? '';
    const firstMatchesOrigin = originText.length > 0 && (first?.toLowerCase().includes(originText) || originText.includes(first!.toLowerCase()));
    const firstMatchesDestination = destinationText.length > 0 && (first?.toLowerCase().includes(destinationText) || destinationText.includes(first!.toLowerCase()));
    if (firstMatchesOrigin && second) {
      return { context: setContextSlots(context, { origin: stationForCandidate(second) }, 'CORRECT'), changedFields: ['origin'] };
    }
    if (firstMatchesDestination && second) {
      return {
        context: setContextSlots(context, { destination: stationForCandidate(second) }, 'CORRECT'),
        changedFields: ['destination'],
      };
    }
  }

  // Case C: single station, no 'se' marker — if it matches an existing slot value, it's a correction of the OTHER slot… ambiguous, so prefer destination only when context already has origin and the message pattern ends with the station ("…nahi, Chandigarh").
  if (mentionedStations.length === 1 && context.origin && !destinationCandidate) {
    const station = mentionedStations[0]!;
    return { context: setContextSlots(context, { destination: stationForCandidate(station) }, 'CORRECT'), changedFields: ['destination'] };
  }

  return { context, changedFields: changed };
}

/** Resolve a bare candidate into a minimal Station (name-only; code comes from lookup later). */
export function stationForCandidate(candidate: string): Station {
  const trimmed = candidate.trim();
  if (TYPED_STATION_CODE.test(trimmed)) {
    return { code: trimmed, name: null, zone: null, state: null, latitude: null, longitude: null };
  }
  // name-only placeholder — the orchestrator resolves the code via lookupStation before any tool call
  return { code: '', name: trimmed, zone: null, state: null, latitude: null, longitude: null };
}

export function slotsMissingForJourney(context: ConversationContext): ContextSlotField[] {
  const missing: ContextSlotField[] = [];
  if (!context.origin) missing.push('origin');
  if (!context.destination) missing.push('destination');
  if (!context.journeyDate) missing.push('journeyDate');
  if (!context.passengerCount) missing.push('passengerCount');
  return missing;
}

export function applySlots(context: ConversationContext, slots: ContextSlots): ConversationContext {
  return setContextSlots(context, slots, 'FILL_MISSING');
}

/**
 * STATION NAME RESOLUTION (user complaint fix): "Ludhiana se Haridwar jaana hai"
 * type queries must resolve by NAME — providers return "HARIDWAR JN",
 * "LUDHIANA JN", "LUDHIANA QUICK TRANS" etc. Junction-suffix matching +
 * provider confidence/isMajor signals auto-pick the main station; genuine
 * ambiguity still asks. Verified against REAL RailCore response shapes.
 */

import { describe, expect, it } from 'vitest';
import { stationFromLookup } from '../../ai/slotResolution.js';
import type { Station } from '../../shared/index.js';
import { createHarness, freshContext, run } from '../orchestration/harness.js';

const S = (code: string, name: string, extra: Partial<Station> = {}): Station => ({
  code, name, zone: null, state: null, latitude: null, longitude: null, ...extra,
});

// Real RailCore response shapes (captured live 2026-08-28)
const LUDHIANA_RESULTS: Station[] = [
  S('LDH', 'LUDHIANA JN', { confidence: 1, isMajor: true }),
  S('LQTS', 'LUDHIANA QUICK TRANS', { confidence: 0.62 }),
  S('GNGR', 'GUNGRANA'),
];
const HARIDWAR_RESULTS: Station[] = [
  S('HW', 'HARIDWAR JN', { confidence: 1, isMajor: true }),
  S('HDS', 'HARIDASPUR'),
  S('HRJ', 'HARIJ'),
];

describe('stationFromLookup: name → main station (verified provider shapes)', () => {
  it('"ludhiana" → LDH (LUDHIANA JN) — junction-suffix auto-pick, no question', () => {
    const result = stationFromLookup('ludhiana', LUDHIANA_RESULTS);
    expect(result.station?.code).toBe('LDH');
    expect(result.choiceNeeded).toBeNull();
  });

  it('"haridwar" → HW (HARIDWAR JN) — even with HARIDASPUR/HARIJ in results', () => {
    const result = stationFromLookup('haridwar', HARIDWAR_RESULTS);
    expect(result.station?.code).toBe('HW');
    expect(result.choiceNeeded).toBeNull();
  });

  it('exact name still wins ("BEAS")', () => {
    expect(stationFromLookup('beas', [S('BEAS', 'BEAS')]).station?.code).toBe('BEAS');
  });

  it('provider confidence winner picks the main city station', () => {
    const result = stationFromLookup('jalandhar', [
      S('JRC', 'JALANDHAR CITY', { confidence: 1, isMajor: true }),
      S('JUC', 'JALANDHAR CANTT', { confidence: 0.6 }),
    ]);
    expect(result.station?.code).toBe('JRC');
  });

  it('genuine ambiguity (different bases, no signals) still asks — never guesses', () => {
    const result = stationFromLookup('harid', [S('HW', 'HARIDWAR JN'), S('HDS', 'HARIDASPUR')]);
    expect(result.station).toBeNull();
    expect(result.choiceNeeded?.length).toBe(2);
  });
});

describe('conversation: full name-based journey resolves without blocking', () => {
  it('"Mujhe Ludhiana se Haridwar jaana hai" → both stations filled, asks only the date', async () => {
    const harness = createHarness();
    const turn = await run(harness, freshContext(), 'Mujhe Ludhiana se Haridwar jaana hai');

    expect(turn.context.origin?.code).toBe('LDH');  // "Ludhiana Jn" via junction-suffix
    expect(turn.context.destination?.code).toBe('HW'); // "Haridwar" single result
    expect(turn.reply).toMatch(/kis date/i);          // journey continues — NO station question
  });
});

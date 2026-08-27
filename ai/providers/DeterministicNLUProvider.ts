/**
 * DETERMINISTIC NLU PROVIDER (default AI provider when no AI_API_KEY is
 * configured, and the mandatory fallback when a real AI provider fails,
 * times out or returns invalid JSON).
 *
 * It implements the same AIProvider interface and returns the SAME strict
 * structured output schema — so it is a drop-in for the real providers. It is
 * deliberately rule-based: it never invents railway facts (it only extracts
 * what the user literally said), which makes it safe under the fact-safety
 * rules.
 *
 * Supported understanding (Hindi/Hinglish/English):
 *   intents: live status, availability, fare, timetable, train info, PNR,
 *   bookings, wallet, cancelled trains, station lookup, comparison, glossary,
 *   book/search journey, help; slot-fillers (bare date/count/class/station/
 *   result references) surface as intent UNKNOWN + extracted slots, which the
 *   orchestrator resolves against the pending question.
 */

import type {
  AIReplyInput,
  AIReplyResult,
  AIUnderstandingInput,
  AIUnderstandingResult,
  ContextSlotField,
  Intent,
  TravelClassCode,
} from '../../shared/index.js';
import { TRAVEL_CLASSES } from '../../shared/index.js';
import type { AIProvider } from '../AIProvider.js';

const STOPWORDS = new Set([
  'mujhe', 'main', 'hum', 'mein', 'me', 'hai', 'hain', 'haan', 'nahi', 'na', 'kya', 'kaunsi', 'kaun', 'kab',
  'kahan', 'kaha', 'kitne', 'kitni', 'kitna', 'jaana', 'jana', 'jaana', 'jaa', 'chahiye', 'chahiye', 'karna',
  'kar', 'karo', 'karun', 'batao', 'bata', 'dikhao', 'dikha', 'se', 'se', 'tak', 'to', 'from', 'the', 'a',
  'an', 'is', 'are', 'train', 'trains', 'ki', 'ke', 'ka', 'ko', 'bhi', 'please', 'ya', 'ya', 'or', 'and',
  'wali', 'wala', 'upar', 'ticket', 'tickets', 'book', 'booking', 'karunga', 'karungi', 'saab', 'sab', 'actually', 'jagah', 'badlo', 'bhai', 'yaar', 'waise', 'achha', 'chalo', 'sahi', 'dikhao',
]);

const DATE_TODAY = /\b(aaj|aa?j|today)\b/i;
const DATE_TOMORROW = /\b(kal|tomorrow)\b/i;
const DATE_DAY_AFTER = /\b(parso|parsu|day after tomorrow)\b/i;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;
const DMY_DATE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/;
const MONTHS: Record<string, string> = {
  jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03', apr: '04', april: '04',
  may: '05', jun: '06', june: '06', jul: '07', july: '07', aug: '08', august: '08', augst: '08',
  sep: '09', sept: '09', september: '09', oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6,
};

const ORDINALS: Readonly<Record<string, number>> = {
  pehli: 0, pehla: 0, first: 0, '1st': 0,
  doosri: 1, dusri: 1, doosra: 1, second: 1, '2nd': 1,
  teesri: 2, tisri: 2, third: 2, '3rd': 2,
};

const GLOSSARY_TOKENS = [
  'cc', 'ec', 'sl', '1a', '2a', '3a', '3e', '2s', 'rac', 'wl', 'gn', 'tq', 'tatkal', 'chart', 'pnr', 'speed', 'cnf',
];

function emptySlots(): AIUnderstandingResult['slots'] {
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

function extractTrainNumbers(text: string): string[] {
  return [...text.matchAll(/\b(\d{4,6})\b/g)].map((match) => match[1]!).filter((n) => /^\d{5}$/.test(n) || /^\d{4}$/.test(n));
}

function extractPnr(text: string): string | null {
  const match = text.match(/\b(\d{10})\b/);
  return match ? match[1]! : null;
}

function extractTravelClass(text: string): TravelClassCode | null {
  for (const code of TRAVEL_CLASSES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(text)) return code;
  }
  // common spoken forms
  if (/\bsleeper\b/i.test(text)) return 'SL';
  if (/\bchair\s*car\b/i.test(text)) return 'CC';
  if (/\bthird\s*ac\b|\b3ac\b/i.test(text)) return '3A';
  if (/\bsecond\s*ac\b|\b2ac\b/i.test(text)) return '2A';
  if (/\bfirst\s*ac\b|\b1ac\b/i.test(text)) return '1A';
  return null;
}

function extractPassengerCount(text: string): number | null {
  const trimmed = text.trim().toLowerCase().replace(/[?.!]+$/, '');
  // "hum 3 log hain" / "hum teen log hain"
  const humLog = text.match(/\bhum\s+(\d|ek|do|teen|char|chaar|panch|paanch|chhe)\s+log\b/i);
  if (humLog) {
    const word = humLog[1]!.toLowerCase();
    const value = /^\d$/.test(word) ? Number(word) : (NUMBER_WORDS[word] ?? null);
    if (value !== null && value >= 1 && value <= 6) return value;
  }
  // "mere liye aur meri wife ke liye" — reliably TWO parties (self + one named companion)
  if (/mere liye aur (meri?|mere|mere)\s*(wife|biwi|patni|husband|pati|bhai|behen|dost|friend|maa|papa|beta|beti)/i.test(text)) return 2;
  const digitMatch = text.match(/\b(\d)\s*(ticket|tickets|passenger|passengers|log|aadmi|seat|seats)\b/i);
  if (digitMatch) return Math.min(6, Math.max(1, Number(digitMatch[1])));
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\s+(ticket|tickets|passenger|passengers|log|aadmi)\\b`, 'i').test(text)) return value;
  }
  // a BARE 1-6 digit (or bare number word) answering a pending "kitne passengers?" question
  if (/^[1-6]$/.test(trimmed)) return Number(trimmed);
  if (Object.keys(NUMBER_WORDS).includes(trimmed) && trimmed !== 'ek') return NUMBER_WORDS[trimmed] ?? null;
  if (trimmed === 'ek') return 1;
  return null;
}

function extractDateText(text: string): string | null {
  if (ISO_DATE.test(text)) return text.match(ISO_DATE)![1]!;
  const dmy = text.match(DMY_DATE);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  // "27 August" / "August 27" / "27 aug" → day-month (resolver applies the year rule)
  const dayMonth = text.match(/\b(\d{1,2})\s+([a-z]{3,9})\b/i);
  if (dayMonth && MONTHS[dayMonth[2]!.toLowerCase()]) {
    return `${Number(dayMonth[1])}-${Number(MONTHS[dayMonth[2]!.toLowerCase()])}`;
  }
  const monthDay = text.match(/\b([a-z]{3,9})\s+(\d{1,2})\b/i);
  if (monthDay && MONTHS[monthDay[1]!.toLowerCase()]) {
    return `${Number(monthDay[2])}-${Number(MONTHS[monthDay[1]!.toLowerCase()])}`;
  }
  // weekday names: "Monday", "next Sunday", "is sunday", "agle somvar"
  const WEEKDAYS: Record<string, number> = {
    sunday: 0, ravivar: 0, sun: 0,
    monday: 1, somvar: 1, mon: 1,
    tuesday: 2, mangalvar: 2, tue: 2,
    wednesday: 3, budhvar: 3, wed: 3,
    thursday: 4, guruvar: 4, thu: 4,
    friday: 5, shukravar: 5, fri: 5,
    saturday: 6, shanivar: 6, sat: 6,
  };
  const weekend = text.match(/\b(this|is|agla|agle)?\s*weekend\b/i);
  if (weekend) return 'next-saturday';
  const weekdayMatch = text.match(/\b(next|agla|agle|coming|is|aane wale)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar)\b/i);
  if (weekdayMatch && WEEKDAYS[weekdayMatch[2]!.toLowerCase()] !== undefined) {
    return `${weekdayMatch[1] ? 'next-' : 'weekday-'}${WEEKDAYS[weekdayMatch[2]!.toLowerCase()]}`;
  }
  if (DATE_DAY_AFTER.test(text)) return 'parso';
  if (DATE_TOMORROW.test(text)) return 'kal';
  if (DATE_TODAY.test(text)) return 'aaj';
  return null;
}

function extractStations(message: string): { origin: string | null; destination: string | null; mentioned: string[] } {
  const tokens = message.split(/[\s,]+/).map((t) => t.replace(/[?.!]+$/, '')).filter((t) => t.length > 0);
  const mentioned: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/^[A-Z][a-z]{2,}$/.test(token)) {
      mentioned.push(token);
      continue;
    }
    // lowercase known-ish station words (long alphabetic tokens that aren't stopwords)
    if (/^[a-z]{4,}$/.test(lower) && !DATE_WORDS.has(lower) && !GENERIC_WORDS.has(lower)) {
      mentioned.push(token);
    }
  }

  let origin: string | null = null;
  let destination: string | null = null;

  const lowerTokens = tokens.map((t) => t.toLowerCase());
  for (let i = 0; i < lowerTokens.length; i += 1) {
    const token = lowerTokens[i]!;
    if ((token === 'se' || token === 'from') && i > 0) {
      const candidate = tokens[i - 1]!;
      if (!STOPWORDS.has(candidate.toLowerCase()) && /^[A-Za-z]{2,}$/.test(candidate)) origin = candidate;
    }
    if (token === 'to' || token === 'tak') {
      for (let j = i + 1; j < Math.min(i + 3, lowerTokens.length); j += 1) {
        const candidate = tokens[j]!;
        if (!STOPWORDS.has(candidate.toLowerCase()) && /^[A-Za-z]{2,}$/.test(candidate)) {
          destination = candidate;
          break;
        }
      }
    }
  }

  // "X se Y …" without explicit to/tak: destination = first station-like token after 'se'
  if (origin && !destination) {
    const seIndex = lowerTokens.findIndex((t, idx) => (t === 'se' || t === 'from') && tokens[idx - 1]?.toLowerCase() === origin!.toLowerCase());
    if (seIndex >= 0) {
      for (let j = seIndex + 1; j < lowerTokens.length; j += 1) {
        const candidate = tokens[j]!;
        const lowerCandidate = candidate.toLowerCase();
        if (lowerCandidate === 'se' || lowerCandidate === 'from') break;
        if (!STOPWORDS.has(lowerCandidate) && /^[A-Za-z]{2,}$/.test(candidate)) {
          destination = candidate;
          break;
        }
      }
    }
  }

  return { origin, destination, mentioned: mentioned.slice(0, 4) };
}

const DATE_WORDS = new Set(['aaj', 'kal', 'parso', 'today', 'tomorrow', 'date', 'din', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const GENERIC_WORDS = new Set([
  'train', 'trains', 'status', 'live', 'seat', 'seats', 'fare', 'kitna', 'kitne', 'kitni', 'time', 'timetable',
  'schedule', 'route', 'ticket', 'tickets', 'booking', 'bookings', 'wallet', 'balance', 'pnr', 'cancel',
  'cancelled', 'station', 'code', 'please', 'batao', 'dikhao', 'chahiye', 'jaana', 'jana', 'chahta', 'chahti',
  'better', 'kaunsi', 'konsi', 'available', 'availability', 'information', 'info', 'details', 'railway', 'indian',
]);

function extractResultReference(text: string, results?: readonly { train: { number: string; name: string | null } }[]): string | null {
  const numbered = text.match(/\b(\d{5})\s*(wali|wala|train|vali|vala)?\b/i);
  const ordinalEntry = Object.entries(ORDINALS).find(([word]) => new RegExp(`\\b${word}\\b`, 'i').test(text));
  if (/\b(last|aakhri|antim|neeche|niche)\s*(wali|wala|train)?\b/i.test(text)) return 'last';
  if (/\b(upar|upar wali|upar wala)\b/i.test(text)) return '1';
  if (ordinalEntry) return String(ordinalEntry[1] + 1);
  if (numbered && (/\bwali\b|\bwala\b|\btrain\b/i.test(text))) return numbered[1]!;
  // name-based reference: the word(s) before "wali/wala" matching a CURRENT result's name
  if (results && results.length > 0 && /\bwali\b|\bwala\b/i.test(text)) {
    const nameRef = text.match(/([a-z]+\s?[a-z]*)\s+(?:wali|wala)/i);
    const candidate = nameRef?.[1]?.trim().toLowerCase();
    if (candidate && candidate.length > 2) {
      const words = candidate.split(/\s+/);
      for (const word of words) {
        if (['train', 'ki', 'ka', 'ye', 'wahi', 'bhai'].includes(word)) continue;
        const match = results.find((entry) => entry.train.name?.toLowerCase().includes(word));
        if (match) return match.train.name ?? word; // name-substring ref
      }
    }
  }
  return null;
}

function extractGlossaryTerm(text: string): string | null {
  const lower = text.toLowerCase();
  for (const token of GLOSSARY_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(lower)) {
      // A bare class token with a train number + availability/fare words is a LIVE query, not glossary.
      return token.toUpperCase() === 'TATKAL' ? 'TQ' : token.toUpperCase();
    }
  }
  if (/\btatkal\b/.test(lower)) return 'TQ';
  if (/\bwaiting list\b/.test(lower)) return 'WL';
  if (/\bchair car\b/.test(lower)) return 'CC';
  return null;
}

function isGlossaryQuestion(text: string): boolean {
  return /\b(kya hot[ai] hai?|kya hot[ai]|kya hai|matlab|meaning|what is|kaunsi class|difference|antar|fark|kya hote hain)\b/i.test(text);
}

function isJourneyIntent(text: string): boolean {
  return (
    /\b(jaana|jana|jaaye|jaye|journey|travel|book|ticket|chahiye|trains? between|se .*tak)\b/i.test(text) ||
    /\b(ki )?trains?\b[^.?!]*\b(batao|dikhao|chahiye|batado)\b/i.test(text) ||
    /\btrains?\s+(batao|dikhao|chahiye)\b/i.test(text) ||
    /\bkoi (aur |dusri |doosri )?train\b/i.test(text) ||
    /\btrain\s+(hai|chahiye|hain)\b/i.test(text) ||
    /\btrains?\b[^.?!]*\bfrom\b/i.test(text)
  );
}

function isSlotFillerOnly(text: string): boolean {
  const trimmed = text.trim().toLowerCase().replace(/[?.!]+$/, '');
  const hasDate = DATE_TODAY.test(trimmed) || DATE_TOMORROW.test(trimmed) || DATE_DAY_AFTER.test(trimmed) || ISO_DATE.test(trimmed) || DMY_DATE.test(trimmed);
  const bareDate = hasDate && trimmed.split(/\s+/).length <= 4 && !extractTrainNumbers(trimmed).length && !/live|status|pnr|wallet|ticket|cancel/i.test(trimmed);
  if (bareDate) return true;
  // bare passenger count "2" / "do ticket"
  if (/^(\d|ek|do|teen|char|chaar|panch|paanch|chhe)(\s+(ticket|tickets|passenger|passengers|log|aadmi))?$/.test(trimmed)) return true;
  // bare class
  if (TRAVEL_CLASSES.some((code) => new RegExp(`^${code}$`, 'i').test(trimmed))) return true;
  return false;
}

const STRONG_INFO_TRIGGER = /\b(live|status|abhi kaha|kahan hai|kitni late|pnr\s*\d|pnr check|timetable|time\s*table|cancel|wallet|bookings?)\b/i;
const JOURNEY_TRIGGER = /\b(jaana|jana|jaaye|jaye|booking|book|ticket|chahiye)\b/i;

/**
 * MULTI-INTENT SPLIT (deterministic, conservative): only splits when the message
 * clearly contains BOTH an informational railway request and a booking/journey
 * request joined by a conjunction. Order: informational first, booking last —
 * so the pending-booking question is what the user sees at the end.
 */
export function splitCompoundRequest(message: string): string[] | null {
  const parts = message
    .split(/\s+(?:aur|or|and|phir|fir|bhi|also)\s+|,\s*|;\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 1);
  if (parts.length < 2 || parts.length > 3) return null;
  const infoParts = parts.filter((part) => STRONG_INFO_TRIGGER.test(part) && !JOURNEY_TRIGGER.test(part));
  const journeyParts = parts.filter((part) => JOURNEY_TRIGGER.test(part) && !STRONG_INFO_TRIGGER.test(part));
  if (infoParts.length === 0 || journeyParts.length === 0) return null;
  const ordered = [...infoParts, ...journeyParts];
  return ordered.length === parts.length ? ordered : null;
}

export class DeterministicNLUProvider implements AIProvider {
  readonly providerId = 'deterministic-nlu';

  understand(input: AIUnderstandingInput): Promise<AIUnderstandingResult> {
    const message = input.userMessage;
    const text = message;
    const lower = message.toLowerCase();
    const slots = emptySlots();

    slots.trainNumber = extractTrainNumbers(text)[0] ?? null;
    slots.secondTrainNumber = extractTrainNumbers(text)[1] ?? null;
    slots.pnr = extractPnr(text);
    slots.travelClass = extractTravelClass(text);
    slots.passengerCount = extractPassengerCount(text);
    slots.dateText = extractDateText(text);
    slots.resultReference = extractResultReference(text, input.conversation.lastSearchResults ?? undefined);
    slots.isCorrection = /\b(nahi|nahin|no|instead|badal|badlo|change)\b|ki jagah/i.test(lower);
    const stations = extractStations(message);
    slots.originQuery = stations.origin;
    slots.destinationQuery = stations.destination;
    slots.mentionedStations = stations.mentioned;
    slots.glossaryTerm = extractGlossaryTerm(text);

    if (!slots.trainNumber && input.conversation.selectedTrain) {
      slots.trainNumber = input.conversation.selectedTrain.number;
    }

    // "12014 nahi 14542 ka live status" — a correction between two train numbers:
    // the SECOND number is the train the user actually means.
    if (slots.trainNumber && slots.secondTrainNumber && /\b(nahi|nahin|ki jagah|instead)\b/i.test(lower)) {
      slots.trainNumber = slots.secondTrainNumber;
      slots.secondTrainNumber = null;
    }

    // "pehli wali" etc. while results are shown → selection filler
    if (slots.resultReference && input.conversation.lastSearchResults && input.conversation.lastSearchResults.length > 0) {
      const words = lower.split(/\s+/).length;
      if (words <= 5) {
        return Promise.resolve(resolve({ intent: 'BOOK_TRAIN', confidence: 0.8, slots, missing: [] }));
      }
    }

    // ── intent detection (priority order matters) ──
    let intent: Intent = 'UNKNOWN';
    let confidence = 0.4;
    let missing: ContextSlotField[] = [];

    if ((slots.pnr && /pnr|status|check/i.test(lower)) || (/\bpnr\b/i.test(lower) && /check|status|mera|meri|karo/i.test(lower))) {
      intent = 'CHECK_PNR';
      confidence = slots.pnr ? 0.95 : 0.8;
    } else if (/\bspeed\b|\baraftar\b/i.test(lower) && slots.trainNumber) {
      intent = 'GET_TRAIN_INFO'; // exact speed only if the provider returns a verified field
      confidence = 0.8;
    } else if (/\btimetable\b|\btime\s*table\b|\bschedule\b|\broute\b|\bstops?\b|kaha kaha (ruk|rukti)/i.test(lower)) {
      intent = 'GET_TIMETABLE';
      confidence = 0.85;
    } else if ((/\b(baare|bare|about|info|information|details)\b/i.test(lower) && slots.trainNumber) || (/\b(daily|roz)\b/i.test(lower) && /chalti|chalta|runs?/i.test(lower)) || (/\bclasses\b|kaunse class/i.test(lower) && (slots.trainNumber || /is train/i.test(lower)))) {
      intent = 'GET_TRAIN_INFO';
      confidence = 0.8;
    } else if (/\b(live|abhi|kaha|kahan|where|running|kahan hai|kitni late|late hai|chal rahi|next station|agla station)\b/i.test(lower) || (/status/i.test(lower) && !/pnr/i.test(lower))) {
      intent = 'LIVE_TRAIN_STATUS'; // orchestrator asks for the train number when none is known
      confidence = slots.trainNumber || input.conversation.selectedTrain ? 0.9 : 0.7;
    } else if (/cancel(l)?ed|cancel/i.test(lower) && (/train/i.test(lower) || slots.trainNumber !== null)) {
      intent = 'GET_CANCELLED_TRAINS';
      confidence = 0.85; // slots.trainNumber stays → "is 12014 cancelled?" gets an evidence check
    } else if ((/\b(seat|seats|available|availability|milegi|milega)\b/i.test(lower) || /\brac\b/i.test(lower) || (/\b(wl|waitlist|waiting list|kitni wl)\b/i.test(lower) && !/kya hota|matlab/i.test(lower)) || (/\b(cc|ec|sl|1a|2a|3a|3e|2s)\b/i.test(lower) && /\bhain?\b|\bmileg/i.test(lower) && !/fare|price|paisa|padega|padenge/i.test(lower) && (slots.trainNumber || input.conversation.selectedTrain))) && (slots.trainNumber || input.conversation.selectedTrain || /is (train|mein)/i.test(lower))) {
      intent = 'GET_AVAILABILITY';
      confidence = 0.85;
    } else if (/\b(fare|price|rate|paisa|paise)\b/i.test(lower) || (/\bkitn[ea]?\b/i.test(lower) && /\b(fare|ticket|ka)\b/i.test(lower) && !/seat/i.test(lower) && slots.travelClass)) {
      intent = 'GET_FARE';
      confidence = 0.85;
    } else if (/meri|my/i.test(lower) && /ticket|booking|bookings|history/i.test(lower)) {
      intent = 'VIEW_BOOKINGS';
      confidence = 0.9;
    } else if (/\bwallet\b|\bbalance\b/i.test(lower)) {
      intent = 'VIEW_WALLET';
      confidence = 0.9;
    } else if ((slots.trainNumber && slots.secondTrainNumber) || (/\b(better|compare|vs|versus|kaunsi|konsi)\b/i.test(lower) && slots.trainNumber && slots.secondTrainNumber) || (/\b(fastest|sabse tez|jaldi pahunch|sabse jaldi|pehle\s+[a-z]+\s+pahunch|earliest\s+(arrival|departure)|shortest|longest|sabse\s+kam\s+samay|sabse\s+zyada\s+(samay|time|der)|zyada\s+time\s+lagat|sabse\s+dheere|slowest|latest\s+departure)\w*/i.test(lower) && (input.conversation.lastSearchResults?.length ?? 0) >= 2)) {
      intent = 'COMPARE_TRAINS';
      confidence = 0.9;
    } else if (isGlossaryQuestion(lower) && !slots.trainNumber && !/station code|code kya|ka code/i.test(lower)) {
      intent = 'GENERAL_RAILWAY_QUERY'; // glossaryTerm may be null → restricted knowledge capability handles it
      confidence = slots.glossaryTerm ? 0.9 : 0.7;
    } else if (/\bhelp\b|kya kya kar/i.test(lower)) {
      intent = 'HELP';
      confidence = 0.9;
    } else if (/\bstation code\b|\bcode kya\b/i.test(lower) && slots.mentionedStations.length > 0) {
      intent = 'LOOKUP_STATION';
      confidence = 0.85;
    } else if (/\bkitni?\s+trains?\s+hain\b|\bkitne\s+train\b/i.test(lower) && !/cancel/i.test(lower)) {
      // "Kal kitni trains hain?" → TRAIN SEARCH (never cancelled without explicit cancel words)
      intent = 'BOOK_TRAIN';
      confidence = 0.8;
    } else if (isJourneyIntent(lower) && (stations.origin || stations.destination)) {
      intent = /book/i.test(lower) || /ticket|chahiye/i.test(lower) ? 'BOOK_TRAIN' : 'BOOK_TRAIN';
      confidence = 0.8;
      if (!stations.origin) missing.push('origin');
      if (!stations.destination) missing.push('destination');
      if (!slots.dateText) missing.push('journeyDate');
    } else if (isJourneyIntent(lower) && !stations.origin && !stations.destination) {
      // "Kal jaana hai" — continuation of an existing journey conversation
      intent = 'BOOK_TRAIN';
      confidence = 0.6;
    } else if (isSlotFillerOnly(message)) {
      intent = 'UNKNOWN';
      confidence = 0.7; // slot-filler — orchestrator resolves against pending question
    } else if (/\b(weather|mausam|cricket|movie|film|song|gaana|joke|chutkula|politics|share market|stock)\b/i.test(lower)) {
      intent = 'NORMAL_CHAT'; // off-scope small talk — politely declined, no tools
      confidence = 0.9;
    }

    return Promise.resolve(resolve({ intent, confidence, slots, missing }));
  }

  generateResponse(input: AIReplyInput): Promise<AIReplyResult> {
    // Deterministic replies are built by the orchestrator's template layer; the
    // provider returns the pending question when one exists, else a neutral ack.
    const pending = input.conversation.pendingQuestion;
    return Promise.resolve({ message: pending ?? 'Theek hai — aur kuch jaanna hai?', askForField: null });
  }
}

interface IntentDraft {
  intent: Intent;
  confidence: number;
  slots: AIUnderstandingResult['slots'];
  missing: ContextSlotField[];
}

function resolve(draft: IntentDraft): AIUnderstandingResult {
  return {
    intent: draft.intent,
    confidence: draft.confidence,
    slots: draft.slots,
    missingFields: draft.missing,
    toolRequest: null,
  };
}

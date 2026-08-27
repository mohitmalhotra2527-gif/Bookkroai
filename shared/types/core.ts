/** Core conversation contracts — the backbone of multi-turn, interruptible AI conversations. */

import type { Intent } from './intent.js';
import type { Station, Train, TrainSearchResult, TravelClassCode } from './railway.js';
import type { ToolName } from './tools.js';
import type { PassengerDetail } from './booking.js';
import type { BookingStage } from '../bookingFlow.js';
import type { QuotaCode } from './railway.js';
import type { Availability, Fare } from './railway.js';

export interface User {
  id: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  preferredLanguage: string;
  createdAt: string;
}

export type ConversationRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  intent: Intent | null;
  toolName: ToolName | null;
}

/** Slot fields filled progressively over multiple turns (journey details etc.). */
export type ContextSlotField =
  | 'origin'
  | 'destination'
  | 'journeyDate'
  | 'passengerCount'
  | 'selectedTrain'
  | 'selectedClass'
  | 'passengerName'
  | 'passengerAge'
  | 'passengerGender'
  | 'passengerBerth';

/** Pending station-choice disambiguation ("Delhi" matched several stations). */
export interface StationChoicePending {
  field: ContextSlotField; // 'origin' | 'destination'
  options: readonly Station[];
  askedAt: string;
}

/** Audit entry recorded when the user CORRECTS an already-filled slot. */
export interface ContextCorrection {
  field: ContextSlotField;
  previousValue: unknown;
  newValue: unknown;
  correctedAt: string;
}

/**
 * Snapshot of an in-flight booking saved when the user interrupts the flow
 * (e.g. asks "12014 ka live status batao" mid-booking). The orchestrator can
 * restore it later so "Kal jaana hai" resumes the original booking context.
 */
export interface PausedBookingSnapshot {
  pausedAtStage: BookingStage;
  pausedAt: string;
  reason: 'USER_INTERRUPTION' | 'SERVER_REQUESTED';
  slots: PausedBookingSlots;
  lastSearchResults: readonly TrainSearchResult[] | null;
  pendingQuestion: string | null;
}

export interface PausedBookingSlots {
  origin: Station | null;
  destination: Station | null;
  journeyDate: string | null;
  passengerCount: number | null;
  selectedTrain: Train | null;
  selectedClass: TravelClassCode | null;
}

export interface ConversationContext {
  id: string;
  userId: string;

  // ── journey slots (multi-turn memory) ──
  origin: Station | null;
  destination: Station | null;
  journeyDate: string | null;
  passengerCount: number | null;
  selectedTrain: Train | null;
  selectedClass: TravelClassCode | null;
  selectedQuota: QuotaCode | null;
  lastSearchResults: readonly TrainSearchResult[] | null;

  // ── conversation state ──
  lastAskedField: ContextSlotField | null;
  bookingStage: BookingStage;
  lastIntent: Intent | null;
  lastTool: ToolName | null;
  pendingQuestion: string | null;

  // ── interrupt/resume foundation ──
  userCorrections: readonly ContextCorrection[];
  pausedBooking: PausedBookingSnapshot | null;

  // ── Step 4: pending station disambiguation ──
  stationChoices: StationChoicePending | null;

  // ── Step 5: conversational booking flow ──
  /** Collected passenger details (name/age/gender/berth), one at a time. */
  passengers: readonly PassengerDetail[];
  /** In-progress passenger being collected. */
  passengerDraft: PassengerDetail | null;
  /** Last VERIFIED availability for the current selection (invalidated on any change). */
  lastAvailability: Availability | null;
  /** Last VERIFIED fare quote for the current selection (invalidated on any change). */
  lastFareQuote: Fare | null;
  /** Compact envelope of the last executed tool ({success, tool, provider, error, timestamp} — no raw payloads, no secrets). */
  lastToolResult: { success: boolean; tool: string; provider: string | null; error: string | null; timestamp: string } | null;
  /** Most recently DISCUSSED train (result-detail answers, data follow-ups) — "uska fare?" resolves here. */
  lastReferencedTrain: Train | null;
  /** A "fastest/kaunsi" clause awaiting the search that was blocked on a missing date. */
  pendingFastestHint: boolean;

  // ── transcript ──
  messages: readonly ConversationMessage[];

  createdAt: string;
  updatedAt: string;
}

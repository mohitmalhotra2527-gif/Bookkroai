/**
 * DETERMINISTIC RAILWAY TOOL EXECUTORS — the only bridge between the Tool
 * Registry and the RailwayProviderRouter (Step 2). All execution is
 * server-side; the AI layer can request these tools but never execute them.
 * ProviderResult → normalized ToolResult mapping happens here.
 */

import type {
  AvailabilityQuery,
  CancelledTrainsQuery,
  FareQuery,
  LiveStatusQuery,
  PNRQuery,
  ProviderResult,
  QuotaCode,
  StationLookupQuery,
  Timetable,
  Train,
  TrainRefQuery,
  TrainSearchQuery,
  TrainSearchResult,
  TravelClassCode,
} from '../../shared/index.js';
import { isZeroResult } from '../../shared/index.js';
import type { ToolCall, ToolResult } from '../../shared/index.js';
import type { RailwayProviderRouter } from '../../railway/index.js';
import type { ToolExecutionContext, ToolExecutor } from '../registry.js';
import { toolFailure, toolSuccess } from '../results.js';

function callOf(context: ToolExecutionContext, tool: ToolCall['tool']): { id: string | null; tool: string } {
  return { id: context.call?.id ?? null, tool };
}

function mapProviderFailure(call: { id: string | null; tool: string }, result: ProviderResult<never>): ToolResult<never> {
  if (!result.ok) {
    if (result.error.kind === 'INVALID_INPUT') {
      return toolFailure(call, 'INVALID_RAILWAY_QUERY', result.error.message);
    }
    if (result.error.kind === 'UNSUPPORTED_CAPABILITY' || result.error.kind === 'NOT_IMPLEMENTED') {
      return toolFailure(call, 'RAILWAY_CAPABILITY_UNSUPPORTED', result.error.message);
    }
    // Honest, user-safe failure — no internal details, no fabricated data.
    return toolFailure(
      call,
      'RAILWAY_DATA_UNAVAILABLE',
      'Railway data is currently unavailable (provider failure or missing credentials).',
    );
  }
  return toolFailure(call, 'RAILWAY_DATA_UNAVAILABLE', 'Railway data is currently unavailable.');
}

function mapResult<T>(call: { id: string | null; tool: string }, result: ProviderResult<T>): ToolResult<T | null> {
  if (result.ok) {
    const provider = result.source ? result.source.toLowerCase() : null;
    if (isZeroResult(result)) {
      return {
        callId: call.id,
        tool: call.tool,
        ok: true,
        data: null,
        unavailableReason: result.emptyReason === 'NOT_FOUND' ? 'NOT_FOUND' : 'NO_RESULTS',
        error: null,
        executedBy: 'SERVER',
        provider,
      };
    }
    return { ...toolSuccess(call, result.data), provider };
  }
  return mapProviderFailure(call, result as ProviderResult<never>);
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function numberInput(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function createRailwayToolExecutors(router: RailwayProviderRouter): Record<string, ToolExecutor> {
  return {
    lookupStation: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'lookupStation');
      const query: StationLookupQuery = { query: stringInput(input, 'query') ?? '' };
      return mapResult(call, await router.stationLookup(query));
    },

    searchTrains: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'searchTrains');
      const query: TrainSearchQuery = {
        originCode: (stringInput(input, 'originCode') ?? '').toUpperCase(),
        destinationCode: (stringInput(input, 'destinationCode') ?? '').toUpperCase(),
        journeyDate: stringInput(input, 'journeyDate'),
      };
      void numberInput(input, 'passengerCount');
      return mapResult<TrainSearchResult[]>(call, await router.trainSearch(query));
    },

    getTrainInfo: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getTrainInfo');
      const query: TrainRefQuery = { trainNumber: stringInput(input, 'trainNumber') ?? '' };
      return mapResult<Train>(call, await router.trainInfo(query));
    },

    getTimetable: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getTimetable');
      const query: TrainRefQuery = { trainNumber: stringInput(input, 'trainNumber') ?? '' };
      return mapResult<Timetable>(call, await router.timetable(query));
    },

    getLiveStatus: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getLiveStatus');
      const query: LiveStatusQuery = {
        trainNumber: stringInput(input, 'trainNumber') ?? '',
        journeyDate: stringInput(input, 'journeyDate'),
      };
      return mapResult(call, await router.liveStatus(query));
    },

    getAvailability: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getAvailability');
      const travelClass = stringInput(input, 'travelClass')?.toUpperCase() as TravelClassCode | undefined;
      const query: AvailabilityQuery = {
        trainNumber: stringInput(input, 'trainNumber') ?? '',
        journeyDate: stringInput(input, 'journeyDate') ?? '',
        travelClass: travelClass ?? null,
        quota: (stringInput(input, 'quota')?.toUpperCase() as QuotaCode | undefined) ?? null,
        fromStationCode: stringInput(input, 'fromStationCode')?.toUpperCase() ?? null,
        toStationCode: stringInput(input, 'toStationCode')?.toUpperCase() ?? null,
      };
      return mapResult(call, await router.availability(query));
    },

    getFare: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getFare');
      const travelClass = stringInput(input, 'travelClass')?.toUpperCase() as TravelClassCode | undefined;
      const query: FareQuery = {
        trainNumber: stringInput(input, 'trainNumber') ?? '',
        fromStationCode: stringInput(input, 'fromStationCode')?.toUpperCase() ?? null,
        toStationCode: stringInput(input, 'toStationCode')?.toUpperCase() ?? null,
        journeyDate: stringInput(input, 'journeyDate'),
        travelClass: travelClass ?? null,
        quota: (stringInput(input, 'quota')?.toUpperCase() as QuotaCode | undefined) ?? null,
      };
      return mapResult(call, await router.fare(query));
    },

    checkPNR: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'checkPNR');
      const query: PNRQuery = { pnr: stringInput(input, 'pnr') ?? '' };
      return mapResult(call, await router.pnr(query));
    },

    getCancelledTrains: async (input, ctx): Promise<ToolResult> => {
      const call = callOf(ctx, 'getCancelledTrains');
      const query: CancelledTrainsQuery = { journeyDate: stringInput(input, 'journeyDate') ?? '' };
      return mapResult(call, await router.cancelledTrains(query));
    },
  };
}

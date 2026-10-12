import {
  BootstrapStatic,
  ElementType,
  Fixture,
  ManagerEntry,
  ManagerHistory,
  ManagerPicks,
  Player,
  SquadPick,
} from './types';
import { effectivePosition } from './utils';

const API_BASE = '/api/fpl';

export class FplApiError extends Error {
  readonly status: number | null;
  readonly path: string;

  constructor(message: string, path: string, status: number | null = null) {
    super(message);
    this.name = 'FplApiError';
    this.status = status;
    this.path = path;
  }
}

async function getJSON<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: 'application/json' },
    });
  } catch (cause) {
    // Network-level failure: the dev server may not be running, or offline.
    throw new FplApiError(
      'Could not reach the FPL Pilot server. Is it running?',
      path,
      null
    );
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // Response was not JSON; the status text is the best we have.
    }
    throw new FplApiError(`FPL request failed (${response.status}): ${detail}`, path, response.status);
  }

  return (await response.json()) as T;
}

/**
 * Fetch the season bootstrap.
 *
 * NOTE: the FPL API returns its players under `elements`, not `players`. Reading
 * `bootstrap.players` yields `undefined` and silently blanks the whole app.
 */
export async function fetchBootstrapStatic(): Promise<BootstrapStatic> {
  const data = await getJSON<BootstrapStatic>('/bootstrap-static/');

  if (!Array.isArray(data?.elements) || data.elements.length === 0) {
    throw new FplApiError('Bootstrap payload contained no players', '/bootstrap-static/');
  }
  if (!Array.isArray(data?.teams) || data.teams.length === 0) {
    throw new FplApiError('Bootstrap payload contained no teams', '/bootstrap-static/');
  }

  return data;
}

export async function fetchFixtures(): Promise<Fixture[]> {
  const data = await getJSON<Fixture[]>('/fixtures/');
  if (!Array.isArray(data)) {
    throw new FplApiError('Fixtures payload was not an array', '/fixtures/');
  }
  return data;
}

export async function fetchManagerEntry(managerId: number): Promise<ManagerEntry> {
  const data = await getJSON<ManagerEntry>(`/entry/${managerId}/`);
  if (typeof data?.id !== 'number') {
    throw new FplApiError(`No FPL team found with ID ${managerId}`, `/entry/${managerId}/`, 404);
  }
  return data;
}

export async function fetchManagerPicks(managerId: number, event: number): Promise<ManagerPicks> {
  const data = await getJSON<ManagerPicks>(`/entry/${managerId}/event/${event}/picks/`);
  if (!Array.isArray(data?.picks)) {
    throw new FplApiError(
      `Picks for gameweek ${event} were unavailable`,
      `/entry/${managerId}/event/${event}/picks/`
    );
  }
  return data;
}

export async function fetchManagerHistory(managerId: number): Promise<ManagerHistory> {
  return getJSON<ManagerHistory>(`/entry/${managerId}/history/`);
}

export async function purgeFPLCache(): Promise<void> {
  const response = await fetch(`${API_BASE}/purge-cache`, { method: 'POST' });
  if (!response.ok) throw new FplApiError('Failed to purge cache', '/purge-cache');
}

/**
 * The gameweek to plan for: the first one that has not finished.
 *
 * Using `events[events.length - 1]` gives gameweek 38 for the whole season, which
 * silently plans every recommendation around fixtures that are months away.
 */
export function resolveNextEvent(bootstrap: BootstrapStatic): number {
  const upcoming = bootstrap.events.find((event) => !event.finished);
  if (upcoming) return upcoming.id;

  // Season complete — advise on the last gameweek that was actually played.
  const played = [...bootstrap.events].reverse().find((event) => event.finished);
  return played?.id ?? bootstrap.events[bootstrap.events.length - 1]?.id ?? 1;
}

/** The gameweek currently being played, for context labels. */
export function resolveCurrentEvent(bootstrap: BootstrapStatic): number {
  const flagged = bootstrap.events.find((event) => event.is_current);
  if (flagged) return flagged.id;
  const played = [...bootstrap.events].reverse().find((event) => event.finished);
  return played?.id ?? 1;
}

/** A manager's squad for the most recent gameweek that returns picks. */
export async function fetchLatestSquadPicks(
  managerId: number,
  startEvent: number
): Promise<{ picks: ManagerPicks; event: number }> {
  for (let event = startEvent; event >= 1; event--) {
    try {
      const picks = await fetchManagerPicks(managerId, event);
      return { picks, event };
    } catch (error) {
      // A manager who joined mid-season has no picks for early gameweeks, so
      // keep walking backwards. Only a server-side failure ends the search —
      // retrying it 38 times would just hammer a broken upstream.
      if (error instanceof FplApiError && error.status !== null && error.status < 500) {
        continue;
      }
      if (error instanceof FplApiError && error.status === null) throw error;
    }
  }

  throw new FplApiError(
    `No squad could be loaded for team ${managerId}. Check the ID in your FPL account settings.`,
    `/entry/${managerId}/event/${startEvent}/picks/`,
    404
  );
}

export interface ManagerSnapshot {
  entry: ManagerEntry;
  picks: ManagerPicks;
  /** Gameweek the picks were taken from. */
  event: number;
  /** All squad members resolved against the bootstrap player list. */
  squad: Player[];
  /** The XI the manager is currently fielding (picks with a multiplier). */
  currentXI: Player[];
  captainId: number | null;
  viceCaptainId: number | null;
  /** Unspent funds, in tenths of a million. */
  bank: number;
  /** Transfers already made this gameweek; more will cost a hit. */
  transfersMadeThisEvent: number;
  activeChip: string | null;
}

/** Resolve a pick list into players, preserving multiplier information. */
function resolvePicks(
  picks: SquadPick[],
  playersById: Map<number, Player>
): { player: Player; pick: SquadPick }[] {
  const resolved: { player: Player; pick: SquadPick }[] = [];
  for (const pick of picks) {
    const player = playersById.get(pick.element);
    if (player) resolved.push({ player, pick });
  }
  return resolved;
}

/**
 * Load everything the app needs about one manager: entry, squad, XI, bank and
 * armbands, all resolved against a known player list.
 */
export async function loadManagerSnapshot(
  managerId: number,
  players: Player[]
): Promise<ManagerSnapshot> {
  const playersById = new Map(players.map((player) => [player.id, player]));

  const entry = await fetchManagerEntry(managerId);
  const { picks, event } = await fetchLatestSquadPicks(managerId, entry.current_event);

  const resolved = resolvePicks(picks.picks, playersById);
  if (resolved.length === 0) {
    throw new FplApiError(
      `Team ${managerId} returned picks we could not match to any player. The FPL data may have just rolled over.`,
      `/entry/${managerId}/event/${event}/picks/`
    );
  }

  const squad = resolved.map((item) => item.player);
  const currentXI = resolved
    .filter((item) => item.pick.multiplier > 0)
    .map((item) => item.player);

  const captain = resolved.find((item) => item.pick.multiplier === 2);
  const vice = resolved.find((item) => item.pick.multiplier === 3);

  // `is_captain` is the authoritative flag; fall back to the multiplier.
  const captainId =
    resolved.find((item) => item.pick.is_captain)?.player.id ?? captain?.player.id ?? null;
  const viceCaptainId =
    resolved.find((item) => item.pick.is_vice_captain)?.player.id ?? vice?.player.id ?? null;

  return {
    entry,
    picks,
    event,
    squad,
    currentXI: currentXI.length >= 11 ? currentXI : squad.slice(0, 11),
    captainId,
    viceCaptainId,
    bank: picks.entry_history.bank,
    transfersMadeThisEvent: picks.entry_history.event_transfers,
    activeChip: picks.active_chip,
  };
}

/** Group a player list by effective position, preserving relative order. */
export function groupByPosition(players: Player[]): Record<ElementType, Player[]> {
  const groups: Record<ElementType, Player[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const player of players) groups[effectivePosition(player)].push(player);
  return groups;
}
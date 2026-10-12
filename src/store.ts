import { create } from 'zustand';
import {
  BootstrapStatic,
  ChipAdvice,
  Fixture,
  FixtureRun,
  Formation,
  GameEvent,
  LineupAdvice,
  Player,
  Team,
  TransferPlan,
  TransferSuggestion,
  XPtsWeights,
  DEFAULT_XPTS_WEIGHTS,
} from './types';
import {
  TeamIndex,
  buildLineupAdvice,
  buildTransferPlans,
  getChipAdvice,
  getFixtureRuns,
  rankTransferOptions,
} from './engine';
import { indexTeams, indexUpcomingFixtures } from './utils';
import { ManagerSnapshot } from './api';

const MANAGER_ID_KEY = 'fpl-pilot:manager-id';
const WEIGHTS_KEY = 'fpl-pilot:xpts-weights';
const FORMATION_KEY = 'fpl-pilot:forced-formation';

export type LoadStatus = 'idle' | 'loading-season' | 'loading-manager' | 'ready' | 'error';

function readStorage<T>(key: string, parse: (raw: string) => T | null, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Reject anything that would let a corrupt value break the model. */
function parseWeights(raw: string): XPtsWeights | null {
  try {
    const value = JSON.parse(raw) as Partial<XPtsWeights>;
    const keys = Object.keys(DEFAULT_XPTS_WEIGHTS) as (keyof XPtsWeights)[];
    const result = { ...DEFAULT_XPTS_WEIGHTS };
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        result[key] = Math.min(1, Math.max(0, candidate));
      }
    }
    return result;
  } catch {
    return null;
  }
}

function parseFormation(raw: string): Formation | null {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.length !== 4) return null;
    const formation = value.map(Number);
    if (formation.some((n) => !Number.isInteger(n) || n < 1)) return null;
    const total = formation.reduce((a, b) => a + b, 0);
    return total === 11 ? (formation as Formation) : null;
  } catch {
    return null;
  }
}

/** Normalise the tunable weights so they always sum to 1. */
export function normaliseWeights(weights: XPtsWeights): XPtsWeights {
  const total =
    weights.form +
    weights.underlyingMetrics +
    weights.fdr +
    weights.homeAwayBoost +
    weights.availability;

  if (total <= 0) return { ...DEFAULT_XPTS_WEIGHTS };

  return {
    form: weights.form / total,
    underlyingMetrics: weights.underlyingMetrics / total,
    fdr: weights.fdr / total,
    homeAwayBoost: weights.homeAwayBoost / total,
    availability: weights.availability / total,
  };
}

export interface AppState {
  // --- Season data -------------------------------------------------------
  players: Player[];
  teams: Team[];
  fixtures: Fixture[];
  events: GameEvent[];
  /** The live gameweek (context/labels). */
  currentEvent: number;
  /** The gameweek being planned for — drives every fixture lookup. */
  nextEvent: number;
  teamsMap: TeamIndex;
  /** Sorted upcoming fixtures per team; always starts at `nextEvent`. */
  upcomingFixtures: Map<number, Fixture[]>;

  // --- Manager -----------------------------------------------------------
  managerId: string | null;
  managerEntry: import('./types').ManagerEntry | null;
  squad: Player[];
  currentXI: Player[];
  captainId: number | null;
  viceCaptainId: number | null;
  /** Tenths of a million. */
  bank: number;
  activeChip: string | null;
  transfersMadeThisEvent: number;

  // --- Advice ------------------------------------------------------------
  lineup: LineupAdvice | null;
  captainRationale: string;
  transferOptions: TransferSuggestion[];
  transferPlans: TransferPlan[];
  chipAdvice: ChipAdvice[];
  fixtureRuns: FixtureRun[];

  // --- UI ----------------------------------------------------------------
  status: LoadStatus;
  error: string | null;
  selectedPlayer: Player | null;
  weights: XPtsWeights;
  forcedFormation: Formation | null;

  // --- Actions -----------------------------------------------------------
  loadSeason: (bootstrap: BootstrapStatic, fixtures: Fixture[], nextEvent: number, currentEvent: number) => void;
  loadManager: (snapshot: ManagerSnapshot) => void;
  resetManager: () => void;
  recompute: () => void;
  setStatus: (status: LoadStatus) => void;
  setError: (error: string | null) => void;
  selectPlayer: (player: Player | null) => void;
  setWeights: (weights: XPtsWeights) => void;
  resetWeights: () => void;
  setForcedFormation: (formation: Formation | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  players: [],
  teams: [],
  fixtures: [],
  events: [],
  currentEvent: 1,
  nextEvent: 1,
  teamsMap: new Map(),
  upcomingFixtures: new Map(),

  managerId: readStorage(MANAGER_ID_KEY, (raw) => raw, null),
  managerEntry: null,
  squad: [],
  currentXI: [],
  captainId: null,
  viceCaptainId: null,
  bank: 0,
  activeChip: null,
  transfersMadeThisEvent: 0,

  lineup: null,
  captainRationale: '',
  transferOptions: [],
  transferPlans: [],
  chipAdvice: [],
  fixtureRuns: [],

  status: 'idle',
  error: null,
  selectedPlayer: null,
  weights: readStorage(WEIGHTS_KEY, parseWeights, { ...DEFAULT_XPTS_WEIGHTS }),
  forcedFormation: readStorage(FORMATION_KEY, parseFormation, null),

  loadSeason: (bootstrap, fixtures, nextEvent, currentEvent) => {
    const teamsMap = indexTeams(bootstrap.teams);
    set({
      players: bootstrap.elements,
      teams: bootstrap.teams,
      fixtures,
      events: bootstrap.events,
      currentEvent,
      nextEvent,
      teamsMap,
      // Sorted, filtered to unplayed fixtures — reading index 0 of the raw
      // payload would hand back an arbitrary already-played fixture.
      upcomingFixtures: indexUpcomingFixtures(fixtures, nextEvent),
    });
    get().recompute();
  },

  loadManager: (snapshot) => {
    set({
      managerId: String(snapshot.entry.id),
      managerEntry: snapshot.entry,
      squad: snapshot.squad,
      currentXI: snapshot.currentXI,
      captainId: snapshot.captainId,
      viceCaptainId: snapshot.viceCaptainId,
      bank: snapshot.bank,
      activeChip: snapshot.activeChip,
      transfersMadeThisEvent: snapshot.transfersMadeThisEvent,
      status: 'ready',
      error: null,
    });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MANAGER_ID_KEY, String(snapshot.entry.id));
    }
    get().recompute();
  },

  resetManager: () => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(MANAGER_ID_KEY);
    set({
      managerId: null,
      managerEntry: null,
      squad: [],
      currentXI: [],
      captainId: null,
      viceCaptainId: null,
      bank: 0,
      activeChip: null,
      transfersMadeThisEvent: 0,
      lineup: null,
      transferOptions: [],
      transferPlans: [],
      chipAdvice: [],
      selectedPlayer: null,
    });
  },

  /**
   * Re-run the whole model. Called whenever weights, formation, squad, or season
   * data change, so the pitch and the advice can never disagree.
   */
  recompute: () => {
    const state = get();
    const { squad, players, teamsMap, upcomingFixtures, nextEvent, weights } = state;

    if (squad.length < 11 || players.length === 0) {
      set({ lineup: null, transferOptions: [], transferPlans: [], chipAdvice: [] });
      return;
    }

    // Only one free transfer per gameweek, less any already spent.
    const freeTransfers = Math.max(0, 1 - state.transfersMadeThisEvent);

    const lineup = buildLineupAdvice({
      squad,
      currentXI: state.currentXI.length >= 11 ? state.currentXI : squad.slice(0, 11),
      currentCaptainId: state.captainId,
      currentViceCaptainId: state.viceCaptainId,
      teamsMap,
      fixturesByTeam: upcomingFixtures,
      currentEvent: nextEvent,
      weights,
      forcedFormation: state.forcedFormation,
      freeTransfers,
      activeChip: state.activeChip,
    });

    const transferContext = {
      squad,
      allPlayers: players,
      bank: state.bank,
      teamsMap,
      fixturesByTeam: upcomingFixtures,
      weights,
      freeTransfers,
    };

    const transferOptions = rankTransferOptions(transferContext, 15);
    const transferPlans = buildTransferPlans(transferContext, transferOptions, 3);

    const chipAdvice = getChipAdvice({
      currentEvent: nextEvent,
      squad,
      xi: lineup.starters,
      captain: lineup.captain,
      teamsMap,
      fixturesByTeam: upcomingFixtures,
      weights,
    });

    set({
      lineup,
      captainRationale: (lineup as LineupAdvice & { captainRationale?: string }).captainRationale ?? '',
      transferOptions,
      transferPlans,
      chipAdvice,
      fixtureRuns: getFixtureRuns(state.teams, upcomingFixtures, 5),
    });
  },

  setStatus: (status) => set({ status }),
  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),
  selectPlayer: (player) => set({ selectedPlayer: player }),

  setWeights: (weights) => {
    const normalised = normaliseWeights(weights);
    set({ weights: normalised });
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(WEIGHTS_KEY, JSON.stringify(normalised));
    }
    get().recompute();
  },

  resetWeights: () => get().setWeights({ ...DEFAULT_XPTS_WEIGHTS }),

  setForcedFormation: (formation) => {
    set({ forcedFormation: formation });
    if (typeof localStorage !== 'undefined') {
      if (formation) localStorage.setItem(FORMATION_KEY, JSON.stringify(formation));
      else localStorage.removeItem(FORMATION_KEY);
    }
    get().recompute();
  },
}));
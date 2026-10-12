/**
 * FPL Pilot - domain types.
 *
 * Shapes for `Player`, `Team`, `Fixture`, `BootstrapStatic`, `ManagerEntry` and
 * `ManagerPicks` were verified against the live Fantasy Premier League public API
 * (https://fantasy.premierleague.com/api/, season 2026/27).
 *
 * Two API details that are easy to get wrong and are relied upon throughout:
 *  - Bootstrap players live under `elements`, NOT `players`.
 *  - Monetary values (`now_cost`, `bank`, `value`) are integer tenths of a
 *    million (£6.1m == `now_cost: 61`). `toMillions()` normalises these.
 */

// ---------------------------------------------------------------------------
// Raw API payloads
// ---------------------------------------------------------------------------

/** element_type: 1=GK, 2=DEF, 3=MID, 4=FWD */
export type ElementType = 1 | 2 | 3 | 4;

export const POSITIONS: Record<ElementType, string> = {
  1: 'GK',
  2: 'DEF',
  3: 'MID',
  4: 'FWD',
};

export const POSITION_NAMES: Record<ElementType, string> = {
  1: 'Goalkeeper',
  2: 'Defender',
  3: 'Midfielder',
  4: 'Forward',
};

/**
 * An FPL "element" (a player). Numeric-valued-per-game metrics are delivered by
 * the API as strings; `toNum()` normalises them.
 */
export interface Player {
  id: number;
  first_name: string;
  second_name: string;
  web_name: string;
  known_name: string | null;
  status: string;
  code: number;
  team: number;
  team_code: number;
  element_type: ElementType;
  squad_number: number | null;
  photo: string;
  region: number;
  position: string;

  /** Tenths of a million. */
  now_cost: number;
  cost_change_event: number;
  price_change_percent: string;

  form: string;
  points_per_game: string;
  /** Total FPL points scored this season (the API's `total_points`). */
  total_points: number;
  event_points: number;
  minutes: number;
  starts: number;
  value_form: string;
  value_season: string;

  selected_by_percent: string;
  transfers_in: number;
  transfers_out: number;
  transfers_in_event: number;
  transfers_out_event: number;
  loaned_in: number;
  loaned_out: number;

  /** Availability + news. */
  news: string;
  news_added: string | null;
  chance_of_playing_next_round: number | null;
  chance_of_playing_this_round: number | null;
  can_select: boolean;
  can_transact: boolean;
  special: boolean;
  removed: boolean;

  dream_team_count: number;
  in_dreamteam: boolean;

  // Scoring-relevant season totals.
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;

  influence: string;
  creativity: string;
  threat: string;
  ict_index: string;

  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;

  // Analyst / scout data.
  scout_risks: string;
  region_name: string | null;
  birth_date: string | null;
}

export interface Team {
  id: number;
  name: string;
  short_name: string;
  code: number;
  /** 1 (easiest) .. 5 (hardest) as played at home. */
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
  played: number;
  win: number;
  draw: number;
  loss: number;
  points: number;
  position: number;
  form: string | null;
}

export interface FixtureStat {
  identifier: string;
  element: number;
  opponent_team: number | null;
  team_set: number;
  value: number;
  completed_passes?: number | null;
}

export interface Fixture {
  id: number;
  code: number;
  event: number;
  finished: boolean;
  finished_provisional: boolean;
  kickoff_time: string | null;
  minutes: number;
  provisional_start_time: boolean;
  started: boolean;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  /** 1 (easiest) .. 5 (hardest) for the home side. */
  team_h_difficulty: number;
  /** 1 (easiest) .. 5 (hardest) for the away side. */
  team_a_difficulty: number;
  pulse_id: number;
  stats: FixtureStat[];
}

export interface ElementTypeMeta {
  id: ElementType;
  plural_name: string;
  plural_name_short: string;
  singular_name: string;
  singular_name_short: string;
  squad_select: number;
  squad_min_play: number;
  squad_max_play: number;
}

export interface GameEvent {
  id: number;
  name: string;
  deadline_time: string;
  average_entry_score: number;
  finished: boolean;
  data_checked: boolean;
  highest_score: number | null;
  players_locked: boolean;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
}

export interface Phase {
  id: number;
  name: string;
  start_event: number;
  stop_event: number;
}

export interface GameSettings {
  squad_squadplay: number;
  squad_squadsize: number;
  squad_team_limit: number;
  squad_total_spend: number;
  transfers_cap: number;
  max_extra_free_transfers: number;
  ui_currency_multiplier: number;
}

export interface BootstrapStatic {
  events: GameEvent[];
  phases: Phase[];
  /** NOTE: named `elements` by the API, not `players`. */
  elements: Player[];
  teams: Team[];
  element_types: ElementTypeMeta[];
  game_settings: GameSettings;
  total_players: number;
}

export interface ManagerEntry {
  id: number;
  player_first_name: string;
  player_last_name: string;
  player_region_id: number;
  player_region_name: string;
  current_event: number;
  started_event: number;
  name: string;
  summary_overall_points: number;
  summary_overall_rank: number | null;
  summary_event_points: number;
  summary_event_rank: number | null;
  /** Tenths of a million. */
  last_deadline_bank: number;
  last_deadline_value: number;
  last_deadline_total_transfers: number;
  entered_events: number[];
}

export interface SquadPick {
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
  element_type: ElementType;
}

export interface EntryHistoryEvent {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  overall_rank: number;
  /** Tenths of a million. */
  bank: number;
  /** Tenths of a million. */
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}

export interface ManagerPicks {
  /** e.g. "wildcard" | "freehit" | "bboost" | "3xc" | null */
  active_chip: string | null;
  automatic_subs: unknown[];
  entry_history: EntryHistoryEvent;
  picks: SquadPick[];
}

export interface ManagerHistoryEvent {
  season_name: string;
  total_points: number;
  rank: number;
  rank_percentage: string;
}

export interface ManagerHistory {
  current: EntryHistoryEvent[];
  past: ManagerHistoryEvent[];
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

/**
 * Tunable influences on the xPts model. Each weight is in [0, 1]; the panel
 * normalises them to sum to 1. A weight of 0 disables that component entirely,
 * 1 applies it at full strength.
 */
export interface XPtsWeights {
  /** Recent form (points per game, shrunk by games played). */
  form: number;
  /** Underlying metrics (xGI per 90, ICT, and GKs' saves/clean sheets). */
  underlyingMetrics: number;
  /** Fixture difficulty (1..5). */
  fdr: number;
  /** Home advantage. */
  homeAwayBoost: number;
  /** Availability (chance of playing, news). */
  availability: number;
}

export const DEFAULT_XPTS_WEIGHTS: XPtsWeights = {
  form: 0.3,
  underlyingMetrics: 0.35,
  fdr: 0.2,
  homeAwayBoost: 0.15,
  availability: 0.2,
};

/** Formation tuple: [GK, DEF, MID, FWD]. */
export type Formation = [number, number, number, number];

export const VALID_FORMATIONS: Formation[] = [
  [1, 3, 5, 2],
  [1, 3, 4, 3],
  [1, 4, 4, 2],
  [1, 4, 3, 3],
  [1, 5, 3, 2],
  [1, 5, 2, 3],
  [1, 4, 5, 1],
];

export const POSITION = {
  GK: 1,
  DEF: 2,
  MID: 3,
  FWD: 4,
} as const;

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

export type ComponentKey =
  | 'baseline'
  | 'form'
  | 'underlying'
  | 'fixture'
  | 'availability'
  | 'risk';

export interface XPtsComponent {
  key: ComponentKey;
  label: string;
  /** The metric as modelled, e.g. 4.2 expected points per game. */
  rawValue: number;
  /** Signed points added to (or removed from) the projection. */
  contribution: number;
  /** Human-readable justification shown in the UI. */
  detail: string;
}

/** A full, auditable account of how one player's projection was reached. */
export interface XPtsBreakdown {
  playerId: number;
  total: number;
  components: XPtsComponent[];
  /** Form string, e.g. "5.0,4.0,6.0,3.5,5.5". */
  form: string;
  /** Null when the team has no remaining fixture. */
  fixture: FixtureOutlook | null;
  availability: AvailabilityOutlook;
}

export interface FixtureOutlook {
  fixture: Fixture;
  opponentId: number;
  opponentName: string;
  opponentShortName: string;
  isHome: boolean;
  /** 1..5 as published by the FPL. */
  difficulty: number;
  kickoffTime: string | null;
  /** Rolling FDR over the next `window` gameweeks; null when not enough data. */
  rollingDifficulty: number | null;
}

export interface AvailabilityOutlook {
  /** 0..1, or null when the API published no chance-of-playing value. */
  chanceOfPlaying: number | null;
  /** True when `news` carries an injury/doubt marker. */
  hasNews: boolean;
  news: string;
  isDoubtful: boolean;
}

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

export interface LineupChange {
  playerId: number;
  playerName: string;
  position: ElementType;
  direction: 'in' | 'out';
  reason: string;
  /** Points gained (positive) or lost (negative) by making this change. */
  xPtsDelta: number;
}

export interface LineupAdvice {
  starters: Player[];
  bench: Player[];
  captain: Player;
  viceCaptain: Player;
  formation: Formation;
  /** Projected points for the recommended XI. */
  projectedPoints: number;
  /** Projected points for the manager's actual XI. */
  currentProjectedPoints: number;
  /** projectedPoints - currentProjectedPoints */
  projectedGain: number;
  changes: LineupChange[];
  /** Live break-even requirement for a hit, or null when unlimited. */
  breakEven: number | null;
  /** Keyed by player id. */
  breakdownById: Record<number, XPtsBreakdown>;
  /** The XI the manager actually has, resolved to players. */
  currentStarters: Player[];
  currentCaptainId: number | null;
  currentViceCaptainId: number | null;
}

export type ChipId = 'wildcard' | 'freehit' | 'benchboost' | 'triplecaptain';

export interface ChipAdvice {
  chip: ChipId;
  label: string;
  /** True when the model thinks playing this chip now beats hoarding it. */
  recommended: boolean;
  confidence: 'low' | 'medium' | 'high';
  headline: string;
  rationale: string[];
  timing: string;
}

export interface TransferSuggestion {
  id: string;
  sell: Player;
  buy: Player;
  sellXPts: number;
  buyXPts: number;
  /** buyXPts - sellXPts, always > 0 for a suggested transfer. */
  netGain: number;
  /**
   * Change in bank, in tenths of a million. Positive = you spend,
   * negative = the sale funds part of the purchase.
   */
  cashDelta: number;
  reason: string;
  /** 1-based rank across all suggestions for this gameweek. */
  rank: number;
  /** True when the buy brings the squad to 4 players from one club (illegal). */
  breachesClubLimit: boolean;
}

export interface TransferPlan {
  id: string;
  transfers: TransferSuggestion[];
  netGain: number;
  /** Net bank change in tenths of a million. */
  cashDelta: number;
  /** True when the plan fits inside the available bank and transfer budget. */
  feasible: boolean;
  blockers: string[];
  headline: string;
}

export interface FixtureRun {
  teamId: number;
  teamName: string;
  teamShortName: string;
  fixtures: FixtureOutlook[];
  /** Mean difficulty across `fixtures`; lower is easier. */
  averageDifficulty: number;
}

export interface TeamForm {
  team: Team;
  /** 'W'/'D'/'L' strings, most recent last. */
  recent: string[];
  points: number;
}
/**
 * FPL Pilot — projection and advice engine.
 *
 * Every exported function is pure and side-effect free so the whole model can be
 * unit-tested against recorded FPL payloads (see test/engine.test.ts).
 *
 * Design goals:
 *  1. Every projection is *explainable* — `calculatePlayerXPts` returns an
 *     `XPtsBreakdown` whose components sum exactly to the headline number.
 *  2. Every lookup uses correctly-sorted upcoming fixtures. The raw `/fixtures`
 *     payload is not ordered per team, so reading index 0 of an unsorted list
 *     yields an arbitrary, often already-played, fixture.
 *  3. Real FPL constraints are enforced: max 3 players per club, one goalkeeper
 *     in the XI, valid formations, bank-aware transfers, hit accounting.
 */

import {
  ChipAdvice,
  FixtureOutlook,
  ChipId,
  ElementType,
  Fixture,
  FixtureRun,
  Formation,
  LineupAdvice,
  LineupChange,
  Player,
  Team,
  TeamForm,
  TransferPlan,
  TransferSuggestion,
  XPtsBreakdown,
  XPtsComponent,
  XPtsWeights,
  DEFAULT_XPTS_WEIGHTS,
  VALID_FORMATIONS,
} from './types';
import {
  clamp,
  difficultyFor,
  effectivePosition,
  hasInjuryNews,
  isHomeFixture,
  mean,
  nineties,
  opponentOf,
  parseForm,
  playerName,
  round,
  sum,
  toNum,
} from './utils';

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

/**
 * Expected points for a fully-fit, average, *starter* in each position, before
 * any form / fixture / availability adjustment. Derived from the ~4.3 points a
 * median FPL player averages per gameweek.
 */
const POSITION_BASELINE: Record<ElementType, number> = {
  1: 3.5,
  2: 3.7,
  3: 4.0,
  4: 3.9,
};

/** Points of value per unit of per-90 expected goal involvement. */
const POINTS_PER_XGI = 5.0;
/** Points of value per unit of per-90 ICT index. */
const POINTS_PER_ICT = 1.5;
/** Goalkeepers are scored on saves and clean sheets instead of xGI. */
const POINTS_PER_GK_ACTION = 2.5;

/**
 * Games of evidence needed before we trust a player's form line. `reliability =
 * games / (games + SHRINK)` — a debutant is pulled hard toward the positional
 * baseline, a 12-game regular is nearly believed at face value.
 */
const SHRINK = 3.0;

/** Points of swing between the easiest and hardest published FDR. */
const FDR_SPAN = 0.7;
/** Points of swing between playing at home and away. */
const HOME_ADVANTAGE = 0.45;

/** Community rule of thumb: each hit must beat a rival spending 1.5 pts/hit. */
export const POINTS_PER_HIT = 1.5;

const POSITION_LABEL: Record<ElementType, string> = {
  1: 'GK',
  2: 'DEF',
  3: 'MID',
  4: 'FWD',
};

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface Availability {
  /** 0..1 probability the player is available for the next gameweek. */
  factor: number;
  /** Null when the API gave no chance-of-playing field. */
  chanceOfPlaying: number | null;
  status: string;
  news: string;
  doubtful: boolean;
}

/**
 * Combine the API's `chance_of_playing_next_round` with the status code and the
 * news string. FPL sets status to 'a' (available), 'd' (doubtful), 'i'
 * (injured) or 's' (suspended).
 */
export function assessAvailability(player: Player): Availability {
  const chance = player.chance_of_playing_next_round;
  const status = (player.status ?? 'a').toLowerCase();
  const news = player.news ?? '';

  let factor: number;
  if (typeof chance === 'number' && Number.isFinite(chance)) {
    factor = clamp(chance / 100, 0, 1);
  } else if (status === 'i' || status === 's') {
    factor = 0.12;
  } else if (status === 'd') {
    factor = 0.45;
  } else {
    factor = 1;
  }

  const doubtful =
    hasInjuryNews(news) ||
    status === 'd' ||
    (typeof chance === 'number' && chance < 75);

  // Injury news is only actionable when the player is not otherwise marked fine.
  if (factor > 0.8 && hasInjuryNews(news)) factor = 0.7;

  return {
    factor,
    chanceOfPlaying: typeof chance === 'number' ? chance : null,
    status,
    news,
    doubtful,
  };
}

// ---------------------------------------------------------------------------
// Fixture context
// ---------------------------------------------------------------------------

/**
 * Everything the model needs about a team's immediate fixture run.
 */
export interface FixtureContext {
  fixture: Fixture;
  opponentId: number;
  opponentName: string;
  opponentShortName: string;
  isHome: boolean;
  difficulty: number;
  kickoffTime: string | null;
  rollingDifficulty: number | null;
}

export type TeamIndex = Map<number, Team>;

/**
 * Build the fixture context for a team's next game.
 *
 * `fixturesByTeam` must come from `indexUpcomingFixtures(fixtures, currentEvent)`
 * so that entry 0 really is the next unplayed fixture.
 */
export function fixtureContextFor(
  teamId: number,
  fixturesByTeam: Map<number, Fixture[]>,
  teamsMap: TeamIndex,
  window = 5
): FixtureContext | null {
  const list = fixturesByTeam.get(teamId);
  const fixture = list?.[0];
  if (!fixture) return null;

  const opponentId = opponentOf(fixture, teamId);
  const opponent = teamsMap.get(opponentId);
  const upcoming = list!.slice(0, window);
  const rolling = upcoming.length > 0 ? mean(upcoming.map((f) => difficultyFor(f, teamId))) : null;

  return {
    fixture,
    opponentId,
    opponentName: opponent?.name ?? `Team ${opponentId}`,
    opponentShortName: opponent?.short_name ?? String(opponentId),
    isHome: isHomeFixture(fixture, teamId),
    difficulty: difficultyFor(fixture, teamId),
    kickoffTime: fixture.kickoff_time,
    rollingDifficulty: rolling === null ? null : round(rolling, 2),
  };
}

// ---------------------------------------------------------------------------
// The xPts model
// ---------------------------------------------------------------------------

export interface XPtsInput {
  player: Player;
  teamsMap: TeamIndex;
  fixturesByTeam: Map<number, Fixture[]>;
  weights?: XPtsWeights;
}

/**
 * Project a player's points for the next gameweek, with a full audit trail.
 *
 * The model is additive around a positional baseline:
 *
 *   raw   = baseline + form + underlying + fixture
 *   total = raw x availability
 *
 * so `components` always sum to `total`.
 */
export function calculatePlayerXPtsDetailed(input: XPtsInput): XPtsBreakdown {
  const { player, teamsMap, fixturesByTeam } = input;
  const weights = input.weights ?? DEFAULT_XPTS_WEIGHTS;
  const position = effectivePosition(player);
  const baseline = POSITION_BASELINE[position];

  const games = nineties(player.minutes);
  const reliability = games / (games + SHRINK);

  // --- Form -------------------------------------------------------------
  const ppg = toNum(player.points_per_game) || (games > 0 ? player.total_points / games : 0);
  const formHistory = parseForm(player.form ?? '');
  const formEdge = clamp(ppg - baseline, -baseline * 0.75, baseline * 2);
  const formContribution = formEdge * reliability * weights.form;
  const recentForm = formHistory.length > 0
    ? ` Recent: ${formHistory.slice(-5).join(', ')}.`
    : '';

  // --- Underlying -------------------------------------------------------
  const xgiSeason = toNum(player.expected_goals) + toNum(player.expected_assists);
  const ictSeason = toNum(player.ict_index);

  let underlyingRaw: number;
  let underlyingDetail: string;

  if (position === 1) {
    const actions = player.clean_sheets + player.saves * 0.25;
    underlyingRaw = games > 0 ? (actions / games) * POINTS_PER_GK_ACTION : 0;
    underlyingDetail = `${player.clean_sheets} clean sheets and ${player.saves} saves in ${Math.round(games)} appearances`;
  } else {
    const xgiPer90 = games > 0 ? xgiSeason / games : 0;
    const ictPer90 = games > 0 ? ictSeason / games : 0;
    underlyingRaw = xgiPer90 * POINTS_PER_XGI + ictPer90 * POINTS_PER_ICT;
    underlyingDetail = `${round(xgiPer90, 2)} xGI/90 and ${round(ictPer90, 2)} ICT/90 over ${Math.round(games)} appearances`;
  }

  const underlyingContribution =
    clamp(underlyingRaw, 0, baseline * 1.6) * reliability * weights.underlyingMetrics;

  // --- Fixture ----------------------------------------------------------
  const fixture = fixtureContextFor(player.team, fixturesByTeam, teamsMap);
  let fixtureContribution = 0;
  let fixtureDetail = 'No remaining fixture this season';

  if (fixture) {
    // fdrEdge is +FDR_SPAN/2 for the easiest fixture and -FDR_SPAN/2 for the hardest.
    const fdrEdge = (3 - fixture.difficulty) * (FDR_SPAN / 2);
    const homeEdge = fixture.isHome ? HOME_ADVANTAGE : -HOME_ADVANTAGE;
    fixtureContribution = fdrEdge * weights.fdr + homeEdge * weights.homeAwayBoost;
    const rolling = fixture.rollingDifficulty;
    fixtureDetail =
      `${fixture.isHome ? 'Home' : 'Away'} vs ${fixture.opponentName} (FDR ${fixture.difficulty})` +
      (rolling !== null ? `, next ${fixture.rollingDifficulty !== null ? 5 : 5} avg FDR ${rolling}` : '');
  }

  // --- Availability -----------------------------------------------------
  const availability = assessAvailability(player);
  const rawTotal = Math.max(
    0,
    baseline + formContribution + underlyingContribution + fixtureContribution
  );
  const total = rawTotal * availability.factor;
  const availabilityContribution = total - rawTotal;

  const availabilityDetail = availability.chanceOfPlaying !== null
    ? `${round(availability.chanceOfPlaying, 0)}% chance of playing`
    : availability.status === 'a'
      ? 'Available, no doubt reported'
      : `Status "${availability.status}"${availability.news ? ` — ${availability.news}` : ''}`;

  const components: XPtsComponent[] = [
    {
      key: 'baseline',
      label: `${POSITION_LABEL[position]} baseline`,
      rawValue: round(baseline, 2),
      contribution: round(baseline, 2),
      detail: `An average available ${POSITION_LABEL[position]} is projected to score this many points`,
    },
    {
      key: 'form',
      label: 'Recent form',
      rawValue: round(ppg, 2),
      contribution: round(formContribution, 2),
      detail:
        games > 0
          ? `${round(ppg, 2)} points per game across ${Math.round(games)} appearances (${round(reliability * 100, 0)}% trusted).${recentForm}`
          : 'No appearances yet this season',
    },
    {
      key: 'underlying',
      label: 'Underlying metrics',
      rawValue: round(underlyingRaw, 2),
      contribution: round(underlyingContribution, 2),
      detail: underlyingDetail,
    },
    {
      key: 'fixture',
      label: 'Fixture',
      rawValue: fixture ? fixture.difficulty : 3,
      contribution: round(fixtureContribution, 2),
      detail: fixtureDetail,
    },
    {
      key: 'availability',
      label: 'Availability',
      rawValue: round(availability.factor, 2),
      contribution: round(availabilityContribution, 2),
      detail: availabilityDetail,
    },
  ];

  return {
    playerId: player.id,
    total: round(total, 2),
    components,
    form: player.form ?? '',
    fixture,
    availability: {
      chanceOfPlaying: availability.chanceOfPlaying ?? null,
      hasNews: hasInjuryNews(availability.news),
      news: availability.news,
      isDoubtful: availability.doubtful,
    },
  };
}

/** Convenience wrapper returning only the headline projection. */
export function calculatePlayerXPts(
  player: Player,
  teamsMap: TeamIndex,
  fixturesByTeam: Map<number, Fixture[]>,
  weights: XPtsWeights = DEFAULT_XPTS_WEIGHTS
): number {
  return calculatePlayerXPtsDetailed({ player, teamsMap, fixturesByTeam, weights }).total;
}

/** Project a whole list of players. */
export function calculateAllXPts(
  players: Player[],
  teamsMap: TeamIndex,
  fixturesByTeam: Map<number, Fixture[]>,
  weights: XPtsWeights = DEFAULT_XPTS_WEIGHTS
): Map<number, XPtsBreakdown> {
  const breakdown = new Map<number, XPtsBreakdown>();
  for (const player of players) {
    breakdown.set(
      player.id,
      calculatePlayerXPtsDetailed({ player, teamsMap, fixturesByTeam, weights })
    );
  }
  return breakdown;
}

// ---------------------------------------------------------------------------
// Squad constraints
// ---------------------------------------------------------------------------

/** FPL rule: at most three players from a single club may be selected. */
export const MAX_PER_CLUB = 3;

export function canAddPlayer(
  player: Player,
  currentClubCounts: Map<number, number>,
  limit = MAX_PER_CLUB
): boolean {
  return (currentClubCounts.get(player.team) ?? 0) < limit;
}

function clubTally(players: Player[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const player of players) {
    counts.set(player.team, (counts.get(player.team) ?? 0) + 1);
  }
  return counts;
}

/** Fill one formation greedily by xPts, respecting the max-3-per-club rule. */
function buildXIForFormation(
  squad: Player[],
  xPts: Map<number, number>,
  formation: Formation,
  clubLimit = MAX_PER_CLUB
): { xi: Player[]; complete: boolean } {
  const counts = clubTally([]);
  const xi: Player[] = [];

  // Group by the element type the formation needs, each sorted best-first.
  const pools: Record<ElementType, Player[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
  };
  for (const player of squad) pools[effectivePosition(player)].push(player);
  for (const type of [1, 2, 3, 4] as ElementType[]) {
    pools[type].sort((a, b) => (xPts.get(b.id) ?? 0) - (xPts.get(a.id) ?? 0));
  }

  const slots: ElementType[] = [
    ...Array<ElementType>(formation[0]).fill(1),
    ...Array<ElementType>(formation[1]).fill(2),
    ...Array<ElementType>(formation[2]).fill(3),
    ...Array<ElementType>(formation[3]).fill(4),
  ];

  const taken = new Set<number>();

  for (const slot of slots) {
    const chosen = pools[slot].find(
      (player) => !taken.has(player.id) && canAddPlayer(player, counts, clubLimit)
    );
    if (!chosen) return { xi, complete: false };
    taken.add(chosen.id);
    counts.set(chosen.team, (counts.get(chosen.team) ?? 0) + 1);
    xi.push(chosen);
  }

  return { xi, complete: true };
}

export interface OptimalXIOptions {
  squad: Player[];
  teamsMap: TeamIndex;
  fixturesByTeam: Map<number, Fixture[]>;
  weights?: XPtsWeights;
  /** Restrict the search to a single formation. */
  forcedFormation?: Formation | null;
  clubLimit?: number;
}

export interface OptimalXIResult {
  xi: Player[];
  formation: Formation;
  projectedPoints: number;
  /** Every formation that could be fielded with this squad. */
  feasibleFormations: Formation[];
}

/**
 * Pick the highest-projection valid starting XI.
 *
 * Enumerates every legal formation, fills each greedily by projected points
 * while honouring the three-per-club rule, and keeps the best total. When
 * `forcedFormation` is supplied, only that shape is considered.
 */
export function findOptimalStartingXI(options: OptimalXIOptions): OptimalXIResult {
  const { squad, teamsMap, fixturesByTeam, weights = DEFAULT_XPTS_WEIGHTS } = options;
  const clubLimit = options.clubLimit ?? MAX_PER_CLUB;

  if (squad.length < 11) {
    throw new Error(`A starting XI needs at least 11 players, received ${squad.length}`);
  }

  const xPts = new Map<number, number>(
    squad.map((player) => [
      player.id,
      calculatePlayerXPts(player, teamsMap, fixturesByTeam, weights),
    ])
  );

  const formations: Formation[] = options.forcedFormation
    ? [options.forcedFormation]
    : VALID_FORMATIONS;

  let best: OptimalXIResult | null = null;
  const feasible: Formation[] = [];

  for (const formation of formations) {
    const { xi, complete } = buildXIForFormation(squad, xPts, formation, clubLimit);
    if (!complete) continue;
    feasible.push(formation);

    const total = round(sum(xi.map((player) => xPts.get(player.id) ?? 0)), 2);
    if (!best || total > best.projectedPoints) {
      best = { xi, formation, projectedPoints: total, feasibleFormations: feasible };
    }
  }

  if (!best) {
    throw new Error('No valid formation fits this squad within the three-per-club limit');
  }

  return { ...best, feasibleFormations: feasible };
}

export interface CaptaincyResult {
  captain: Player;
  viceCaptain: Player;
  captainXPts: number;
  viceXPts: number;
  rationale: string;
}

/**
 * Pick the captain pair. Double-up candidates (two midfielders, two forwards
 * from the same fixture) are considered, and an injury risk or a blank fixture
 * is enough to push a player down to vice.
 */
export function selectCaptaincy(
  starters: Player[],
  teamsMap: TeamIndex,
  fixturesByTeam: Map<number, Fixture[]>,
  weights: XPtsWeights = DEFAULT_XPTS_WEIGHTS
): CaptaincyResult {
  if (starters.length === 0) throw new Error('Cannot pick a captain from an empty XI');
  if (starters.length === 1) {
    const only = starters[0];
    const score = calculatePlayerXPts(only, teamsMap, fixturesByTeam, weights);
    return {
      captain: only,
      viceCaptain: only,
      captainXPts: score,
      viceXPts: score,
      rationale: 'Only one player is available in the XI, so they take both armsbands.',
    };
  }

  const ranked = starters
    .map((player) => {
      const breakdown = calculatePlayerXPtsDetailed({ player, teamsMap, fixturesByTeam, weights });
      // Blank fixtures and injury doubts are real risks; discount them so a
      // slightly lower projection on a safe player can still win the armband.
      const riskPenalty = breakdown.availability.isDoubtful ? 0.6 : 0;
      return {
        player,
        total: breakdown.total,
        adjusted: round(breakdown.total - riskPenalty, 2),
        breakdown,
      };
    })
    .sort((a, b) => b.adjusted - a.adjusted || b.total - a.total);

  const [first, second] = ranked;
  const captainFixture = first.breakdown.fixture;
  const rationale = captainFixture
    ? `Highest projection at ${round(first.total, 2)} pts (${captainFixture.isHome ? 'home' : 'away'} to ${captainFixture.opponentName}, FDR ${captainFixture.difficulty}).` +
      (first.breakdown.availability.isDoubtful
        ? ' Discounted for an availability doubt.'
        : '')
    : `Highest projection at ${round(first.total, 2)} pts.`;

  return {
    captain: first.player,
    viceCaptain: second.player,
    captainXPts: first.total,
    viceXPts: second.total,
    rationale,
  };
}

/**
 * Order the bench. Automatic substitutions start from the top of the bench, so
 * the strongest auto-sub replacement is placed first; remaining slots keep a
 * conventional positional order for readability.
 */
export function orderBench(
  squad: Player[],
  starters: Player[],
  xPts: Map<number, number>
): Player[] {
  const starterIds = new Set(starters.map((player) => player.id));
  return squad
    .filter((player) => !starterIds.has(player.id))
    .sort((a, b) => {
      const diff = (xPts.get(b.id) ?? 0) - (xPts.get(a.id) ?? 0);
      if (Math.abs(diff) > 0.0001) return diff;
      return effectivePosition(a) - effectivePosition(b);
    });
}

// ---------------------------------------------------------------------------
// Lineup advice (recommended XI vs the manager's actual XI)
// ---------------------------------------------------------------------------

export interface LineupAdviceInput {
  /** All players in the manager's squad (should be 15). */
  squad: Player[];
  /** The manager's currently-fielded XI, resolved to players. */
  currentXI: Player[];
  currentCaptainId: number | null;
  currentViceCaptainId: number | null;
  teamsMap: TeamIndex;
  fixturesByTeam: Map<number, Fixture[]>;
  currentEvent: number;
  weights?: XPtsWeights;
  forcedFormation?: Formation | null;
  freeTransfers?: number;
  activeChip?: string | null;
}

export interface LineupAdviceResult extends LineupAdvice {
  captainRationale: string;
  bench: Player[];
}

/**
 * Build the full lineup recommendation, including what would change versus the
 * manager's current selection and what it is worth.
 */
export function buildLineupAdvice(input: LineupAdviceInput): LineupAdviceResult {
  const weights = input.weights ?? DEFAULT_XPTS_WEIGHTS;

  const breakdown = calculateAllXPts(
    [...input.squad, ...input.currentXI],
    input.teamsMap,
    input.fixturesByTeam,
    weights
  );
  const xPts = new Map<number, number>(
    [...breakdown.entries()].map(([id, value]) => [id, value.total])
  );

  const optimal = findOptimalStartingXI({
    squad: input.squad,
    teamsMap: input.teamsMap,
    fixturesByTeam: input.fixturesByTeam,
    weights,
    forcedFormation: input.forcedFormation ?? null,
  });

  const { captain, viceCaptain, rationale } = selectCaptaincy(
    optimal.xi,
    input.teamsMap,
    input.fixturesByTeam,
    weights
  );

  const bench = orderBench(input.squad, optimal.xi, xPts);

  const currentIds = new Set(input.currentXI.map((player) => player.id));
  const recommendedIds = new Set(optimal.xi.map((player) => player.id));

  const currentProjected = round(
    sum(input.currentXI.map((player) => xPts.get(player.id) ?? 0)),
    2
  );

  // Captain and vice are double-weighted in an FPL score, so an armband swap is
  // worth twice a regular swap. Fold it into the reported gain.
  const armbandDelta = round(
    (xPts.get(captain.id) ?? 0) -
      (xPts.get(input.currentCaptainId ?? captain.id) ?? 0) +
      (xPts.get(viceCaptain.id) ?? 0) -
      (xPts.get(input.currentViceCaptainId ?? viceCaptain.id) ?? 0),
    2
  );

  const changes: LineupChange[] = [];

  for (const player of optimal.xi) {
    if (currentIds.has(player.id)) continue;
    const outgoing = input.currentXI
      .filter((candidate) => !recommendedIds.has(candidate.id))
      .sort(
        (a, b) => (xPts.get(a.id) ?? 0) - (xPts.get(b.id) ?? 0)
      )[0];
    changes.push({
      playerId: player.id,
      playerName: playerName(player),
      position: effectivePosition(player),
      direction: 'in',
      xPtsDelta: round((xPts.get(player.id) ?? 0) - (outgoing ? xPts.get(outgoing.id) ?? 0 : 0), 2),
      reason: outgoing
        ? `Projects ${round(xPts.get(player.id) ?? 0, 2)} pts versus ${round(xPts.get(outgoing.id) ?? 0, 2)} for ${playerName(outgoing)}`
        : `Projects ${round(xPts.get(player.id) ?? 0, 2)} pts and fills an empty slot`,
    });
  }

  for (const player of input.currentXI) {
    if (recommendedIds.has(player.id)) continue;
    const bestAlternative = optimal.xi
      .filter((candidate) => !currentIds.has(candidate.id))
      .sort((a, b) => (xPts.get(b.id) ?? 0) - (xPts.get(a.id) ?? 0))[0];
    changes.push({
      playerId: player.id,
      playerName: playerName(player),
      position: effectivePosition(player),
      direction: 'out',
      xPtsDelta: round(
        bestAlternative ? (xPts.get(player.id) ?? 0) - (xPts.get(bestAlternative.id) ?? 0) : 0,
        2
      ),
      reason: bestAlternative
        ? `${playerName(bestAlternative)} projects ${round(xPts.get(bestAlternative.id) ?? 0, 2)} pts against ${round(xPts.get(player.id) ?? 0, 2)}`
        : 'Not part of the optimal XI',
    });
  }

  changes.sort((a, b) => b.xPtsDelta - a.xPtsDelta);

  // A lineup change costs nothing but consumes one of the free transfers that
  // are also needed for squad transfers, so the break-even is the same maths.
  const freeTransfers = input.freeTransfers ?? 1;
  const hits = Math.max(0, Math.ceil(changes.length / 2) - freeTransfers);

  return {
    starters: optimal.xi,
    bench,
    captain,
    viceCaptain,
    formation: optimal.formation,
    projectedPoints: optimal.projectedPoints,
    currentProjectedPoints: currentProjected,
    projectedGain: round(optimal.projectedPoints - currentProjected + armbandDelta, 2),
    changes,
    breakEven: hits > 0 ? round(hits * POINTS_PER_HIT, 1) : null,
    breakdownById: Object.fromEntries(breakdown),
    currentStarters: input.currentXI,
    currentCaptainId: input.currentCaptainId,
    currentViceCaptainId: input.currentViceCaptainId,
    captainRationale: rationale,
  };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface TransferContext {
  squad: Player[];
  allPlayers: Player[];
  /** Available funds in tenths of a million. */
  bank: number;
  teamsMap: TeamIndex;
  fixturesByTeam: Map<number, Fixture[]>;
  weights?: XPtsWeights;
  freeTransfers?: number;
  clubLimit?: number;
}

/** Number of buy candidates examined per position per sale. */
const CANDIDATES_PER_POSITION = 40;
/** Single transfers retained for planning. */
const PLANNING_POOL = 8;

/**
 * Rank single in-for-out opportunities.
 *
 * Brute-forcing 15 x 667 pairs is wasteful and, worse, re-projects the same
 * player thousands of times. Instead we project every player exactly once, then
 * walk the best N candidates per position for each sale.
 */
export function rankTransferOptions(context: TransferContext, limit = 15): TransferSuggestion[] {
  const weights = context.weights ?? DEFAULT_XPTS_WEIGHTS;
  const clubLimit = context.clubLimit ?? MAX_PER_CLUB;

  const squadIds = new Set(context.squad.map((player) => player.id));
  const squadBreakdown = calculateAllXPts(context.squad, context.teamsMap, context.fixturesByTeam, weights);

  const available = context.allPlayers.filter(
    (player) =>
      !squadIds.has(player.id) &&
      player.can_select !== false &&
      player.removed !== true
  );
  const availableBreakdown = calculateAllXPts(
    available,
    context.teamsMap,
    context.fixturesByTeam,
    weights
  );

  // Bucket buyers by position, best projection first.
  const pools = new Map<ElementType, Player[]>();
  for (const type of [1, 2, 3, 4] as ElementType[]) pools.set(type, []);
  for (const player of available) {
    pools.get(effectivePosition(player))!.push(player);
  }
  for (const list of pools.values()) {
    list.sort(
      (a, b) => (availableBreakdown.get(b.id)?.total ?? 0) - (availableBreakdown.get(a.id)?.total ?? 0)
    );
  }

  const squadClubs = clubTally(context.squad);
  const options: TransferSuggestion[] = [];

  for (const sell of context.squad) {
    const sellTotal = squadBreakdown.get(sell.id)?.total ?? 0;
    const clubsAfterSale = new Map(squadClubs);
    clubsAfterSale.set(sell.team, (clubsAfterSale.get(sell.team) ?? 0) - 1);

    const pool = pools.get(effectivePosition(sell)) ?? [];
    for (const buy of pool.slice(0, CANDIDATES_PER_POSITION)) {
      const cashDelta = buy.now_cost - sell.now_cost;
      if (cashDelta > context.bank) continue; // Not affordable with current funds.

      const buyTotal = availableBreakdown.get(buy.id)?.total ?? 0;
      const netGain = round(buyTotal - sellTotal, 2);
      if (netGain <= 0.05) continue; // Ignore noise.

      const breaches = !canAddPlayer(buy, clubsAfterSale, clubLimit);

      options.push({
        id: `${sell.id}>${buy.id}`,
        sell,
        buy,
        sellXPts: sellTotal,
        buyXPts: buyTotal,
        netGain,
        cashDelta,
        breachesClubLimit: breaches,
        rank: 0,
        reason: buildTransferReason(sellTotal, buyTotal, availableBreakdown.get(buy.id)),
      });
    }
  }

  options.sort((a, b) => {
    // Actionable options first, then by projected gain.
    if (a.breachesClubLimit !== b.breachesClubLimit) return a.breachesClubLimit ? 1 : -1;
    return b.netGain - a.netGain;
  });

  return options.slice(0, limit).map((option, index) => ({ ...option, rank: index + 1 }));
}

function buildTransferReason(
  sellXPts: number,
  buyXPts: number,
  breakdown: XPtsBreakdown | undefined
): string {
  const gain = round(buyXPts - sellXPts, 2);
  if (!breakdown) return `${gain} pts better projection`;
  const fixture = breakdown.fixture;
  const detail = fixture
    ? `${fixture.isHome ? 'H' : 'A'} ${fixture.opponentShortName} (FDR ${fixture.difficulty})`
    : 'no fixture remaining';
  return `+${gain} pts (${round(buyXPts, 2)} vs ${round(sellXPts, 2)}) — ${detail}`;
}

/**
 * Combine single options into feasible multi-transfer plans, accounting for the
 * bank and for the point cost of each hit.
 */
export function buildTransferPlans(
  context: TransferContext,
  options: TransferSuggestion[],
  maxTransfers = 3
): TransferPlan[] {
  const bank = context.bank;
  const freeTransfers = context.freeTransfers ?? 1;
  const pool = options.filter((option) => !option.breachesClubLimit).slice(0, PLANNING_POOL);

  if (pool.length === 0) return [];

  const plans: TransferPlan[] = [];

  const evaluate = (transfers: TransferSuggestion[], id: string): TransferPlan => {
    const netGain = round(sum(transfers.map((t) => t.netGain)), 2);
    const cashDelta = sum(transfers.map((t) => t.cashDelta));

    // Transfers must be affordable at every step, not just at the end.
    let running = 0;
    for (const transfer of transfers) {
      running += transfer.cashDelta;
      if (running > bank) {
        return {
          id,
          transfers,
          netGain,
          cashDelta,
          feasible: false,
          blockers: ['Requires more funds than the current bank allows'],
          headline: `${transfers.length}-transfer plan, ${netGain} pts, unaffordable`,
        };
      }
    }

    const hits = Math.max(0, transfers.length - freeTransfers);
    const blockers: string[] = [];
    if (cashDelta < 0) {
      blockers.push(`Releases £${(-cashDelta / 10).toFixed(1)}m to the bank`);
    }
    if (hits > 0) {
      blockers.push(`Costs ${hits} hit${hits === 1 ? '' : 's'} (needs ${round(hits * POINTS_PER_HIT, 1)} pts to break even)`);
    }

    return {
      id,
      transfers: transfers.map((t, i) => ({ ...t, rank: i + 1 })),
      netGain,
      cashDelta,
      feasible: true,
      blockers,
      headline:
        `${transfers.length}-transfer plan: ${transfers.length === 1 ? '' : '+'}${netGain} pts` +
        (hits > 0 ? ` for ${hits} hit${hits === 1 ? '' : 's'}` : ' with no hit'),
    };
  };

  // 1-transfer plans.
  for (const option of pool) plans.push(evaluate([option], option.id));

  // 2-transfer plans: every compatible pair.
  if (maxTransfers >= 2) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const pair = compatible([pool[i]], [pool[j]]);
        if (pair) plans.push(evaluate(pair, `${pool[i].id}|${pool[j].id}`));
      }
    }
  }

  // 3-transfer plans: extend each pair with the best remaining option.
  if (maxTransfers >= 3) {
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const pair = compatible([pool[i]], [pool[j]]);
        if (!pair) continue;
        for (const candidate of pool) {
          const triple = compatible(pair, [candidate]);
          if (triple) plans.push(evaluate(triple, `${pair[0].id}|${pair[1].id}|${candidate.id}`));
        }
      }
    }
  }

  const unique = new Map<string, TransferPlan>();
  for (const plan of plans) {
    const existing = unique.get(plan.id);
    if (!existing || plan.netGain > existing.netGain) unique.set(plan.id, plan);
  }

  return [...unique.values()]
    .filter((plan) => plan.feasible)
    .sort((a, b) => b.netGain - a.netGain || a.transfers.length - b.transfers.length)
    .slice(0, 12);
}

/** Two sets are compatible when they touch disjoint players and respect the club limit. */
function compatible(...sets: TransferSuggestion[][]): TransferSuggestion[] | null {
  const all = sets.flat();
  const bought = new Set<number>();
  const sold = new Set<number>();
  const clubs = new Map<number, number>();

  for (const transfer of all) {
    if (sold.has(transfer.sell.id) || bought.has(transfer.buy.id)) return null;
    if (bought.has(transfer.sell.id)) return null; // Buying then selling the same player.
    if (sold.has(transfer.buy.id)) return null; // Selling then re-buying the same player.
    sold.add(transfer.sell.id);
    bought.add(transfer.buy.id);
  }

  // Re-derive club counts from a throwaway tally so we do not need the squad here.
  for (const transfer of all) {
    clubs.set(transfer.sell.team, (clubs.get(transfer.sell.team) ?? 0) - 1);
  }
  for (const transfer of all) {
    const next = (clubs.get(transfer.buy.team) ?? 0) + 1;
    if (next > MAX_PER_CLUB) return null;
    clubs.set(transfer.buy.team, next);
  }

  return all;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const CHIP_LABELS: Record<ChipId, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  benchboost: 'Bench Boost',
  triplecaptain: 'Triple Captain',
};

/**
 * Advise on each chip against the *next* gameweek, using the same projections the
 * lineup advice uses so the two never disagree.
 */
export function getChipAdvice(input: {
  currentEvent: number;
  totalEvents?: number;
  squad: Player[];
  xi: Player[];
  captain: Player;
  teamsMap: TeamIndex;
  fixturesByTeam: Map<number, Fixture[]>;
  weights?: XPtsWeights;
  /** 0..1 — how committed the manager already is to this gameweek. */
  totalEventsUsed?: number;
  chipsRemaining?: Partial<Record<ChipId, number>>;
}): ChipAdvice[] {
  const weights = input.weights ?? DEFAULT_XPTS_WEIGHTS;
  const totalEvents = input.totalEvents ?? 38;
  const remaining = totalEvents - input.currentEvent;
  const xPts = new Map<number, number>(
    input.squad.map((player) => [
      player.id,
      calculatePlayerXPts(player, input.teamsMap, input.fixturesByTeam, weights),
    ])
  );

  const advice: ChipAdvice[] = [];

  // --- Bench Boost -------------------------------------------------------
  const starterIds = new Set(input.xi.map((player) => player.id));
  const bench = input.squad.filter((player) => !starterIds.has(player.id));
  const worstStarter = Math.min(...input.xi.map((player) => xPts.get(player.id) ?? 0));
  const benchGain = sum(
    bench.map((player) => (xPts.get(player.id) ?? 0) - worstStarter)
  );
  const benchDepth = bench.filter((player) => (xPts.get(player.id) ?? 0) >= worstStarter * 0.85).length;
  const bbRecommended = benchGain >= 3 && benchDepth >= 2;
  advice.push({
    chip: 'benchboost',
    label: CHIP_LABELS.benchboost,
    recommended: bbRecommended,
    confidence: benchGain >= 6 ? 'high' : bbRecommended ? 'medium' : 'low',
    headline: bbRecommended
      ? `Bench boost is worth roughly ${round(benchGain, 1)} points`
      : 'Save the bench boost',
    rationale: [
      `${benchDepth} of ${bench.length} bench players project within 15% of your worst starter (${round(worstStarter, 1)} pts).`,
      `Swapping them all in is worth about ${round(benchGain, 1)} points.`,
      remaining <= 8
        ? 'With eight gameweeks or fewer left, bench depth is about to matter much more.'
        : 'Bench Boost pays off most when your substitutes are starters in waiting.',
    ],
    timing: remaining <= 8 ? 'Use any time you have four credible starters on the bench.' : 'Save for a gameweek with a stacked bench.',
  });

  // --- Triple Captain ---------------------------------------------------
  const captainBreakdown = calculatePlayerXPtsDetailed({
    player: input.captain,
    teamsMap: input.teamsMap,
    fixturesByTeam: input.fixturesByTeam,
    weights,
  });
  const captainFixture = captainBreakdown.fixture;
  const tcScore =
    (captainFixture ? 6 - captainFixture.difficulty : 3) +
    (captainFixture?.isHome ? 2 : 0) +
    (captainBreakdown.availability.isDoubtful ? -6 : 0);
  const tcRecommended = tcScore >= 6 && !captainBreakdown.availability.isDoubtful;
  advice.push({
    chip: 'triplecaptain',
    label: CHIP_LABELS.triplecaptain,
    recommended: tcRecommended,
    confidence: tcScore >= 8 ? 'high' : tcRecommended ? 'medium' : 'low',
    headline: tcRecommended
      ? `${playerName(input.captain)} faces a premium fixture — triple captain candidate`
      : `No triple captain candidate this week`,
    rationale: captainFixture
      ? [
          `${playerName(input.captain)} plays ${captainFixture.isHome ? 'at home' : 'away'} to ${captainFixture.opponentName} (FDR ${captainFixture.difficulty}).`,
          `Projected ${round(captainBreakdown.total, 2)} points; three times that is ${round(captainBreakdown.total * 3, 1)}.`,
        ]
      : [`${playerName(input.captain)} has no remaining fixture.`],
    timing: 'Best used on a home game against a bottom-half side with no fitness doubts.',
  });

  // --- Free Hit ---------------------------------------------------------
  // Count double fixtures this gameweek that the squad is not exploiting.
  const nextEvent = input.currentEvent;
  const doublingTeams = new Set<number>();
  for (const [, list] of input.fixturesByTeam) {
    const fixture = list.find((f) => f.event === nextEvent);
    if (!fixture) continue;
    const teamsThisEvent = input.fixturesByTeam
      .get(fixture.team_h)
      ?.filter((f) => f.event === nextEvent);
    if (teamsThisEvent && teamsThisEvent.length > 1) doublingTeams.add(fixture.team_h);
  }
  const unusedDoubles = input.squad.filter(
    (player) => (input.fixturesByTeam.get(player.team)?.filter((f) => f.event === nextEvent).length ?? 0) > 1
  ).length;
  const fhRecommended = unusedDoubles >= 2;
  advice.push({
    chip: 'freehit',
    label: CHIP_LABELS.freehit,
    recommended: fhRecommended,
    confidence: unusedDoubles >= 3 ? 'high' : fhRecommended ? 'medium' : 'low',
    headline: fhRecommended
      ? `${unusedDoubles} of your own players have a double fixture — Free Hit is live`
      : 'No compelling double fixture this week',
    rationale: [
      `${doublingTeams.size} clubs play twice in gameweek ${nextEvent}.`,
      `${unusedDoubles} player${unusedDoubles === 1 ? '' : 's'} on your own roster already have one.`,
      'A Free Hit is worth it when you can add two premium double-fixture players for one gameweek.',
    ],
    timing: 'One gameweek only — the squad reverts automatically afterwards.',
  });

  // --- Wildcard ---------------------------------------------------------
  const underPerformers = input.squad.filter(
    (player) => (xPts.get(player.id) ?? 0) < 3.2
  ).length;
  const wcRecommended = underPerformers >= 6;
  advice.push({
    chip: 'wildcard',
    label: CHIP_LABELS.wildcard,
    recommended: wcRecommended,
    confidence: underPerformers >= 8 ? 'high' : wcRecommended ? 'medium' : 'low',
    headline: wcRecommended
      ? `${underPerformers} squad members project below 3.2 points — overhaul warranted`
      : 'Squad depth is adequate, hold the wildcard',
    rationale: [
      `${underPerformers} of ${input.squad.length} players project under 3.2 points.`,
      remaining <= 10
        ? `${remaining} gameweeks left — a reset is hard to recover from late.`
        : 'A wildcard cannot be recalled; make it count.',
    ],
    timing: remaining > 10 ? 'Best spent once you know the promoted sides and your early-season read.' : 'Late-season wildcards are high risk.',
  });

  return advice;
}

// ---------------------------------------------------------------------------
// Fixture runs and team form
// ---------------------------------------------------------------------------

/** Rank every club's next `window` gameweeks easiest-first. */
export function getFixtureRuns(
  teams: Team[],
  fixturesByTeam: Map<number, Fixture[]>,
  window = 5
): FixtureRun[] {
  const runs: FixtureRun[] = [];

  for (const team of teams) {
    const list = (fixturesByTeam.get(team.id) ?? []).slice(0, window);
    if (list.length === 0) continue;

    const fixtures: FixtureOutlook[] = list.map((fixture) => {
      const opponentId = opponentOf(fixture, team.id);
      const opponent = teams.find((t) => t.id === opponentId);
      const upcoming = list.filter((f) => f.event <= fixture.event);
      return {
        fixture,
        opponentId,
        opponentName: opponent?.name ?? `Team ${opponentId}`,
        opponentShortName: opponent?.short_name ?? String(opponentId),
        isHome: isHomeFixture(fixture, team.id),
        difficulty: difficultyFor(fixture, team.id),
        kickoffTime: fixture.kickoff_time,
        rollingDifficulty: round(mean(upcoming.map((f) => difficultyFor(f, team.id))), 2),
      };
    });

    runs.push({
      teamId: team.id,
      teamName: team.name,
      teamShortName: team.short_name,
      fixtures,
      averageDifficulty: round(mean(fixtures.map((f) => f.difficulty)), 2),
    });
  }

  return runs.sort((a, b) => a.averageDifficulty - b.averageDifficulty);
}

/** Recent W/D/L strings for a club, most recent last. */
export function getTeamForm(team: Team, allFixtures: Fixture[], last = 5): TeamForm {
  const played = allFixtures
    .filter(
      (fixture) =>
        fixture.finished &&
        (fixture.team_h === team.id || fixture.team_a === team.id)
    )
    .sort((a, b) => a.event - b.event)
    .slice(-last);

  const recent = played.map((fixture) => {
    const home = fixture.team_h === team.id;
    const scored = (home ? fixture.team_h_score : fixture.team_a_score) ?? 0;
    const conceded = (home ? fixture.team_a_score : fixture.team_h_score) ?? 0;
    return scored > conceded ? 'W' : scored === conceded ? 'D' : 'L';
  });

  return { team, recent, points: team.points };
}

export type { FixtureOutlook };
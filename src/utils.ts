import { ElementType, Player, Team, Fixture } from './types';

/**
 * Parse an FPL numeric string field. The API returns most ratios as strings and
 * may return `null` for a not-yet-computed value; both collapse to 0.
 */
export function toNum(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The API expresses every money value in tenths of a million, and expresses some
 * of them (entry history `bank`, `value`) differently across endpoints. These
 * helpers keep the tenths convention in one place.
 */
export function toMillions(tenths: number): number {
  return tenths / 10;
}

export function tenthsFromMillions(millions: number): number {
  return Math.round(millions * 10);
}

/** Round to `dp` decimal places, avoiding float noise like 4.999999999. */
export function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** Parse FPL's comma-separated form string into numbers, oldest first. */
export function parseForm(form: string): number[] {
  if (!form) return [];
  return form
    .split(',')
    .map((entry) => parseFloat(entry))
    .filter((entry) => Number.isFinite(entry));
}

/** Minutes played expressed as 90-minute equivalents, floored at 0. */
export function nineties(minutes: number): number {
  return Math.max(0, minutes / 90);
}

export function playerName(player: Player): string {
  return player.web_name || `${player.first_name} ${player.second_name}`.trim();
}

/** Short label used in dense UI, e.g. "Saka (M)". */
export function playerLabel(player: Player): string {
  return `${playerName(player)} (${player.position || '?'})`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/**
 * How likely a news string signals an injury/suspension/doubt.
 * The API sets `status` to 'd' (doubtful) / 'i' (injured) / 's' (suspended);
 * `news` carries a short free-text reason for some players only.
 */
const INJURY_NEWS = /\b(injur|suspens|doubt|hamstring|knock|unfit|not fit|ruled out|late test|fitness|illness|ill\b)/i;

export function hasInjuryNews(news: string): boolean {
  return typeof news === 'string' && news.length > 0 && INJURY_NEWS.test(news);
}

/** Build a team id -> team lookup. */
export function indexTeams(teams: Team[]): Map<number, Team> {
  return new Map(teams.map((team) => [team.id, team]));
}

/** Build a player id -> player lookup. */
export function indexPlayers(players: Player[]): Map<number, Player> {
  return new Map(players.map((player) => [player.id, player]));
}

/**
 * Build a team id -> remaining fixtures lookup, sorted by gameweek.
 *
 * The raw `/fixtures` payload is NOT sorted per team, so reading `[0]` off an
 * unsorted list yields an arbitrary — often already-played — fixture. Every
 * caller must use this helper and only ever look at future fixtures.
 *
 * @param fromEvent first gameweek to consider (inclusive)
 * @param throughEvent stop after this gameweek (inclusive)
 */
export function indexUpcomingFixtures(
  fixtures: Fixture[],
  fromEvent: number,
  throughEvent: number = 38
): Map<number, Fixture[]> {
  const byTeam = new Map<number, Fixture[]>();

  for (const fixture of fixtures) {
    if (fixture.event < fromEvent || fixture.event > throughEvent) continue;

    for (const teamId of [fixture.team_h, fixture.team_a]) {
      const list = byTeam.get(teamId);
      if (list) list.push(fixture);
      else byTeam.set(teamId, [fixture]);
    }
  }

  for (const list of byTeam.values()) {
    list.sort(
      (a, b) =>
        a.event - b.event ||
        (a.kickoff_time ?? '').localeCompare(b.kickoff_time ?? '')
    );
  }

  return byTeam;
}

/** The fixture a team plays in `event`, or null when they do not. */
export function fixtureForEvent(
  fixturesByTeam: Map<number, Fixture[]>,
  teamId: number,
  event: number
): Fixture | null {
  return fixturesByTeam.get(teamId)?.find((fixture) => fixture.event === event) ?? null;
}

/**
 * Resolve the next fixture for a team from a lookup built by
 * {@link indexUpcomingFixtures} from a given gameweek onwards.
 */
export function nextFixtureFor(
  fixturesByTeam: Map<number, Fixture[]>,
  teamId: number
): Fixture | null {
  return fixturesByTeam.get(teamId)?.[0] ?? null;
}

/** 1..5 difficulty for `teamId` in `fixture`. */
export function difficultyFor(fixture: Fixture, teamId: number): number {
  return fixture.team_h === teamId ? fixture.team_h_difficulty : fixture.team_a_difficulty;
}

export function isHomeFixture(fixture: Fixture, teamId: number): boolean {
  return fixture.team_h === teamId;
}

export function opponentOf(fixture: Fixture, teamId: number): number {
  return fixture.team_h === teamId ? fixture.team_a : fixture.team_h;
}

/** Count of players per club in a list — used to enforce the max-3 rule. */
export function clubCounts(players: Player[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const player of players) {
    counts.set(player.team, (counts.get(player.team) ?? 0) + 1);
  }
  return counts;
}

/** Elements whose type matches, in stable (input) order. */
export function byElementType(players: Player[], type: ElementType): Player[] {
  return players.filter((player) => player.element_type === type);
}

/**
 * Dominant (DEF/MID/FWD) a player plays in, inferred from their squad number.
 * FPL shirts: 1-2 GK, 3-6 DEF, 7-11 MID, 12+ FWD — but this varies per club, so
 * we fall back to their listed element_type when the shirt is missing.
 */
export function effectivePosition(player: Player): ElementType {
  const shirt = player.squad_number;
  if (!shirt) return player.element_type;
  if (shirt <= 2) return 1;
  if (shirt <= 6) return 2;
  if (shirt <= 11) return 3;
  return 4;
}
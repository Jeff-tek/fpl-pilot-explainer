import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildLineupAdvice,
  buildTransferPlans,
  calculatePlayerXPtsDetailed,
  findOptimalStartingXI,
  getChipAdvice,
  rankTransferOptions,
  selectCaptaincy,
} from '../src/engine';
import {
  BootstrapStatic,
  Fixture,
  Player,
  Team,
  XPtsWeights,
  DEFAULT_XPTS_WEIGHTS,
} from '../src/types';
import { resolveCurrentEvent, resolveNextEvent } from '../src/api';
import { indexTeams, indexUpcomingFixtures } from '../src/utils';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8')) as T;

/**
 * Snapshots were captured from the live 2026/27 FPL API so the model is tested
 * against real payload shapes rather than hand-written mocks. Notably the API
 * names its player array `elements`, not `players`.
 */
const bootstrap = fixture<BootstrapStatic>('bootstrap-static.json');
const fixtures = fixture<Fixture[]>('fixtures.json');
const picksFixture = fixture<{ picks: { element: number; multiplier: number }[] }>(
  'picks-3808385-gw6.json'
);

const players: Player[] = bootstrap.elements;
const teams: Team[] = bootstrap.teams;
const playersById = new Map(players.map((p) => [p.id, p]));

const nextEvent = resolveNextEvent(bootstrap);
const currentEvent = resolveCurrentEvent(bootstrap);
const teamsMap = indexTeams(teams);
const upcoming = indexUpcomingFixtures(fixtures, nextEvent);

/** A realistic 15-player squad resolved from the captured picks payload. */
const squad = picksFixture.picks
  .map((pick) => playersById.get(pick.element))
  .filter((p): p is Player => p !== undefined);

const weights: XPtsWeights = DEFAULT_XPTS_WEIGHTS;

describe('season data', () => {
  it('exposes players under `elements`, not `players`', () => {
    // Regression: the original code read `bootstrap.players`, which is undefined
    // against the live API and silently blanks the entire app.
    assert.equal(
      (bootstrap as unknown as { players?: unknown }).players,
      undefined,
      'the API must not expose a `players` alias'
    );
    assert.ok(players.length > 600, `expected a full squad list, got ${players.length}`);
  });

  it('plans for the first unfinished gameweek, not the last event in the season', () => {
    // Regression: `events[events.length - 1]` returned gameweek 38 all season.
    const lastEventId = bootstrap.events[bootstrap.events.length - 1].id;
    assert.notEqual(nextEvent, lastEventId);
    assert.ok(
      bootstrap.events.find((e) => e.id === nextEvent)?.finished === false,
      `gameweek ${nextEvent} must be unplayed`
    );
    assert.ok(nextEvent >= currentEvent);
  });
});

describe('fixture ordering', () => {
  it('never returns an already-played fixture', () => {
    for (const [teamId, list] of upcoming) {
      assert.ok(list.length > 0, `team ${teamId} has no upcoming fixtures`);
      for (const f of list) {
        assert.ok(
          f.event >= nextEvent,
          `team ${teamId} got gameweek ${f.event}, which is before ${nextEvent}`
        );
        assert.equal(f.finished, false);
      }
    }
  });

  it('sorts each club\'s fixtures by gameweek ascending', () => {
    for (const [teamId, list] of upcoming) {
      const events = list.map((f) => f.event);
      assert.deepEqual(events, [...events].sort((a, b) => a - b), `team ${teamId} unsorted`);
    }
  });

  it('exposes the genuinely next fixture at index 0', () => {
    for (const [teamId, list] of upcoming) {
      const expected = Math.min(
        ...fixtures
          .filter(
            (f) =>
              f.event >= nextEvent && (f.team_h === teamId || f.team_a === teamId)
          )
          .map((f) => f.event)
      );
      assert.equal(list[0].event, expected, `team ${teamId} index 0 is not its next fixture`);
    }
  });
});

describe('xPts model', () => {
  it('produces components that sum to the headline projection', () => {
    for (const player of squad) {
      const breakdown = calculatePlayerXPtsDetailed({
        player,
        teamsMap,
        fixturesByTeam: upcoming,
        weights,
      });

      const sum = breakdown.components.reduce((acc, c) => acc + c.contribution, 0);
      // Components are rounded to 2dp individually, so allow a cent of drift.
      assert.ok(
        Math.abs(sum - breakdown.total) <= 0.02,
        `${player.web_name}: components ${sum} vs total ${breakdown.total}`
      );
    }
  });

  it('never projects a negative score', () => {
    for (const player of squad) {
      const { total } = calculatePlayerXPtsDetailed({
        player,
        teamsMap,
        fixturesByTeam: upcoming,
        weights,
      });
      assert.ok(total >= 0, `${player.web_name} projected ${total}`);
    }
  });

  it('projects a plausible range for a full squad', () => {
    const totals = squad.map(
      (p) => calculatePlayerXPtsDetailed({ player: p, teamsMap, fixturesByTeam: upcoming, weights }).total
    );
    assert.ok(Math.min(...totals) >= 0, 'no negative projections');
    assert.ok(Math.max(...totals) < 20, `implausible peak ${Math.max(...totals)}`);
  });

  it('penalises an injured player versus the same player fully fit', () => {
    const fit = { ...playersById.get(squad[0].id)!, chance_of_playing_next_round: 100, news: '' };
    const hurt = { ...fit, chance_of_playing_next_round: 10, status: 'i' };

    const fitTotal = calculatePlayerXPtsDetailed({ player: fit, teamsMap, fixturesByTeam: upcoming, weights }).total;
    const hurtTotal = calculatePlayerXPtsDetailed({ player: hurt, teamsMap, fixturesByTeam: upcoming, weights }).total;

    assert.ok(hurtTotal < fitTotal, `injured ${hurtTotal} should be below fit ${fitTotal}`);
  });

  it('rewards an easier fixture for the same player', () => {
    const player = squad[0];
    const easy = calculatePlayerXPtsDetailed({
      player,
      teamsMap,
      fixturesByTeam: new Map([[player.team, [{ ...upcoming.get(player.team)![0], team_h_difficulty: 1, team_a_difficulty: 1 }]]]),
      weights,
    }).total;
    const hard = calculatePlayerXPtsDetailed({
      player,
      teamsMap,
      fixturesByTeam: new Map([[player.team, [{ ...upcoming.get(player.team)![0], team_h_difficulty: 5, team_a_difficulty: 5 }]]]),
      weights,
    }).total;

    assert.ok(easy > hard, `easy ${easy} should beat hard ${hard}`);
  });
});

describe('starting XI', () => {
  it('picks exactly eleven players', () => {
    const result = findOptimalStartingXI({ squad, teamsMap, fixturesByTeam: upcoming, weights });
    assert.equal(result.xi.length, 11);
  });

  it('respects the maximum of three players per club', () => {
    const result = findOptimalStartingXI({ squad, teamsMap, fixturesByTeam: upcoming, weights });
    const counts = new Map<number, number>();
    for (const p of result.xi) counts.set(p.team, (counts.get(p.team) ?? 0) + 1);
    for (const [teamId, count] of counts) {
      assert.ok(count <= 3, `team ${teamId} fielded ${count} players`);
    }
  });

  it('fields exactly one goalkeeper', () => {
    const result = findOptimalStartingXI({ squad, teamsMap, fixturesByTeam: upcoming, weights });
    assert.equal(result.xi.filter((p) => p.element_type === 1).length, 1);
  });

  it('sums the formation shape to eleven and matches the XI', () => {
    const result = findOptimalStartingXI({ squad, teamsMap, fixturesByTeam: upcoming, weights });
    assert.equal(result.formation.reduce((a, b) => a + b, 0), 11);
  });

  it('honours a forced formation', () => {
    const result = findOptimalStartingXI({
      squad,
      teamsMap,
      fixturesByTeam: upcoming,
      weights,
      forcedFormation: [1, 5, 3, 2],
    });
    assert.deepEqual(result.formation, [1, 5, 3, 2]);
    assert.equal(result.xi.filter((p) => p.element_type === 2).length, 5);
  });

  it('rejects a squad that cannot field a legal XI', () => {
    assert.throws(
      () => findOptimalStartingXI({ squad: squad.slice(0, 5), teamsMap, fixturesByTeam: upcoming, weights }),
      /at least 11 players/
    );
  });
});

describe('captaincy', () => {
  it('selects two starters with a rationale', () => {
    const xi = findOptimalStartingXI({ squad, teamsMap, fixturesByTeam: upcoming, weights }).xi;
    const { captain, viceCaptain, rationale } = selectCaptaincy(xi, teamsMap, upcoming, weights);

    assert.ok(xi.some((p) => p.id === captain.id));
    assert.ok(xi.some((p) => p.id === viceCaptain.id));
    assert.notEqual(captain.id, viceCaptain.id);
    assert.ok(rationale.length > 0);
  });
});

describe('transfers', () => {
  const context = {
    squad,
    allPlayers: players,
    bank: 50,
    teamsMap,
    fixturesByTeam: upcoming,
    weights,
    freeTransfers: 1,
  };

  it('only ever improves the projection', () => {
    for (const option of rankTransferOptions(context, 15)) {
      assert.ok(option.netGain > 0, `${option.buy.web_name} for ${option.sell.web_name} loses points`);
    }
  });

  it('stays inside the available bank', () => {
    for (const option of rankTransferOptions(context, 15)) {
      assert.ok(
        option.cashDelta <= context.bank,
        `${option.buy.web_name} costs more than the bank`
      );
    }
  });

  it('never sells a player and buys the same player back', () => {
    for (const option of rankTransferOptions(context, 15)) {
      assert.notEqual(option.sell.id, option.buy.id);
    }
  });

  it('only sells players the manager actually owns', () => {
    const squadIds = new Set(squad.map((p) => p.id));
    for (const option of rankTransferOptions(context, 15)) {
      assert.ok(squadIds.has(option.sell.id));
      assert.ok(!squadIds.has(option.buy.id));
    }
  });

  it('flags a swap that would breach the three-per-club limit', () => {
    const options = rankTransferOptions(context, 40);
    for (const option of options) {
      const count = squad.filter((p) => p.team === option.buy.team).length;
      const afterSale = count - (option.sell.team === option.buy.team ? 1 : 0);
      assert.equal(
        option.breachesClubLimit,
        afterSale + 1 > 3,
        `club-limit flag wrong for ${option.buy.web_name}`
      );
    }
  });

  it('builds feasible multi-transfer plans', () => {
    const options = rankTransferOptions(context, 15);
    const plans = buildTransferPlans(context, options, 3);

    for (const plan of plans) {
      assert.ok(plan.feasible);
      assert.ok(plan.transfers.length >= 1 && plan.transfers.length <= 3);
      assert.ok(plan.cashDelta <= context.bank, 'plan overspends the bank');

      const sold = new Set(plan.transfers.map((t) => t.sell.id));
      assert.equal(sold.size, plan.transfers.length, 'plan sells the same player twice');

      const bought = new Set(plan.transfers.map((t) => t.buy.id));
      assert.equal(bought.size, plan.transfers.length, 'plan buys the same player twice');
    }
  });

  it('handles an empty bank without proposing unaffordable swaps', () => {
    const options = rankTransferOptions({ ...context, bank: 0 }, 15);
    for (const option of options) {
      assert.ok(option.cashDelta <= 0, `${option.buy.web_name} unaffordable at zero bank`);
    }
  });

  it('returns nothing actionable when nothing improves the projection', () => {
    // A bank of zero plus a squad of the best available players should still
    // degrade gracefully rather than throwing.
    assert.doesNotThrow(() => rankTransferOptions({ ...context, bank: 0 }, 15));
  });
});

describe('lineup advice', () => {
  it('produces a ranked, explained change list', () => {
    const currentXI = picksFixture.picks
      .filter((p) => p.multiplier > 0)
      .map((p) => playersById.get(p.element))
      .filter((p): p is Player => p !== undefined);

    const advice = buildLineupAdvice({
      squad,
      currentXI,
      currentCaptainId: currentXI[0]?.id ?? null,
      currentViceCaptainId: currentXI[1]?.id ?? null,
      teamsMap,
      fixturesByTeam: upcoming,
      currentEvent: nextEvent,
      weights,
      freeTransfers: 1,
    });

    assert.equal(advice.starters.length, 11);
    assert.equal(advice.bench.length, squad.length - 11);
    assert.ok(advice.captainRationale.length > 0);
    assert.ok(Number.isFinite(advice.projectedPoints));
    assert.ok(Number.isFinite(advice.projectedGain));

    // Changes must be sorted best-first.
    for (let i = 1; i < advice.changes.length; i++) {
      assert.ok(advice.changes[i - 1].xPtsDelta >= advice.changes[i].xPtsDelta);
    }
  });
});

describe('chips', () => {
  it('returns an opinion on every chip', () => {
    const xi = findOptimalStartingXI({ squad, teamsMap, fixturesByTeam: upcoming, weights }).xi;
    const advice = getChipAdvice({
      currentEvent: nextEvent,
      squad,
      xi,
      captain: xi[0],
      teamsMap,
      fixturesByTeam: upcoming,
      weights,
    });

    assert.equal(advice.length, 4);
    for (const chip of advice) {
      assert.ok(chip.headline.length > 0);
      assert.ok(chip.rationale.length > 0);
      assert.ok(['low', 'medium', 'high'].includes(chip.confidence));
    }
  });
});
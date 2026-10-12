import { useEffect, useMemo, type ReactNode } from 'react';
import { useAppStore } from '../store';
import {
  AvailabilityOutlook,
  ElementType,
  Fixture,
  POSITIONS,
  POSITION_NAMES,
  Player,
} from '../types';
import {
  difficultyFor,
  isHomeFixture,
  opponentOf,
  parseForm,
  playerName,
  round,
  sum,
  toMillions,
  toNum,
} from '../utils';

// ---------------------------------------------------------------------------
// Presentation helpers (shared vocabulary with TacticalPitch)
// ---------------------------------------------------------------------------

/** 1..5 FDR ramp — identical to the pitch markers so the two never disagree. */
function fdrColour(fdr: number): string {
  if (fdr <= 1) return '#22c55e';
  if (fdr === 2) return '#4ade80';
  if (fdr === 3) return '#facc15';
  if (fdr === 4) return '#fb923c';
  return '#ef4444';
}

function positionColour(elementType: ElementType): string {
  switch (elementType) {
    case 1:
      return '#eab308';
    case 2:
      return '#3b82f6';
    case 3:
      return '#22c55e';
    default:
      return '#ef4444';
  }
}

/** `+1.24` / `-0.60` — the model is signed, so the UI must be too. */
function signed(value: number, dp = 2): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(dp)}`;
}

function formatKickoff(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ChipStyle {
  label: string;
  className: string;
}

/**
 * FPL publishes `status` as a single letter: 'a' available, 'd' doubtful,
 * 'i' injured, 's' suspended. Anything unknown falls back to the model's own
 * `isDoubtful` verdict, and finally to a clean bill of health.
 */
const STATUS_CHIPS: Record<string, ChipStyle | undefined> = {
  a: {
    label: 'Available',
    className: 'bg-fpl-success/20 text-fpl-success border-fpl-success/50',
  },
  d: {
    label: 'Doubtful',
    className: 'bg-fpl-warning/20 text-fpl-warning border-fpl-warning/50',
  },
  i: {
    label: 'Injured',
    className: 'bg-fpl-danger/20 text-fpl-danger border-fpl-danger/50',
  },
  s: {
    label: 'Suspended',
    className: 'bg-fpl-danger/20 text-fpl-danger border-fpl-danger/50',
  },
};

function availabilityChip(player: Player, outlook: AvailabilityOutlook | undefined): ChipStyle {
  const byStatus = STATUS_CHIPS[(player.status ?? '').toLowerCase()];
  if (byStatus) return byStatus;
  if (outlook?.isDoubtful) {
    return { label: 'Doubtful', className: 'bg-fpl-warning/20 text-fpl-warning border-fpl-warning/50' };
  }
  return {
    label: 'Available',
    className: 'bg-fpl-success/20 text-fpl-success border-fpl-success/50',
  };
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function PositionBadge({ elementType }: { elementType: ElementType }) {
  return (
    <svg viewBox="0 0 24 24" className="w-10 h-10 shrink-0" role="img" aria-label={POSITION_NAMES[elementType]}>
      <circle cx="12" cy="12" r="11" fill={positionColour(elementType)} stroke="#ffffff" strokeWidth="1.6" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="8"
        fontWeight="bold"
        fill="#111827"
      >
        {POSITIONS[elementType]}
      </text>
    </svg>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="bg-gray-800 rounded p-4">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h3 className="font-semibold text-fpl-accent">{title}</h3>
        {hint && <span className="text-xs text-gray-500">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

interface Tile {
  label: string;
  value: string;
  tone?: string;
}

function TileGrid({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {tiles.map((tile) => (
        <div key={tile.label} className="bg-gray-900 rounded px-2 py-1.5">
          <p className="text-[0.65rem] uppercase tracking-wide text-gray-500">{tile.label}</p>
          <p className={`text-sm font-bold font-mono ${tile.tone ?? 'text-gray-100'}`}>{tile.value}</p>
        </div>
      ))}
    </div>
  );
}

function FdrPill({ difficulty }: { difficulty: number }) {
  const colour = fdrColour(difficulty);
  return (
    <span
      className="text-xs font-bold px-1.5 py-0.5 rounded font-mono"
      style={{ backgroundColor: `${colour}22`, color: colour }}
      title={`Fixture difficulty rating ${difficulty} (1 easiest, 5 hardest)`}
    >
      FDR {difficulty}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export default function PlayerModal() {
  const player = useAppStore((state) => state.selectedPlayer);
  const selectPlayer = useAppStore((state) => state.selectPlayer);
  const teamsMap = useAppStore((state) => state.teamsMap);
  const upcomingFixtures = useAppStore((state) => state.upcomingFixtures);
  const nextEvent = useAppStore((state) => state.nextEvent);
  const lineup = useAppStore((state) => state.lineup);

  // The model only projects your own squad, so this is legitimately undefined
  // for any transfer-market player picked from the SquadBrowser.
  const breakdown = player ? lineup?.breakdownById[player.id] : undefined;

  /** Sum of the signed contributions, recomputed so the footer can prove it. */
  const componentSum = useMemo(
    () => (breakdown ? sum(breakdown.components.map((component) => component.contribution)) : 0),
    [breakdown]
  );

  /**
   * Next 5 fixtures straight off the store's pre-sorted per-team index.
   * The raw `/fixtures` payload is not sorted and is not filtered, so reading
   * it directly would show already-played games.
   */
  const fixtureRows = useMemo(() => {
    if (!player) return [];
    const list = (upcomingFixtures.get(player.team) ?? []).slice(0, 5);
    return list.map((fixture: Fixture) => {
      const opponentId = opponentOf(fixture, player.team);
      return {
        id: fixture.id,
        event: fixture.event,
        isHome: isHomeFixture(fixture, player.team),
        opponent: teamsMap.get(opponentId)?.short_name ?? `Team ${opponentId}`,
        difficulty: difficultyFor(fixture, player.team),
        kickoff: formatKickoff(fixture.kickoff_time),
      };
    });
  }, [player, upcomingFixtures, teamsMap]);

  useEffect(() => {
    if (!player) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') selectPlayer(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [player, selectPlayer]);

  if (!player) return null;

  const club = teamsMap.get(player.team);
  const chip = availabilityChip(player, breakdown?.availability);
  const chance = breakdown?.availability.chanceOfPlaying ?? player.chance_of_playing_next_round;
  const formEntries = parseForm(player.form ?? '');
  const outlook = breakdown?.fixture ?? null;

  // Each component is rounded for display, so the printed sum can drift from
  // the printed total by a hundredth or two. Showing that beats hiding it.
  const drift = breakdown ? round(componentSum - breakdown.total, 2) : 0;

  const seasonTiles: Tile[] = [
    { label: 'Total points', value: String(player.total_points) },
    { label: 'Minutes', value: player.minutes.toLocaleString() },
    { label: 'Goals', value: String(player.goals_scored) },
    { label: 'Assists', value: String(player.assists) },
    { label: 'Clean sheets', value: String(player.clean_sheets) },
    { label: 'Saves', value: String(player.saves) },
    { label: 'Bonus', value: String(player.bonus) },
    { label: 'BPS', value: String(player.bps) },
    { label: 'Points per game', value: toNum(player.points_per_game).toFixed(2) },
    {
      label: 'Form',
      value: formEntries.length > 0 ? formEntries.map((value) => value.toFixed(1)).join(' · ') : '—',
    },
  ];

  const underlyingTiles: Tile[] = [
    { label: 'xG', value: toNum(player.expected_goals).toFixed(2) },
    { label: 'xA', value: toNum(player.expected_assists).toFixed(2) },
    { label: 'ICT', value: toNum(player.ict_index).toFixed(2) },
    { label: 'Influence', value: toNum(player.influence).toFixed(2) },
    { label: 'Creativity', value: toNum(player.creativity).toFixed(2) },
    { label: 'Threat', value: toNum(player.threat).toFixed(2) },
    { label: 'xGC', value: toNum(player.expected_goals_conceded).toFixed(2) },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`${playerName(player)} — player detail`}
      onClick={() => selectPlayer(null)}
    >
      <div
        className="modal-enter w-full max-w-3xl my-auto bg-gray-900 rounded-lg shadow-2xl border border-gray-700"
        onClick={(event) => event.stopPropagation()}
      >
        {/* --- Header ----------------------------------------------------- */}
        <div className="p-4 border-b border-gray-700 flex items-start gap-3">
          <PositionBadge elementType={player.element_type} />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold truncate">{playerName(player)}</h2>
              <span className={`px-2 py-0.5 rounded-full border text-xs font-bold ${chip.className}`}>
                {chip.label}
              </span>
            </div>
            <p className="text-sm text-gray-300">{club?.name ?? `Team ${player.team}`}</p>
            <p className="text-xs text-gray-400">
              {POSITION_NAMES[player.element_type]}
              {player.position ? ` · ${player.position}` : ''}
              {player.squad_number !== null ? ` · shirt ${player.squad_number}` : ''} · projected for GW
              {nextEvent}
            </p>
            {chance !== null && (
              <p className="text-xs text-gray-400">
                {Math.round(chance)}% chance of playing next round
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => selectPlayer(null)}
            aria-label="Close"
            className="text-gray-400 hover:text-fpl-accent text-2xl leading-none px-1"
          >
            ×
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* --- Price / ownership ---------------------------------------- */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-gray-800 rounded px-3 py-2 text-center">
              <p className="text-xs text-gray-400">Price</p>
              <p className="font-bold text-fpl-accent font-mono">
                £{toMillions(player.now_cost).toFixed(1)}m
              </p>
            </div>
            <div className="bg-gray-800 rounded px-3 py-2 text-center">
              <p className="text-xs text-gray-400">Ownership</p>
              <p className="font-bold font-mono">{toNum(player.selected_by_percent).toFixed(1)}%</p>
            </div>
            <div className="bg-gray-800 rounded px-3 py-2 text-center">
              <p className="text-xs text-gray-400">Projected</p>
              <p className="font-bold text-fpl-accent font-mono">
                {breakdown ? `${breakdown.total.toFixed(2)}` : '—'}
              </p>
            </div>
          </div>

          {/* --- News ------------------------------------------------------ */}
          {player.news.trim().length > 0 && (
            <div className="bg-fpl-warning/10 border border-fpl-warning/50 rounded p-3">
              <p className="text-xs font-bold text-fpl-warning uppercase tracking-wide">
                Team news
                {player.news_added ? ` · ${player.news_added}` : ''}
              </p>
              <p className="text-sm text-yellow-200 mt-1">{player.news}</p>
            </div>
          )}

          {/* --- Breakdown ------------------------------------------------- */}
          {breakdown ? (
            <Section title="How the projection is built" hint="signed points added">
              <ul className="space-y-1.5">
                {breakdown.components.map((component) => (
                  <li key={component.key} className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-200">{component.label}</p>
                      <p className="text-xs text-gray-400">{component.detail}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p
                        className={`text-sm font-bold font-mono ${
                          component.contribution >= 0 ? 'text-green-400' : 'text-red-400'
                        }`}
                      >
                        {signed(component.contribution)}
                      </p>
                      <p className="text-[0.65rem] text-gray-500 font-mono">
                        raw {component.rawValue.toFixed(2)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              {/* The audit strip: proves the rows above really do add up. */}
              <p className="mt-3 pt-2 border-t border-gray-700 text-xs text-gray-400">
                Components sum to{' '}
                <span className="font-mono font-bold text-gray-200">{signed(componentSum)}</span> ={' '}
                <span className="text-fpl-accent font-bold font-mono">
                  {breakdown.total.toFixed(2)}
                </span>{' '}
                points
                {drift !== 0 && (
                  <span className="text-gray-500">
                    {' '}
                    (off by {signed(drift)} from per-component rounding)
                  </span>
                )}
              </p>
            </Section>
          ) : (
            <Section title="Projection">
              <p className="text-sm text-gray-400">
                The xPts model only projects players inside your own squad. {playerName(player)} is
                outside it, so there is no breakdown to show — the season data below is still live.
              </p>
            </Section>
          )}

          {/* --- Next fixture ---------------------------------------------- */}
          <Section title="Next fixture">
            {outlook ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="px-2 py-0.5 rounded text-xs font-bold bg-gray-700 text-gray-100"
                      title={outlook.isHome ? 'Home fixture' : 'Away fixture'}
                    >
                      {outlook.isHome ? 'H' : 'A'}
                    </span>
                    <span className="text-sm font-semibold truncate">{outlook.opponentName}</span>
                  </div>
                  <FdrPill difficulty={outlook.difficulty} />
                </div>
                <p className="text-xs text-gray-400">
                  {formatKickoff(outlook.kickoffTime) ?? 'Kickoff time not published'}
                  {outlook.rollingDifficulty !== null && (
                    <>
                      {' · '}rolling FDR next 5:{' '}
                      <span
                        className="font-mono font-bold"
                        style={{ color: fdrColour(Math.round(outlook.rollingDifficulty)) }}
                      >
                        {outlook.rollingDifficulty.toFixed(2)}
                      </span>
                    </>
                  )}
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-400">
                {breakdown
                  ? 'No remaining fixture this season.'
                  : 'Fixture outlook is only modelled for your own squad.'}
              </p>
            )}
          </Section>

          {/* --- Fixture run ---------------------------------------------- */}
          <Section title="Next 5 fixtures" hint={club?.short_name}>
            {fixtureRows.length === 0 ? (
              <p className="text-sm text-gray-400">No upcoming fixtures listed.</p>
            ) : (
              <ul className="space-y-1">
                {fixtureRows.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded bg-gray-900/60"
                  >
                    <span className="text-gray-500 font-mono w-10">GW{row.event}</span>
                    <span className="text-gray-400 w-4 font-bold">{row.isHome ? 'H' : 'A'}</span>
                    <span className="flex-1 font-semibold truncate">{row.opponent}</span>
                    <span className="text-gray-500 font-mono hidden sm:inline">
                      {row.kickoff ?? ''}
                    </span>
                    <FdrPill difficulty={row.difficulty} />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* --- Season stats ---------------------------------------------- */}
          <Section title="Season stats">
            <TileGrid tiles={seasonTiles} />
          </Section>

          {/* --- Underlying metrics ---------------------------------------- */}
          <Section title="Underlying metrics" hint="season totals">
            <TileGrid tiles={underlyingTiles} />
          </Section>
        </div>

        {/* --- Footer ----------------------------------------------------- */}
        <div className="border-t border-gray-700 p-4">
          <button
            type="button"
            onClick={() => selectPlayer(null)}
            className="w-full px-4 py-2 bg-fpl-accent text-fpl-primary font-bold rounded hover:bg-opacity-90 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
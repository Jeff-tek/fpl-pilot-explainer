import { useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { ElementType, Player, XPtsBreakdown } from '../types';
import { POSITIONS, VALID_FORMATIONS } from '../types';
import { difficultyFor, effectivePosition, toMillions } from '../utils';

/** Pitch is drawn attacking upwards, the way FPL managers read a formation. */
const PITCH = { width: 68, height: 105 };

interface Slot {
  player: Player;
  x: number;
  y: number;
}

/**
 * Lay the XI out on the pitch.
 *
 * Returns one slot per starter with its own player attached, so a caller can
 * never mis-align a rendered position against `starters[idx]` the way index
 * based layouts do when a formation's shape changes.
 */
function layoutXI(starters: Player[], formation: [number, number, number, number]): Slot[] {
  const pools = new Map<ElementType, Player[]>();
  for (const type of [1, 2, 3, 4] as ElementType[]) pools.set(type, []);
  for (const player of starters) {
    pools.get(effectivePosition(player))!.push(player);
  }

  const [gk, def, mid, fwd] = formation;

  // Row anchors, measured from the goalkeeper end.
  const rows: { type: ElementType; count: number; y: number; spread: number }[] = [
    { type: 1, count: gk, y: 96, spread: 0 },
    { type: 2, count: def, y: 76, spread: 30 },
    { type: 3, count: mid, y: 53, spread: 42 },
    { type: 4, count: fwd, y: 28, spread: 34 },
  ];

  const slots: Slot[] = [];
  const centre = PITCH.width / 2;

  for (const row of rows) {
    const group = pools.get(row.type) ?? [];
    const count = Math.min(row.count, group.length);
    if (count === 0) continue;

    const step = count === 1 ? 0 : (row.spread / (count - 1));
    const start = centre - (step * (count - 1)) / 2;

    for (let i = 0; i < count; i++) {
      slots.push({
        player: group[i],
        x: start + step * i,
        y: row.y,
      });
    }
  }

  return slots;
}

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

export default function TacticalPitch() {
  const lineup = useAppStore((state) => state.lineup);
  const teamsMap = useAppStore((state) => state.teamsMap);
  const selectPlayer = useAppStore((state) => state.selectPlayer);
  const [view, setView] = useState<'projected' | 'changes'>('projected');

  const slots = useMemo(
    () => (lineup ? layoutXI(lineup.starters, lineup.formation) : []),
    [lineup]
  );

  if (!lineup) return null;

  const changeById = new Map<number, number>();
  for (const change of lineup.changes) {
    changeById.set(change.playerId, change.xPtsDelta);
  }

  const total = lineup.starters.reduce(
    (sum, player) => sum + (lineup.breakdownById[player.id]?.total ?? 0),
    0
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1">
          {(['projected', 'changes'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
                view === mode
                  ? 'bg-fpl-accent text-fpl-primary'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              {mode === 'projected' ? 'Projected points' : 'Changes vs your XI'}
            </button>
          ))}
        </div>

        <p className="text-sm text-gray-400">
          Formation{' '}
          <span className="text-fpl-accent font-bold">
            {lineup.formation.slice(1).join('-')}
          </span>
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-4">
        {/* --- Pitch --- */}
        <svg
          viewBox={`0 0 ${PITCH.width} ${PITCH.height}`}
          className="w-full max-w-md mx-auto rounded-lg border border-gray-700"
          role="img"
          aria-label={`Recommended starting XI in a ${lineup.formation.join('-')} formation`}
        >
          <defs>
            <linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#1e5631" />
              <stop offset="50%" stopColor="#17472a" />
              <stop offset="100%" stopColor="#1e5631" />
            </linearGradient>
          </defs>
          <rect width={PITCH.width} height={PITCH.height} fill="url(#grass)" />

          {/* Mown stripes */}
          {Array.from({ length: 10 }).map((_, i) => (
            <rect
              key={i}
              x="0"
              y={i * (PITCH.height / 10)}
              width={PITCH.width}
              height={PITCH.height / 20}
              fill="#ffffff"
              opacity="0.03"
            />
          ))}

          {/* Markings */}
          <g stroke="#ffffff" strokeOpacity="0.45" strokeWidth="0.4" fill="none">
            <rect x="2" y="2" width={PITCH.width - 4} height={PITCH.height - 4} />
            <line x1="2" y1={PITCH.height / 2} x2={PITCH.width - 2} y2={PITCH.height / 2} />
            <circle cx={PITCH.width / 2} cy={PITCH.height / 2} r="8" />
            {/* Attacking (top) penalty area */}
            <rect x="16" y="2" width="36" height="14" />
            <rect x="25" y="2" width="18" height="5" />
            <circle cx={PITCH.width / 2} cy="9" r="0.6" fill="#ffffff" />
            {/* Defending (bottom) penalty area */}
            <rect x="16" y={PITCH.height - 16} width="36" height="14" />
            <rect x="25" y={PITCH.height - 7} width="18" height="5" />
            <circle cx={PITCH.width / 2} cy={PITCH.height - 9} r="0.6" fill="#ffffff" />
          </g>

          {/* Players */}
          {slots.map(({ player, x, y }) => {
            const breakdown: XPtsBreakdown | undefined = lineup.breakdownById[player.id];
            const fdr = breakdown?.fixture ? difficultyFor(breakdown.fixture.fixture, player.team) : 3;
            const club = teamsMap.get(player.team)?.short_name ?? '';
            const isCaptain = player.id === lineup.captain.id;
            const isVice = player.id === lineup.viceCaptain.id;
            const doubtful = breakdown?.availability.isDoubtful ?? false;
            const delta = changeById.get(player.id);

            const label =
              view === 'projected'
                ? `${breakdown?.total.toFixed(1) ?? '—'} pts`
                : delta !== undefined
                  ? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`
                  : '—';

            return (
              <g
                key={player.id}
                onClick={() => selectPlayer(player)}
                className="cursor-pointer"
              >
                <title>
                  {`${player.web_name} — ${POSITIONS[player.element_type]} — ${breakdown?.total.toFixed(
                    2
                  ) ?? '?'} projected pts` +
                    (breakdown?.fixture
                      ? `\n${breakdown.fixture.isHome ? 'Home' : 'Away'} vs ${
                          breakdown.fixture.opponentName
                        } (FDR ${breakdown.fixture.difficulty})`
                      : '') +
                    (doubtful ? '\nDoubtful' : '')}
                </title>

                <circle
                  cx={x}
                  cy={y}
                  r="4.2"
                  fill={positionColour(player.element_type)}
                  stroke="#ffffff"
                  strokeWidth="0.5"
                  className="hover:opacity-80 transition-opacity"
                />
                {doubtful && (
                  <circle
                    cx={x + 3.2}
                    cy={y - 3.2}
                    r="1.5"
                    fill="#fbbf24"
                    stroke="#1f2937"
                    strokeWidth="0.4"
                  />
                )}
                {(isCaptain || isVice) && (
                  <g>
                    <circle
                      cx={x - 3.2}
                      cy={y - 3.2}
                      r="1.7"
                      fill={isCaptain ? '#fbbf24' : '#d1d5db'}
                      stroke="#1f2937"
                      strokeWidth="0.4"
                    />
                    <text
                      x={x - 3.2}
                      y={y - 3.2}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fontSize="2"
                      fontWeight="bold"
                      fill="#111827"
                    >
                      {isCaptain ? 'C' : 'V'}
                    </text>
                  </g>
                )}

                <text
                  x={x}
                  y={y + 6.4}
                  textAnchor="middle"
                  fontSize="2.6"
                  fontWeight="bold"
                  fill="#ffffff"
                  className="pointer-events-none select-none"
                >
                  {player.web_name.length > 9
                    ? `${player.web_name.slice(0, 8)}…`
                    : player.web_name}
                </text>
                <text
                  x={x}
                  y={y + 8.9}
                  textAnchor="middle"
                  fontSize="2"
                  fill="#ffffff"
                  opacity="0.6"
                  className="pointer-events-none select-none"
                >
                  {club}
                </text>
                <text
                  x={x}
                  y={y + 11.8}
                  textAnchor="middle"
                  fontSize="2.4"
                  fontWeight="bold"
                  fill={view === 'changes' && delta !== undefined && delta > 0 ? '#4ade80' : fdrColour(fdr)}
                  className="pointer-events-none select-none"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>

        {/* --- Bench + summary --- */}
        <div className="flex-1 space-y-4">
          <div className="bg-gray-800 rounded p-4">
            <h3 className="font-semibold text-fpl-accent mb-1">Projected gameweek score</h3>
            <div className="flex items-end gap-3">
              <span className="text-4xl font-bold text-fpl-accent">{total.toFixed(1)}</span>
              <span className="text-sm text-gray-400 mb-1.5">
                your current XI projects {lineup.currentProjectedPoints.toFixed(1)}
              </span>
            </div>
            {lineup.projectedGain > 0 && (
              <p className="text-fpl-success text-sm mt-1">
                Swapping to the recommended XI is worth about{' '}
                <strong>{lineup.projectedGain.toFixed(1)} points</strong>.
              </p>
            )}
            {lineup.projectedGain <= 0 && (
              <p className="text-gray-400 text-sm mt-1">
                You are already playing the optimal XI — hold the armband decision below.
              </p>
            )}
          </div>

          <div className="bg-gray-800 rounded p-4">
            <h3 className="font-semibold text-fpl-accent mb-2">Armbands</h3>
            <p className="text-sm">
              <span className="text-fpl-accent font-bold">C — {lineup.captain.web_name}</span>{' '}
              ({lineup.breakdownById[lineup.captain.id]?.total.toFixed(2)} pts)
            </p>
            <p className="text-sm">
              <span className="font-bold">V — {lineup.viceCaptain.web_name}</span> (
              {lineup.breakdownById[lineup.viceCaptain.id]?.total.toFixed(2)} pts)
            </p>
          </div>

          <div className="bg-gray-800 rounded p-4">
            <h3 className="font-semibold text-fpl-accent mb-2">Bench (auto-sub order)</h3>
            <ul className="space-y-1">
              {lineup.bench.map((player, index) => {
                const breakdown = lineup.breakdownById[player.id];
                const fdr = breakdown?.fixture ? breakdown.fixture.difficulty : 3;
                return (
                  <li key={player.id}>
                    <button
                      onClick={() => selectPlayer(player)}
                      className="w-full flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-gray-700 transition-colors text-left"
                    >
                      <span className="text-gray-500 w-4">{index + 1}</span>
                      <span className="flex-1">{player.web_name}</span>
                      <span className="text-xs text-gray-400">
                        {POSITIONS[player.element_type]}
                      </span>
                      <span className="text-xs text-gray-400">
                        £{toMillions(player.now_cost).toFixed(1)}m
                      </span>
                      <span
                        className="text-xs font-bold px-1.5 py-0.5 rounded"
                        style={{ backgroundColor: `${fdrColour(fdr)}22`, color: fdrColour(fdr) }}
                      >
                        {breakdown?.total.toFixed(1) ?? '—'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Formation options offered in the settings panel. */
export { VALID_FORMATIONS };
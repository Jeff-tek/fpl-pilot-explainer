import { useMemo, useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../store';
import { ElementType, POSITIONS, Player, XPtsBreakdown } from '../types';
import { parseForm, playerName, toMillions, toNum } from '../utils';

type SortKey = 'xpts' | 'price' | 'ownership';
type PositionFilter = 'ALL' | ElementType;

/** Rows past this are not painted; the counts above the table stay honest. */
const RENDER_LIMIT = 200;

const POSITION_FILTERS: { value: PositionFilter; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 1, label: POSITIONS[1] },
  { value: 2, label: POSITIONS[2] },
  { value: 3, label: POSITIONS[3] },
  { value: 4, label: POSITIONS[4] },
];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'xpts', label: 'Projected xPts' },
  { value: 'price', label: 'Price (cheap first)' },
  { value: 'ownership', label: 'Ownership %' },
];

/** Mean of the last five gameweek scores — 0 when the player has no form. */
function formAverage(player: Player): number {
  const recent = parseForm(player.form ?? '').slice(-5);
  if (recent.length === 0) return 0;
  return recent.reduce((total, value) => total + value, 0) / recent.length;
}

/** Lowercased haystack; `web_name` first, full name as a fallback. */
function searchKey(player: Player): string {
  return (player.web_name || playerName(player)).toLowerCase();
}

/** Projects descending; players the model never scored sink to the bottom. */
function byProjection(
  a: Player,
  b: Player,
  breakdowns: Map<number, XPtsBreakdown>
): number {
  const left = breakdowns.get(a.id)?.total;
  const right = breakdowns.get(b.id)?.total;
  if (left === undefined && right === undefined) return a.now_cost - b.now_cost;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left || a.now_cost - b.now_cost;
}

export default function SquadBrowser() {
  const players = useAppStore((state) => state.players);
  const teamsMap = useAppStore((state) => state.teamsMap);
  const squad = useAppStore((state) => state.squad);
  const lineup = useAppStore((state) => state.lineup);
  const nextEvent = useAppStore((state) => state.nextEvent);
  const selectPlayer = useAppStore((state) => state.selectPlayer);

  const [search, setSearch] = useState('');
  const [positionFilter, setPositionFilter] = useState<PositionFilter>('ALL');
  const [squadOnly, setSquadOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>('xpts');

  // Derived once per store change so the hot memo below stays cheap and its
  // identity only flips when the underlying data actually changes.
  const breakdowns = useMemo(() => {
    const map = new Map<number, XPtsBreakdown>();
    const source = lineup?.breakdownById;
    if (source) {
      for (const [id, breakdown] of Object.entries(source)) map.set(Number(id), breakdown);
    }
    return map;
  }, [lineup]);

  const squadIds = useMemo(() => new Set(squad.map((player) => player.id)), [squad]);

  /**
   * The one hot path: 667 players re-filtered on every keystroke. Everything
   * expensive happens here, never inline in the JSX below.
   */
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched: Player[] = [];

    for (const player of players) {
      if (positionFilter !== 'ALL' && player.element_type !== positionFilter) continue;
      if (squadOnly && !squadIds.has(player.id)) continue;
      if (needle && !searchKey(player).includes(needle)) continue;
      matched.push(player);
    }

    if (sortBy === 'price') {
      matched.sort(
        (a, b) => a.now_cost - b.now_cost || playerName(a).localeCompare(playerName(b))
      );
    } else if (sortBy === 'ownership') {
      matched.sort(
        (a, b) =>
          toNum(b.selected_by_percent) - toNum(a.selected_by_percent) || a.now_cost - b.now_cost
      );
    } else {
      matched.sort((a, b) => byProjection(a, b, breakdowns));
    }

    return matched;
  }, [players, search, positionFilter, squadOnly, sortBy, squadIds, breakdowns]);

  const visible = rows.length > RENDER_LIMIT ? rows.slice(0, RENDER_LIMIT) : rows;

  function handleClear() {
    setSearch('');
    setPositionFilter('ALL');
    setSquadOnly(false);
    setSortBy('xpts');
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, player: Player) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectPlayer(player);
  }

  return (
    <section className="bg-gray-900 rounded-lg shadow-lg border border-gray-800">
      {/* Controls ---------------------------------------------------------- */}
      <div className="border-b border-gray-800 p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="text-xl font-bold text-fpl-accent">Player market</h2>
          <span className="text-xs text-gray-500">xPts projected for GW{nextEvent}</span>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search player…"
            aria-label="Search players by name"
            className="flex-1 min-w-[12rem] px-3 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-fpl-accent text-sm"
          />

          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as SortKey)}
            aria-label="Sort players"
            className="px-3 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-fpl-accent text-sm"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-xs text-gray-300 select-none">
            <input
              type="checkbox"
              checked={squadOnly}
              onChange={(event) => setSquadOnly(event.target.checked)}
              className="accent-fpl-accent"
            />
            My squad only
          </label>

          <button
            type="button"
            onClick={handleClear}
            className="px-3 py-2 text-xs font-semibold rounded transition-colors bg-gray-700 text-gray-200 hover:bg-gray-600"
          >
            Clear
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          {POSITION_FILTERS.map((filter) => {
            const active = positionFilter === filter.value;
            return (
              <button
                key={filter.label}
                type="button"
                onClick={() => setPositionFilter(filter.value)}
                aria-pressed={active}
                className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
                  active
                    ? 'bg-fpl-accent text-fpl-primary'
                    : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
                }`}
              >
                {filter.label}
              </button>
            );
          })}
        </div>

        <p className="text-xs text-gray-400">
          Showing <span className="font-mono font-bold text-gray-200">{rows.length}</span> of{' '}
          <span className="font-mono">{players.length}</span> players
          {rows.length > RENDER_LIMIT && (
            <span className="text-gray-500">
              {' '}
              — capped at the top {RENDER_LIMIT} rendered rows; narrow the search to reach the rest
            </span>
          )}
        </p>
      </div>

      {/* Table ------------------------------------------------------------- */}
      {players.length === 0 ? (
        <p className="p-6 text-sm text-gray-400">Waiting for the season data to load…</p>
      ) : rows.length === 0 ? (
        <div className="p-6 text-sm text-gray-400 space-y-2">
          <p>No players match that search.</p>
          <button
            type="button"
            onClick={handleClear}
            className="px-3 py-1 text-xs font-semibold rounded transition-colors bg-gray-700 text-gray-200 hover:bg-gray-600"
          >
            Reset filters
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-800">
                <th className="px-4 py-2 font-semibold">Player</th>
                <th className="px-4 py-2 font-semibold">Club</th>
                <th className="px-4 py-2 font-semibold">Pos</th>
                <th className="px-4 py-2 font-semibold text-right">Price</th>
                <th className="px-4 py-2 font-semibold text-right">Form</th>
                <th className="px-4 py-2 font-semibold text-right">xPts</th>
                <th className="px-4 py-2 font-semibold text-right">Own %</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((player) => {
                const breakdown = breakdowns.get(player.id);
                const doubtful = breakdown?.availability.isDoubtful ?? false;
                const total = breakdown?.total;
                const averageForm = formAverage(player);
                const club = teamsMap.get(player.team);

                return (
                  <tr
                    key={player.id}
                    tabIndex={0}
                    onClick={() => selectPlayer(player)}
                    onKeyDown={(event) => handleRowKeyDown(event, player)}
                    className="border-b border-gray-800/60 hover:bg-gray-800 cursor-pointer focus:outline-none focus:bg-gray-800"
                  >
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className="font-medium">{playerName(player)}</span>
                      {doubtful && (
                        <span
                          className="ml-2 inline-block w-2 h-2 rounded-full bg-fpl-warning align-middle"
                          title={breakdown?.availability.news || 'Doubtful for the next gameweek'}
                          aria-label="Doubtful"
                        />
                      )}
                      {squadIds.has(player.id) && (
                        <span className="ml-2 text-xs text-fpl-accent">squad</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-300 whitespace-nowrap" title={club?.name}>
                      {club?.short_name ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-gray-300 font-mono">
                      {POSITIONS[player.element_type]}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">
                      £{toMillions(player.now_cost).toFixed(1)}m
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-300">
                      {averageForm > 0 ? averageForm.toFixed(1) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-fpl-accent font-bold">
                      {total === undefined ? '—' : total.toFixed(2)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-gray-300">
                      {toNum(player.selected_by_percent).toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
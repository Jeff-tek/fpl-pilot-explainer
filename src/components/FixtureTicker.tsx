import { useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { getFixtureRuns } from '../engine';
import { FixtureRun } from '../types';

function difficultyColour(difficulty: number): string {
  if (difficulty <= 1.5) return 'text-green-400 bg-green-900 bg-opacity-25 border-green-700';
  if (difficulty <= 2.5) return 'text-green-300 bg-green-900 bg-opacity-20 border-green-800';
  if (difficulty <= 3.5) return 'text-yellow-400 bg-yellow-900 bg-opacity-20 border-yellow-800';
  if (difficulty <= 4.5) return 'text-orange-400 bg-orange-900 bg-opacity-20 border-orange-800';
  return 'text-red-400 bg-red-900 bg-opacity-25 border-red-800';
}

export default function FixtureTicker() {
  const teams = useAppStore((state) => state.teams);
  const upcomingFixtures = useAppStore((state) => state.upcomingFixtures);
  const squad = useAppStore((state) => state.squad);
  const teamsMap = useAppStore((state) => state.teamsMap);

  const [mode, setMode] = useState<'easy' | 'squad'>('easy');

  /** Every club's next five gameweeks, easiest first. */
  const runs = useMemo(
    () => getFixtureRuns(teams, upcomingFixtures, 5),
    [teams, upcomingFixtures]
  );

  /** Clubs the user actually owns players for, easiest first. */
  const squadRuns = useMemo(() => {
    const teamIds = new Set(squad.map((player) => player.team));
    return runs.filter((run) => teamIds.has(run.teamId));
  }, [runs, squad]);

  const visible: FixtureRun[] = mode === 'easy' ? runs.slice(0, 10) : squadRuns;

  if (runs.length === 0) {
    return (
      <section className="bg-gray-900 rounded-lg p-4 shadow-lg">
        <h2 className="text-lg font-bold text-fpl-accent">Fixture difficulty</h2>
        <p className="text-sm text-gray-400 mt-2">
          No remaining fixtures were found for this season.
        </p>
      </section>
    );
  }

  return (
    <section className="bg-gray-900 rounded-lg p-4 shadow-lg">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 className="text-lg font-bold text-fpl-accent">
          Next 5 gameweeks of fixtures
        </h2>
        <div className="flex gap-1">
          {(['easy', 'squad'] as const).map((option) => (
            <button
              key={option}
              onClick={() => setMode(option)}
              className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
                mode === option
                  ? 'bg-fpl-accent text-fpl-primary'
                  : 'bg-gray-700 text-gray-200 hover:bg-gray-600'
              }`}
            >
              {option === 'easy' ? 'Easiest overall' : 'My clubs'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'squad' && squadRuns.length === 0 ? (
        <p className="text-sm text-gray-400">No clubs in your squad yet.</p>
      ) : (
        <div className="space-y-3">
          {visible.map((run) => {
            const club = teamsMap.get(run.teamId);
            return (
              <div key={run.teamId} className="bg-gray-800 rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-sm">
                    {club?.name ?? run.teamName}
                    <span className="text-gray-500 ml-2">{run.teamShortName}</span>
                  </span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded border ${
                      difficultyColour(run.averageDifficulty)
                    }`}
                  >
                    avg FDR {run.averageDifficulty.toFixed(2)}
                  </span>
                </div>

                <div className="flex gap-2 overflow-x-auto pb-1">
                  {run.fixtures.map((fixture) => (
                    <div
                      key={fixture.fixture.id}
                      className={`flex-shrink-0 px-3 py-1.5 rounded border text-center ${difficultyColour(
                        fixture.difficulty
                      )}`}
                    >
                      <p className="text-[10px] opacity-80">GW{fixture.fixture.event}</p>
                      <p className="text-xs font-semibold">
                        {fixture.isHome ? 'H' : 'A'} {fixture.opponentShortName}
                      </p>
                      <p className="text-[10px] font-bold">FDR {fixture.difficulty}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-4 text-xs text-gray-400">
        <span className="text-green-400 font-bold">1–2</span> easy ·{' '}
        <span className="text-yellow-400 font-bold">3</span> even ·{' '}
        <span className="text-red-400 font-bold">4–5</span> hard. FDR is published by the FPL.
      </div>
    </section>
  );
}
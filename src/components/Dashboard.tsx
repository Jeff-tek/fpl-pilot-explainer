import { useState } from 'react';
import { useAppStore } from '../store';
import { loadManagerById } from '../App';
import { toMillions } from '../utils';
import TacticalPitch from './TacticalPitch';
import PlayerModal from './PlayerModal';
import SettingsPanel from './SettingsPanel';
import LineupCard from './LineupCard';
import FixtureTicker from './FixtureTicker';
import TransferAdvisor from './TransferAdvisor';
import ChipAdvisor from './ChipAdvisor';
import SquadBrowser from './SquadBrowser';

type Panel = 'transfers' | 'players' | 'settings' | 'export';

export default function Dashboard() {
  const lineup = useAppStore((state) => state.lineup);
  const managerEntry = useAppStore((state) => state.managerEntry);
  const nextEvent = useAppStore((state) => state.nextEvent);
  const bank = useAppStore((state) => state.bank);
  const transfersMade = useAppStore((state) => state.transfersMadeThisEvent);
  const activeChip = useAppStore((state) => state.activeChip);
  const resetManager = useAppStore((state) => state.resetManager);
  const selectedPlayer = useAppStore((state) => state.selectedPlayer);

  const [panel, setPanel] = useState<Panel>('transfers');
  const [switching, setSwitching] = useState(false);
  const [nextTeamId, setNextTeamId] = useState('');

  if (!managerEntry) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-400">Loading lineup…</p>
      </div>
    );
  }

  async function handleSwitchTeam(event: React.FormEvent) {
    event.preventDefault();
    const id = Number.parseInt(nextTeamId, 10);
    if (!Number.isFinite(id) || id <= 0) return;

    setSwitching(true);
    try {
      await loadManagerById(id);
      setNextTeamId('');
    } catch {
      // loadManagerById surfaces the message in the store's error banner.
    } finally {
      setSwitching(false);
    }
  }

  const freeTransfers = Math.max(0, 1 - transfersMade);

  const tabs: { id: Panel; label: string }[] = [
    { id: 'transfers', label: 'Transfers' },
    { id: 'players', label: 'Players' },
    { id: 'settings', label: 'Model' },
    { id: 'export', label: 'Share' },
  ];

  return (
    <div className="min-h-screen bg-fpl-primary">
      <header className="bg-gray-900 border-b border-gray-800 p-4 sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-fpl-accent">FPL Pilot</h1>
            <p className="text-sm text-gray-400">
              {managerEntry.name} · planning GW{nextEvent} · £
              {toMillions(bank).toFixed(1)}m bank ·{' '}
              {freeTransfers > 0
                ? `${freeTransfers} free transfer${freeTransfers === 1 ? '' : 's'} left`
                : 'any transfer costs a hit'}
            </p>
          </div>

          <form onSubmit={handleSwitchTeam} className="flex items-center gap-2">
            <input
              type="number"
              value={nextTeamId}
              onChange={(event) => setNextTeamId(event.target.value)}
              placeholder="Team ID"
              aria-label="Switch to a different FPL team ID"
              className="w-28 px-2 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-fpl-accent"
            />
            <button
              type="submit"
              disabled={switching || !nextTeamId.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {switching ? 'Loading…' : 'Switch'}
            </button>
            <button
              type="button"
              onClick={resetManager}
              className="px-3 py-1.5 text-sm bg-gray-700 rounded hover:bg-gray-600 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-6">
        {activeChip && (
          <div className="bg-fpl-accent text-fpl-primary rounded px-4 py-2 text-sm font-semibold">
            {activeChip.toUpperCase()} is active this gameweek — the recommendations below assume the
            chip is already spent.
          </div>
        )}

        <FixtureTicker />

        <section className="bg-gray-900 rounded-lg p-6 shadow-lg">
          <h2 className="text-xl font-bold text-fpl-accent mb-4">
            Recommended XI
          </h2>
          <TacticalPitch />
        </section>

        {lineup && lineup.changes.length > 0 && (
          <section className="bg-gray-900 rounded-lg p-6 shadow-lg">
            <h2 className="text-xl font-bold text-fpl-accent mb-1">Suggested changes</h2>
            <p className="text-xs text-gray-400 mb-4">
              Each swap is free while you have a free transfer. Armband swaps count double because
              the captain scores twice.
            </p>
            <ul className="space-y-2">
              {lineup.changes.map((change) => (
                <li
                  key={`${change.direction}-${change.playerId}`}
                  className="flex items-center justify-between gap-3 text-sm bg-gray-800 rounded px-3 py-2"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        change.direction === 'in' ? 'text-fpl-success' : 'text-fpl-danger'
                      }
                    >
                      {change.direction === 'in' ? '▲ IN' : '▼ OUT'}
                    </span>
                    <span className="font-semibold">{change.playerName}</span>
                  </span>
                  <span className="text-xs text-gray-400 text-right flex-1">{change.reason}</span>
                  <span
                    className={
                      change.xPtsDelta > 0
                        ? 'text-fpl-success font-bold'
                        : 'text-gray-500 font-bold'
                    }
                  >
                    {change.xPtsDelta > 0 ? '+' : ''}
                    {change.xPtsDelta.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <nav className="flex gap-1 bg-gray-900 rounded-lg p-1 shadow-lg">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setPanel(tab.id)}
              className={`flex-1 px-4 py-2 text-sm font-semibold rounded transition-colors ${
                panel === tab.id
                  ? 'bg-fpl-accent text-fpl-primary'
                  : 'text-gray-300 hover:bg-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <section className="bg-gray-900 rounded-lg p-6 shadow-lg">
          {panel === 'transfers' && (
            <>
              <TransferAdvisor />
              <div className="mt-8 border-t border-gray-800 pt-6">
                <ChipAdvisor />
              </div>
            </>
          )}
          {panel === 'players' && <SquadBrowser />}
          {panel === 'settings' && (
            <>
              <h2 className="text-xl font-bold text-fpl-accent mb-4">
                Projection model
              </h2>
              <SettingsPanel />
            </>
          )}
          {panel === 'export' && (
            <>
              <h2 className="text-xl font-bold text-fpl-accent mb-4">
                Share your lineup
              </h2>
              <LineupCard />
            </>
          )}
        </section>
      </main>

      {selectedPlayer && <PlayerModal />}

      <footer className="text-center text-xs text-gray-500 py-8">
        Data from the official Fantasy Premier League API · projections are estimates, not advice
      </footer>
    </div>
  );
}
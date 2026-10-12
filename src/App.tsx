import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from './store';
import {
  FplApiError,
  fetchBootstrapStatic,
  fetchFixtures,
  loadManagerSnapshot,
  resolveCurrentEvent,
  resolveNextEvent,
} from './api';
import Dashboard from './components/Dashboard';
import ManagerSearch from './components/ManagerSearch';
import './App.css';

/**
 * Resolve a manager ID into a fully loaded squad inside the store.
 * Shared by the initial restore and by manual team switching.
 */
export async function loadManagerById(managerId: number): Promise<void> {
  const store = useAppStore.getState();
  store.setStatus('loading-manager');
  store.setError(null);

  try {
    if (store.players.length === 0) {
      throw new FplApiError(
        'Season data is not loaded yet. Please wait a moment and try again.',
        '/bootstrap-static/'
      );
    }
    const snapshot = await loadManagerSnapshot(managerId, store.players);
    // `loadManager` also flips status to 'ready' and triggers recompute.
    useAppStore.getState().loadManager(snapshot);
  } catch (error) {
    const message =
      error instanceof FplApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Something went wrong loading that team.';
    useAppStore.getState().setError(message);
    throw error;
  }
}

export default function App() {
  const status = useAppStore((state) => state.status);
  const error = useAppStore((state) => state.error);
  const managerId = useAppStore((state) => state.managerId);
  const squad = useAppStore((state) => state.squad);
  const players = useAppStore((state) => state.players);

  const [seasonError, setSeasonError] = useState<string | null>(null);

  const loadSeason = useCallback(async () => {
    setSeasonError(null);
    useAppStore.getState().setStatus('loading-season');

    try {
      const [bootstrap, fixtures] = await Promise.all([
        fetchBootstrapStatic(),
        fetchFixtures(),
      ]);

      // `nextEvent` is the first unplayed gameweek — the one every fixture
      // lookup, projection and transfer recommendation is anchored to.
      const nextEvent = resolveNextEvent(bootstrap);
      const currentEvent = resolveCurrentEvent(bootstrap);

      useAppStore.getState().loadSeason(bootstrap, fixtures, nextEvent, currentEvent);
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : 'Could not load Fantasy Premier League data.';
      setSeasonError(message);
      useAppStore.getState().setStatus('error');
    }
  }, []);

  useEffect(() => {
    void loadSeason();
  }, [loadSeason]);

  // Restore the last-used team once the season data is available.
  useEffect(() => {
    if (players.length === 0 || squad.length > 0 || !managerId) return;

    const id = Number.parseInt(managerId, 10);
    if (!Number.isFinite(id) || id <= 0) {
      useAppStore.getState().resetManager();
      return;
    }

    void loadManagerById(id).catch(() => {
      // `loadManagerById` writes the message into the store; a stale saved ID
      // must not trap the user on a loading screen, so fall back to search.
      useAppStore.getState().resetManager();
    });
  }, [players.length, managerId]);

  // The season failed outright — nothing else can work without it.
  if (seasonError) {
    return (
      <div className="min-h-screen bg-fpl-primary flex items-center justify-center p-4">
        <div className="bg-gray-900 rounded-lg p-8 max-w-lg w-full text-center">
          <h1 className="text-3xl font-bold text-fpl-accent mb-3">FPL Pilot</h1>
          <p className="text-fpl-danger mb-4">{seasonError}</p>
          <p className="text-sm text-gray-400 mb-6">
            FPL Pilot reads live data from fantasy.premierleague.com through its own{' '}
            <code className="text-fpl-accent">/api/fpl/*</code> proxy, which runs as part of
            this deployment. This usually means the proxy function failed to start.
          </p>
          <button
            onClick={() => void loadSeason()}
            className="px-6 py-2 bg-fpl-accent text-fpl-primary font-bold rounded hover:bg-fpl-accent/90 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (status === 'loading-season' || status === 'idle') {
    return (
      <div className="min-h-screen bg-fpl-primary flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-fpl-accent mb-4">FPL Pilot</h1>
          <p className="text-gray-300">Loading Fantasy Premier League data…</p>
          <p className="text-xs text-gray-500 mt-2">
            Fetching 38 gameweeks of fixtures and every Premier League player
          </p>
        </div>
      </div>
    );
  }

  if (status === 'loading-manager') {
    return (
      <div className="min-h-screen bg-fpl-primary flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-fpl-accent mb-4">FPL Pilot</h1>
          <p className="text-gray-300">Loading your squad…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-fpl-primary text-white">
      {error && (
        <div className="bg-fpl-danger text-white p-3 text-center text-sm">
          {error}
          {managerId && (
            <button
              onClick={() => useAppStore.getState().resetManager()}
              className="ml-3 underline font-semibold"
            >
              Choose a different team
            </button>
          )}
        </div>
      )}

      {squad.length >= 11 ? <Dashboard /> : <ManagerSearch />}
    </div>
  );
}
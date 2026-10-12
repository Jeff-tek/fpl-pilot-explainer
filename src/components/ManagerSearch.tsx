import { useState, type FormEvent } from 'react';
import { useAppStore } from '../store';
import { FplApiError, loadManagerSnapshot } from '../api';

interface Props {
  /** Called once a squad has been loaded successfully. */
  onLoaded?: () => void;
}

/**
 * A real, public FPL team from the 2026/27 season. The previous build shipped
 * invented IDs (2432, 1) which 404 against the live API.
 */
const DEMO_TEAM_ID = 3808385;

const INVALID_ID_MESSAGE = 'Team ID must be a positive whole number';

const TEAM_ID_PATTERN = /^\d+$/;

interface Notice {
  tone: 'error' | 'warning';
  text: string;
}

/**
 * Validate before spending a round trip. The FPL API answers nonsense IDs with
 * a 404, but an inline hint is a far better experience than a failed load — and
 * a request with no players available cannot be resolved anyway.
 */
function parseTeamId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!TEAM_ID_PATTERN.test(trimmed)) return null;
  const id = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

export default function ManagerSearch({ onLoaded }: Props) {
  // Individual selectors: this screen only cares about the player list (to keep
  // the load from resolving against nothing) and the store's load action.
  const players = useAppStore((state) => state.players);
  const loadManager = useAppStore((state) => state.loadManager);

  const [teamId, setTeamId] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(false);

  const seasonReady = players.length > 0;

  function handleChange(value: string) {
    setTeamId(value);
    // Any edit clears the previous complaint — the message is about the text
    // the user has just replaced.
    setNotice(null);
  }

  async function load(id: number) {
    if (loading) return;

    if (!seasonReady) {
      setNotice({
        tone: 'warning',
        text: 'Season data is not loaded yet, so a squad cannot be matched to real players. Wait for the season to finish loading, and make sure the FPL Pilot server is running.',
      });
      return;
    }

    setLoading(true);
    setNotice(null);

    try {
      // api.ts owns squad resolution; the store action owns everything else.
      const snapshot = await loadManagerSnapshot(id, useAppStore.getState().players);
      loadManager(snapshot);
      onLoaded?.();
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof FplApiError || error instanceof Error
            ? error.message
            : 'Could not load that team.',
      });
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsed = parseTeamId(teamId);
    if (parsed === null) {
      setNotice({ tone: 'error', text: INVALID_ID_MESSAGE });
      return;
    }

    void load(parsed);
  }

  function handleDemo() {
    setTeamId(String(DEMO_TEAM_ID));
    void load(DEMO_TEAM_ID);
  }

  return (
    <div className="min-h-screen bg-fpl-primary flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-lg shadow-2xl p-8 max-w-md w-full">
        <h1 className="text-4xl font-bold text-fpl-accent mb-2 text-center">FPL Pilot</h1>
        <p className="text-gray-400 text-center mb-8">
          Explainable Fantasy Premier League Assistant
        </p>

        {!seasonReady && (
          <div className="mb-6 bg-yellow-900 bg-opacity-30 border border-yellow-700 rounded p-3 text-xs text-yellow-200">
            <p className="font-semibold mb-1">Season data is still loading</p>
            <p>
              FPL Pilot needs the full player list before it can read your squad. If this
              message stays, the dev server is probably not running — start it with{' '}
              <span className="text-fpl-accent">npm run dev</span>.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mb-8">
          <label htmlFor="team-id" className="block text-sm font-semibold mb-2">
            Your FPL Team ID
          </label>
          <input
            id="team-id"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={teamId}
            onChange={(event) => handleChange(event.target.value)}
            placeholder="Enter your team ID"
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded focus:outline-none focus:border-fpl-accent text-white"
            disabled={loading}
          />

          {notice && (
            <p
              role="alert"
              className={`text-sm mt-2 ${notice.tone === 'error' ? 'text-fpl-danger' : 'text-fpl-warning'}`}
            >
              {notice.text}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !seasonReady}
            className="w-full mt-4 px-4 py-2 bg-fpl-accent text-fpl-primary font-bold rounded hover:bg-fpl-accent/90 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Loading…' : 'Load Team'}
          </button>
        </form>

        <div className="relative mb-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-700" />
          </div>
          <div className="relative flex justify-center text-sm">
            <span className="px-2 bg-gray-900 text-gray-400">or explore first</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleDemo}
          disabled={loading || !seasonReady}
          className="w-full px-4 py-2 bg-gray-800 text-white border border-gray-700 rounded hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          Try a demo team (#{DEMO_TEAM_ID})
        </button>

        <p className="text-gray-500 text-xs text-center mt-6">
          Find your FPL Team ID in your account settings or the URL of your team page
        </p>
      </div>
    </div>
  );
}
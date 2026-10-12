import { useRef, useState } from 'react';
import { useAppStore } from '../store';
import { POSITIONS } from '../types';
import { toMillions } from '../utils';

export default function LineupCard() {
  const lineup = useAppStore((state) => state.lineup);
  const managerEntry = useAppStore((state) => state.managerEntry);
  const nextEvent = useAppStore((state) => state.nextEvent);

  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!lineup || !managerEntry) return null;

  const advice = lineup;
  const entry = managerEntry;

  const handleExport = async () => {
    if (!cardRef.current) return;

    setBusy(true);
    setMessage(null);

    try {
      // Imported lazily: html2canvas is ~200 kB and only needed on demand.
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(cardRef.current, {
        backgroundColor: '#37003c',
        scale: 2,
        useCORS: true,
      });

      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `FPL-Pilot-GW${nextEvent}.png`;
      link.click();
      setMessage('Image saved to your downloads.');
    } catch (error) {
      console.error('Failed to export card:', error);
      setMessage('Could not render the image. Use "Copy text" instead.');
    } finally {
      setBusy(false);
    }
  }

  const handleCopy = () => {
    const lines = [
      `FPL Pilot — GW${nextEvent}`,
      `${entry.name}`,
      '',
      `Formation ${advice.formation.join('-')} — projected ${advice.projectedPoints.toFixed(1)} pts`,
      '',
      ...advice.starters.map(
        (player) =>
          `• ${player.web_name} (${POSITIONS[player.element_type]}, £${toMillions(
            player.now_cost
          ).toFixed(1)}m) ${advice.breakdownById[player.id]?.total.toFixed(1) ?? '—'} pts`
      ),
      '',
      `C: ${advice.captain.web_name}`,
      `VC: ${advice.viceCaptain.web_name}`,
      '',
      `Bench: ${advice.bench.map((player) => player.web_name).join(', ')}`,
    ];

    const text = lines.join('\n');

    navigator.clipboard
      .writeText(text)
      .then(() => setMessage('Lineup copied to your clipboard.'))
      .catch(() => setMessage('Clipboard unavailable — select the card text instead.'));
  }

  return (
    <div className="space-y-4">
      <div
        ref={cardRef}
        className="bg-gradient-primary rounded-lg p-8 max-w-sm mx-auto text-center"
      >
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-fpl-accent mb-1">FPL PILOT</h1>
          <p className="text-gray-300">{managerEntry.name}</p>
          <p className="text-xs text-gray-400">Gameweek {nextEvent}</p>
        </div>

        <div className="bg-black bg-opacity-30 rounded p-4 mb-6">
          <p className="text-xs text-gray-400 mb-1">Formation</p>
          <p className="text-3xl font-bold text-fpl-accent">{lineup.formation.join('-')}</p>
        </div>

        <div className="mb-6 text-left">
          <h3 className="font-bold text-fpl-accent mb-3 text-center">Starting XI</h3>
          <div className="grid grid-cols-2 gap-2">
            {lineup.starters.map((player) => {
              const isCaptain = player.id === lineup.captain.id;
              const isVice = player.id === lineup.viceCaptain.id;
              return (
                <div
                  key={player.id}
                  className="bg-black bg-opacity-20 rounded p-2 text-xs"
                >
                  <p className="font-semibold truncate">
                    {player.web_name}
                    {isCaptain && ' ★'}
                    {isVice && ' ☆'}
                  </p>
                  <p className="text-gray-400">
                    {POSITIONS[player.element_type]} ·{' '}
                    {lineup.breakdownById[player.id]?.total.toFixed(1) ?? '—'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-black bg-opacity-30 rounded p-4 mb-6">
          <p className="text-xs text-gray-400 mb-2">Projected points</p>
          <p className="text-4xl font-bold text-fpl-accent mb-2">
            {lineup.projectedPoints.toFixed(1)}
          </p>
          <div className="flex justify-around text-xs">
            <div>
              <p className="text-gray-400">Captain</p>
              <p className="font-semibold">{lineup.captain.web_name}</p>
            </div>
            <div>
              <p className="text-gray-400">Vice</p>
              <p className="font-semibold">{lineup.viceCaptain.web_name}</p>
            </div>
          </div>
        </div>

        <div className="text-xs text-gray-400">
          <p className="mb-1">
            Bench: {lineup.bench.map((player) => player.web_name).join(', ')}
          </p>
        </div>

        <div className="mt-6 pt-4 border-t border-gray-700">
          <p className="text-xs text-gray-500">Generated by FPL Pilot</p>
        </div>
      </div>

      <div className="flex gap-2 max-w-sm mx-auto">
        <button
          onClick={handleExport}
          disabled={busy}
          className="flex-1 px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {busy ? 'Rendering…' : 'Export image'}
        </button>
        <button
          onClick={handleCopy}
          className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
        >
          Copy text
        </button>
      </div>

      {message && <p className="text-center text-xs text-gray-400">{message}</p>}
    </div>
  );
}
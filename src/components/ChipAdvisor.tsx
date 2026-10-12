import { useAppStore } from '../store';
import type { ChipAdvice, ChipId } from '../types';

/**
 * Explicit chip names so the card reads correctly even if the engine's `label`
 * changes wording. The engine already emits these, but the id is the contract.
 */
const CHIP_NAMES: Record<ChipId, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  benchboost: 'Bench Boost',
  triplecaptain: 'Triple Captain',
};

/** Short gloss under the chip name, so the id is never the only cue. */
const CHIP_BLURBS: Record<ChipId, string> = {
  wildcard: 'Re-roll your whole squad, no transfer cost',
  freehit: 'Unlimited transfers that revert after one gameweek',
  benchboost: 'All four substitutes start, no transfer cost',
  triplecaptain: 'Your captain scores triple points',
};

/**
 * Confidence is shown as a word *and* a colour *and* a filled-bar count, so it
 * is never communicated by colour alone.
 */
const CONFIDENCE: Record<
  ChipAdvice['confidence'],
  { label: string; filled: number; text: string; bar: string }
> = {
  high: { label: 'High confidence', filled: 3, text: 'text-fpl-success', bar: 'bg-fpl-success' },
  medium: {
    label: 'Medium confidence',
    filled: 2,
    text: 'text-fpl-warning',
    bar: 'bg-fpl-warning',
  },
  low: { label: 'Low confidence', filled: 1, text: 'text-gray-400', bar: 'bg-gray-500' },
};

function ConfidenceMeter({ confidence }: { confidence: ChipAdvice['confidence'] }) {
  const meta = CONFIDENCE[confidence];

  return (
    <span className="inline-flex items-center gap-1.5" title={meta.label}>
      <span className="flex items-end gap-0.5" aria-hidden="true">
        {[0, 1, 2].map((step) => (
          <span
            key={step}
            className={`w-1.5 rounded-sm ${
              step < meta.filled ? `${meta.bar} h-3` : 'bg-gray-700 h-3'
            }`}
          />
        ))}
      </span>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${meta.text}`}>
        {meta.label}
      </span>
    </span>
  );
}

function ChipCard({ advice }: { advice: ChipAdvice }) {
  const { recommended, chip, headline, rationale, timing, label } = advice;
  const name = CHIP_NAMES[chip];

  return (
    <li
      className={`mb-2 rounded border p-3 ${
        recommended
          ? 'border-fpl-accent bg-gray-800 ring-1 ring-fpl-accent/30'
          : 'border-gray-700 bg-gray-800/40'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3
            className={`text-sm font-bold ${recommended ? 'text-fpl-accent' : 'text-gray-400'}`}
          >
            {name}
          </h3>
          {/* The engine label is the fallback name; only show it if it differs. */}
          {label && label !== name && (
            <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
          )}
          {recommended && (
            <span className="rounded bg-fpl-accent px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-fpl-primary">
              Use it
            </span>
          )}
        </div>
        <ConfidenceMeter confidence={advice.confidence} />
      </div>

      <p className="mt-0.5 text-[10px] text-gray-500">{CHIP_BLURBS[chip]}</p>

      <p className={`mt-1.5 text-sm ${recommended ? 'text-gray-100' : 'text-gray-400'}`}>
        {headline}
      </p>

      {rationale.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {rationale.map((line) => (
            <li key={line} className="text-xs text-gray-400">
              &bull; {line}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 border-t border-gray-700/60 pt-1.5 text-xs text-gray-400">
        <span className="font-semibold text-gray-500">Timing: </span>
        {timing}
      </p>
    </li>
  );
}

export default function ChipAdvisor() {
  const chipAdvice = useAppStore((state) => state.chipAdvice);

  const recommendedCount = chipAdvice.filter((advice) => advice.recommended).length;

  return (
    <section className="bg-gray-900 rounded-lg p-4 shadow-lg">
      <header className="mb-3">
        <h2 className="text-lg font-bold text-fpl-accent">&#127183; Chip Advisor</h2>
        <p className="text-xs text-gray-400">
          {chipAdvice.length === 0
            ? 'No chip assessment available yet.'
            : `${chipAdvice.length} chips assessed &bull; ${recommendedCount} recommended to play now`}
        </p>
      </header>

      {chipAdvice.length === 0 ? (
        <div className="rounded border border-dashed border-gray-700 bg-gray-800/40 p-4 text-center">
          <p className="text-sm font-semibold text-gray-300">No chip advice yet.</p>
          <p className="mt-1 text-xs text-gray-400">
            Load your manager and a full squad, and the model will tell you whether to hold or play.
          </p>
        </div>
      ) : (
        <ul className="list-none">
          {chipAdvice.map((advice) => (
            <ChipCard key={advice.chip} advice={advice} />
          ))}
        </ul>
      )}
    </section>
  );
}

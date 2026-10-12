import { useMemo, useState } from 'react';
import { normaliseWeights, useAppStore } from '../store';
import { DEFAULT_XPTS_WEIGHTS, Formation, VALID_FORMATIONS, XPtsWeights } from '../types';

interface Props {
  onClose?: () => void;
}

type WeightKey = keyof XPtsWeights;

interface WeightMeta {
  key: WeightKey;
  label: string;
  description: string;
}

/** Every tunable influence on the model, in the order the model applies them. */
const WEIGHT_META: WeightMeta[] = [
  { key: 'form', label: 'Form', description: 'Recent form (points per game)' },
  {
    key: 'underlyingMetrics',
    label: 'Underlying metrics',
    description: 'Underlying metrics (xGI, ICT, saves)',
  },
  { key: 'fdr', label: 'Fixture difficulty', description: 'Fixture difficulty (1 easy - 5 hard)' },
  { key: 'homeAwayBoost', label: 'Home advantage', description: 'Home advantage' },
  {
    key: 'availability',
    label: 'Availability',
    description: 'Availability and injury news',
  },
];

/** FPL formations are quoted as DEF-MID-FWD; the goalkeeper is always implicit. */
function formationLabel([, def, mid, fwd]: Formation): string {
  return `${def}-${mid}-${fwd}`;
}

export default function SettingsPanel({ onClose }: Props) {
  // Action selectors never change identity, so these cost no extra renders.
  const setWeights = useAppStore((state) => state.setWeights);
  const resetWeights = useAppStore((state) => state.resetWeights);
  const setForcedFormation = useAppStore((state) => state.setForcedFormation);
  const forcedFormation = useAppStore((state) => state.forcedFormation);

  /**
   * The sliders keep their own raw values: the store normalises on write, so
   * echoing it back into the draft would quantise the thumb to whatever step the
   * normalised number happens to land on.
   */
  const [draft, setDraft] = useState<XPtsWeights>(() => ({ ...useAppStore.getState().weights }));
  const [applied, setApplied] = useState(false);

  const total = useMemo(
    () => WEIGHT_META.reduce((sum, meta) => sum + draft[meta.key], 0),
    [draft]
  );

  function share(key: WeightKey): number {
    // Every weight can be dragged to 0, so the percentage needs a guard.
    return total > 0 ? (draft[key] / total) * 100 : 0;
  }

  function handleChange(key: WeightKey, value: number) {
    const next: XPtsWeights = { ...draft, [key]: value };
    setDraft(next);
    setApplied(false);
    // Live-update the pitch as the slider moves. setWeights normalises again.
    setWeights(next);
  }

  function handleApply() {
    setWeights(normaliseWeights(draft));
    setApplied(true);
  }

  function handleReset() {
    resetWeights();
    setDraft({ ...DEFAULT_XPTS_WEIGHTS });
    setApplied(false);
  }

  const forcedKey = forcedFormation ? formationLabel(forcedFormation) : null;

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------------- */}
      {/* xPts weights                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section>
        <div className="bg-blue-900 bg-opacity-30 border border-blue-700 rounded p-3 text-xs text-blue-200 mb-4">
          ℹ️ Weights are relative — the model normalises them to sum to 100%. Move a
          slider up and everything else is scaled down to match, and the pitch re-runs
          immediately.
        </div>

        <div className="space-y-4">
          {WEIGHT_META.map((meta) => (
            <div key={meta.key}>
              <div className="flex items-baseline justify-between mb-1">
                <label htmlFor={`weight-${meta.key}`} className="font-semibold text-sm">
                  {meta.label}
                </label>
                <span className="text-fpl-accent font-bold text-sm">
                  {share(meta.key).toFixed(1)}%
                </span>
              </div>
              <input
                id={`weight-${meta.key}`}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draft[meta.key]}
                onChange={(event) =>
                  handleChange(meta.key, Number.parseFloat(event.target.value))
                }
                className="w-full"
              />
              <p className="text-xs text-gray-400 mt-1">{meta.description}</p>
            </div>
          ))}
        </div>

        <div className="bg-gray-800 rounded p-3 mt-4 text-xs text-gray-400 flex justify-between">
          <span>Raw total</span>
          <span className="font-mono text-gray-200">{total.toFixed(2)}</span>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={handleReset}
            className="flex-1 px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="flex-1 px-4 py-2 bg-fpl-accent text-fpl-primary font-bold rounded hover:bg-fpl-accent/90 transition-colors"
          >
            Apply
          </button>
        </div>

        {applied && (
          <p className="text-xs text-fpl-success mt-2">
            Applied — weights normalised and saved.
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Formation                                                         */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-t border-gray-700 pt-6">
        <h4 className="font-semibold text-fpl-accent mb-1">Formation</h4>
        <p className="text-xs text-gray-400 mb-4">
          Forcing a formation constrains the optimiser to fill only that shape, instead of
          letting it search every legal one for the highest-scoring XI.
        </p>

        <div className="grid grid-cols-4 gap-2">
          <FormationButton
            label="Auto"
            sublabel="best XI"
            active={forcedKey === null}
            onClick={() => setForcedFormation(null)}
          />
          {VALID_FORMATIONS.map((formation) => (
            <FormationButton
              key={formationLabel(formation)}
              label={formationLabel(formation)}
              sublabel={forcedKey === formationLabel(formation) ? 'active' : ' '}
              active={forcedKey === formationLabel(formation)}
              onClick={() => setForcedFormation(formation)}
            />
          ))}
        </div>
      </section>

      {onClose && (
        <section className="border-t border-gray-700 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2 bg-gray-800 text-white border border-gray-700 rounded hover:bg-gray-700 transition-colors"
          >
            Done
          </button>
        </section>
      )}
    </div>
  );
}

interface FormationButtonProps {
  label: string;
  sublabel: string;
  active: boolean;
  onClick: () => void;
}

function FormationButton({ label, sublabel, active, onClick }: FormationButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-2 py-2 rounded border text-sm font-bold transition-colors ${
        active
          ? 'bg-fpl-accent text-fpl-primary border-fpl-accent'
          : 'bg-gray-800 text-gray-200 border-gray-700 hover:bg-gray-700'
      }`}
    >
      {label}
      <span className="block text-[10px] font-normal opacity-70">{sublabel}</span>
    </button>
  );
}
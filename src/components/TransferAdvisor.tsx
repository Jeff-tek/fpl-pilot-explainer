import { useState } from 'react';
import { useAppStore } from '../store';
import { POSITIONS } from '../types';
import type { Player, TransferPlan, TransferSuggestion } from '../types';
import { playerName, toMillions } from '../utils';

/** Which of the two advisor views is on screen. */
type ViewMode = 'single' | 'plans';

interface SwapLegProps {
  player: Player;
  xPts: number;
  side: 'in' | 'out';
  disabled: boolean;
  onSelect: (player: Player) => void;
}

/**
 * One side of a swap: a clickable player name plus their projected points.
 * Clicking opens the shared PlayerModal via the store.
 */
function SwapLeg({ player, xPts, side, disabled, onSelect }: SwapLegProps) {
  return (
    <span className="flex items-baseline gap-1">
      <button
        type="button"
        onClick={() => onSelect(player)}
        title={`Open ${playerName(player)}`}
        className={`text-xs font-semibold underline underline-offset-2 transition-colors hover:text-fpl-accent ${
          side === 'out' ? 'text-red-300' : 'text-green-300'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        {playerName(player)}
      </button>
      <span className="text-[10px] uppercase tracking-wide text-gray-500">
        {POSITIONS[player.element_type]}
      </span>
      <span className="text-[10px] text-gray-400">{xPts.toFixed(1)}pts</span>
    </span>
  );
}

/**
 * cashDelta is tenths of a million: positive means you spend, negative means the
 * sale funds part of the purchase. Rendered as a cost or a credit accordingly.
 */
function formatCash(cashDelta: number): { text: string; className: string } {
  if (cashDelta > 0) {
    return { text: `£${toMillions(cashDelta).toFixed(1)}m cost`, className: 'text-gray-300' };
  }
  if (cashDelta < 0) {
    return {
      text: `+£${toMillions(-cashDelta).toFixed(1)}m credit`,
      className: 'text-fpl-success',
    };
  }
  return { text: 'Even swap', className: 'text-gray-500' };
}

function SwapArrow() {
  return (
    <span aria-hidden="true" className="text-gray-600">
      &rarr;
    </span>
  );
}

interface SingleTransferRowProps {
  suggestion: TransferSuggestion;
  onSelect: (player: Player) => void;
}

function SingleTransferRow({ suggestion, onSelect }: SingleTransferRowProps) {
  const { breachesClubLimit } = suggestion;
  const cash = formatCash(suggestion.cashDelta);

  return (
    <li
      className={`border-t border-gray-800 py-2 first:border-t-0 ${
        breachesClubLimit ? 'opacity-50' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="w-5 shrink-0 text-center font-mono text-[10px] text-gray-500">
          {suggestion.rank}
        </span>
        <SwapLeg
          player={suggestion.sell}
          xPts={suggestion.sellXPts}
          side="out"
          disabled={breachesClubLimit}
          onSelect={onSelect}
        />
        <SwapArrow />
        <SwapLeg
          player={suggestion.buy}
          xPts={suggestion.buyXPts}
          side="in"
          disabled={breachesClubLimit}
          onSelect={onSelect}
        />
        <span className="ml-auto shrink-0 font-mono text-xs font-bold text-fpl-success">
          +{suggestion.netGain.toFixed(1)} pts
        </span>
      </div>

      <div className="mt-1 flex items-start justify-between gap-2 pl-7">
        <p className="text-xs text-gray-400">{suggestion.reason}</p>
        <span className={`shrink-0 whitespace-nowrap font-mono text-xs ${cash.className}`}>
          {cash.text}
        </span>
      </div>

      {breachesClubLimit && (
        <p className="mt-1 pl-7">
          <span className="rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-300">
            4 from one club &mdash; not allowed
          </span>
        </p>
      )}
    </li>
  );
}

interface MultiTransferPlanCardProps {
  plan: TransferPlan;
  onSelect: (player: Player) => void;
}

function MultiTransferPlanCard({ plan, onSelect }: MultiTransferPlanCardProps) {
  const cash = formatCash(plan.cashDelta);

  return (
    <li
      className={`mb-2 rounded border p-2 ${
        plan.feasible ? 'border-gray-700 bg-gray-800/60' : 'border-red-800 bg-red-900/20'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-100">{plan.headline}</h3>
        <span className="font-mono text-xs font-bold text-fpl-success">
          +{plan.netGain.toFixed(1)} pts
        </span>
      </div>

      <ol className="mt-1.5 space-y-1">
        {plan.transfers.map((transfer, index) => {
          const leg = formatCash(transfer.cashDelta);
          return (
            <li
              key={transfer.id}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-gray-700/60 pt-1"
            >
              <span className="w-4 shrink-0 text-center font-mono text-[10px] text-gray-500">
                {index + 1}
              </span>
              <SwapLeg
                player={transfer.sell}
                xPts={transfer.sellXPts}
                side="out"
                disabled={false}
                onSelect={onSelect}
              />
              <SwapArrow />
              <SwapLeg
                player={transfer.buy}
                xPts={transfer.buyXPts}
                side="in"
                disabled={false}
                onSelect={onSelect}
              />
              <span className={`ml-auto shrink-0 font-mono text-[10px] ${leg.className}`}>
                {leg.text}
              </span>
            </li>
          );
        })}
      </ol>

      {!plan.feasible && (
        <p className="mt-1.5 rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-300">
          Not feasible this gameweek
        </p>
      )}

      {plan.blockers.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {plan.blockers.map((blocker) => (
            <li key={blocker} className="text-[10px] text-gray-400">
              &bull; {blocker}
            </li>
          ))}
        </ul>
      )}

      <p className={`mt-1 text-right text-[10px] ${cash.className}`}>Net {cash.text}</p>
    </li>
  );
}

function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded border border-dashed border-gray-700 bg-gray-800/40 p-4 text-center">
      <p className="text-sm font-semibold text-gray-300">{title}</p>
      <p className="mt-1 text-xs text-gray-400">{detail}</p>
    </div>
  );
}

export default function TransferAdvisor() {
  const transferOptions = useAppStore((state) => state.transferOptions);
  const transferPlans = useAppStore((state) => state.transferPlans);
  const bank = useAppStore((state) => state.bank);
  const transfersMadeThisEvent = useAppStore((state) => state.transfersMadeThisEvent);
  const selectPlayer = useAppStore((state) => state.selectPlayer);

  const [view, setView] = useState<ViewMode>('single');

  return (
    <section className="bg-gray-900 rounded-lg p-4 shadow-lg">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-fpl-accent">&#128260; Transfer Advisor</h2>
          <p className="text-xs text-gray-400">
            Bank &pound;{toMillions(bank).toFixed(1)}m
            {transfersMadeThisEvent > 0 && (
              <span className="text-fpl-warning">
                {' '}
                &bull; {transfersMadeThisEvent} transfer
                {transfersMadeThisEvent === 1 ? '' : 's'} used, further moves cost a hit
              </span>
            )}
          </p>
        </div>
      </header>

      {/* View toggle */}
      <div className="mb-3 inline-flex rounded border border-gray-700 bg-gray-800 p-0.5">
        {(
          [
            ['single', `Single transfers (${transferOptions.length})`],
            ['plans', `Multi-transfer plans (${transferPlans.length})`],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => setView(mode)}
            aria-pressed={view === mode}
            className={`rounded px-2 py-1 text-xs transition-colors ${
              view === mode
                ? 'bg-fpl-accent font-bold text-fpl-primary'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'single' ? (
        transferOptions.length === 0 ? (
          <EmptyPanel
            title="No transfer improves your projection this gameweek."
            detail="Holding is correct. Revisit once team news or fixtures change."
          />
        ) : (
          <ul className="list-none">
            {transferOptions.map((suggestion) => (
              <SingleTransferRow
                key={suggestion.id}
                suggestion={suggestion}
                onSelect={selectPlayer}
              />
            ))}
          </ul>
        )
      ) : transferPlans.length === 0 ? (
        <EmptyPanel
          title="No feasible multi-transfer plan."
          detail="Every combination either breaches the club limit or costs more than your bank allows."
        />
      ) : (
        <ul className="list-none">
          {transferPlans.map((plan) => (
            <MultiTransferPlanCard key={plan.id} plan={plan} onSelect={selectPlayer} />
          ))}
        </ul>
      )}
    </section>
  );
}
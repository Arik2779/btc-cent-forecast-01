// btc-cent-forecast-01 entry (Node 22, standard library only): a damped
// 24-hour mean-reversion forecaster for Bitcoin's price 240 minutes ahead.
//
//   guess = last * exp(clamp(-GAIN * log(last / price[24h ago]), +/-CAP))
//
// with GAIN = 0.06 and CAP = 0.015 (1.5% per 4 hours).
//
// Why this shape, and why so small:
//
//   - The score is mean absolute error, so the best guess is the conditional
//     median of the price 4 hours out. For a near-random walk that median is
//     the checkpoint close itself (persistence, the house baseline). Any
//     adjustment must earn its keep, and it must be small, because every
//     dollar it adds in the wrong direction is a dollar of error.
//   - On the practice history (Nov 7-11 2026, one continuous 1-minute
//     series rebuilt from the six practice windows), the 4-hour log return
//     is negatively correlated with the trailing 24-hour log return
//     (corr about -0.61 on walk-forward points; lag-1 autocorrelation of
//     non-overlapping 4-hour returns about -0.39). The pool's price snaps
//     back after a large 24-hour move. Momentum models (earnings-weighted
//     drift, trailing-return extrapolation, per-case OLS) all score WORSE
//     than persistence on the same history, so the only adjustment that
//     survives is a small reversion against the 24-hour move.
//   - The gain is deliberately shrunk far below the OLS estimate (-0.16):
//     the effective sample is only ~24 independent 4-hour returns in the
//     whole practice window, so a fitted gain would be overfit to one week.
//     At GAIN = 0.06 the backtests read: walk-forward 4-hour MAE 41,267
//     cents vs 42,939 for persistence (-3.9%); 16 non-overlapping 4-hour
//     checkpoints 40,705 vs 41,768 (-2.5%), better in both halves of the
//     week; the 5 graded practice checkpoints 47,118 vs 47,055 (neutral,
//     +0.1%). The downside if the effect is absent is ~0.1%; the upside if
//     it holds is a few percent. That asymmetry is the whole bet.
//   - CAP bounds the damage: no matter how far the price ran in the last
//     24 hours, the forecast never moves more than 1.5% from the checkpoint
//     close, so a regime flip cannot turn one case into a blowout.
//
// The program is deterministic (no randomness, no time, no network) and
// O(n) in the case's prices, so two runs write identical bytes in a few
// milliseconds, far under the 8-second cap.
//
// I/O contract (from the kit's RULES.txt): read every <id>.in in the input
// directory (MAKEFUN_INPUT_DIR or /input), each a case of 4,320 one-minute
// closes ending at its checkpoint; write <id>.out to the output directory
// (MAKEFUN_OUTPUT_DIR or /output) as {"forecasts":[{"case":"<id>",
// "price":<number>}]}, exactly one row, price on the grid's 5 decimals
// inside (0, 10,000,000).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The smallest positive price on the grid: one unit of its 5 decimals. */
const MIN_PRICE = 0.00001;
/** The largest grid price below the scorer's exclusive 10,000,000-dollar cap. */
const MAX_PRICE = 9_999_999.99999;

/** How far back the reversion looks, in minutes: one day of closes. */
const LOOKBACK_MINUTES = 1440;
/** Fraction of the trailing 24-hour log return the forecast reverses. */
const REVERSION_GAIN = 0.06;
/** Widest the forecast may move from the checkpoint close, in log terms. */
const MAX_LOG_MOVE = 0.015;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  markets: CaseMarket[];
}

/** x kept on the grid's 5 decimals and inside the scorer's (0, 10,000,000). */
const price5 = (x: number): number => Math.round(Math.min(MAX_PRICE, Math.max(MIN_PRICE, x)) * 1e5) / 1e5;

/**
 * Forecast for one case: the checkpoint close nudged against the trailing
 * 24-hour move. With fewer than LOOKBACK closes the lag is the whole
 * history; with too little history it is plain persistence.
 */
function forecast(m: CaseMarket): number {
  if (!Array.isArray(m.prices) || m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const last = m.prices[m.prices.length - 1] as number;
  if (typeof last !== 'number' || !Number.isFinite(last)) throw new Error(`market ${m.id}'s last price is not a finite number`);
  const n = m.prices.length;
  if (n <= 60) return price5(last);
  const lag = Math.min(LOOKBACK_MINUTES, n - 1);
  const past = m.prices[n - 1 - lag] as number;
  if (typeof past !== 'number' || !Number.isFinite(past) || past <= 0) return price5(last);
  const trailing = Math.log(last / past);
  const move = Math.max(-MAX_LOG_MOVE, Math.min(MAX_LOG_MOVE, -REVERSION_GAIN * trailing));
  return price5(last * Math.exp(move));
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (!Array.isArray(c.markets) || c.markets.length !== 1) throw new Error(`${file} does not hold exactly one market`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts: [{ case: id, price: forecast(c.markets[0] as CaseMarket) }] })}\n`);
}

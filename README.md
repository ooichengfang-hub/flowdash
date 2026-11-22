# FlowDash · Crypto Liquidity & Order Flow Dashboard

Single-file (`index.html`, vanilla HTML/CSS/JS, no libraries, no CDN) dashboard for **BTCUSDT / ETHUSDT USDT-M perpetuals** on Binance, timeframes 1m / 5m (default) / 15m / 1h.
Public market data only: no account, no API keys, no orders. Works from `file://`, any static host, or installed on a phone (PWA).

## What it does
1. **Live dashboard**: candles (own canvas chart: pan, zoom, crosshair), volume bars, live price, 24h change, countdown, connection pills (market WS, depth WS, book REST, OI REST).
2. **Liquidity**: full order book snapshots (`/fapi/v1/depth?limit=1000`) every 10 s → wall detection (size > k × median of nearby levels, minimum value), wall tracking (persist / moved / **pulled** = vanished without trades / **filled** = vanished with trades at that price), ±0.5% / ±1% concentration and imbalance, top-20 live imbalance (`@depth20@500ms`), and a **sampled heatmap** stored in IndexedDB (24 h per symbol). The heatmap shows resting limit orders only for the time the app has been open; it is not executed volume and there is no history before that.
3. **OI and volume**: current OI (polled every 10 s), OI change 1m (local samples), 5m / 15m / 1h (Binance `openInterestHist`), price-vs-OI interpretation table; exact aggressive buy / sell volume and session CVD from every aggTrade; candle delta/CVD from kline taker-buy volume; volume spikes; CVD divergence; confirmation vs exhaustion.
4. **CHoCH + BOS + Retest engine** (closed candles only, no repainting): sweep → absorption/pressure → CHoCH → BOS → retest → CVD + volume confirmation → OI evidence (scoring) → stop loss. Step checklist with ✓/✗ and values, LONG / SHORT / WAIT, entry, SL, TP1 (1:2), TP2 (1:3), position size for the risk % including fees and slippage, transparent confidence score.
5. **Backtest**: up to 1500 historical candles replayed bar by bar (engine sees only past bars), entry at the next bar's open + slippage, stop first if a bar hits both, taker fee on every fill. Output: trades, win rate, profit factor, max drawdown, net profit, average R:R, long vs short, equity curve, trade list.

DEMO mode (`DEMO` button or `index.html?demo`) replays a scripted, deterministic scenario with one LONG and one SHORT setup. It is bannered, pauses all live connections and is never mixed with live data.

## Data types
| What | Type |
|---|---|
| Candles, 24h ticker, current OI, OI history, aggTrades, top-20 depth | REAL (Binance public API) |
| Candle delta / CVD in chart, engine and backtest | CANDLE-DERIVED (kline taker-buy volume) |
| OI change 1m, order book walls / concentration / heatmap, wall pulled/filled | SAMPLED (recorded locally while the app is open) |
| DEMO scenario | DEMO (scripted) |

## Tests
`node --test tests/` runs the pure-logic tests (swings, sweep, CHoCH/BOS/retest, OI table, CVD/divergence, walls, sizing, backtest no-look-ahead, stats) against the code embedded in `index.html`, plus a recorded real BTCUSDT 5m fixture.

Not financial advice. Signals are rule outputs, not predictions.

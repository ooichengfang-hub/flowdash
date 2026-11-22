// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/<script id="fdcore">([\s\S]*?)<\/script>/)[1];
const sb = { module: { exports: {} } }; vm.runInNewContext(src, sb);
const FD = sb.module.exports;
const J = (x) => JSON.parse(JSON.stringify(x));
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, a + ' vs ' + b);
// helper: candle from (o,h,l,c) with volume v and taker-buy fraction bf
let T = Date.UTC(2026, 0, 1);
const C = (o, h, l, c, v = 100, bf = 0.5) => { const t = T; T += 3e5; return { t, o, h, l, c, v, q: v * c, n: 1, tb: v * bf, tq: v * bf * c, T: t + 3e5 - 1, d: v * (2 * bf - 1) }; };
const line = (closes, bf = 0.5) => closes.map((c, i) => C(i ? closes[i - 1] : c, Math.max(c, i ? closes[i - 1] : c) + 0.1, Math.min(c, i ? closes[i - 1] : c) - 0.1, c, 100, bf));

test('parseKline: taker-buy volume gives aggressive buy/sell split and delta', () => {
  const k = FD.parseKline([1000, '10', '12', '9', '11', '50', 1999, '550', 42, '30', '330', '0']);
  assert.deepStrictEqual(J(k), { t: 1000, o: 10, h: 12, l: 9, c: 11, v: 50, q: 550, n: 42, tb: 30, tq: 330, T: 1999, d: 10 });
  const w = FD.parseWsKline({ t: 1, T: 2, o: '1', h: '2', l: '0.5', c: '1.5', v: '10', q: '15', n: 3, V: '4', Q: '6', x: true });
  assert.strictEqual(w.d, -2); assert.strictEqual(w.x, true);
});
test('swings: fractal needs N bars each side and is only confirmed N bars later', () => {
  const cs = line([1, 2, 3, 5, 3, 2, 1, 2, 3]);
  assert.strictEqual(FD.swingAt(cs, 3, 2), 'H'); assert.strictEqual(FD.swingAt(cs, 2, 2), null);
  assert.strictEqual(FD.swingAt(cs.slice(0, 5), 3, 2), null, 'not confirmed before N right-side bars exist');
  const sw = FD.findSwings(cs, 2); assert.deepStrictEqual(J(sw.map(s => [s.i, s.type, s.conf])), [[3, 'H', 5], [6, 'L', 8]]);
  assert.deepStrictEqual(J(FD.findSwings(cs, 2, 7).map(s => s.i)), [3], 'upto=7 cannot see the swing low at 6 yet');
});
test('OI interpretation table (interpretations only)', () => {
  assert.strictEqual(FD.oiInterpret(0.5, 0.4).code, 'new_longs');
  assert.strictEqual(FD.oiInterpret(-0.5, 0.4).code, 'new_shorts');
  assert.strictEqual(FD.oiInterpret(0.5, -0.4).code, 'short_covering');
  assert.strictEqual(FD.oiInterpret(-0.5, -0.4).code, 'long_liquidation');
  assert.strictEqual(FD.oiInterpret(0.01, 0.4).code, 'flat'); assert.strictEqual(FD.oiInterpret(NaN, 1).code, 'na');
  assert.match(FD.oiInterpret(1, 1).text, /possible new long/);
});
test('oiAt never looks ahead; oiChange over windows', () => {
  const s = [{ t: 0, oi: 100 }, { t: 300, oi: 110 }, { t: 600, oi: 99 }];
  assert.strictEqual(FD.oiAt(s, 299).oi, 100); assert.strictEqual(FD.oiAt(s, 300).oi, 110); assert.strictEqual(FD.oiAt(s, -1), null);
  near(FD.oiChange(s, 600, 300).pct, -10); near(FD.oiChange(s, 600, 600).pct, -1); assert.strictEqual(FD.oiChange(s, 600, 5000), null);
});
test('CVD series, volume spikes and divergence', () => {
  const cs = [C(1, 2, 0, 1, 100, 0.7), C(1, 2, 0, 1, 100, 0.2), C(1, 2, 0, 1, 300, 0.5)];
  assert.deepStrictEqual(J(FD.cvdSeries(cs)).map(x => +x.toFixed(6)), [40, -20, -20]);
  const vs = Array.from({ length: 25 }, (_, i) => C(1, 2, 0, 1, i === 22 ? 500 : 100));
  assert.deepStrictEqual(J(FD.spikes(vs, 2, 20)), [22]);
  const sw = [{ i: 1, type: 'H', price: 10 }, { i: 5, type: 'H', price: 11 }, { i: 2, type: 'L', price: 5 }, { i: 6, type: 'L', price: 4 }];
  const cvd = [0, 50, 10, 0, 0, 30, 20];
  const dv = FD.divergence(null, cvd, sw); assert.ok(dv.bearish, 'price HH with CVD LH'); assert.ok(dv.bullish, 'price LL with CVD HL');
  assert.deepStrictEqual(J(FD.divergence(null, [0, 50, 10, 0, 0, 60, 5], sw)), { bearish: null, bullish: null });
});
test('book concentration and imbalance within ±x%', () => {
  const bids = [[99.6, 10], [99, 5], [97, 100]], asks = [[100.4, 2], [101.5, 50]];
  const c = FD.concentration(bids, asks, 100, 0.5); near(c.bid, 996); near(c.ask, 200.8); near(c.imb, (996 - 200.8) / (996 + 200.8));
  const c1 = FD.concentration(bids, asks, 100, 1); near(c1.bid, 996 + 495);
});
test('wall detection: size > k x median of nearby levels and min notional', () => {
  const bids = [[99.9, 1], [99.8, 1.2], [99.7, 0.8], [99.6, 30], [99.5, 1], [90, 500]];
  const asks = [[100.1, 1], [100.2, 1], [100.3, 12], [100.4, 1]];
  const w = FD.detectWalls(bids, asks, 100, { k: 8, rangePct: 1, minNotional: 0 });
  assert.deepStrictEqual(J(w.map(x => [x.side, x.price])), [['bid', 99.6], ['ask', 100.3]]);
  assert.strictEqual(FD.detectWalls(bids, asks, 100, { k: 8, rangePct: 1, minNotional: 2000 }).length, 1);
});
test('wall tracking: persists, moves, gets pulled (cancelled) or filled (absorbed), or leaves the window', () => {
  const w = (side, price, qty) => ({ side, price, qty, notional: price * qty });
  const prev = FD.trackWalls([], [w('bid', 99, 50), w('ask', 101, 40), w('bid', 98, 30), w('ask', 103, 20)], () => 0, () => true, 1000).active;
  assert.ok(prev.every(x => x.first === 1000));
  const traded = (p) => (p === 101 ? 35 : 0), inRange = (p) => p !== 103;
  const r = FD.trackWalls(prev, [w('bid', 99, 48), w('bid', 98.05, 31)], traded, inRange, 2000);
  const ev = Object.fromEntries(r.events.map(e => [e.type, e]));
  assert.strictEqual(ev.filled.price, 101, 'ask wall vanished WITH trades at that price = filled/absorbed');
  assert.strictEqual(ev.moved.price, 98); assert.strictEqual(ev.moved.to, 98.05);
  assert.strictEqual(ev.out.price, 103);
  assert.strictEqual(r.active.find(x => x.price === 99).first, 1000, 'persisting wall keeps its first-seen time');
  const r2 = FD.trackWalls(r.active, [], () => 0, () => true, 3000);
  assert.deepStrictEqual(J(r2.events.map(e => e.type)), ['pulled', 'pulled'], 'vanished without trades = pulled (cancelled)');
  assert.strictEqual(r2.events[0].life, 2000);
});
test('binBook bins levels for the heatmap within ±range', () => {
  const b = FD.binBook([[99.97, 1], [99.93, 2], [95, 9]], [[100.02, 3], [100.08, 1]], 100, 0.05, 1, 5);
  assert.deepStrictEqual(J(b.b), [[99.95, 1], [99.9, 2]]); assert.deepStrictEqual(J(b.a), [[100.05, 3], [100.1, 1]]); assert.strictEqual(b.t, 5);
});
test('position size: loss at stop incl. fees and slippage equals equity x risk%', () => {
  const p = FD.positionSize(10000, 1, 100, 98, 0.05, 2);
  const qty = p.qty, entryFill = 100 * (1 + 2e-4), stopFill = 98 * (1 - 2e-4);
  const loss = (entryFill - stopFill) * qty + (entryFill + stopFill) * qty * 0.0005;
  near(p.riskAmt, 100); assert.ok(Math.abs(loss - 100) < 1e-3, 'loss ' + loss);
  assert.ok(p.qty < 100 / 2, 'fees+slippage shrink size vs naive 50'); assert.strictEqual(FD.positionSize(1, 1, 100, 100, 0, 0), null);
  const s = FD.positionSize(10000, 2, 100, 103, 0, 0); near(s.qty, 200 / 3);
});
test('engine: demo scenario walks sweep -> CHoCH -> BOS -> retest -> LONG, then the mirror SHORT', () => {
  const d = FD.demoScenario(), r = FD.runEngine(d.candles, { oi: d.oi });
  assert.strictEqual(r.signals.length, 2);
  const [L, S] = r.signals; assert.strictEqual(L.side, 'long'); assert.strictEqual(S.side, 'short');
  const seq = (side) => r.events.filter(e => e.side === side && ['sweep', 'choch', 'bos', 'signal'].includes(e.type));
  const longSeq = seq('long').filter(e => e.i <= L.i).slice(-4).map(e => e.type); assert.deepStrictEqual(J(longSeq), ['sweep', 'choch', 'bos', 'signal']);
  const shortSeq = seq('short').filter(e => e.i <= S.i).slice(-4).map(e => e.type); assert.deepStrictEqual(J(shortSeq), ['sweep', 'choch', 'bos', 'signal']);
  for (const s of [L, S]) {
    const up = s.side === 'long';
    assert.ok(up ? s.sl < s.entryRef : s.sl > s.entryRef, 'SL on the correct side'); near(Math.abs(s.tp1 - s.entryRef), 2 * s.R, 1e-9); near(Math.abs(s.tp2 - s.entryRef), 3 * s.R, 1e-9);
    assert.ok(up ? s.sweep.extreme < s.sweep.level : s.sweep.extreme > s.sweep.level);
    assert.ok(s.choch.i > s.sweep.i && s.bos.i > s.choch.i && s.retest.i > s.bos.i && s.i === s.retest.i);
    assert.ok(up ? s.conf.barDelta > 0 && s.conf.roll > 0 : s.conf.barDelta < 0 && s.conf.roll < 0);
    assert.strictEqual(s.oi.code, up ? 'new_longs' : 'new_shorts'); assert.strictEqual(s.score, s.breakdown.reduce((a, b) => a + b.pts, 0)); assert.ok(s.score >= 60 && s.score <= 100);
  }
});
test('engine: no signal without the required confirmation; no CHoCH if the break is with the trend', () => {
  const d = FD.demoScenario();
  const flip = d.candles.map((c, i) => i === 44 ? Object.assign({}, c, { tb: c.v * 0.3, d: c.v * -0.4 }) : c); // retest bar now sellers
  const r = FD.runEngine(flip, { oi: d.oi }); assert.ok(!r.signals.some(s => s.side === 'long' && s.i === 44));
  // an uptrend that sweeps a swing low and breaks a swing high is a continuation, not a CHoCH
  const up = FD.runEngine(d.candles.slice(45, 70), {}); assert.ok(!up.events.some(e => e.type === 'choch' && e.side === 'long'));
});
test('engine: no look-ahead -- appending future bars never changes earlier signals or events', () => {
  const d = FD.demoScenario(), cs = d.candles, full = FD.runEngine(cs, { oi: d.oi });
  for (const k of [30, 44, 45, 60, 83, 84, 90]) {
    const part = FD.runEngine(cs.slice(0, k), { oi: d.oi });
    assert.deepStrictEqual(J(part.signals), J(full.signals.filter(s => s.i < k)), 'signals differ at k=' + k);
    assert.deepStrictEqual(J(part.events), J(full.events.filter(e => e.i < k)), 'events differ at k=' + k);
    assert.deepStrictEqual(J(part.swings), J(full.swings.filter(s => s.conf < k)));
  }
});
test('backtest: next-bar-open entry with slippage, SL checked first when a bar hits both', () => {
  T = Date.UTC(2026, 0, 2);
  const cs = [C(100, 101, 99, 100), C(100, 100.5, 99.5, 100), C(100, 106, 97, 101), C(101, 102, 100, 101)];
  const sig = [{ i: 0, side: 'long', sl: 98, score: 60 }];
  const bt = FD.backtest(cs, sig, { equity: 10000, riskPct: 1, feePct: 0, slipBps: 0, mode: 'tp1' });
  const t = bt.trades[0]; assert.strictEqual(t.entryI, 1); assert.strictEqual(t.entry, 100); assert.strictEqual(t.exits[0].why, 'SL', 'bar 2 hit TP and SL: SL first'); near(t.pnl, -100, 1e-3); near(t.rMult, -1, 1e-5);
  const bt2 = FD.backtest(cs, sig, { equity: 10000, riskPct: 1, feePct: 0.05, slipBps: 5, mode: 'tp1' });
  assert.ok(Math.abs(bt2.trades[0].entry - 100.05) < 1e-9); near(bt2.trades[0].pnl, -100, 1e-3);
});
test('backtest: split exits (50% at 1:2, stop to break-even, 50% at 1:3), gap skip and fees', () => {
  T = Date.UTC(2026, 0, 3);
  const cs = [C(100, 100, 100, 100), C(100, 100.5, 99.5, 100), C(100, 104.2, 99.8, 104), C(104, 106.5, 103, 106), C(106, 106, 105, 105)];
  const bt = FD.backtest(cs, [{ i: 0, side: 'long', sl: 98 }], { feePct: 0, slipBps: 0, mode: 'split' });
  const t = bt.trades[0]; assert.deepStrictEqual(J(t.exits.map(e => e.why)), ['TP1', 'TP2']); near(t.rMult, 2.5, 1e-9);
  const cs2 = [C(100, 100, 100, 100), C(100, 100.5, 99.5, 100), C(100, 104.2, 99.8, 104), C(104, 104.5, 99, 100)];
  const t2 = FD.backtest(cs2, [{ i: 0, side: 'long', sl: 98 }], { feePct: 0, slipBps: 0, mode: 'split' }).trades[0];
  assert.deepStrictEqual(J(t2.exits.map(e => e.why)), ['TP1', 'BE']); near(t2.rMult, 1, 1e-9);
  const sh = FD.backtest(cs2, [{ i: 0, side: 'short', sl: 99 }], { feePct: 0, slipBps: 0 }).trades[0]; assert.strictEqual(sh.skipped, 'gap beyond stop');
  const fee = FD.backtest(cs, [{ i: 0, side: 'long', sl: 98 }], { feePct: 0.05, slipBps: 0, mode: 'split' }).trades[0];
  assert.ok(fee.pnl < t.pnl, 'fees reduce pnl');
});
test('backtest: one position at a time and identical results when future bars are appended', () => {
  const d = FD.demoScenario(), cs = d.candles, sigs = FD.runEngine(cs, { oi: d.oi }).signals;
  const full = FD.backtest(cs, sigs, {});
  assert.strictEqual(full.trades.filter(t => !t.skipped).length, 2);
  for (const k of [60, 70, 90, 100]) {
    const part = FD.backtest(cs.slice(0, k), FD.runEngine(cs.slice(0, k), { oi: d.oi }).signals, {});
    const closed = (bt) => J(bt.trades.filter(t => !t.open && t.exitI < k - 1));
    assert.deepStrictEqual(closed(part), closed(full));
  }
  const overlapping = FD.backtest(cs, [sigs[0], Object.assign({}, sigs[0], { i: sigs[0].i + 1 })], {});
  assert.strictEqual(overlapping.trades.length, 1, 'second signal ignored while in a trade');
});
test('stats: win rate, profit factor, net, max drawdown, long vs short', () => {
  const tr = [{ side: 'long', pnl: 200, rMult: 2, plannedRR: 2 }, { side: 'short', pnl: -100, rMult: -1, plannedRR: 2 }, { side: 'long', pnl: -100, rMult: -1, plannedRR: 3 }, { side: 'short', pnl: 300, rMult: 3, plannedRR: 3 }];
  const s = FD.stats(tr, 1000);
  assert.strictEqual(s.n, 4); near(s.winRate, 50); near(s.pf, 2.5); near(s.net, 300); near(s.maxDD, 200); near(s.maxDDPct, 200 / 1200 * 100); near(s.avgR, 0.75); near(s.avgPlannedRR, 2.5); near(s.endEq, 1300);
  assert.strictEqual(s.long.n, 2); near(s.long.net, 100); near(s.short.pf, 3);
  assert.ok(isNaN(FD.stats([], 1000).winRate));
});
test('checklist: 8 steps, OI is the only non-required row', () => {
  const d = FD.demoScenario(), r = FD.runEngine(d.candles.slice(0, 40), { oi: d.oi });
  const rows = FD.checklist(r.long, 'long'); assert.strictEqual(rows.length, 8);
  assert.deepStrictEqual(J(rows.filter(x => !x.req).map(x => x.name.slice(0, 2))), ['7.']);
  assert.ok(rows[0].ok && rows[2].ok, 'sweep and CHoCH done at bar 39'); assert.ok(!rows[4].ok);
});
test('formatting in UTC+8', () => {
  assert.strictEqual(FD.fmtTime(Date.UTC(2026, 0, 1, 16, 30, 5)), '00:30:05'); assert.strictEqual(FD.fmtUsd(1234567), '$1.23M'); assert.strictEqual(FD.fmtPct(-1.234), '-1.23%');
  assert.strictEqual(FD.fmtCountdown(65e3), '01:05'); assert.deepStrictEqual([0, 3, 9].map(FD.backoff), [1000, 8000, 30000]); assert.strictEqual(FD.niceStep(1000, 5), 200);
});
test('real recorded fixture (BTCUSDT 5m): engine + backtest have no look-ahead and stats are consistent', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'btcusdt-5m.json'), 'utf8'));
  const cs = fx.klines.map(FD.parseKline), oi = fx.oiHist;
  assert.ok(cs.length >= 1400);
  cs.forEach((c) => assert.ok(c.tb >= 0 && c.tb <= c.v + 1e-9 && Math.abs(c.d - (2 * c.tb - c.v)) < 1e-9));
  const full = FD.runEngine(cs, { oi });
  for (const k of [400, 800, 1200]) {
    const part = FD.runEngine(cs.slice(0, k), { oi });
    assert.deepStrictEqual(J(part.signals), J(full.signals.filter((s) => s.i < k)), 'k=' + k);
  }
  // swings only become known N bars later
  full.swings.forEach((s) => assert.strictEqual(s.conf, s.i + 3));
  // every signal has a stop on the right side and the required steps in order
  full.signals.forEach((s) => { assert.ok(s.side === 'long' ? s.sl < s.entryRef : s.sl > s.entryRef); assert.ok(s.sweep.i < s.choch.i && s.choch.i < s.bos.i && s.bos.i < s.retest.i); });
  const bt = FD.backtest(cs, full.signals, { equity: 10000, riskPct: 1, feePct: 0.05, slipBps: 2 });
  const tr = bt.trades.filter((t) => !t.skipped), s = bt.stats;
  assert.strictEqual(s.n, tr.length); near(s.net, tr.reduce((a, t) => a + t.pnl, 0), 1e-6); near(s.endEq, 10000 + s.net, 1e-6);
  tr.forEach((t) => { assert.ok(t.entryI > t.sigI); assert.ok(t.rMult >= -1.0001, 'never lose more than 1R incl. fees: ' + t.rMult); });
});
test('walls: top-N cap per side, and a wall still resting in the book is not reported as pulled', () => {
  const bids = [[99.9, 1], [99.8, 1], [99.7, 50], [99.6, 40], [99.5, 30], [99.4, 1], [99.3, 1], [99.2, 1], [99.1, 1]], asks = [[100.1, 1], [100.2, 1], [100.3, 1]];
  const w = FD.detectWalls(bids, asks, 100, { k: 5, rangePct: 1, maxPerSide: 2 });
  assert.deepStrictEqual(J(w.map((x) => x.price)), [99.7, 99.6]);
  const prev = FD.trackWalls([], w, () => 0, () => true, 1).active;
  const r = FD.trackWalls(prev, [{ side: 'bid', price: 99.7, qty: 50 }], () => 0, () => true, 2, { qtyAt: (s, p) => (p === 99.6 ? 38 : 0) });
  assert.deepStrictEqual(J(r.events), []); assert.strictEqual(r.active.length, 2); assert.strictEqual(r.active.find((x) => x.price === 99.6).first, 1);
  const r2 = FD.trackWalls(r.active, [], () => 0, () => true, 3, { qtyAt: (s, p) => (p === 99.6 ? 5 : 0) });
  assert.deepStrictEqual(J(r2.events.map((e) => [e.type, e.price])), [['pulled', 99.7], ['pulled', 99.6]], 'shrunk from 38 to 5 without trades = pulled');
});

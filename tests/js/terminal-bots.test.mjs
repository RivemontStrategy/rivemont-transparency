// node tests/js/terminal-bots.test.mjs  — bots in the Terminal: presets, grid lines, profit per line, rule texts, the funding
// pick, chart drags, the Amount sheet and book marks (web/bot-setup/terminal-core.js; web/bot-setup/terminal-bots.js uses them)
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const T = createRequire(import.meta.url)("../../web/bot-setup/terminal-core.js");
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// presets: the app's Safe / Balanced / Aggressive; a grid's range around this market's price, rounded; leverage capped
const g = T.botPreset("grid", "balanced", 3412.5, 25);
assert.deepEqual([g.mode, g.grids, g.total_usd, g.leverage, g.lower, g.upper], ["neutral", 20, 400, 2, 3208, 3617]);   // ±6%, an even count
assert.equal(T.botPreset("grid", "aggressive", 3412.5, 3).leverage, 3);                  // 5x capped at the market's 3x
assert.equal(T.botPreset("grid", "safe", null, 25).lower, null);                         // no price yet: filled in later
assert.equal(T.niceRound(104250 * 0.92), 95910); assert.equal(T.niceRound(0.24121 * 1.08), 0.2605);
const d = T.botPreset("dca", "balanced", 3412.5, 25);
assert.deepEqual([d.base_usd, d.so_count, d.so_step_pct, d.step_scale, d.so_mult, d.tp_pct, d.sl_pct], [50, 5, 1, 1.2, 1.4, 1.2, 12]);
const i = T.botPreset("indicator", "balanced");
d.base_usd = 999; assert.equal(T.BOT_PRESETS.dca.balanced.base_usd, 50);                  // a copy, never the preset itself
assert.equal(i.conditions[0].ind, "ma_cross");

// profit per grid line after the maker fee and Rivemont's fee on both fills (radar/auto/bots.py grid_profit_pct)
const p = T.gridProfit({lower: 1800, upper: 2200, grids: 10}, {maker: 0.00015, rivemont: 0.0005});
near(p.max, (40 / 1800 - 0.0013) * 100); near(p.min, (40 / 2160 - 0.0013) * 100);
assert.ok(T.gridProfit({lower: 1990, upper: 2010, grids: 10}, {maker: 0.00015, rivemont: 0.0005}).min < 0);
assert.equal(T.gridProfit({lower: 10, upper: 5, grids: 4}), null);

// the grid's plan at the start (bots.grid_levels + grid_plan): buys below, sells above, the nearest line empty
assert.deepEqual(T.gridLines(90, 110, 4, 101).map(l => [l.px, l.side]), [[90, "buy"], [95, "buy"], [100, "empty"], [105, "sell"], [110, "sell"]]);
assert.deepEqual(T.gridLines(90, 110, 4, 50).map(l => l.side), ["empty", "sell", "sell", "sell", "sell"]);   // below the range
assert.deepEqual(T.gridLines(5, 5, 4, 5), []);

// one short line per bot and per preset card
assert.equal(T.botRule("grid", {lower: 3140, upper: 3686, grids: 16}), "3,140–3,686 · 16");
assert.equal(T.botRule("grid", {lower: 180.4, upper: 220, grids: 10}), "180.40–220.00 · 10");
assert.equal(T.botRule("dca", {so_count: 4, so_step_pct: 2, tp_pct: 1.5}), "4 × 2% · TP 1.5%");
assert.equal(T.botRule("dca", {so_count: 0, tp_pct: 3}), "No extra orders · TP 3%");
assert.equal(T.botRule("indicator", {timeframe: "1h", conditions: [{ind: "ma_cross", ma: "ema", fast: 9, slow: 21, op: "crosses_above"}, {ind: "rsi", period: 14, op: "below", value: 30}]}),
  "1h EMA 9/21 cross ↑ +1");
assert.equal(T.condText({ind: "rsi", period: 14, op: "below", value: 30}), "RSI 14 < 30");
assert.equal(T.condText({ind: "ma_cross", ma: "ema", fast: 9, slow: 21, op: "crosses_above"}, true), "EMA 9 crosses above EMA 21");
assert.equal(T.condText({ind: "price_ma", ma: "sma", period: 50, op: "crosses_below"}), "Price × SMA 50 ↓");
assert.equal(T.condText({ind: "bb", period: 20, std: 2, op: "touches_lower"}), "BOLL 20,2 lower");
assert.equal(T.presetFacts("grid", g, {maker: 0, rivemont: 0}), "±6% · 20 grids · +0.57%/line · 2x");
assert.equal(T.presetFacts("dca", T.botPreset("dca", "safe")), "5 × 1.3% · ×1.2 · TP 1.5% · 1x");
assert.equal(T.botSide("grid", {mode: "neutral"}), null); assert.equal(T.botSide("grid", {mode: "short"}), "short");
assert.equal(T.botSide("dca", {side: "long"}), "long");

// the venue whose funding pays the bot's side (rate_1h: what a long pays per hour; a short receives it)
const mk = {ETH: {hyperliquid: {rate_1h: 0.0000125}, lighter: {rate_1h: -0.000004}, aster: {rate_1h: 0.00003}, grvt: {rate_1h: null}}};
let f = T.fundingPick(mk, "ETH", "long", "hyperliquid");
assert.equal(f.venue, "lighter"); near(f.rate, 0.000004); near(f.here, -0.0000125);
f = T.fundingPick(mk, "ETH", "short", "hyperliquid");
assert.equal(f.venue, "aster"); near(f.rate, 0.00003); near(f.here, 0.0000125);
assert.equal(T.fundingPick(mk, "ETH", "short", "hyperliquid", ["hyperliquid", "lighter"]).venue, "hyperliquid");   // only usable ones
assert.equal(T.fundingPick(mk, "ETH", null, "hyperliquid"), null);                       // a neutral grid holds no side
assert.equal(T.fundingPick(mk, "BTC", "long", "hyperliquid"), null);

// a dragged chart line -> its setting
assert.deepEqual(T.dragSetting("grid", "upper", {}, 3400, 3712.4), {upper: 3712});
assert.deepEqual(T.dragSetting("dca", "tp", {side: "long"}, 2000, 2031), {tp_pct: 1.55});
assert.deepEqual(T.dragSetting("dca", "sl", {side: "short"}, 2000, 2200), {sl_pct: 10});
assert.deepEqual(T.dragSetting("dca", "last", {side: "long", so_count: 4}, 2000, 1840), {so_step_pct: 2});
assert.deepEqual(T.dragSetting("dca", "tp", {side: "long"}, 2000, 2000), {tp_pct: 0.01});   // never zero
assert.equal(T.dragSetting("dca", "last", {so_count: 0}, 2000, 1800), null);
assert.equal(T.dragSetting("grid", "lower", {}, 2000, -1), null);
assert.equal(T.dragSetting("dca", "tp", {side: "long"}, 2000, 1990), null);                // past the entry: refused, never its mirror
assert.equal(T.dragSetting("dca", "sl", {side: "short"}, 2000, 1990), null);
assert.deepEqual(T.dragSetting("grid", "tp_px", {}, 2000, 2412.37), {tp_px: 2412});    // a price setting: the price
assert.deepEqual(T.dragSetting("trailstop", "activation", {side: "long"}, 2000, 2050), {activation_pct: 2.5});

// what a new bot may use on an exchange: what the exchange reports as free (api.room_check; nothing kept, no 10% held back)
assert.equal(T.botRoom({balance: 600, withdrawable: 300}), 300);
assert.equal(T.botRoom({balance: 600, withdrawable: 0}), 0);
assert.equal(T.botRoom({balance: null, withdrawable: null}), null); assert.equal(T.botRoom(null), null);

// the Amount sheet: increase within the exchange's room (else the deposit that makes it fit), reduce never below in-use
let b = T.budgetChange({add: true, now: 200, delta: "100", money: {balance: 600, withdrawable: 300}});
assert.deepEqual([b.after, b.block, b.deposit], [300, false, 0]);
b = T.budgetChange({add: true, now: 200, delta: "310", money: {balance: 600, withdrawable: 300}});
assert.deepEqual([b.after, b.block, b.deposit], [510, true, 10]);                          // 310 - 300 free = 10 more
b = T.budgetChange({add: true, now: 200, delta: 100, limit: 1000, others: 850, money: null});
assert.ok(b.block && /at most \$1,000/.test(b.why));
b = T.budgetChange({add: false, now: 200, delta: 150, inUse: 80});
assert.ok(b.block && b.stop && /\$80/.test(b.why) && b.after === 50);
b = T.budgetChange({add: false, now: 200, delta: 100, inUse: 80});
assert.deepEqual([b.after, b.block], [100, false]);
assert.ok(T.budgetChange({add: false, now: 200, delta: 200}).stop);
assert.ok(T.budgetChange({add: true, now: 200, delta: ""}).block);

// book rows at a grid line: the nearest row within half a step, empty lines left out
const lines = T.gridLines(3140, 3686, 16, 3412.5);
const rows = [3400, 3410, 3420, 3480, 3500, 3310];
const m = T.bookMarks(rows, lines, 10);
assert.equal(m[3480], "sell"); assert.equal(m[3310], "buy"); assert.equal(m[3400], undefined); assert.equal(m[3410], undefined);
assert.deepEqual(T.bookMarks(rows, [], 10), {});

console.log("terminal-bots: ok");

// node tests/js/bot-flow.test.mjs — the guided bot setup (/bots/new, web/bot-setup/bot-flow.js BotFlowPlan): the steps each
// type goes through, what step 2 holds, every setting of every type in Customize's Entry / Exit / Risk / Timing (nothing
// the builder had becomes unreachable), the URL prefill, the Start guard (minimum, liquidation on isolated), the market's
// mood line and the plan cards' backtest amount.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const T = req("../../web/bot-setup/terminal-core.js");
const P = req("../../web/bot-setup/terminal-bots.js");
const F = req("../../web/bot-setup/bot-flow.js");

// the steps: a bot built here, the Signal bot (its own page). Funding Arbitrage (two exchanges) left on 2026-10-06
for (const k of T.BOT_KINDS) assert.deepEqual(F.steps(k), ["choose", "amount", "review"], k);
assert.ok(!T.BOT_KINDS.includes("arb"));
assert.deepEqual(F.steps("signal"), ["choose", "alerts"]);
assert.deepEqual(F.steps("grid", {priv: true}), ["amount", "review"]);         // a copy with hidden settings: no type to choose
// step 1 shows five types first (Market Neutral, both legs on Hyperliquid, is the hedged one). (The live repository
// also checks here that the catalog matches the server's bot list, which is not part of this repository.)
assert.deepEqual(F.QUICK, ["grid", "dca", "infinity", "pair", "signal"]);

// step 2: plans for every type built here, and what the types that do not fit plans get besides
assert.equal(F.stage("grid"), "plans"); assert.equal(F.stage("dca"), "plans");
assert.equal(F.stage("pair"), "pair"); assert.equal(F.stage("rebalance"), "basket"); assert.equal(F.stage("custom"), "rules");
assert.equal(F.stage("scaleout", true), "position"); assert.equal(F.stage("signal"), "signal");

// Customize: every type's settings in the four groups, each once; every setting a preset (or the builder's advanced
// options) sets is in a group, so nothing the old panel offered is out of reach
const AMOUNT = new Set(["total_usd", "base_usd", "size_usd", "usd", "first_usd", "max_total_usd", "preset", "min_usd"]);   // from the amount
const ALIAS = {range: "range", lower: "range", upper: "range", range_n: "range_by", grid_by: "step_pct", conditions: "conditions",
  every: "every", entry: "entry", logic: "rules"};
const EXTRA = {dca: P.DCA_MORE, grid: ["spacing", "trigger_px", "tp_px", "sl_px", "tp_pct", "sl_pct", "max_active", "stop_action", "range_by"],
  rgrid: ["spacing", "trigger_px", "tp_px", "sl_px", "tp_pct", "sl_pct", "max_active", "stop_action", "range_by"],
  infinity: ["spacing", "trigger_px", "tp_px", "sl_px", "tp_pct", "sl_pct", "max_active", "stop_action", "range_by", "trail_up", "trail_down"],
  indicator: ["trail_pct", "exit_opposite", "exit"]};
for (const k of T.BOT_KINDS) {
  const g = F.groups(k, T.BOT_SCHEMA[k], T.BOT_SIDES[k]);
  assert.deepEqual(Object.keys(g), F.GROUPS, k);
  const keys = F.keysOf(g);
  assert.equal(new Set(keys).size, keys.length, `${k}: a setting in two groups`);
  const need = new Set();
  for (const n of ["safe", "balanced", "aggressive"]) for (const key of Object.keys(T.BOT_PRESETS[k][n])) need.add(key);
  for (const key of EXTRA[k] || []) need.add(key);
  for (const f of T.BOT_SCHEMA[k] || []) need.add(f.k);
  for (const key of need) {
    if (AMOUNT.has(key)) continue;
    if (key === "side" && (k === "scaleout" || (T.BOT_SIDES[k] && !T.BOT_SIDES[k].length) || k === "rgrid")) continue;   // the type fixes it
    if (key === "mode" && k === "rgrid") continue;
    if (key === "leverage" && (k === "scaleout" || k === "liqguard")) continue;  // it works on a position you hold: 1x
    if (key === "rules" || key === "timeframe" && k === "custom") { assert.ok(keys.includes(key), `${k}: ${key}`); continue; }
    assert.ok(keys.includes(ALIAS[key] || key) || keys.includes(key), `${k}: ${key} is not in Customize`);
  }
  if (k !== "scaleout" && k !== "liqguard") assert.ok(g.risk.includes("leverage") && g.risk.includes("margin"), `${k}: leverage and margin under Risk`);
  if ((T.BOT_SCHEMA[k] || []).some(f => f.k === "timeframe")) assert.ok(g.timing.includes("timeframe"), `${k}: its chart under Timing`);
}
// the schedule of a type is Timing; a short grid has no direction; the DCA's groups as the concept has them
assert.deepEqual(F.groups("recurring", T.BOT_SCHEMA.recurring, T.BOT_SIDES.recurring).timing, ["every", "at_hour", "weekday", "times"]);
assert.ok(!F.groups("rgrid").entry.includes("mode") && F.groups("grid").entry.includes("mode"));
// a take-profit ladder closes a short as well as a long: its direction is a setting (audit bots-ui-05)
assert.ok(F.groups("scaleout", T.BOT_SCHEMA.scaleout, T.BOT_SIDES.scaleout).entry.includes("side"));
assert.ok(!F.groups("scaleout", T.BOT_SCHEMA.scaleout, T.BOT_SIDES.scaleout).risk.includes("leverage"));
assert.deepEqual(F.groups("dca").exit, ["tp_pct", "tp_base", "tp_trail_pct", "be_pct"]);
assert.deepEqual(F.groups("dca").risk, ["sl_pct", "sl_base", "max_losses", "leverage", "margin"]);

// the prefill: a type, a coin and an exchange from the link; an edit or settings open Customize; a shared setup waits for it
const K = T.BOT_KINDS;
assert.deepEqual(F.prefill("?kind=dca&coin=eth&venue=lighter", K), {kind: "dca", coin: "ETH", venue: "lighter"});
assert.deepEqual(F.prefill("?kind=neutral", K), {kind: "pair"});                // the Market Neutral bot's own name
assert.deepEqual(F.prefill("?kind=arb", K), {});                                // the retired Funding Arbitrage: no type
assert.deepEqual(F.prefill("?kind=bogus&coin=<x>&venue=Bad!", K), {});          // nothing unknown gets through
assert.equal(F.prefill("?coin=xyz:TSLA", K).coin, "xyz:TSLA");                  // a builder-dex market keeps its case
assert.deepEqual(F.prefill("?edit=7&kind=grid", K), {kind: "grid", edit: 7, step: "custom"});
assert.equal(F.prefill("?kind=grid&cfg=eyJ9", K).step, "custom");
assert.equal(F.prefill("?from=calm-eth", K).step, "from");
assert.equal(F.prefill("?kind=grid&step=review", K).step, "review");            // the expert's Balanced-and-review
assert.equal(F.prefill("?kind=grid&amount=250", K).amount, 250);
assert.equal(F.prefill("?edit=abc", K).edit, undefined);

// the guard: Start is off under the minimum, and while liquidation comes before the bot's own orders on isolated margin;
// on cross it only warns (the rest of the account backs it); a type that adds no money needs no amount
const ok = {ok: true, safe_leverage: 8, leverage_block: null};
assert.equal(F.guard({chk: ok, cross: false, total: 0, minTotal: 21.3}).state, "amount");
assert.deepEqual(F.guard({chk: ok, cross: false, total: 20, minTotal: 21.3}), {state: "min", min: 21.3});
assert.equal(F.guard({chk: null, cross: false, total: 100, minTotal: 21.3}).state, "wait");
assert.deepEqual(F.guard({chk: {ok: false, error: "Set the range."}, total: 100, minTotal: 10}), {state: "error", text: "Set the range."});
const lb = {ok: true, safe_leverage: 3, leverage_block: "At 10x it is liquidated before its last order."};
assert.deepEqual(F.guard({chk: lb, cross: false, total: 100, minTotal: 10}), {state: "block", text: lb.leverage_block, safe: 3});
assert.equal(F.guard({chk: lb, cross: true, total: 100, minTotal: 10}).state, "warn");
assert.deepEqual(F.guard({chk: ok, cross: false, total: 100, minTotal: 10}), {state: "ok", min: 10, safe: 8, stop: "set"});
// the green line says what the limit was measured against, never more (audit H02): no stop loss says so; a stop with
// no price (an ATR trail, a max loss in $) is "not checked against it"; a stop just before the liquidation is the warning
// line with the leverage that keeps the room, and it is not listed twice under the guard
assert.equal(F.guard({chk: {...ok, has_stop: false, stop_checked: false}, total: 100, minTotal: 10}).stop, "none");
assert.equal(F.guard({chk: {...ok, has_stop: true, stop_checked: false}, total: 100, minTotal: 10}).stop, "free");
assert.equal(F.guard({chk: {...ok, has_stop: true, stop_checked: true}, total: 100, minTotal: 10}).stop, "set");
const gap = {...ok, stop_gap: true, room_leverage: 6, warnings: ["The stop is only 0.25% of the price before the estimated liquidation.", "Trailing note.", "20x note."]};
assert.deepEqual(F.guard({chk: gap, cross: false, total: 100, minTotal: 10, leverage: 8}), {state: "gap", min: 10, text: gap.warnings[0], safe: 6});
assert.equal(F.guard({chk: {...gap, room_leverage: 8}, cross: false, total: 100, minTotal: 10, leverage: 8}).safe, null);   // no lower offer
assert.deepEqual(F.warnList(gap), ["Trailing note.", "20x note."]);
assert.deepEqual(F.warnList({...gap, stop_gap: false}), [gap.warnings[0], "Trailing note."]);
assert.deepEqual(F.warnList(null), []);
// "safe" only when the server computed it: a bot on a position you hold, or a type with no liquidation estimate (Market
// Neutral, Rebalancing), is "not checked", never the green line (audit H01)
assert.equal(F.guard({chk: {ok: true, safe_leverage: null, leverage_block: null}, total: 0, minTotal: 0, noAmount: true}).state, "held");
assert.equal(F.guard({chk: ok, total: 0, minTotal: 0, noAmount: true}).state, "held");
assert.deepEqual(F.guard({chk: {ok: true, safe_leverage: null, leverage_block: null}, cross: false, total: 100, minTotal: 10}), {state: "unest", min: 10});
// a long-only Rebalancing basket at 1x on isolated margin has no liquidation price: "None at 1x" and the plain guard, not
// "not estimated" (audit bots-ui-06); a short basket, any leverage above 1x or cross margin stays "not estimated"
const nolq = {ok: true, safe_leverage: null, leverage_block: null};
assert.deepEqual(F.guard({chk: nolq, cross: false, total: 100, minTotal: 10, kind: "rebalance", side: "long", leverage: 1}), {state: "ok", min: 10, none: true});
assert.deepEqual(F.guard({chk: nolq, cross: false, total: 100, minTotal: 10, kind: "rebalance", leverage: 1}), {state: "ok", min: 10, none: true});
assert.equal(F.guard({chk: nolq, cross: false, total: 100, minTotal: 10, kind: "rebalance", side: "short", leverage: 1}).state, "unest");
assert.equal(F.guard({chk: nolq, cross: false, total: 100, minTotal: 10, kind: "rebalance", side: "long", leverage: 2}).state, "unest");
assert.equal(F.guard({chk: nolq, cross: true, total: 100, minTotal: 10, kind: "rebalance", side: "long", leverage: 1}).state, "unest");
assert.equal(F.guard({chk: nolq, cross: false, total: 100, minTotal: 10, kind: "pair", side: "long", leverage: 1}).state, "unest");
assert.equal(F.noLiq("rebalance", "long", 1), true); assert.equal(F.noLiq("rebalance", undefined, undefined), true);
assert.equal(F.noLiq("rebalance", "short", 1), false); assert.equal(F.noLiq("rebalance", "long", 3), false); assert.equal(F.noLiq("dca", "long", 1), false);
assert.equal(F.guard({chk: nolq, cross: false, total: 5, minTotal: 10, kind: "rebalance", side: "long", leverage: 1}).state, "min");   // the minimum first

// the setup kept across the in-place sign-in comes back only on its own link (the sign-in reloads the same address); a
// link opened fresh for another copy, a bot to edit or another type wins (audit bots-ui-03/17)
const kept = {kind: "dca", from: null}, keptCopy = {kind: "grid", from: "pubg0001"};
assert.equal(F.keptFits(kept, F.prefill("?coin=BTC&venue=hyperliquid&kind=dca", K)), true);
assert.equal(F.keptFits(kept, F.prefill("?coin=BTC&venue=hyperliquid", K)), true);
assert.equal(F.keptFits(kept, F.prefill("?coin=BTC&venue=hyperliquid&kind=grid&from=pubg0001", K)), false);   // a copy link, fresh
assert.equal(F.keptFits(kept, F.prefill("?from=pubg0001", K)), false);
assert.equal(F.keptFits(kept, F.prefill("?kind=grid", K)), false);                                        // another type's link
assert.equal(F.keptFits(kept, F.prefill("?edit=7&kind=dca", K)), false);                                  // a bot to edit
assert.equal(F.keptFits(keptCopy, F.prefill("?kind=grid&from=pubg0001", K)), true);                       // the copy's own link
assert.equal(F.keptFits(keptCopy, F.prefill("?kind=grid&from=pubg0001@lighter", K)), true);
assert.equal(F.keptFits(keptCopy, F.prefill("?kind=grid&from=other002", K)), false);                      // another copy
assert.equal(F.keptFits(keptCopy, F.prefill("?kind=grid", K)), true);                                     // its link lost: it loads again
assert.equal(F.keptFits(null, F.prefill("?kind=grid", K)), false);

// percentages: whole numbers keep their zeros (the liquidation distance read −5% for −50%: audit bots-ui-01, ui-core-02)
assert.equal(F.pct(-50.27, 0), "−50%");
assert.equal(F.pct(50, 0), "50%"); assert.equal(F.pct(40, 0), "40%"); assert.equal(F.pct(-10, 0), "−10%");
assert.equal(F.pct(-100, 0), "−100%"); assert.equal(F.pct(20, 0), "20%"); assert.equal(F.pct(-9.6, 0), "−10%");
assert.equal(F.pct(1.50), "1.5%"); assert.equal(F.pct(5.1), "5.1%"); assert.equal(F.pct(10), "10%"); assert.equal(F.pct(12.34), "12.3%");
assert.equal(F.pct(-3.2, 1), "−3.2%"); assert.equal(F.pct(0.4, 0), "0%"); assert.equal(F.pct(-0.3, 0), "0%"); assert.equal(F.pct(-0.001), "0%");
assert.equal(F.pct(null), "–"); assert.equal(F.pct(NaN), "–");
assert.equal(F.pctS(5.1), "+5.1%"); assert.equal(F.pctS(0.3, 0), "0%"); assert.equal(F.pctS(-50.3, 0), "−50%"); assert.equal(F.pctS(30, 0), "+30%");

// the liquidation row: both sides of a neutral grid from the check's own price; none estimated for a two-leg bot (it
// read "None at 2x"); cross margin depends on the account
const ng = F.liqView({ok: true, price: 84728.5, est_liq_px: {long: 42195.19, short: 129930.03}, cross_margin: false}, 90000);
assert.equal(ng.state, "est"); assert.deepEqual(ng.sides.map(s => s.side), ["long", "short"]);
assert.equal(F.pctS(ng.sides[0].pct, 0), "−50%"); assert.equal(F.pctS(ng.sides[1].pct, 0), "+53%");
assert.equal(F.liqView({ok: true, price: 84000, est_liq_px: {long: null, short: null}, cross_margin: false}).state, "none");
assert.equal(F.liqView({ok: true, price: 84000, est_liq_px: null, cross_margin: true}).state, "cross");
assert.equal(F.liqView(null).state, "wait");
assert.equal(F.liqView({ok: true, est_liq_px: {long: 900}, cross_margin: false}, 1000).sides[0].pct.toFixed(0), "-10");

// "Loss at stop loss": a stop of any kind (BotPlan.hasStop) reads "Not estimated" without a figure, never "No stop loss"
for (const [k, c] of [["martingale", {sl_pct: 18}], ["chase", {trail_pct: 3}], ["pair", {stop_z: 4}], ["pair", {max_loss_usd: 50}], ["trailstop", {by: "atr"}],
                      ["rgrid", {mode: "short", stop_outside: true}], ["grid", {mode: "neutral", stop_outside: false, tp_px: 99}], ["infinity", {trail_up: true}]])
  assert.equal(P.hasStop(k, c), true, k);
for (const [k, c] of [["dca", {sl_pct: null}], ["grid", {mode: "long", stop_outside: false, tp_px: 99}], ["recurring", {}]]) assert.equal(P.hasStop(k, c), false, k);
// a short grid's take-profit price is below its range: a profit, never a stop (as bots.has_stop; residual audit bots-ui-04)
assert.equal(P.hasStop("grid", {mode: "short", tp_px: 78000, stop_outside: false}), false);
assert.equal(P.hasStop("rgrid", {tp_px: 78000, stop_outside: false}), false);
assert.equal(P.hasStop("grid", {mode: "neutral", tp_px: 92000, stop_outside: false}), true);       // closes its short side
assert.equal(P.hasStop("grid", {tp_px: 92000, stop_outside: false}), true);
assert.equal(P.hasStop("rgrid", {sl_px: 92000, stop_outside: false}), true);

// the market's mood over 7 days of 4h candles: inside a range, or up / down further than its own swing
const flat = Array.from({length: 42}, (_, i) => { const c = 100 + Math.sin(i / 3); return [i, c, c + 0.5, c - 0.5, c]; });
assert.equal(F.mood(flat).mood, "range");
const up = Array.from({length: 42}, (_, i) => { const c = 100 + i; return [i, c - 0.5, c + 0.5, c - 1, c]; });
assert.deepEqual(F.mood(up), {mood: "up", pct: 41.7});
assert.equal(F.mood(up.map(r => [r[0], 300 - r[1], 300 - r[3], 300 - r[2], 300 - r[4]])).mood, "down");
assert.equal(F.mood(flat.slice(0, 5)), null);
assert.equal(F.fits("grid", {mood: "range"}, T.BOT_MARKETS), true);
assert.equal(F.fits("infinity", {mood: "down"}, T.BOT_MARKETS), false);
assert.equal(F.fits("pair", {mood: "up"}, T.BOT_MARKETS), null);                 // hedged: the market does not matter

// the plan cards' backtest runs on the amount typed once it meets the minimum, else on the reference amount
assert.equal(F.btAmount(500, 20, 1000), 500);
assert.equal(F.btAmount(10, 20, 1000), 1000);
assert.equal(F.btAmount(0, 1500, 1000), 1500);

console.log("bot-flow ok");

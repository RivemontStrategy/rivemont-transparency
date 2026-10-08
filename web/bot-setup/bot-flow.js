/* Rivemont: the guided bot setup at /bots/new (radar/bot_flow.py). Concept A "Steps": 1 Choose (the type with what it is best for, the coin, the exchange,
   one line on what the market is doing), 2 Amount (one big field, Safe / Balanced / Aggressive from the existing presets,
   each with its key numbers and its own 30-day backtest), 3 Review (the chart with the bot's lines, the backtest labelled
   Simulation with the parts that add up to it, what it will do in plain sentences, the risk figures, the minimum and
   safe-leverage guard) -> Start. Customize is a full page with every setting by Entry / Exit / Risk / Timing beside a live
   check. Nothing here trades or validates on its own: the plan, the checks (/api/auto/bots/check), the backtest, the
   blocks and Start are radar/web/terminal-bots.js's (window.TBX), on the Terminal's page and data (S, select, api ...).
   BotFlowPlan (below) is pure and tested with node (tests/js/bot-flow.test.mjs). */

/* ---------------- BotFlowPlan: the steps, the setting groups, the prefill, the guard, the market's mood ---------------- */
(function (root) {
  /* step 1's types before "All bot types": the most used, as the concept */
  const QUICK = ['grid', 'dca', 'infinity', 'pair', 'signal'];
  const GRIDS = ['grid', 'rgrid', 'infinity'];
  const clone = o => JSON.parse(JSON.stringify(o));
  /* the steps a type goes through: a bot built here (Choose, Amount, Review); the Signal bot is set up on its own page; a
     copy whose creator hid the settings skips Choose. (Funding Arbitrage, which needed two exchanges, left on 2026-10-06.) */
  function steps(kind, o) {
    if (o && o.priv) return ['amount', 'review'];
    if (kind === 'signal') return ['choose', 'alerts'];
    return ['choose', 'amount', 'review'];
  }
  /* what step 2 holds besides the amount: plans for every type built here; the Market Neutral bot also its second coin,
     Rebalancing its basket, Custom rules its rule sets in words; a type that follows a position you hold no amount */
  function stage(kind, noAmount) {
    if (kind === 'signal') return kind;
    return {pair: 'pair', rebalance: 'basket', custom: 'rules'}[kind] || (noAmount ? 'position' : 'plans');
  }
  /* Customize: every setting of a type in its group. Grid, DCA and Indicator have their own rows (terminal-bots.js keeps
     their fields); the other types come from the schema (terminal-core.js BOT_SCHEMA): its Schedule is Timing, a chart's
     timeframe is Timing too; the side, the leverage and the margin mode join where the type has them */
  const GRID_ROWS = {entry: ['mode', 'range', 'range_by', 'grids', 'step_pct', 'spacing', 'trail_up', 'trail_down'],
    exit: ['stop_outside', 'stop_action', 'tp_px', 'sl_px', 'tp_pct', 'sl_pct'], risk: ['leverage', 'margin', 'max_active'], timing: ['trigger_px']};
  const DCA_ROWS = {entry: ['side', 'base', 'so_count', 'so_step_pct', 'step_scale', 'so_mult', 'max_active'], exit: ['tp_pct', 'tp_base', 'tp_trail_pct', 'be_pct'],
    risk: ['sl_pct', 'sl_base', 'max_losses', 'leverage', 'margin'], timing: ['start_px', 'start', 'repeat', 'cooldown_min', 'max_rounds']};
  const IND_ROWS = {entry: ['side', 'strat', 'conditions', 'entry'], exit: ['tp_pct', 'exit_opposite', 'exit'], risk: ['sl_pct', 'trail_pct', 'leverage', 'margin'],
    timing: ['timeframe']};
  const GROUPS = ['entry', 'exit', 'risk', 'timing'];
  function groups(kind, schema, sides) {
    if (GRIDS.includes(kind)) {
      const g = clone(GRID_ROWS);
      if (kind === 'rgrid') g.entry = g.entry.filter(k => k !== 'mode');           // a short grid: its side is the type
      if (kind !== 'infinity') g.entry = g.entry.filter(k => k !== 'trail_up' && k !== 'trail_down');
      return g;
    }
    if (kind === 'dca') return clone(DCA_ROWS);
    if (kind === 'indicator') return clone(IND_ROWS);
    const out = {entry: [], exit: [], risk: [], timing: []};
    if (!(sides && !sides.length)) out.entry.push('side');
    for (const f of schema || []) {
      const g = f.k === 'timeframe' || f.g === 'schedule' ? 'timing' : f.g;
      if (!out[g].includes(f.k)) out[g].push(f.k);
    }
    if (kind !== 'scaleout' && kind !== 'liqguard') out.risk.push('leverage', 'margin');  // it only works on a position you hold
    return out;
  }
  const keysOf = g => GROUPS.reduce((a, k) => a.concat(g[k] || []), []);
  /* /bots/new?kind=&coin=&venue= ... -> what the setup starts from. step: 'review' (the expert's "Use Balanced, go to
     Review") or 'custom'; edit: a bot's id (its settings into Customize); from: a shared setup; cfg: settings in base64 */
  function prefill(search, kinds) {
    const q = new URLSearchParams(search || ''), o = {};
    let k = q.get('kind');
    if (k === 'neutral') k = 'pair';
    if (k && (kinds || []).concat(['signal']).includes(k)) o.kind = k;
    const coin = (q.get('coin') || '').trim();
    if (/^([A-Za-z0-9]{1,15}|[a-z][a-z0-9]{0,7}:[A-Za-z0-9]{1,15})$/.test(coin)) o.coin = coin.includes(':') ? coin : coin.toUpperCase();
    if (/^[a-z]{2,12}$/.test(q.get('venue') || '')) o.venue = q.get('venue');
    if (/^\d{1,9}$/.test(q.get('edit') || '')) o.edit = +q.get('edit');
    if (q.get('from')) o.from = q.get('from');
    if (q.get('cfg')) o.cfg = true;
    if (q.get('try') === '1') o.try = true;                    // the first-time demo link: everything up to Start without a wallet
    const a = +q.get('amount'); if (a > 0) o.amount = a;
    if (['review', 'custom', 'amount'].includes(q.get('step'))) o.step = q.get('step');
    if (o.edit || o.cfg) o.step = 'custom';                    // a bot's or a pick's own settings: every one of them in view
    if (o.from) o.step = 'from';                               // a shared setup: Customize, or the amount when its settings are hidden
    return o;
  }
  /* the guard under the risk figures: Start is off while the amount is under the minimum, or (isolated margin) while the
     exchange would liquidate the bot before its own last order or stop; on cross the rest of the account backs it, so it
     only warns. 'ok' only when the server computed a safe leverage: a bot that follows a position you hold ('held') or a
     type with no liquidation estimate (two legs, a basket: 'unest') says it was not checked, never that it is safe; a
     long-only basket at 1x on isolated margin is the exception: the exchange has no liquidation price for it (noLiq).
     'ok' says what the limit was measured against (stop): 'none' (no stop loss: the loss keeps growing), 'free' (a stop
     with no price to measure, an ATR trail or a max loss in $: not checked against it) or 'set' (its last order and its
     stop) or 'range' (a grid whose only exit is moving its range: no stop loss, never green; audit H02). A stop that sits just before the liquidation ('gap', the server's first warning) is said here, never a green
     dot (audit H02). o = {chk (the server's check for these settings), cross, total, minTotal, noAmount, kind, side,
     leverage} */
  const noLiq = (kind, side, lev) => kind === 'rebalance' && (side || 'long') === 'long' && (+lev || 1) === 1;
  const stopOf = c => c.has_stop === false ? 'none' : c.range_exit ? 'range' : c.has_stop && c.stop_checked === false ? 'free' : 'set';
  function guard(o) {
    const c = o.chk;
    if (!o.noAmount && !(o.total > 0)) return {state: 'amount'};
    if (!o.noAmount && o.total < o.minTotal - 1e-9) return {state: 'min', min: o.minTotal};
    if (!c) return {state: 'wait'};
    if (!c.ok) return {state: 'error', text: c.error};
    if (c.leverage_block) return {state: o.cross ? 'warn' : 'block', text: c.leverage_block, safe: c.safe_leverage};
    if (o.noAmount) return {state: 'held'};
    if (c.stop_gap && (c.warnings || [])[0]) return {state: 'gap', min: o.minTotal, text: c.warnings[0], safe: c.room_leverage < (+o.leverage || 1) ? c.room_leverage : null};
    if (!(c.safe_leverage >= 1)) return !o.cross && noLiq(o.kind, o.side, o.leverage) ? {state: 'ok', min: o.minTotal, none: true} : {state: 'unest', min: o.minTotal};
    return {state: 'ok', min: o.minTotal, safe: c.safe_leverage, stop: stopOf(c)};
  }
  /* the server's warnings the page lists under the guard: the stop-gap line is the guard's own (never twice) */
  const warnList = (c, n) => c && c.ok ? (c.warnings || []).slice(c.stop_gap ? 1 : 0).slice(0, n || 2) : [];
  /* the setup kept across the in-place sign-in (s, bot-flow keep()) against the link the page opened with (q, prefill):
     the sign-in reloads the same address, so a link that names another copy, a bot to edit (never kept: an edit is
     signed in) or another type was opened fresh and wins over the kept setup (audit bots-ui-03/17) */
  const slugOf = x => String(x || '').split('@')[0];
  const keptFits = (s, q) => !!s && !(q.from && slugOf(q.from) !== slugOf(s.from)) && !q.edit && !(q.kind && s.kind && q.kind !== s.kind);
  /* a percentage on screen: whole numbers keep their zeros (−50%, not −5%), trailing zeros after the point go (5.1%,
     not 5.10%), a figure that rounds to zero reads 0% (never −0% or a bare %); the true minus sign */
  const MN = s => String(s).replace(/^-/, '−');
  function pct(x, d) {
    if (x == null || !isFinite(x)) return '–';
    let s = (+x).toFixed(d == null ? (Math.abs(x) < 10 ? 2 : 1) : d);
    if (s.includes('.')) s = s.replace(/\.?0+$/, '');
    return MN(+s === 0 ? '0' : s) + '%';
  }
  const pctS = (x, d) => { const s = pct(x, d); return (x > 0 && s !== '0%' ? '+' : '') + s; };
  /* the liquidation row from the server's check (r): on cross margin it depends on the account; else every side the bot
     can hold with its distance from the price the check used (a neutral grid has two); a type with no estimate (two
     legs, a basket) says so: never "none" */
  function liqView(r, px) {
    if (!r) return {state: 'wait'};
    if (r.cross_margin) return {state: 'cross'};
    const lq = r.est_liq_px || {}, p = r.price || px;
    const sides = ['long', 'short'].filter(s => lq[s] > 0).map(s => ({side: s, px: lq[s], pct: p ? (lq[s] / p - 1) * 100 : null}));
    return sides.length ? {state: 'est', sides} : {state: 'none'};
  }
  /* what the market did over the last 7 days of 4h candles ([t, o, h, l, c]): a range (it stayed within ±half), up or
     down (moved further than its own swing) */
  function mood(rows, n) {
    const w = (rows || []).slice(-(n || 42));
    if (w.length < 12) return null;
    const hi = Math.max(...w.map(r => r[2])), lo = Math.min(...w.map(r => r[3])), first = w[0][1], last = w[w.length - 1][4];
    if (!(hi > 0) || !(lo > 0) || !(first > 0)) return null;
    const half = (hi - lo) / 2 / ((hi + lo) / 2) * 100, chg = (last / first - 1) * 100;
    const r1 = x => Math.round(x * 10) / 10;
    return Math.abs(chg) < Math.max(1.5, half * 0.6) ? {mood: 'range', pct: r1(half)} : {mood: chg > 0 ? 'up' : 'down', pct: r1(Math.abs(chg))};
  }
  /* does the type suit that market (terminal-core.js BOT_MARKETS)? null: the type is hedged, the market does not matter */
  function fits(kind, m, markets) {
    const want = (markets || {})[kind] || [];
    if (!m || !want.length || (want.length === 1 && want[0] === 'hedged')) return null;
    return want.includes({range: 'sideways', up: 'up', down: 'down'}[m.mood]);
  }
  /* the plan cards' backtest amount: the amount typed once it meets the minimum, else the reference (as the backtest) */
  const btAmount = (total, minTotal, ref) => total > 0 && total >= minTotal ? total : Math.max(minTotal || 0, ref || 1000);
  /* the checks between settings the server makes after each field's own limits (audit BOT-08: they only failed at the
     review): c is the plan's config (what is sent), -> [{key: the field to mark, code, v: the numbers its line names}].
     Each mirrors one server check, with the server's default for an empty field (radar/auto/bots.py _cond: a fast
     period under the slow one; bot_rules.py compile_preset and _v_rules: the averages and MACD of Stop and reverse, a
     funding exit under its entry, the types whose stop loss is required; bot_twap.py: at most one slice a minute;
     bot_pair.py: the exit inside the entry, the z stop beyond it and beyond the last level, some stop, a stop loss in
     trend mode; bot_guard.py: the day's margin cap at least one addition; bot_kinds.py: a trailing stop that waits for
     its profit needs a stop loss, a martingale on dips a take profit). tests/test_bot_audit1007.py runs every case
     through both and keeps them equal. Fields past their own limits are left to those (BotFlowKit fieldErrs). */
  const NUM = x => typeof x === 'number' && isFinite(x);
  const off = x => x == null || x === '' || x === 0 || x === '0' || x === false;     // bots._opt: empty, 0 or off
  const REQ_SL = ['breakout', 'meanrev', 'ladder', 'funding', 'fundflip', 'martingale'];
  function relErrs(kind, c) {
    c = c || {};
    const out = [], add = (key, code, v) => { if (!out.some(e => e.key === key)) out.push({key, code, v: v || {}}); };
    const fastSlow = (path, x) => {
      if (!x || (x.ind !== 'ma_cross' && x.ind !== 'macd')) return;
      const macd = x.ind === 'macd', f = x.fast == null ? (macd ? 12 : 9) : x.fast, s = x.slow == null ? (macd ? 26 : 21) : x.slow;
      if (NUM(f) && NUM(s) && f >= s) add(path + 'fast', 'fast', {n: s});
    };
    if (kind === 'sar' && (c.signal === 'ma_cross' || c.signal === 'macd')) fastSlow('', {ind: c.signal, fast: c.fast, slow: c.slow});
    if (kind === 'indicator') (c.conditions || []).forEach((x, i) => fastSlow(`conditions.${i}.`, x));
    if (kind === 'dca' && c.start) (c.start.conditions || []).forEach((x, i) => fastSlow(`start.conditions.${i}.`, x));
    if (kind === 'custom') (c.rules || []).forEach((r, i) => (r.if || []).forEach((x, j) => fastSlow(`rules.${i}.if.${j}.`, x)));
    if (kind === 'twap') {
      const d = c.duration_min == null ? 60 : c.duration_min, n = c.slices == null ? 12 : c.slices;
      if (NUM(d) && NUM(n) && n > 0 && d / n < 1) add('slices', 'slices', {n: Math.floor(d), m: d});
    }
    if (kind === 'pair') {
      const en = c.entry_z == null ? 2 : c.entry_z, ex = c.exit_z == null ? 0.5 : c.exit_z;
      if (NUM(en) && NUM(ex) && ex >= en) add('exit_z', 'exit_z', {z: en});
      if (NUM(en) && NUM(c.stop_z) && c.stop_z > 0) {
        const lv = NUM(c.levels) ? Math.round(c.levels) : 1, step = NUM(c.level_step_z) ? c.level_step_z : 0.5;
        const last = Math.round((en + (lv > 1 ? (lv - 1) * step : 0)) * 1e6) / 1e6;
        if (c.stop_z <= en) add('stop_z', 'stop_z', {z: en});
        else if (lv > 1 && c.mode !== 'trend' && c.stop_z <= last) add('stop_z', 'stop_lv', {z: last});
      }
      if (off(c.stop_z) && off(c.sl_pct) && off(c.max_loss_usd)) add(c.mode === 'trend' ? 'sl_pct' : 'stop_z', 'pair_stop');
      if (c.mode === 'trend' && off(c.sl_pct)) add('sl_pct', 'sl_req');
    }
    if (kind === 'funding' || kind === 'fundflip') {
      const lo = c.min_rate == null ? (kind === 'funding' ? 0.005 : 0.01) : c.min_rate, ex = c.exit_rate == null ? (kind === 'funding' ? 0.001 : 0) : c.exit_rate;
      if (NUM(lo) && NUM(ex) && lo > 0 && ex >= lo) add('exit_rate', 'exit_rate', {r: lo});
    }
    if (REQ_SL.includes(kind) && off(c.sl_pct)) add('sl_pct', 'sl_req');
    if (kind === 'martingale' && (c.add_on || 'loss') === 'loss' && off(c.tp_pct)) add('tp_pct', 'tp_req');
    if (kind === 'indicator' && c.side === 'neutral') { if (off(c.tp_pct)) add('tp_pct', 'tp_req'); if (off(c.sl_pct)) add('sl_pct', 'sl_req'); }
    if (kind === 'trailstop' && !off(c.activation_pct) && off(c.sl_pct)) add('sl_pct', 'sl_trail');
    if (kind === 'liqguard' && ['margin', 'margin_reduce'].includes(c.action || 'margin_reduce')) {
      if (c.margin_usd == null || c.margin_usd === '') add('margin_usd', 'margin_req');
      else if (NUM(c.margin_usd) && NUM(c.max_margin_day_usd) && c.margin_usd >= 1 && c.max_margin_day_usd < c.margin_usd) add('max_margin_day_usd', 'day_cap', {usd: c.margin_usd});
    }
    return out;
  }
  const api = {QUICK, GRIDS, GROUPS, steps, stage, groups, keysOf, prefill, keptFits, noLiq, guard, stopOf, warnList, mood, fits, btAmount, MN, pct, pctS, liqView, relErrs};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BotFlowPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* ---------------- BotFlowKit: Customize's setting rows (every setting of a type by Entry / Exit / Risk / Timing, one
   plain line each), built on terminal-bots.js's state and bindings (window.TBX-shaped X: B, shape, cfg, vals, onInput ...
   through bindPane). One renderer for the guided setup's Customize (/bots/new) and the Backtest lab's settings
   (/bots/terminal, terminal-bots.js labPaint). ---------------- */
if (typeof window !== 'undefined') window.BotFlowKit = function (X) {
  const B = X.B, P = X.P, FP = window.BotFlowPlan, T = () => window.TerminalCore;
  const ICON = {down: '<svg class="i" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>'};
  const chk = () => B.chk && B.chk.ok && B.chk.key === X.chkKey() ? B.chk : null;
  const GNAME = () => ({entry: _t('Entry'), exit: _t('Exit'), risk: _t('Risk'), timing: _t('Timing')});
  const GLINE = () => ({entry: _t('Where and how the bot places its orders.'), exit: _t('When the bot takes its profit or stops, and what it does with its position.'),
    risk: _t('How much the bot can lose and how close liquidation is.'), timing: _t('When the bot begins, what it reads and how it repeats.')});
  const row = (label, line, ctl, o = {}) => `<div class="bf-r${o.wide ? ' wide' : ''}${o.sw ? ' sw' : ''}"${o.k ? ` data-row="${esc(o.k)}"` : ''}><div><span class="k">${esc(label)}</span>` +
    (o.hHtml != null ? `<span class="h"${o.fv ? ` data-fv="${o.fv}"` : ''}>${o.hHtml}</span>` : '') +
    (line || o.ro ? `<span class="h">${line ? esc(line) : ''}${o.ro ? ` <span class="ro num" data-bv="${o.ro}">${X.vals()[o.ro] || ''}</span>` : ''}</span>` : '') + '</div>' +
    (ctl != null ? `<div class="bf-ctl">${ctl}</div>` : '') + (o.full ? `<div class="full">${o.full}</div>` : '') + '</div>';
  const numC = (k, v, u, ph, label) => `<span class="bf-in"><input data-bk="${k}" inputmode="decimal" autocomplete="off" value="${v == null ? '' : esc(v)}" placeholder="${esc(ph || '')}" aria-label="${esc(label || k)}">${u ? `<span class="u">${esc(u)}</span>` : ''}</span>`;
  const txtC = (k, v, ph, label) => `<span class="bf-in"><input data-bk="${k}" data-up="1" autocomplete="off" autocapitalize="characters" value="${v == null ? '' : esc(v)}" placeholder="${esc(ph || '')}" aria-label="${esc(label || k)}"></span>`;
  const segC = (k, v, opts) => `<div class="bf-seg" data-bseg="${esc(k)}" role="group">${opts.map(([a, l]) => `<button type="button" data-v="${esc(a)}" class="${String(v) === String(a) ? 'on' : ''}" aria-pressed="${String(v) === String(a)}">${esc(l)}</button>`).join('')}</div>`;
  const selC = (k, v, opts, label) => `<span class="bf-in"><select data-bk="${k}" aria-label="${esc(label || k)}">${opts.map(([a, l, off]) => `<option value="${esc(a)}" ${String(v) === String(a) ? 'selected' : ''}${off ? ' disabled' : ''}>${esc(l)}</option>`).join('')}</select>${ICON.down}</span>`;
  const swC = (k, on, def, label) => `<label class="bf-sw"><input type="checkbox" ${def === undefined ? `data-bk="${k}"` : `data-btog="${k}" data-def="${esc(JSON.stringify(def))}"`} ${on ? 'checked' : ''} aria-label="${esc(label || k)}"><i></i></label>`;
  /* a setting that is off or a value: the switch, and the value's field once on */
  const togC = (k, v, u, def, label) => (v != null && v !== '' && v !== false ? `<span class="bf-in sm"><input data-bk="${k}" inputmode="decimal" autocomplete="off" value="${esc(v)}" aria-label="${esc(label)}">${u ? `<span class="u">${esc(u)}</span>` : ''}</span>` : '') +
    swC(k, v != null && v !== '' && v !== false, def, label);
  const roC = key => `<span class="bf-in ro num" data-bv="${key}">${X.vals()[key] || '–'}</span>`;
  const n0 = x => x ? +String(X.rp(x)).replace(/,/g, '') : null;
  const SIDE_LINE = () => _t('The side it trades: Long earns when the price rises, Short when it falls.');
  const levC = () => `<button class="bf-in" type="button" id="tb-lev" aria-haspopup="dialog" aria-label="${_t('Leverage')}"><span class="num">${X.shape().leverage || 1}x</span>${ICON.down}</button>`;
  const mmC = () => `<button class="bf-in" type="button" id="tb-mm" aria-haspopup="dialog" aria-label="${_t('Margin')}"><span>${X.cross() ? _t('Cross') : _t('Isolated')}</span>${ICON.down}</button>`;
  const levRow = () => row(_t('Leverage'), '', levC(), {k: 'leverage', hHtml: esc(levLine()), fv: 'levline'});
  /* the leverage limit is an estimate, never called "safe" (audit 2026-10-04): isolated margin, every order filled; fees,
     funding, slippage and fast moves are not in it. A bot with no stop is told it has none. */
  function levLine() {
    const r = chk();
    // cross margin: the liquidation depends on the whole account, so no verdict about it (QA 2026-10-06, RV-04)
    if (!(r && r.safe_leverage >= 1) || X.cross()) return _t('Your position is the amount times the leverage.');
    return r.has_stop === false ? _t('Up to {n}x, the estimated liquidation comes after the bot\'s last order. It has no stop loss.', {n: r.safe_leverage})
      : r.range_exit ? _t('Up to {n}x, the estimated liquidation comes after the bot\'s last order and the point where it moves its range. It has no stop loss.', {n: r.safe_leverage})
      : r.has_stop && r.stop_checked === false ? _t('Up to {n}x, the estimated liquidation comes after the bot\'s last order. Its stop has no fixed price, so it is not checked against the liquidation.', {n: r.safe_leverage})
      : _t('Up to {n}x, the estimated liquidation comes after the last order and the stop loss. An estimate: fees, slippage and fast moves are not in it.', {n: r.safe_leverage});
  }
  const mmRow = () => row(_t('Margin'), _t('Isolated uses margin for this market, not a separate bot account. Cross shares account margin.'), mmC(), {k: 'margin'});
  function gridRow(key, s, c) {
    const k = B.kind, short = c.mode === 'short';          // a short grid (Reverse, or Direction Short) gains as the price falls
    switch (key) {
      case 'mode': return row(_t('Direction'), _t('Neutral buys below the price and sells above it. Long or Short holds a position from the start.'), segC('mode', s.mode || 'neutral', [['neutral', _t('Neutral')], ['long', _t('Long')], ['short', _t('Short')]]), {k: key});
      case 'range': return row(_t('Price range'), _t('It trades only inside this range.'), `<span class="bf-rg"><span class="bf-in"><input data-bk="lower" inputmode="decimal" autocomplete="off" value="${c.lower == null ? '' : esc(c.lower)}" aria-label="${_t('Low')}"></span><span class="dash">–</span><span class="bf-in"><input data-bk="upper" inputmode="decimal" autocomplete="off" value="${c.upper == null ? '' : esc(c.upper)}" aria-label="${_t('High')}"></span></span>`, {k: key, ro: 'rng_rd'});
      case 'range_by': { const by = s.range_by === 'swing' ? 'swing' : 'vol';
        return row(_t('Range from'), _t('± % of the price: centred on the price, as wide as the coin usually moves (30 days of 4h volatility). Last candles: the low and high of the last candles of the preset\'s chart.'),
          segC('range_by', by, [['vol', _t('± % of price')], ['swing', _t('Last candles')]]), {k: key}) +
          (by === 'swing' ? row(_t('Candles'), _t('How many closed candles the low and high are read from (10 to 250).'), numC('range_n', s.range_n || 30, '', '30', _t('Candles')), {k: 'range_n'}) : ''); }
      case 'grids': return row(_t('Grids'), _t('More lines: more, smaller trades. Fewer: bigger, rarer ones.'), numC('grids', c.grids, '', '', _t('Grids')), {k: key});
      case 'step_pct': { const x = P.stepOf(c.lower, c.upper, c.grids, c.spacing);
        return row(_t('Step'), _t('The gap between two lines; typing it sets the grids.'), numC('step_pct', s.grid_by === 'step' && s.step_pct ? s.step_pct : x == null ? '' : Math.round(x * 100) / 100, '%', '', _t('Step')), {k: key, ro: 'gstep_rd'}); }
      case 'spacing': return row(_t('Spacing'), _t('Same % gap earns the same share on every line.'), segC('spacing', c.spacing === 'geometric' ? 'geometric' : 'arithmetic', [['arithmetic', _t('Same $ gap')], ['geometric', _t('Same % gap')]]), {k: key});
      case 'trail_up': return row(_t('Move up with the price'), _t('When the price goes above the range, the grid closes and starts again around the new price.'), swC('trail_up', s.trail_up !== false, undefined, _t('Move up with the price')), {k: key, sw: 1});
      case 'trail_down': return row(_t('Move down with the price'), _t('When the price falls under the range, the grid closes and starts again around the new price.'), swC('trail_down', !!s.trail_down, undefined, _t('Move down with the price')), {k: key, sw: 1});
      case 'stop_outside': return row(_t('Stop when the price leaves the range'), _t('Off: it waits for the price to come back.'), swC('stop_outside', s.stop_outside !== false, undefined, _t('Stop when the price leaves the range')), {k: key, sw: 1});
      case 'stop_action': return row(_t('At a stop'), s.stop_action === 'keep' ? _t('Cancels the orders and leaves what it holds open for you.') : _t('Cancels the orders and closes what it holds at market.'),
        segC('stop_action', s.stop_action === 'keep' ? 'keep' : 'close', [['close', _t('Close position')], ['keep', _t('Keep position')]]), {k: key});
      case 'tp_px': return row(_t('Take-profit price'), short ? _t('Stops the grid when the price falls to it.') : _t('Stops the grid when the price reaches it.'),
        togC('tp_px', s.tp_px, '', n0(short ? c.lower && c.lower * 0.98 : c.upper && c.upper * 1.02), _t('Take-profit price')), {k: key, sw: !s.tp_px});
      case 'sl_px': return row(_t('Stop-loss price'), short ? _t('Stops the grid when the price rises to it.') : _t('Stops the grid when the price falls to it.'),
        togC('sl_px', s.sl_px, '', n0(short ? c.upper && c.upper * 1.02 : c.lower && c.lower * 0.98), _t('Stop-loss price')), {k: key, sw: !s.sl_px});
      case 'tp_pct': return row(_t('Take profit on the investment'), _t('Stops once the grid has made this share of its amount.'), togC('tp_pct', s.tp_pct, '%', 20, _t('Take profit on the investment')), {k: key, sw: !s.tp_pct});
      case 'sl_pct': return row(_t('Stop loss on the investment'), _t('Stops once the grid has lost this share of its amount.'), togC('sl_pct', s.sl_pct, '%', 10, _t('Stop loss on the investment')), {k: key, sw: !s.sl_pct});
      case 'leverage': return levRow();
      case 'margin': return mmRow();
      case 'max_active': return row(_t('Limit orders on the exchange'), _t('Only the lines nearest the price rest; for exchanges with an order cap.'), togC('max_active', s.max_active, '', Math.min(20, Math.max(2, Math.floor((c.grids || 4) / 2))), _t('Limit orders on the exchange')), {k: key, ro: 'cap_rd', sw: !s.max_active});
      case 'trigger_px': return row(_t('Start at a price'), _t('Places no order until the price reaches this.'), togC('trigger_px', s.trigger_px, '', n0(X.mkPrice()), _t('Start at a price')), {k: key, sw: !s.trigger_px});
      default: return '';
    }
  }
  function dcaRow(key, s, c) {
    const sl0 = Math.max(+s.sl_pct || 0, 10), px0 = X.mkPrice() || 0;
    switch (key) {
      case 'side': return row(_t('Direction'), SIDE_LINE(), segC('side', s.side || 'long', [['long', _t('Long')], ['short', _t('Short')]]), {k: key});
      case 'base': return row(_t('Base order'), _t('Bought when a round starts; the rest waits for the adds.'), roC('base'), {k: key});
      case 'so_count': return row(_t('Extra orders'), _t('More adds survive a bigger move but tie up more money.'), numC('so_count', c.so_count, '', '', _t('Extra orders')), {k: key, ro: 'so_rd'});
      case 'so_step_pct': return row(_t('Price step'), _t('The gap between adds. Wider covers a bigger move.'), numC('so_step_pct', s.so_step_pct, '%', '', _t('Price step')), {k: key, ro: 'step_rd'});
      case 'step_scale': return row(_t('Step scale'), _t('Each gap against the one before. Above 1 spreads the adds out.'), numC('step_scale', s.step_scale || 1, '', '1', _t('Step scale')), {k: key});
      case 'so_mult': return row(_t('Size ×'), _t('Each add against the one before. Above 1 averages faster, risks more.'), numC('so_mult', s.so_mult, '', '', _t('Size ×')), {k: key, ro: 'mult_rd'});
      case 'max_active': return row(_t('Limit orders on the exchange'), _t('Only this many adds rest at once; the next goes out when one fills. Frees margin.'), togC('max_active', s.max_active, '', Math.min(2, Math.max(1, c.so_count - 1)), _t('Limit orders on the exchange')), {k: key, sw: !s.max_active});
      case 'tp_pct': return row(_t('Take profit'), _t('Beyond the average entry. Smaller: quicker, smaller wins.'), numC('tp_pct', s.tp_pct, '%', '', _t('Take profit')), {k: key, ro: 'tp_rd'});
      case 'tp_base': return row(_t('Take profit from the first order'), _t('Measured from the first buy, not the average: later exits, more per round.'), swC('tp_base', s.tp_base === 'first', 'first', _t('Take profit from the first order')), {k: key, sw: 1});
      case 'tp_trail_pct': return row(_t('Trailing take profit'), _t('At the target it follows the price and closes on a pullback of this much.'), togC('tp_trail_pct', s.tp_trail_pct, '%', 0.3, _t('Trailing take profit')), {k: key, sw: !s.tp_trail_pct});
      case 'be_pct': return row(_t('Move stop to breakeven'), _t('Once the price is this far in your favour, the stop moves to your average entry.'), togC('be_pct', s.be_pct, '%', Math.max(Math.round((+s.tp_pct || 1) / 2 * 100) / 100, 0.2), _t('Move stop to breakeven')), {k: key, ro: 'be_rd', sw: !s.be_pct});
      case 'sl_pct': return row(_t('Stop loss'), _t('Closes everything at this loss and stops the round. Off: no limit to the loss.'), togC('sl_pct', s.sl_pct, '%', sl0, _t('Stop loss')), {k: key, ro: 'sl_rd', sw: !s.sl_pct});
      case 'sl_base': return s.sl_pct ? row(_t('Measured from'), X.slBaseLine(c), segC('sl_base', s.sl_base === 'avg' ? 'avg' : 'first', [['first', _t('First order')], ['avg', _t('Average entry')]]), {k: key}) : '';
      case 'max_losses': return s.sl_pct ? row(_t('Losses in a row'), _t('Stop losses in a row before the bot stops; until then it starts a new round.'), numC('max_losses', s.max_losses || P.DCA_MAX_LOSSES, '', '', _t('Losses in a row')), {k: key}) : '';
      case 'leverage': return levRow();
      case 'margin': return mmRow();
      case 'start_px': return row(_t('Start at a price'), _t('The first round waits until the price reaches this.'), togC('start_px', s.start_px, '', px0 ? n0(px0 * (c.side === 'short' ? 1.01 : 0.99)) : null, _t('Start at a price')), {k: key, sw: !s.start_px});
      case 'start': return row(_t('Wait for a signal'), _t('Each round starts only when these chart conditions are true.'), `<label class="bf-sw"><input type="checkbox" id="tb-start" ${s.start ? 'checked' : ''} aria-label="${_t('Wait for a signal')}"><i></i></label>`,
        {k: key, sw: 1, full: s.start ? X.segH('start.timeframe', s.start.timeframe, T().BOT_TFS.map(t => [t, t])) + X.condsH(s.start.conditions, 'start.conditions') : ''});
      case 'repeat': return row(_t('Repeat after profit'), _t('Starts a new round after each take profit. Off: one round only.'), swC('repeat', s.repeat !== false, undefined, _t('Repeat after profit')), {k: key, sw: 1});
      case 'cooldown_min': return s.repeat !== false ? row(_t('Wait between rounds'), _t('Minutes it waits after a take profit before the next round starts.'), numC('cooldown_min', s.cooldown_min, _t('min'), '0', _t('Wait between rounds')), {k: key}) : '';
      case 'max_rounds': return s.repeat !== false ? row(_t('Stop after'), _t('Empty: it keeps going until you stop it.'), numC('max_rounds', s.max_rounds, _t('rounds'), '∞', _t('Stop after')), {k: key}) : '';
      default: return '';
    }
  }
  function indRow(key, s, c) {
    const e = s.entry || {mode: 'all'}, ce = c.entry || {};
    switch (key) {
      case 'side': return row(_t('Direction'), s.side === 'neutral' ? _t('Long on the signal, short on its mirror; each signal closes the open side first.') : SIDE_LINE(),
        segC('side', s.side || 'long', [['long', _t('Long')], ['short', _t('Short')], ['neutral', _t('Both')]]), {k: key});
      case 'strat': return row(_t('Indicator'), _t('The chart signal it waits for; Safe, Balanced and Aggressive tune it.'), selC('__strat', B.strat, T().IND_STRATS.map(x => [x, X.IND_LABEL()[x]]), _t('Indicator')), {k: key});
      case 'conditions': return row(_t('Signal'), _t('It enters when these are true on a closed candle.'), null, {k: key, wide: 1, full: X.condsH(s.conditions || [], 'conditions')});
      case 'entry': if (s.side === 'neutral') return '';
        return row(_t('Entry'), _t('All at once, in parts, or adding more as the price moves against it.'), null, {k: key, wide: 1, full: X.segH('entry.mode', e.mode, [['all', _t('At once')], ['split', _t('Split')], ['dca', 'DCA'], ['martingale', _t('Martingale')]], 4, ' sm')}) +
          (e.mode === 'split' ? row(_t('Split'), _t('Price steps: each part waits a step further from the first. Per candle: one part each time a candle closes.'), segC('entry.by', e.by, [['price', _t('Price steps')], ['candles', _t('Per candle')]]), {k: 'entry.by'}) +
            row(_t('Parts'), _t('How many orders the entry is split into.'), numC('entry.parts', ce.parts, '', '', _t('Parts')), {k: 'entry.parts'}) +
            (e.by === 'price' ? row(_t('Price step'), _t('The gap between two parts.'), numC('entry.step_pct', e.step_pct, '%', '', _t('Price step')), {k: 'entry.step_pct'}) : '') : '') +
          (e.mode === 'dca' || e.mode === 'martingale' ? row(_t('Extra orders'), _t('More adds survive a bigger move but tie up more money.'), numC('entry.so_count', ce.so_count, '', '', _t('Extra orders')), {k: 'entry.so_count'}) +
            row(_t('Price step'), _t('The gap between adds. Wider covers a bigger move.'), numC('entry.so_step_pct', e.so_step_pct, '%', '', _t('Price step')), {k: 'entry.so_step_pct'}) +
            row(_t('Size ×'), _t('Each add against the one before. Above 1 averages faster, risks more.'), numC('entry.so_mult', e.so_mult, '', '', _t('Size ×')), {k: 'entry.so_mult'}) : '');
      case 'tp_pct': return row(_t('Take profit'), _t('Closes everything this far in your favour.'), numC('tp_pct', s.tp_pct, '%', '', _t('Take profit')), {k: key, ro: 'tp_rd'});
      case 'exit_opposite': return s.side === 'neutral' ? '' : row(_t('Close on opposite signal'), _t('Closes the trade when the signal turns the other way.'), swC('exit_opposite', !!s.exit_opposite, undefined, _t('Close on opposite signal')), {k: key, sw: 1});
      case 'exit': return s.side === 'neutral' && (s.conditions || []).some(x => x.ind === 'bb') ? row(_t('Exit at'), _t('Middle: closes at the middle band. Opposite signal: holds until the signal turns the other way.'), segC('exit', s.exit || 'mid', [['mid', _t('Middle')], ['flip', _t('Opposite signal')]]), {k: key}) : '';
      case 'sl_pct': return row(_t('Stop loss'), _t('Closes everything this far against you.'), numC('sl_pct', s.sl_pct, '%', '', _t('Stop loss')), {k: key, ro: 'sl_rd'});
      case 'trail_pct': return row(_t('Trailing stop'), _t('The stop follows the best price this far behind it, never back.'), togC('trail_pct', s.trail_pct, '%', 1, _t('Trailing stop')), {k: key, sw: !s.trail_pct});
      case 'leverage': return levRow();
      case 'margin': return mmRow();
      case 'timeframe': return row(_t('Chart'), _t('The candles it reads; it checks as each one closes.'), segC('timeframe', s.timeframe, T().BOT_TFS.map(t => [t, t])), {k: key});
      default: return '';
    }
  }
  /* the schema types: each field's own label and reason (terminal-core.js BOT_SCHEMA), a plain line for the few without one */
  const LINES = () => ({repeat: _t('After each exit it waits for the next entry. Off: one trade only.'),
    // the trailing entry and the martingale start again after a take profit or a trailing stop closing in profit, after
    // fees; the stop loss, or the trailing stop at a loss, ends them (bot_kinds trail_exit_of)
    'chase.repeat': _t('After a take profit, or a trailing stop that closes in profit after fees, it waits for the next entry; the stop loss, or the trailing stop at a loss, ends the bot. Off: one trade only.'),
    'martingale.repeat': _t('After a take profit, or a trailing stop that closes in profit after fees, it starts a new round; the stop loss, or the trailing stop at a loss, ends the bot. Off: one round only.'), timeframe: _t('The candles it reads; it checks as each one closes.'),
    'recurring.every': _t('How often it buys.'), 'recurring.weekday': _t('The day of the weekly buy.'), 'rebalance.coins': _t('The coins it holds and each one\'s allocation; together they make 100%.'),
    'rebalance.mode': _t('On drift: trades back once a coin moves away from its weight. On time: on a fixed schedule.'), 'rebalance.every_h': _t('Hours between two rebalances.'),
    'breakout.expire': _t('Candles the pullback order waits before it is cancelled.'), 'meanrev.period': _t('Candles the bands are measured over.'),
    'trailstop.trail_pct': _t('How far behind the best price the stop follows.'), 'trailstop.atr_period': _t('Candles the ATR is measured over.'),
    'trailstop.atr_mult': _t('The stop sits this many ATRs behind the best price.'), 'chase.mode': _t('Rebound: buys after a bounce from the low. Chase: keeps a limit order at the best price.'),
    'scaleout.step_pct': _t('The gap between two targets.'), 'sar.signal': _t('The trend signal it flips on.'), 'sar.period': _t('Candles the ATR is measured over.'),
    'sar.mult': _t('How far the Supertrend line sits from the price, in ATRs.'), 'sar.fast': _t('The fast average\'s length, in candles.'), 'sar.slow': _t('The slow average\'s length, in candles.'),
    'ladder.lookback': _t('Candles the recent low is read from.'), 'ladder.offset_pct': _t('How far under the recent low the first order waits.'),
    'ladder.count': _t('How many limit orders wait under the low.'), 'ladder.step_pct': _t('The gap between two orders.'), 'funding.exit_rate': _t('Closes once funding pays less than this per hour.'),
    'custom.rules': _t('If these conditions are true, then place these orders: your own bot.')});
  function schemaRow(key, s) {
    const k = B.kind;
    if (key === 'side') {
      const sides = T().BOT_SIDES[k] || ['long', 'short'], W = {long: _t('Long'), short: _t('Short'), both: _t('Both')};
      const held = P.holds(k, s);                                                        // it works on a position you hold
      /* Both: what each side waits for, as the engine runs it (radar/auto/bot_rules.py describe), never "Long earns when the price rises" */
      const BOTH = {breakout: _t('Both: long when a candle closes above the range\'s high, short when it closes below its low.'),
        meanrev: _t('Both: long at the lower band, short at the upper band.'), funding: _t('Both: it takes whichever side funding pays.'), fundflip: _t('Both: it takes whichever side funding pays.')};
      const line = held ? _t('The side of the position you hold: Long for a long, Short for a short.') : (s.side || sides[0]) === 'both' && BOTH[k] ? BOTH[k] : SIDE_LINE();
      return row(_t('Direction'), line, segC('side', s.side || sides[0], sides.map(x => [x, W[x]])), {k: key});
    }
    if (key === 'leverage') return P.holds(k, s) ? '' : levRow();
    if (key === 'margin') return P.holds(k, s) ? '' : mmRow();
    const fs = (T().BOT_SCHEMA[k] || []).filter(f => f.k === key && (!f.show || f.show(s)));
    return fs.map(f => {
      const v = X.getPath(s, f.k);
      let line = f.tip || LINES()[`${k}.${f.k}`] || LINES()[f.k] || '';
      const full = f.l === 'TP' ? _t('Take profit') : f.l === 'SL' ? _t('Stop loss') : null;
      if (full) {          // the row has the room for the whole word; its tip then starts with it ("Take profit: ..."): once is enough
        const m = line.match(/^([^:：]{1,24})[:：]\s*/), eng = f.l === 'TP' ? 'take profit' : 'stop loss';
        if (m && [full.toLowerCase(), eng].includes(m[1].trim().toLowerCase())) { line = line.slice(m[0].length); line = line.charAt(0).toUpperCase() + line.slice(1); }
        f = {...f, l: full};
      }
      const capW = c => c && X.HARD.includes(c) && X.capWhy(c);
      const def = (P.DEFAULTS[k] || {})[f.k];          // the server's value for an empty field: what the field shows (audit BOT-02, BOT-15)
      if (f.t === 'num') return row(f.l, line, numC(f.k, v, f.u, f.ph != null ? f.ph : def != null ? String(def) : '', f.l), {k: f.k});
      if (f.t === 'coin') return row(f.l, line, X.coinBtn(f.k, v, f.l), {k: f.k});
      if (f.t === 'venue') return row(f.l, line, selC(f.k, v || '', X.venueOpts().map(([a, l]) => [a, String(l).replace(/&amp;/g, '&')]), f.l), {k: f.k});
      if (f.t === 'sel') return row(f.l, line, selC(f.k, v, f.opts.map(([a, l, c]) => [a, l, capW(c)]), f.l), {k: f.k});
      if (f.t === 'ck') return row(f.l, line, swC(f.k, v !== false && v != null && v !== '' && v !== 0, undefined, f.l), {k: f.k, sw: 1});
      if (f.t === 'seg') { const opts = f.opts.filter(o => !capW(o[2])).map(([a, l]) => [a, l]); return row(f.l, line, segC(f.k, v == null ? (def != null ? def : f.opts[0][0]) : v, opts), {k: f.k}); }
      if (f.t === 'coins') return row(f.l, line, null, {k: f.k, wide: 1, full: X.coinsH(s.coins || [])});
      if (f.t === 'rules') return row(f.l, line, null, {k: f.k, wide: 1, full: X.rulesH(s.rules || [])});
      return '';
    }).join('');
  }
  /* the number fields' own limits (shared by Customize and the Backtest lab: a test must never run
     with -1 extra orders clamped to 0 without a word) */
  /* each number field's limits as the server validates them (radar/auto/bot_limits.py, served as window.RV_BOT_LIMITS):
     a path's list indexes stand as * ("coins.*.weight"); an indicator condition's by its indicator (round-2 QA
     2026-10-07: a negative take profit, 1e9 %, hour 99 reached the review) */
  const LIM = () => window.RV_BOT_LIMITS || {kinds: {}, cond: {}};
  function limOf(k, key, s) {
    const t = LIM().kinds[k] || {}, star = key.replace(/\.\d+(?=\.|$)/g, '.*');
    if (t[star]) return t[star];
    const m = key.match(/^(.*(?:conditions|\.if))\.(\d+)\.(\w+)$/);
    if (!m) return null;
    const c = (X.getPath(s, m[1]) || [])[+m[2]] || {};
    return ((LIM().cond || {})[c.ind] || {})[m[3]] || null;
  }
  const nfmt = v => { try { return new Intl.NumberFormat(document.documentElement.lang || 'en', {maximumFractionDigits: 8}).format(v); } catch (e) { return String(v); } };
  /* the reason a number is past its limits, in the field's own words: the range it may take */
  function limWhy(l, v, long) {
    const lt = l.lt != null ? l.lt : long ? l.ltL : l.ltS, lo = l.lo != null ? l.lo : l.gt, hi = lt != null ? lt : l.hi;
    const bad = (l.lo != null && v < l.lo) || (l.gt != null && v <= l.gt) || (l.hi != null && v > l.hi) || (lt != null && v >= lt) || (l.int && v !== Math.round(v));
    if (!bad) return '';
    const m = {lo: nfmt(lo), hi: nfmt(hi)};
    if (l.int) return lo != null && hi != null ? _t('Enter a whole number from {lo} to {hi}', m) : lo != null ? _t('Enter a whole number from {lo}', m) : _t('Enter a whole number');
    if (lo == null) return hi == null ? '' : _t('Enter a number below {hi}', m);
    if (hi == null) return l.gt != null ? _t('Enter a number above {lo}', m) : _t('Enter {lo} or more', m);
    if (l.gt != null) return lt != null ? _t('Enter a number above {lo} and below {hi}', m) : _t('Enter a number above {lo}, up to {hi}', m);
    return _t('Enter a number from {lo} to {hi}', m);
  }
  /* a grid's range: both prices above 0, the low under the high, and near the price (from a tenth to ten times it):
     a range a thousand times the price is a typing slip, never a plan (round-2 QA 2026-10-07: lower -5, upper 1e9) */
  const RANGE_X = 10, PX_KEYS = ['limit_px', 'activation_px', 'trigger_px', 'start_px'];
  function rangeErrs(c) {
    const out = [], px = X.mkPrice(), lo = c.lower, hi = c.upper;
    if (!(lo > 0) || !(hi > 0)) return out;
    if (!(hi > lo)) return [{key: 'upper', text: _t('The high must be above the low')}];
    if (px > 0 && (lo < px / RANGE_X || hi > px * RANGE_X)) {
      const t = _t('Keep the range near the price: between {lo} and {hi}', {lo: X.rp(px / RANGE_X), hi: X.rp(px * RANGE_X)});
      if (lo < px / RANGE_X) out.push({key: 'lower', text: t});
      if (hi > px * RANGE_X) out.push({key: 'upper', text: t});
    }
    return out;
  }
  function fieldErrs(drawn) {
    const k = B.kind, s = X.shape(), c = X.cfg(), out = [], seen = new Set();
    const long = (c.side || c.mode || s.side || 'long') !== 'short' && k !== 'rgrid';
    for (const key of drawn) {
      const v = X.getPath(s, key);
      if (v == null || v === '') continue;
      seen.add(key);
      if (typeof v !== 'number' || !isFinite(v)) { out.push({key, text: _t('Enter a number')}); continue; }
      const l = limOf(k, key, s), why = l ? limWhy(l, v, long) : '';
      if (why) { out.push({key, text: why}); continue; }
      // a grid's step at 0 or below: the plan would drop it for the grids' own count, never silently (round-3 QA)
      if (P.GRIDS.includes(k) && key === 'step_pct' && !(v > 0)) { out.push({key, text: _t('Enter a number above {lo}', {lo: nfmt(0)})}); continue; }
      // a price setting from a tenth to ten times the price, as a grid's range (rangeErrs): 1e12 is a typing slip
      const pxNow = X.mkPrice();
      if (PX_KEYS.includes(key) && v > 0 && pxNow > 0 && (v < pxNow / RANGE_X || v > pxNow * RANGE_X)) {
        out.push({key, text: _t('Keep this price near the market price: between {lo} and {hi}', {lo: X.rp(pxNow / RANGE_X), hi: X.rp(pxNow * RANGE_X)})}); continue; }
      const u = X.getPath(c, key);
      if (typeof u === 'number' && isFinite(u) && Math.abs(u - v) > 1e-9 * Math.max(1, Math.abs(v)))
        out.push({key, text: _t('Out of range: the bot would use {v}.', {v: String(+u.toFixed(8))})});
    }
    // the settings the bot would be sent that Customize did not draw (a link's settings, a plan, the other steps): the
    // same limits on what goes to the server
    for (const key of Object.keys(LIM().kinds[k] || {})) {
      if (key.includes('*') || seen.has(key)) continue;
      const u = X.getPath(c, key), l = limOf(k, key, s);
      if (typeof u === 'number' && l && limWhy(l, u, long)) out.push({key, text: limWhy(l, u, long)});
      else if (u != null && u !== '' && typeof u !== 'number' && !(u === false || u === true) && !isFinite(+u)) out.push({key, text: _t('Enter a number')});
    }
    // a long whose last planned buy would sit at a price of zero or below (bots.dca_reach_pct / entry_reach): the server
    // refuses it; said on the step field (a 1e9% step)
    const ZERO = _t('The last order would sit at a price of zero or below: use fewer or smaller steps');
    if (long && k === 'dca' && c.so_count > 0) {
      const sc = +c.step_scale > 0 ? +c.step_scale : 1;
      let r = 0; for (let j = 0; j < c.so_count; j++) r += (+c.so_step_pct || 0) * Math.pow(sc, j);
      if (r >= 100 && !out.some(x => x.key === 'so_step_pct')) out.push({key: 'so_step_pct', text: ZERO});
    }
    if (long && k === 'indicator' && c.entry) {
      const e = c.entry, key = e.mode === 'split' ? 'entry.step_pct' : 'entry.so_step_pct';
      const r = e.mode === 'split' && e.by === 'price' ? (e.parts - 1) * (+e.step_pct || 0) : e.mode === 'dca' || e.mode === 'martingale' ? (e.so_count || 0) * (+e.so_step_pct || 0) : 0;
      if (r >= 100 && !out.some(x => x.key === key)) out.push({key, text: ZERO});
    }
    if (P.GRIDS.includes(k) && c.lower != null && c.upper != null) for (const e of rangeErrs(c)) if (!out.some(x => x.key === e.key)) out.push(e);
    // the checks between settings, said on the field to change with how to fix it, as the server would refuse them at
    // the review (audit BOT-08); a field already past its own limit says that first
    for (const e of FP.relErrs(k, c)) if (!out.some(x => x.key === e.key)) out.push({key: e.key, text: relText(e)});
    // the Market-hours grid's "Wider steps" are wider than the open-market step, as the server checks (audit BOT-06)
    if (k === 'sessgrid' && c.off_hours === 'wide' && c.step_off_pct > 0 && c.step_open_pct > 0 && !(c.step_off_pct > c.step_open_pct) && !out.some(x => x.key === 'step_off_pct'))
      out.push({key: 'step_off_pct', text: _t('Make it wider than the open-market step ({v}%), or pause new entries out of hours', {v: nfmt(c.step_open_pct)})});
    return out;
  }
  function relText(e) {
    const v = e.v, n = x => nfmt(x);
    switch (e.code) {
      case 'fast': return _t('Make the fast period shorter than the slow period ({n})', {n: n(v.n)});
      case 'slices': return _t('At most one slice a minute: use {n} slices or fewer, or a longer run time', {n: n(v.n)});
      case 'exit_z': return _t('Exit closer to 0 than the entry: enter a z below {z}', {z: n(v.z)});
      case 'stop_z': return _t('Stop beyond the entry: enter a z above {z}', {z: n(v.z)});
      case 'stop_lv': return _t('Stop beyond the last entry level: enter a z above {z}', {z: n(v.z)});
      case 'pair_stop': return _t('Set a z stop, a stop loss or a max loss: a pair can drift apart for good');
      case 'exit_rate': return _t('Leave at a lower rate than you enter at: enter less than {r}', {r: n(v.r)});
      case 'sl_req': return _t('Required for this bot: enter a stop loss');
      case 'tp_req': return _t('Required for this bot: enter a take profit');
      case 'sl_trail': return _t('Required while the trail waits for its profit: enter a stop loss');
      case 'margin_req': return _t('Enter the margin to add each time');
      case 'day_cap': return _t('Enter at least the margin added each time ({usd} USD)', {usd: n(v.usd)});
      default: return _t('Fix the settings marked in red.');
    }
  }
  function groupsNow() { const k = B.kind; return FP.groups(k, T().BOT_SCHEMA[k], T().BOT_SIDES[k]); }
  function rowOf(key, s, c) { const k = B.kind; return P.GRIDS.includes(k) ? gridRow(key, s, c) : k === 'dca' ? dcaRow(key, s, c) : k === 'indicator' ? indRow(key, s, c) : schemaRow(key, s); }
  return {GNAME, GLINE, row, numC, txtC, segC, selC, swC, togC, roC, n0, SIDE_LINE, levC, mmC, levRow, levLine, mmRow, gridRow, dcaRow, indRow, LINES, schemaRow, groupsNow, rowOf, fieldErrs, limOf, limWhy};
};

/* ---------------- the page ---------------- */
if (typeof window !== 'undefined' && window.TBX && typeof S !== 'undefined') (function () {
  const X = window.TBX, B = X.B, P = X.P, FP = window.BotFlowPlan, T = () => window.TerminalCore;
  const F = B.flow = {step: 'choose', sub: 0, all: false, ret: 'review', plan: 'balanced', edit: null, pbt: {}, last: '', lastPaint: {}, chartKey: '', pend: null};
  const box = () => document.getElementById('bf');
  /* the page's analytics events (radar/web/ev.js, when loaded): the type and the coin only, never an address or a key */
  const sent = new Set();
  const ev = (name, once) => { const k = name + '|' + (once || ''); if (!window.rvEv || sent.has(k)) return; sent.add(k);
    try { window.rvEv(name, {kind: curKind(), coin: S.coin}); } catch (e) {} };
  const ICON = {back: '<svg class="i" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>', next: '<svg class="i" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    down: '<svg class="i" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>', check: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>', reset: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/></svg>', search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>'};
  const PRE = () => ({safe: _t('Safe'), balanced: _t('Balanced'), aggressive: _t('Aggressive')});
  const pct = FP.pct, pctS = FP.pctS;
  const usd = (x, d) => C().fmtUsd(x, d);
  const amt = x => X.num(x) + ' ' + QT();
  /* a plan's minimum on screen: past the most a bot may use it reads "> 10,000,000 USDC", never a 50-digit figure or
     "at least – USDC" (round-2 QA 2026-10-07) */
  const minAmt = m => !(m > 0) ? '–' : m > P.MAX_USD ? '> ' + amt(P.MAX_USD) : amt(m);
  const KINDS = () => T().BOT_KINDS;
  const isPlanned = k => k !== 'signal';
  const kindLabel = k => k === 'signal' ? _t('Signal bot') : X.kindName(k);
  const curKind = () => B.view === 'signal' ? 'signal' : B.kind;
  /* the market a heading names: a Market Neutral bot both its coins (BTC / ETH), every other bot its market (BTC/USDC) */
  const pairName = () => curKind() === 'pair' && X.cfg().coin_b ? `${C().mktName(S.coin)} / ${C().mktName(X.cfg().coin_b)}` : PAIR();
  const noAmount = () => isPlanned(curKind()) && !B.priv && !!(B.plan || X.plan()).noAmount;
  const stepsNow = () => FP.steps(curKind(), {priv: !!B.priv});
  /* what each type is best for (step 1), one line each */
  const BEST = () => ({grid: _t('Buys below the price and sells above it. Fees and losses can exceed grid gains.'),
    rgrid: _t('Best for a falling or flat market: sells first and buys back lower.'),
    infinity: _t('Best for an uptrend: a grid that moves up with the price.'),
    dca: _t('Best for buying dips: adds lower, sells everything at your take profit.'),
    martingale: _t('Best for choppy markets, with care: doubles down on dips and exits on a small bounce.'),
    recurring: _t('Best for building a position slowly: buys a set amount on a schedule.'),
    rebalance: _t('Best for holding a basket: trades back to your target weights.'),
    indicator: _t('Best if you trade a chart signal: enters on it with a take profit and a stop.'),
    breakout: _t('Best for a market about to move: enters when the price breaks its range.'),
    meanrev: _t('Best for a market that swings back: buys the lower band, sells the upper one.'),
    pair: _t('Best for hedged trades: long one coin, short a related one, trading their gap.'),
    trailstop: _t('Best for protecting a trade: a stop that follows the best price.'),
    scalp: _t('Best for a calm, liquid market: small maker trades around the price.'),
    sar: _t('Best for strong trends: always in the market, flips with the trend.'),
    ladder: _t('Best for catching sharp wicks: limit orders under the recent low.'),
    funding: _t('Best for earning funding: holds the side that gets paid.'),
    chase: _t('Best for entering at a better price: waits for a rebound or chases with a limit order.'),
    scaleout: _t('Best for taking profit in steps on a position you hold.'),
    custom: _t('Best if you have your own rules: if these conditions, then these orders.'),
    signal: _t('Best if you trade from alerts: turns TradingView alerts into orders.'),
    volgrid: _t('Best for a coin whose swings change size: the grid widens in a storm and tightens in a calm.'),
    sessgrid: _t('Best for stocks and commodities: follows the market\'s hours, weekends and opening gaps.'),
    twap: _t('Best for large orders: buys or sells in timed slices instead of one big order.'),
    liqguard: _t('Best for protecting a leveraged position you hold from liquidation.'),
    fundflip: _t('Best when funding runs hot: takes the paid side once it lasts for hours.')});
  const iconOf = k => k === 'signal' ? 'sig' : (T().BOT_CATALOG.find(x => x.id === k) || {}).icon;

  /* ---------------- keep the setup across the in-place sign-in (it reloads the page) ---------------- */
  /* also across a reload of the page (pagehide: a reload used to keep nothing): the step, the amount and
     the plan come back; a new visit (a link, New bot) starts fresh, except after the sign-in (signin) */
  const KEEP = 'rv_botflow';
  function keep(signin) {
    try { const k = curKind(), from = B.priv ? B.priv.slug : B.shared && B.shared.kind === B.kind ? B.shared.slug : null;
      sessionStorage.setItem(KEEP, JSON.stringify({at: Date.now(), signin: !!signin, kind: k, coin: S.coin, venue: S.venue, step: F.step, sub: F.sub, plan: F.plan,
        shape: isPlanned(k) ? B.shape[k] : null, total: B.total[k], preset: B.preset[k],
        from, privIn: B.priv ? {...B.privIn} : null})); } catch (e) {}
  }
  function restore(q) {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(KEEP) || 'null'); sessionStorage.removeItem(KEEP); } catch (e) { s = null; }
    if (!s || Date.now() - s.at > 30 * 60e3 || s.coin !== S.coin || s.venue !== S.venue) return false;
    let nav = ''; try { nav = (performance.getEntriesByType('navigation')[0] || {}).type || ''; } catch (e) {}
    if (!s.signin && nav !== 'reload' && nav !== 'back_forward') return false;
    if (!FP.keptFits(s, q)) return false;
    // a copy: it loads again from its link (from= stays in the address); what was typed comes back once it is here (pending)
    if (s.from) { F.pend = 'from'; F.back = s; F.plan = null; return true; }
    if (s.kind === 'signal') B.view = 'signal'; else { B.view = null; B.kind = s.kind; }
    if (s.shape) B.shape[s.kind] = s.shape;
    if (s.total != null) B.total[s.kind] = s.total;
    if (s.kind in B.preset) B.preset[s.kind] = s.preset;
    F.step = s.step || 'review'; F.plan = s.plan === null ? null : s.plan || 'balanced'; F.sub = +s.sub || 0;
    if (s.step === 'custom') F.ret = 'review';
    return true;
  }

  /* ---------------- navigation ---------------- */
  function go(step, sub) {
    if (step !== 'choose') F.fromErr = null;                  // the copy that failed is behind: its banner goes
    if (step === 'custom' && F.step !== 'custom') F.ret = F.step === 'choose' ? 'amount' : F.step;
    if (step !== 'custom' && F.step !== 'custom' && B.preset[B.kind]) F.plan = B.preset[B.kind];
    F.step = step; F.sub = sub || 0;
    if (step === 'review' && isPlanned(curKind()) && !(X.amtErr && X.amtErr())) ev('config_complete', curKind() + S.coin);
    try { scrollTo(0, 0); } catch (e) {}
    pushStep();
    render();
    if (step === 'review' || step === 'custom') X.schedule(true);
    if (step === 'amount') planBts(true);
    if (step === 'review' && window.rvEv) window.rvEv('config_complete', {kind: curKind(), coin: S.coin, from: S.signedOut ? 'signed_out' : 'signed_in'});   // radar/analytics.py
  }
  const phone = () => typeof isPhone === 'function' && isPhone();
  /* a phone asks one question per screen: step 1 the type, then the coin and the exchange; step 2 the amount, then the plan */
  const subs = step => !phone() ? 1 : step === 'choose' && isPlanned(curKind()) ? 2 : step === 'amount' && FP.stage(curKind(), noAmount()) !== 'position' && !B.priv ? 2 : 1;
  function next() {
    const st = stepsNow(), i = st.indexOf(F.step);
    if (F.step === 'custom') return go(F.ret === 'amount' ? 'review' : F.ret);
    if (F.sub + 1 < subs(F.step)) { F.sub++; try { scrollTo(0, 0); } catch (e) {} pushStep(); render();
      // a phone's plan screen after its amount: the plan picked takes the focus, so a second Enter continues (bind)
      if (F.step === 'amount' && F.sub === 1) { const b = box() && (box().querySelector('.bf-plan.on') || box().querySelector('.bf-plan')); if (b) try { b.focus({preventScroll: true}); } catch (e) {} }
      return; }
    if (curKind() === 'signal' && F.step === 'alerts') { location.href = '/bots/signals'; return; }
    if (F.step === 'review' && S.signedOut) return document.getElementById('bf-cp') ? null : connectPanel();
    if (F.step === 'review') return X.start();
    if (i >= 0 && i < st.length - 1) go(st[i + 1]);
  }
  function back() {
    const h = history.state && history.state.bf;
    if (h && h.i > 0) { history.back(); return; }              // the browser's own Back: the same step as this button
    if (F.step === 'custom') return go(F.ret);
    if (F.sub > 0) { F.sub--; render(); return; }
    const st = stepsNow(), i = st.indexOf(F.step);
    if (i > 0) go(st[i - 1], subs(st[i - 1]) - 1);
    else location.href = closeHref();
  }
  /* the close button: back where the setup was opened from (this site's page that linked here), else the bots */
  const FROM = 'rv_bf_from';
  /* in the page's language: the bots in Korean are /ko/bots (radar/i18n.py PREFIX: the code in lower case), so a visit
     in Korean stays Korean after the close (round-2 QA 2026-10-07: the X opened the English /bots); a page the referrer
     already named in a language keeps it */
  const langPre = () => { const l = String(document.documentElement.lang || 'en'); return /^en\b/i.test(l) || !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(l) ? '' : '/' + l.toLowerCase(); };
  const inLang = f => langPre() && /^\/(bots|markets|setups|points|help)?(\?|$)/.test(f) ? langPre() + (f === '/' ? '' : f) : f;
  function closeHref() { let f = null; try { f = sessionStorage.getItem(FROM); } catch (e) {} return inLang(f || '/bots'); }
  function noteFrom() {
    let f = null;
    try { const r = document.referrer ? new URL(document.referrer) : null;
      if (r && r.origin === location.origin && !r.pathname.startsWith('/bots/new')) f = r.pathname + r.search; } catch (e) {}
    try { if (f) sessionStorage.setItem(FROM, f); else if (!sessionStorage.getItem(FROM)) sessionStorage.setItem(FROM, '/bots'); } catch (e) {}
  }
  /* each step (and a phone's sub-screen) is an entry of the browser's history: Back goes to the step before, as the Back
     button; the Terminal's address updates (history.replaceState with no state) keep the entry's step */
  let popping = false;
  function pushStep() {
    if (popping) return;
    try { const h = history.state && history.state.bf;
      if (h && h.step === F.step && h.sub === F.sub) return;
      history.pushState({bf: {step: F.step, sub: F.sub, i: (h ? h.i : 0) + 1}}, '', location.href); } catch (e) {}
  }
  function onPop(e) {
    const h = e.state && e.state.bf; if (!h) return;
    popping = true;
    try { if (h.step !== F.step) go(h.step, h.sub); else { F.sub = h.sub || 0; render(); } } finally { popping = false; }
  }
  /* the expert's two clicks: Balanced (the type's preset for this market) and straight to the review */
  function expert() { if (hardWhy()) return; X.applyPreset('balanced'); F.plan = 'balanced'; go('review'); }

  /* ---------------- shared markup ---------------- */
  // a bot on a position you hold has no amount: its second step is the plan alone (round-3 QA: "2 Amount" over "Pick a plan")
  const stepName = id => ({choose: _t('Choose'), amount: noAmount() ? _t('Plan') : _t('Amount'), review: _t('Review'), pair: _t('Pair'), alerts: _t('Alerts')})[id];
  function stepsH() {
    const st = stepsNow(), cur = F.step === 'custom' ? (st.includes(F.ret) ? F.ret : st[st.length - 1]) : F.step, ci = st.indexOf(cur);
    const pre = B.priv ? [['choose', true]] : [];
    return `<ol class="bf-steps" aria-label="${_t('Steps')}">` + pre.concat(st.map((id, i) => [id, i < ci])).map(([id, done], n) => {
      const i = B.priv ? n - 1 : n, on = id === cur;
      return `<li><button type="button" data-step="${id}" class="${on ? 'on' : done ? 'done' : ''}" ${done && !(B.priv && id === 'choose') ? '' : 'disabled'}${on ? ' aria-current="step"' : ''}>` +
        `<b>${n + 1}</b><span class="t">${esc(stepName(id))}</span></button></li>`;
    }).join('') + '</ol>';
  }
  /* the workspace design's configuration wizard: its header (where am I, the step's title
     and its line, the close button), the numbered steps under it, then the step's body */
  const crumbH = () => `<p class="bf-crumb">${esc(F.edit ? _t('Edit bot') : F.step === 'custom' ? `${_t('New bot')} / ${_t('Customize')}` : _t('New bot'))} · Hyperliquid</p>`;
  const closeH = () => `<a class="bf-x" href="${esc(closeHref())}" aria-label="${_t('Close')}" title="${_t('Close')}">${ICON.x}</a>`;
  const topH = () => `<div class="bf-top"><div class="bf-tw">${stepsH()}</div></div>`;
  /* every step's <main> opens with its title and line: they go in the header, the steps under it, the rest in the body */
  function headed(h) {
    const i = h.indexOf('<h1>'), j = i < 0 ? -1 : h.indexOf('</p>', h.indexOf('<p class="bf-sub"', i)), m = j < 0 ? -1 : h.indexOf('</main>', j);
    if (i < 0 || j < 0 || m < 0) return topH() + h;
    return h.slice(0, i) + `<header class="bf-mh"><div>${crumbH()}${h.slice(i, j + 4)}</div>${closeH()}</header>` + topH() +
      '<div class="bf-mb">' + h.slice(j + 4, m) + '</div>' + h.slice(m);
  }
  const footH = (left, mid, label, o = {}) => `<div class="bf-foot"><div class="bf-fw">${left}${mid || ''}` +
    (o.href ? `<a class="bf-go" id="bf-go" href="${esc(o.href)}">${esc(label)}${GO}</a>` : `<button class="bf-go" id="bf-go" type="button"${o.off ? ' disabled' : ''}>${esc(label)}${GO}</button>`) + '</div></div>';
  const GO = '<span class="ar" aria-hidden="true">→</span>';
  const backH = ml => `<button class="bf-back${ml ? ' ml' : ''}" id="bf-back" type="button" aria-label="${_t('Back')}">${ICON.back}<span>${_t('Back')}</span></button>`;
  const coinIcon = (c, s) => window.rvCoin ? rvCoin(c, s) : '';
  const venueIcon = (v, s) => window.rvVenue ? rvVenue(v, s, {eager: true}) : '';
  /* the coin's own fee level on its exchange (fees(): a Hyperliquid builder-dex market's multiple, S.mk.fee_mult) */
  /* known: the exchange list (with its fees) is in; until then the fee is loading, never shown as a real 0% (audit BOT-18) */
  const feeOf = v => { const f = (v === S.venue && typeof fees === 'function' ? fees() : (venueInfo(v) || {}).fee) || {};
    const known = (S.venues || []).some(x => x.id === v && x.fee && x.fee.maker != null && x.fee.taker != null);
    return {known, maker: f.maker || 0, taker: f.taker || 0, rivemont: f.rivemont || 0, paid: f.paid || 0, free_left: f.free_left, free_cap: f.free_cap}; };
  /* Rivemont's rate a bot pays: on a Points fee-free day the server sends 0 with the normal rate (paid) that applies once
     the day's cap is used; a bot runs past it, so the normal rate shows with the day's line (as the Terminal; residual
     audit ui-core-04: "+ Rivemont 0%") */
  const rvRate = f => f.rivemont || f.paid;
  const freeDay = f => f.paid && !f.rivemont && f.free_left != null && typeof freeDayLine === 'function' ? freeDayLine(f) : '';
  /* every venue's fee with Rivemont's on top where it applies (each venue's all-in cost, never the exchange's alone) */
  const feeRate = v => { const f = feeOf(v), m = C().fmtRate(f.maker), t = C().fmtRate(f.taker), rv = rvRate(f);
    if (!f.known) return _t('Loading fees…');
    return rv ? _t('Fee {maker} / {taker} + Rivemont {fee} per fill', {maker: m, taker: t, fee: C().fmtRate(rv)}) : _t('Fee {maker} / {taker} per fill', {maker: m, taker: t}); };
  /* the card's line wraps where a narrow column needs it, never inside "+ Rivemont 0.1% per fill" (Rivemont's fee stays
     one piece, never "per fill" alone on a line) */
  const feeCard = v => feeRate(v).replace(/\+ Rivemont (\S+)( per fill)?/, (m, f, p) => '+\u00a0Rivemont\u00a0' + f + (p ? '\u00a0per\u00a0fill' : ''));
  function feeNote() {        // Rivemont's part only where it applies; a fee-free day's line after it
    // an alerts-only liquidation guard places no order: no fee, nothing traded (RV-26)
    if (B.kind === 'liqguard' && !B.priv && X.cfg().action === 'alert') return _t('It places no orders: it only alerts you, so it pays no trading fees.');
    const f = feeOf(S.venue), rv = rvRate(f), d = freeDay(f), v = {venue: L(S.venue), maker: C().fmtRate(f.maker), taker: C().fmtRate(f.taker), fee: C().fmtRate(rv)};
    if (!f.known) return _t('Loading fees…');
    return (rv ? _t('{venue} fee {maker} maker / {taker} taker + Rivemont {fee} per fill. The bot trades in your own account; stop it any time.', v)
      : _t('{venue} fee {maker} maker / {taker} taker per fill. The bot trades in your own account; stop it any time.', v)) + (d ? ' ' + d + '.' : '');
  }
  /* a template with its values in the text colour (B's one-sentence summary): the words stay muted */
  // Korean particles after a marked value are fitted to the value itself, through the runtime's own rule (_t on its last
  // letter + the particle): "ETH을(를)" reads "ETH를" (audit i18n-07; the marker hid the word from the runtime's jo())
  const JO = /\u0001(\d+)\u0002(을\(를\)|를\(을\)|이\(가\)|가\(이\)|은\(는\)|는\(은\)|과\(와\)|와\(과\)|\(으\)로|\(이\)라|\(이\)나)/g;
  function bold(tr, vars) {
    const keys = Object.keys(vars), mark = {};
    keys.forEach((k, i) => { mark[k] = `\u0001${i}\u0002`; });
    return esc(tr(mark)).replace(JO, (m, i, p) => { const w = String(vars[keys[+i]] ?? ''); return w ? `\u0001${i}\u0002` + _t(w.slice(-1) + p).slice(1) : m; })
      .replace(/\u0001(\d+)\u0002/g, (_, i) => `<b>${esc(vars[keys[+i]])}</b>`);
  }

  /* a server's reason as a sentence: its first letter up, a full stop at the end */
  const sentenceOf = t => { const x = String(t || '').trim(); return x ? x.charAt(0).toUpperCase() + x.slice(1) + (/[.!?。]$/.test(x) ? '' : '.') : ''; };
  /* ---------------- step 1: Choose ---------------- */
  function typeH(k) {
    const on = k === curKind(), risk = (T().BOT_CATALOG.find(x => x.id === k) || {}).risk === 'high';
    return `<button type="button" class="bf-typ${on ? ' on' : ''}" data-fkind="${k}" aria-pressed="${on}"><span class="ic">${T().botIcon(iconOf(k))}</span>` +
      `<span><span class="nm">${esc(kindLabel(k))}</span><span class="ln">${esc(BEST()[k] || X.typeLine(k))}${risk ? ` <em class="rk">${_t('High risk')}</em>` : ''}</span></span>` +
      `<span class="ck">${ICON.check}</span></button>`;
  }
  function typesH() {
    const k = curKind();
    if (!F.all) {
      const list = FP.QUICK.concat(FP.QUICK.includes(k) ? [] : [k]);
      return `<div class="bf-types">${list.map(typeH).join('')}</div>` +
        `<button class="bf-lnk bf-more" type="button" id="bf-all">${_t('All {n} bot types', {n: KINDS().length + 1})}${ICON.next}</button>`;
    }
    const known = new Set(KINDS().concat(['signal']));
    const fams = (window.RV_BOT_FAMILIES || []).map(([, name, ids]) => [name, ids.filter(k => known.has(k))]);
    const extra = {custom: ['signal']};
    const groups = fams.length ? fams : Object.entries(T().BOT_GROUP).map(([g, name]) => [name, T().BOT_CATALOG.filter(x => x.group === g).map(x => x.id).concat(extra[g] || [])]);
    return groups.map(([name, ids]) => ids.length ? `<div class="bf-grp">${esc(name)}</div><div class="bf-types">${ids.map(typeH).join('')}</div>` : '').join('') +
      `<button class="bf-lnk bf-more" type="button" id="bf-all">${_t('Fewer bot types')}</button>`;
  }
  function moodNow() {
    const rows = B.mc[X.mcKey('4h')];
    return Array.isArray(rows) ? FP.mood(rows) : null;
  }
  function moodH() {
    const k = curKind();
    if (k === 'signal') return '';
    const m = moodNow();
    if (!m) return `<p class="bf-mood" data-fv="mood">&nbsp;</p>`;
    const coin = C().mktName(S.coin);
    const a = m.mood === 'range' ? _t('{coin} has stayed within ±{pct} for 7 days.', {coin, pct: pct(m.pct, 1)})
      : m.mood === 'up' ? _t('{coin} is up {pct} in 7 days.', {coin, pct: pct(m.pct, 1)}) : _t('{coin} is down {pct} in 7 days.', {coin, pct: pct(m.pct, 1)});
    // the market-hours grid on a coin that trades around the clock: it does not run there at all (hardWhy says so), so
    // never "built for this kind of market" (round-2 QA 2026-10-07)
    const f = k === 'sessgrid' && !hasHours(S.coin) ? null : FP.fits(k, m, T().BOT_MARKETS);
    const b = f == null ? '' : f ? _t('This bot type is built for this kind of market.')
      : _t('This bot type is built for another market: {m}.', {m: (T().BOT_MARKETS[k] || []).map(x => T().BOT_MARKET[x]).join(', ')});
    return `<p class="bf-mood" data-fv="mood">${esc(a + (b ? ' ' + b : ''))}</p>`;
  }
  function coinCardH() {
    const p = curPrice(), ch = typeof dayChange === 'function' ? dayChange() : null;
    return `<button type="button" class="bf-sel" id="bf-coin" aria-haspopup="dialog"><span class="lg">${coinIcon(S.coin, 32)}</span>` +
      `<span><span class="a">${esc(C().mktName(S.coin))}</span><span class="b">${esc(_t('{pair} perpetual', {pair: PAIR()}))}</span></span>` +
      `<span class="r"><span class="a num" data-fv="px">${p ? esc(C().fmtPrice(p)) : '–'}</span><span class="b num ${ch == null ? '' : ch >= 0 ? 'up' : 'dn'}" data-fv="chg">${ch == null ? '–' : esc(C().fmtPct(ch))}</span></span>${ICON.down}</button>`;
  }
  /* Rivemont trades on Hyperliquid only: the exchange is a fixed line with its all-in fee, never a
     picker (no chevron, no sheet) */
  function venueCardH() {
    return `<div class="bf-sel st" id="bf-venue"><span class="lg">${venueIcon(S.venue, 32)}</span><span><span class="a">${esc(L(S.venue))}</span><span class="b">${esc(feeCard(S.venue))}</span></span><span></span><span></span></div>`;
  }
  /* the Market-hours grid follows a stock or commodity market (Hyperliquid's HIP-3 markets): picked on a crypto coin, the
     setup moves once to the most traded of them and says so; a crypto coin picked again after that keeps Continue off
     with the reason (hardWhy) */
  /* a market with hours to follow: a builder-dex (HIP-3) market that is not a crypto one. Paragon's BTCD (Bitcoin
     dominance) is a HIP-3 index that trades around the clock: Hyperliquid's own category (perpCategories "crypto")
     says so, read once per tab (as the Markets page, markets.js cats), a name list until it is in (radar/auto/sessions.py
     market_class; round-3 QA 2026-10-07) */
  const CRYPTO_BASE = /^(BTC|BTCD|ETHD|ETH|SOL|HYPE|XRP|DOGE|BNB|ADA|AVAX|LINK|SUI|LTC|TRX|TON|DOT|PUMP|ENA|USDC|USDT|USDE|USDH)$/;
  let hlCats = null;
  (function () {
    try { const k = JSON.parse(sessionStorage.getItem('rv_hl_cats') || 'null'); if (k && Date.now() - k.t < 3600e3) { hlCats = k.c; return; } } catch (e) {}
    try { fetch('https://api.hyperliquid.xyz/info', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'perpCategories'})})
      .then(r => r.ok ? r.json() : []).then(a => { const c = {}; for (const x of Array.isArray(a) ? a : []) if (Array.isArray(x) && x[0]) c[x[0]] = String(x[1] || '').toLowerCase();
        hlCats = c; try { sessionStorage.setItem('rv_hl_cats', JSON.stringify({t: Date.now(), c})); } catch (e) {}
        if (curKind() === 'sessgrid') { F.last = ''; render(); } }).catch(() => {}); } catch (e) {}
  })();
  const hasHours = c => { const s = String(c || ''); return s.includes(':') && !CRYPTO_BASE.test(s.split(':')[1]) && !(hlCats && hlCats[s] === 'crypto'); };
  function sessFit() {
    if (curKind() !== 'sessgrid' || F.step !== 'choose' || hasHours(S.coin) || F.sessFrom || !S.coins || !S.markets) return;
    const h = S.coins.find(c => hasHours(c.coin) && ((S.markets[c.coin] || {})[S.venue]));
    if (!h) return;
    F.sessFrom = S.coin; pick(h.coin, S.venue);
  }
  const sessNote = () => curKind() === 'sessgrid' && F.sessFrom && hasHours(S.coin) ? `<p class="bf-mood">${esc(_t('Switched from {from} to {to}: this grid follows a stock or commodity market\'s hours.', {from: C().mktName(F.sessFrom), to: C().mktName(S.coin)}))}</p>` : '';
  /* the trailing stop protects a position you hold or opens a new one: the two purposes side by side on step 1, with
     what each does, so a protection tool never opens a position unnoticed (audit BOT-05); kept across the plans */
  function purposeH() {
    if (curKind() !== 'trailstop') return '';
    // Protect is the default: only an explicit 'new' opens a position (X.tsHolds, the server alike)
    const s = X.shape(), held = X.tsHolds(s), v = L(S.venue), none = held ? X.noHeldWhy() : '';
    const b = (id, l) => `<button type="button" data-fpurp="${id}" class="${held === (id === 'attach') ? 'on' : ''}" aria-pressed="${held === (id === 'attach')}">${esc(l)}</button>`;
    return `<p class="bf-lbl">${_t('Purpose')}</p><div class="bf-seg bf-purp" role="group" aria-label="${esc(_t('Purpose'))}">${b('attach', _t('Protect a position I hold'))}${b('new', _t('Open a new position'))}</div>` +
      // an account read with no such position: that, in place of the general line (Start stays off, X.acctBlocks)
      (none ? `<p class="bf-mood bf-none" role="status">${esc(none)}</p>` : `<p class="bf-mood">${esc(held ? _t('It follows the {coin} position you already hold on {venue}: it opens nothing and sets no money aside. With no position there, it has nothing to protect.', {coin: C().mktName(S.coin), venue: v})
        : _t('It opens a new {coin} position on {venue} with your amount, then trails a stop behind it.', {coin: C().mktName(S.coin), venue: v}))}</p>`);
  }
  function chooseH() {
    const k = curKind(), sub = phone() ? F.sub : -1, hand = !isPlanned(k);
    const left = `<div><p class="bf-lbl">${_t('Bot type')}</p>${typesH()}</div>`;
    const right = hand ? `<div class="bf-side"><p class="bf-mood">${esc(_t('Your alerts choose the coin and the exchange; the next step shows how they reach Rivemont.'))}</p></div>`
      : `<div class="bf-side"><p class="bf-lbl">${_t('Coin')}</p>${coinCardH()}<p class="bf-lbl">${_t('Exchange')}</p>${venueCardH()}${purposeH()}${moodH()}${sessNote()}<p class="bf-aerr" data-fv="hard" role="alert">${esc(hardWhy())}</p></div>`;
    const body = sub === 0 ? left : sub === 1 ? right : `<div class="bf-cols">${left}${right}</div>`;
    const head = sub === 1 ? `<h1>${_t('Which market?')}</h1><p class="bf-sub">${_t('The bot trades this market in your own Hyperliquid account.')}</p>`
      : `<h1>${_t('Choose a bot')}</h1><p class="bf-sub">${_t('What it should do, on which Hyperliquid market. Everything can be changed later.')}</p>`;
    const what = `<span class="what"><b>${esc(kindLabel(k))}</b>${hand ? '' : ` · ${esc(pairName())} · ${esc(L(S.venue))}`}</span>`;
    // a link for a market Hyperliquid does not list (?coin=NOTACOIN): the page shows another and says so; an edit link
    // opened signed out: the bot is the wallet's, so it asks for it
    const miss = F.qcoin && S.markets && !S.markets[F.qcoin] && !F.qcoinOff ? `<div class="bf-banner"><span>${esc(_t('{coin} is not a Hyperliquid market. Showing {now} instead.', {coin: F.qcoin, now: C().mktName(S.coin)}))}</span></div>` : '';
    const eo = F.editOut && S.signedOut ? `<div class="bf-banner"><span>${esc(_t('Connect your wallet to edit this bot'))}</span><button class="bf-chip bf-lnk" type="button" id="bf-editin">${_t('Connect wallet')}</button></div>` : '';
    const err = miss + eo + (F.fromErr ? `<div class="bf-banner"><span>${esc(_t('This setup could not be loaded. Pick a bot below, or open the link again in a moment.'))}${F.fromErr.trim() ? ' ' + esc(sentenceOf(F.fromErr)) : ''}</span></div>` : '');
    return `<main class="bf-w">${head}${err}${sub >= 0 ? `<div class="bf-cols bf-one">${body}</div>` : body}</main>` +
      footH(what, isPlanned(k) ? `<button class="bf-lnk bf-sec" type="button" id="bf-expert">${_t('Use Balanced, go to Review')}</button>` : '', _t('Continue'));
  }

  /* ---------------- step 2: Amount (and the plan) ---------------- */
  const KV = (k, v) => `<div class="bf-kv"><span>${esc(k)}</span><span class="num">${v}</span></div>`;
  /* a plan's settings with the choices kept that applyPreset keeps (the side, a grid's direction, a basket, a pair) */
  function planShape(name) {
    const k = B.kind, cur = X.shape(), save = {b: B.basis[k], r: B.rangePre[k]};
    const s = X.presetShape(k, name);
    B.basis[k] = save.b; B.rangePre[k] = save.r;
    const sides = k === 'indicator' ? ['long', 'short', 'neutral'] : T().BOT_SIDES[k] || ['long', 'short'];
    if (cur.side && !P.GRIDS.includes(k) && sides.includes(cur.side) && cur.side !== T().BOT_PRESETS[k][name].side) {
      s.side = cur.side;
      if (k === 'indicator') s.conditions = T().indSignal(B.strat, name, cur.side === 'short' ? 'short' : 'long').conditions;
    }
    if (cur.mode && (k === 'grid' || k === 'infinity')) s.mode = cur.mode;
    for (const x of ['coins', 'coin_b', 'venue_b']) if (cur[x] != null) s[x] = cur[x];
    return s;
  }
  const ctxNow = () => ({px: X.mkPrice(), minOrder: X.minOrder()});
  function planOf(name) {
    const s = planShape(name), p = P.derive(B.kind, s, X.total(), ctxNow());
    return {s, p, c: p.cfg};
  }
  const tfTxt = c => c.timeframe || '';
  const tpsl = c => `${c.tp_pct ? `<span class="up">+${pct(c.tp_pct)}</span>` : '–'} / ${c.sl_pct ? `<span class="dn">−${pct(c.sl_pct)}</span>` : '–'}`;
  /* a plan's three key numbers (labels the builder already uses) */
  function planRows(k, s, c) {
    const lev = `${c.leverage || 1}x`, px = X.mkPrice();
    if (P.GRIDS.includes(k)) {
      const h = c.lower && c.upper && px ? Math.max(c.upper / px - 1, 1 - c.lower / px) * 100 : null;
      return [[_t('Range'), h == null ? '–' : '±' + pct(h, h < 10 ? 1 : 0)], [_t('Grids'), String(c.grids)], [_t('Leverage'), lev]];
    }
    switch (k) {
      case 'dca': return [[_t('Extra orders'), c.so_count ? `${c.so_count} × ${pct(c.so_step_pct)}` : _t('None')], [_t('Take profit'), `<span class="up">+${pct(c.tp_pct)}</span>`], [_t('Leverage'), lev]];
      case 'martingale': return [[_t('Most adds'), `${c.max_adds} × ${pct(c.step_pct)}`], [_t('Multiplier'), `×${c.mult}`], [_t('Take profit'), `<span class="up">+${pct(c.tp_pct)}</span>`]];
      case 'recurring': return [[_t('Every'), esc({hour: _t('Hourly'), day: _t('Daily'), week: _t('Weekly')}[c.every] || c.every)], [_t('Times'), String(c.times)], [_t('Each buy'), X.total() ? usd(c.usd) : '–']];
      case 'rebalance': return [[_t('Rebalance'), c.mode === 'interval' ? _t('Every {h}h', {h: c.every_h}) : _t('Drift {v} pp', {v: c.drift_pct})], [_t('Coins'), String((c.coins || []).length)], [_t('Leverage'), lev]];
      case 'indicator': return [[_t('Signal'), esc(`${tfTxt(c)} ${T().sigLine(c)}`)], [_t('TP / SL'), tpsl(c)], [_t('Leverage'), lev]];
      case 'meanrev': return [[_t('Chart'), tfTxt(c)], [_t('Width'), String(c.std)], [_t('Stop loss'), c.sl_pct ? `<span class="dn">−${pct(c.sl_pct)}</span>` : '–']];
      case 'pair': return [[_t('Chart'), tfTxt(c)], [_t('Enter at z'), String(c.entry_z)], [_t('Stop loss'), c.sl_pct ? `<span class="dn">−${pct(c.sl_pct)}</span>` : '–']];
      case 'sar': return [[_t('Chart'), tfTxt(c)], [_t('Signal'), esc(T().sarSig(c))], [_t('Leverage'), lev]];
      case 'ladder': return [[_t('Chart'), tfTxt(c)], [_t('Orders'), `${c.count} × ${pct(c.step_pct)}`], [_t('TP / SL'), tpsl(c)]];
      case 'custom': return [[_t('Chart'), tfTxt(c)], [_t('Rules'), String((c.rules || []).length)], [_t('Stop loss'), c.sl_pct ? `<span class="dn">−${pct(c.sl_pct)}</span>` : '–']];
      case 'trailstop': return [[_t('Trail by'), c.by === 'atr' ? `${c.atr_mult}× ATR` : pct(c.trail_pct)], [_t('Start at'), c.activation_pct ? '+' + pct(c.activation_pct) : _t('Now')], [_t('Leverage'), lev]];
      case 'chase': return [[_t('Entry'), c.mode === 'chase' ? _t('Chase') : `${_t('Rebound')} ${pct(c.callback_pct)}`], [_t('TP / SL'), tpsl(c)], [_t('Leverage'), lev]];
      case 'scaleout': return [[_t('Targets'), String(c.levels)], [_t('First'), '+' + pct(c.first_pct)], [_t('Every'), pct(c.step_pct)]];
      case 'scalp': return [[_t('Gap'), pct(c.spread_pct)], [_t('Each side'), String(c.levels)], [_t('Leverage'), lev]];
      case 'funding': return [[_t('Enter at'), `${c.min_rate}%/h`], [_t('Exit under'), `${c.exit_rate}%/h`], [_t('Leverage'), lev]];
      case 'volgrid': return [[_t('Step'), `${c.step_atr}× ATR ${tfTxt(c)}`], [_t('Grids'), String(c.grids)], [_t('Leverage'), lev]];
      case 'sessgrid': return [[_t('Step, market open'), pct(c.step_open_pct)], [_t('Out of hours'), c.off_hours === 'wide' ? pct(c.step_off_pct) : _t('Pause new entries')], [_t('Leverage'), lev]];
      case 'twap': return [[_t('Slices'), String(c.slices)], [_t('Run time'), `${c.duration_min} ${_t('min')}`], [_t('Leverage'), c.mode === 'unwind' ? '–' : lev]];
      case 'liqguard': return [[_t('Act at'), pct(c.trigger_pct)], [_t('Then'), esc({margin_reduce: _t('Margin, else cut'), margin: _t('Add margin'), reduce: _t('Cut'), alert: _t('Alert')}[c.action] || '')], [_t('Actions a day'), String(c.max_day)]];
      case 'fundflip': return [[_t('Enter at'), `${(c.preset || c).min_rate}%/h`], [_t('For'), `${(c.preset || c).hours}h`], [_t('Stop loss'), c.sl_pct ? `<span class="dn">−${pct(c.sl_pct)}</span>` : '–']];
      default: return [[_t('Chart'), tfTxt(c)], [_t('TP / SL'), tpsl(c)], [_t('Leverage'), lev]];          // breakout
    }
  }
  const VOL = ['grid', 'rgrid', 'infinity', 'dca', 'martingale', 'ladder'];
  function planLine(k, name) {
    if (k === 'custom') return '';
    // the liquidation guard has no leverage and makes no trades of its own: its plans differ in how early it acts and
    // how (terminal-core.js BOT_PRESETS liqguard; RV-26: it read "low leverage: fewer trades")
    if (k === 'liqguard') return name === 'safe' ? _t('Acts early, far from liquidation: adds margin first, cuts the position only if that is not enough.')
      : name === 'aggressive' ? _t('Acts late, close to liquidation, and cuts a bigger share each time.')
      : _t('Acts at a middle distance from liquidation: adds margin first, then cuts.');
    // relative to the other two plans, never "no loss", and only what every type's plans really differ in (audit COPY-03
    // 2026-10-07: "stops sooner" was not true of every type; an Aggressive DCA has no stop loss at all)
    if (name === 'safe') return _t('Calmer settings and lower leverage than the other plans: fewer trades, smaller swings. Lower risk, not no risk.');
    if (name === 'aggressive') return _t('Tighter settings and more leverage than the other plans: more trades, bigger gains and losses.');
    return VOL.includes(k) || k === 'breakout' || k === 'meanrev' || k === 'indicator' ? _t('Sized to how {coin} moved in the last 30 days.', {coin: C().mktName(S.coin)})
      : _t('The middle ground: steady trades, moderate risk.');
  }
  const ACT = () => ({buy: _t('Buy'), sell: _t('Sell'), close: _t('Close [position]'), target: _t('Go long / short'), ladder: _t('Ladder'), cancel: _t('Cancel orders')});
  /* Custom rules: a rule set in words, one line per rule (if ... then ...) */
  function rulesTxt(c) {
    return (c.rules || []).map(r => `${(r.if || []).map(x => T().condText(x, true)).join(r.logic === 'or' ? ` ${_t('or')} ` : ` ${_t('and')} `)} → ` +
      (r.then || []).map(a => `${a.do === 'target' ? (a.side === 'short' ? _t('Short') : _t('Long')) : ACT()[a.do] || a.do}${a.pct != null && a.do !== 'cancel' ? ' ' + a.pct + '%' : ''}`).join(', '));
  }
  function planBtKey(name) {
    const o = planOf(name), m = FP.btAmount(X.total(), o.p.minTotal, X.BT_REF);
    const c = m === X.total() ? o.c : P.derive(B.kind, o.s, m, ctxNow()).cfg;
    // a plan's range is laid around today's price: the test centres it on the price at its start (as the review's and
    // the Backtest lab's), so a 30-day test never opens outside it (round-3 QA 2026-10-07: 0% and "left your range")
    const rc = P.GRIDS.includes(B.kind) && !o.s.range_man;
    return {key: JSON.stringify([B.kind, c, S.coin, S.venue, curMode(), rc]), body: {kind: B.kind, config: {...c, coin: S.coin, venue: S.venue, margin_mode: curMode()}, days: 30, ...(rc ? {recenter: true} : {})}};
  }
  /* each plan's own 30-day backtest (the same /api/auto/bots/backtest as the review's), once per plan and amount. A test
     that failed is asked again (a busy minute passes: 20 s, the server's Retry-After; another failure 60 s), never kept
     as the plan's answer; a type with no backtest (the liquidation guard) or settings that cannot run fire none */
  const PBT_RETRY = e => e && e.status === 429 ? 20e3 : 60e3;
  function planBts(now) {
    clearTimeout(F.pbtT);
    if (F.step !== 'amount' || !isPlanned(B.kind) || B.priv || !C() || !X.mkPrice()) return;
    if (X.noBtWhy(B.kind) || hardWhy() || X.amtErr()) return;
    if (P.GRIDS.includes(B.kind) && !(X.cfg().upper > X.cfg().lower)) return;
    F.pbtT = setTimeout(() => {
      for (const n of ['safe', 'balanced', 'aggressive']) {
        let q; try { q = planBtKey(n); } catch (e) { continue; }
        const r = F.pbt[q.key];
        if (r && (r.busy || r.d || (r.err && Date.now() < r.again))) continue;
        F.pbt[q.key] = {busy: true};
        api0('/api/auto/bots/backtest', q.body).then(d => { F.pbt[q.key] = {d}; })
          .catch(e => { const w = PBT_RETRY(e); F.pbt[q.key] = {err: e.message, again: Date.now() + w};
            F.pbtN = (F.pbtN || 0) + 1;                       // a few times, never a loop against a test that cannot run
            if (F.pbtN <= 6) { clearTimeout(F.pbtR); F.pbtR = setTimeout(() => planBts(true), w + 50); } }).then(paint);
      }
    }, now ? 0 : 400);
  }
  function planBtTxt(name) {
    if (X.noBtWhy(B.kind)) return esc(_t('No backtest'));
    let q; try { q = planBtKey(name); } catch (e) { return '–'; }
    const r = F.pbt[q.key];
    if (!r || r.busy) return '<span class="sk" style="display:inline-block;width:48px;height:12px"></span>';
    if (r.err) return `<span class="mut" title="${esc(r.err)}">…</span>`;           // asked again shortly; the reason is under the plans
    if (!r.d || !r.d.stats || X.amtErr()) return '–';
    if (idleOf(r.d.stats)) return `<span class="mut">${esc(_t('No trades'))}</span>`;     // nothing filled in the 30 days: said, never a bare dash
    const x = r.d.stats.return_pct;
    return `<span class="${x > 0 ? 'up' : x < 0 ? 'dn' : ''}">${pctS(x)}</span>`;
  }
  /* why the plans' backtests show no figure: the first failure's reason and that it is asked again */
  function planBtErr() {
    if (X.noBtWhy(B.kind)) return '';
    for (const n of ['safe', 'balanced', 'aggressive']) {
      let q; try { q = planBtKey(n); } catch (e) { continue; }
      const r = F.pbt[q.key]; if (r && r.err) return sentenceOf(r.err) + ((F.pbtN || 0) <= 6 ? ' ' + _t('The backtest runs again in a moment.') : '');
    }
    return '';
  }
  /* the plan cards' backtests are simulations (every backtest is labelled so); a type on a position you hold is tested
     on a test position (backtest.run test_position), and the line says its size */
  function simNote() {
    if (X.noBtWhy(B.kind)) return X.noBtWhy(B.kind);
    if (!noAmount()) { let r = null; try { r = F.pbt[planBtKey(B.preset[B.kind] || 'balanced').key]; } catch (e) {}
      const rs = rangeNote(r && r.d);
      const pd = Math.floor(capDays(B.kind, X.cfg()));
      // no amount yet: the plans are tested on an example amount, said so (audit BOT-09)
      const ex = X.total() > 0 || X.amtErr() ? '' : ' ' + _t('Until you enter an amount, the figures use an example {amount}.', {amount: amt(FP.btAmount(0, (B.plan || X.plan()).minTotal, X.BT_REF))});
      return (pd < 30 ? _t('Backtest on the last {n} days of prices: a simulation, not live results.', {n: pd}) : _t('Backtest on the last 30 days of prices: a simulation, not live results.')) + (rs ? ' ' + rs + '.' : '') + ex; }
    const tp = Object.values(F.pbt).map(x => x && x.d && x.d.test_position).find(x => x);
    return _t('Backtest of the last 30 days on a {amount} test position: a simulation, not live results.', {amount: usd(tp ? tp.usd : 1000, 0)});
  }
  function plansH() {
    // the type's default plan, never a recommendation from the backtests' returns (round-3 QA 2026-10-07: "Recommended"
    // sat on a plan at −20.6%); the selection keeps starting from it
    const k = B.kind, cur = B.preset[k], rec = 'balanced';
    const cards = ['safe', 'balanced', 'aggressive'].map(n => {
      const o = planOf(n), rows = planRows(k, o.s, o.c), on = cur === n, pd = Math.min(30, Math.floor(capDays(k, o.c)));
      const ln = k === 'custom' ? `<span class="ln bf-rules">${rulesTxt(o.c).map(x => `<span>${esc(x)}</span>`).join('')}</span>` : `<span class="ln">${esc(planLine(k, n))}</span>`;
      return `<button type="button" class="bf-plan${on ? ' on' : ''}" data-fplan="${n}" aria-pressed="${on}"><span class="nm">${PRE()[n]}${n === rec ? `<span class="rec">${_t('Default')}</span>` : ''}<span class="rd"></span></span>` +
        ln + `<span class="kvl"><span class="num">${rows.map(r => r[1]).join(' · ')}</span><span class="num">${X.noBtWhy(k) ? '' : `<span class="dim">${pd}d </span>`}<b data-fpbt="${n}">${planBtTxt(n)}</b></span></span>` +
        `<span class="kvs">${rows.map(r => KV(r[0], r[1])).join('')}</span>` +
        `<span class="bt"><span>${X.noBtWhy(k) ? _t('Backtest') : pd < 30 ? _t('Backtest, {n} days', {n: pd}) : _t('Backtest, 30 days')}</span><b class="num" data-fpbt="${n}">${planBtTxt(n)}</b></span></button>`;
    }).join('');
    const b = B.basis[k];
    const alone = phone() && F.sub === 1;
    return `<div class="bf-ph${alone ? ' sub' : ''}">${alone ? '' : `<span class="h">${k === 'custom' ? _t('Start from a rule set') : _t('Plan')}</span>`}<span class="n">${esc(cur ? _t('Default: {plan}', {plan: PRE()[rec]}) : _t('Your own settings: pick a plan to start again from it.'))}</span></div>` +
      `<div class="bf-plans">${cards}</div><p class="bf-aerr" data-fv="pbterr" role="status">${esc(planBtErr())}</p><p class="bf-simn" data-fv="simn">${esc(simNote())}</p>${b ? `<p class="bf-basis">${esc(T().basisText(b))}</p>` : ''}`;
  }
  /* settings that cannot work whatever the account (QA 2026-10-06), said where they are and keeping Continue, Done and
     Start off (signed out too, and no backtest is asked for them): a market-hours grid off a stock or commodity market,
     settings whose smallest amount is above the most a bot may use, a basket whose weights do not add up, a Customize
     field that holds what the bot cannot use (fieldErrs) */
  const SESS_WHY = () => _t('Choose a stock or commodity market: this grid follows its market hours');
  function hardWhy() {
    if (!isPlanned(curKind()) || B.priv) return '';
    if (B.kind === 'sessgrid' && !hasHours(S.coin)) return SESS_WHY();
    const fe = fieldErrs();                              // Customize marks the fields; elsewhere the first reason itself
    if (fe.length) return F.step === 'custom' ? _t('Fix the settings marked in red.') : fe[0].text;
    const p = B.plan || X.plan();
    // past the most a bot may use: the figure itself is no help (1e51 USDC once a size multiplier compounds 50 orders)
    if (!(p.minTotal <= P.MAX_USD)) return _t('These settings need more than the {max} a bot may use: use fewer orders or a smaller size multiplier.', {max: amt(P.MAX_USD)});
    if (B.kind === 'rebalance' && (X.cfg().coins || []).some(x => !(+x.weight > 0))) return _t('Give every coin an allocation above 0%');
    if (B.kind === 'rebalance' && Math.abs((X.cfg().coins || []).reduce((a, x) => a + (+x.weight || 0), 0) - 100) > 0.01) return _t('Make the allocations add up to 100%');
    return '';
  }
  /* the Customize fields whose value the bot cannot use, from the settings themselves (so the review knows too): a word
     where a number goes, or a number the plan would change (a count with a fraction, a value past its limit: the plan
     rounds or clamps it, BotPlan.derive), never silently. The number fields are the ones Customize drew (F.nk). */
  F.nk = {};
  function fieldErrs() { return !isPlanned(curKind()) || B.priv ? [] : K.fieldErrs(F.nk[B.kind] || []); }
  /* the amount field's own text when it is not a usable amount (0, negative, a word): the plan reads it as no amount */
  const amtRaw = () => X.amtErr() ? X.B.bad[B.kind] || '' : '';
  /* an amount that cannot work: 0, negative, a word, above the most a bot may use (audit M01), or under the minimum */
  const amtBad = p => !!X.amtErr() || (X.total() > 0 && X.total() < p.minTotal - 1e-9);
  /* under the amount field: why it cannot work (not above 0, above the most a bot may use, under the minimum), or, after
     Max signed out, that the balance needs a wallet */
  function amtErrTxt() {
    if (X.amtErr()) return X.amtErrText();
    const p = B.plan || X.plan(), t = X.total();
    if (F.step === 'amount' && t > 0 && t < p.minTotal - 1e-9) return _t('Below the {min} minimum for these settings: every order must meet {venue}\'s smallest order.', {min: minAmt(p.minTotal), venue: L(S.venue)});
    if (F.maxHint && S.signedOut && !(t > 0)) return _t('Connect a wallet to use your balance');
    return '';
  }
  const amtErrH = (tag = 'p') => `<${tag} class="bf-aerr" data-fv="amterr" role="alert">${esc(amtErrTxt())}</${tag}>`;
  function amountFieldH() {
    const t = B.total[B.kind], a = X.avail(), p = B.plan || X.plan();
    const low = t > 0 && t < p.minTotal - 1e-9;
    const shown = t == null ? amtRaw() : t;
    return `<div class="bf-amt"><div class="bf-amtf${amtRaw() ? ' bad' : ''}"><input data-inv="1" id="bf-amt" inputmode="decimal" autocomplete="off" value="${shown == null ? '' : esc(shown)}" placeholder="0" aria-label="${_t('Amount')}">` +
      `<span class="u">${esc(QT())}</span><button class="mx" type="button" id="bf-max">${_t('Max')}</button></div>` +
      `<div class="bf-amth"><span>${_t('Available')} <b class="num" data-fv="avail">${a == null ? '–' : esc(amt(a))}</b></span>` +
      `<span class="${low ? 'bad' : ''}" data-fv="minw">${_t('Minimum')} <b class="num" data-fv="min">${esc(minAmt(p.minTotal))}</b></span></div>${amtErrH()}</div>`;
  }
  /* a private copy's minimum: the server's check says it (hidden/check min_usd), before anything is typed too (the
     check at the setup's own size, terminal-bots.js privMinProbe); red while the amount is under it */
  const privMin = () => { const r = B.privChk, m = B.privMinAt;
    return r && r.min_usd > 0 ? r.min_usd : m && B.priv && m.slug === B.priv.slug && m.venue === S.venue && m.min > 0 ? m.min : null; };
  /* the private amount field's own text when it is not a usable amount (0, negative, a word) */
  const privRaw = () => { const i = document.querySelector('#bf [data-pk="amount"]'); const v = i ? i.value.trim() : '';
    return v && !(+v.replace(',', '.') > 0) ? v : ''; };
  const privBad = () => { const m = privMin(), t = B.privIn && B.privIn.amount; return !!privRaw() || (!!m && t > 0 && t < m - 1e-9); };
  const privMinH = () => { const m = privMin(), t = B.privIn && B.privIn.amount;
    return `<span class="${m && t > 0 && t < m - 1e-9 ? 'bad' : ''}">${_t('Minimum')} <b class="num">${m ? esc(amt(m)) : '–'}</b></span>`; };
  /* a copy whose creator hid the settings: the amount and the copier's own limits only */
  function privH() {
    const pv = B.privIn || {}, a = X.avail();
    const f = (k, label, line, v, u) => `<div class="bf-r"><div><span class="k">${label}</span><span class="h">${line}</span></div><div class="bf-ctl"><span class="bf-in"><input data-pk="${k}" inputmode="decimal" autocomplete="off" value="${v == null ? '' : esc(v)}" placeholder="${esc(_t('Optional'))}" aria-label="${esc(label)}"><span class="u">${u}</span></span></div></div>`;
    return `<div class="bf-amt"><div class="bf-amtf"><input data-pk="amount" id="bf-amt" inputmode="decimal" autocomplete="off" value="${pv.amount == null ? '' : esc(pv.amount)}" placeholder="0" aria-label="${_t('Amount')}">` +
      `<span class="u">${esc(QT())}</span><button class="mx" type="button" id="bf-pmax">${_t('Max')}</button></div>` +
      `<div class="bf-amth"><span>${_t('Available')} <b class="num" data-fv="avail">${a == null ? '–' : esc(amt(a))}</b></span><span data-fv="pminw">${privMinH()}</span></div></div>` +
      // its margin mode, the copier's pick as for any bot (residual audit bots-engine-05: the block said "Choose Cross
      // margin" with no control on these screens)
      `<div class="bf-ed">${mmRow()}</div>` +
      `<div class="bf-ph lim"><span class="h">${_t('Your limits')}</span><span class="n">${esc(_t('The creator keeps this bot\'s settings private: its entries, exits and steps are not shown.'))}</span></div>` +
      `<div class="bf-ed" style="margin-top:0">${f('sl', _t('Stop loss'), esc(_t('Closes everything and stops once the bot has lost this share of its amount (closed and open P&L together).')), pv.sl, '%')}` +
      f('max', _t('Max loss'), esc(_t('Closes everything and stops once the bot has lost this many dollars.')), pv.max, esc(QT())) + '</div>';
  }
  /* what a bot on a position you hold does with money, true for each type (QA 2026-10-06: the liquidation guard read "it
     adds no money" here and "adds $50 per action" on the review): the guard may add margin up to its own limits, unless it
     only alerts */
  function heldLine() {
    const v = {coin: C().mktName(S.coin), venue: L(S.venue)}, c = X.cfg();
    if (B.kind === 'liqguard' && c.action !== 'alert' && c.action !== 'reduce')
      return _t('It works on the {coin} position you hold on {venue}. It may add margin from your account, only up to the limits in its plan.', v);
    return _t('It works on the {coin} position you hold on {venue}: it adds no money.', v);
  }
  function amountH() {
    const k = B.kind, stg = FP.stage(k, noAmount()), sub = phone() ? F.sub : -1;
    if (B.priv) {
      return `<main class="bf-w"><h1>${_t('How much should it use?')}</h1><p class="bf-sub">${esc(_t('Copied from “{title}”. Set your total, then start.', {title: B.priv.title}))}</p>${privH()}</main>` +
        footH(backH(true), '', _t('Continue'));
    }
    // a bot on a position you hold adds no money: its step is the plan alone, under a plan's heading (QA 2026-10-06: the
    // phone showed "How much should it use?" over an empty screen)
    const head = stg === 'position' ? `<h1>${_t('Pick a plan')}</h1><p class="bf-sub">${esc(heldLine())}</p>`
      : sub === 1 ? `<h1>${k === 'custom' ? _t('Start from a rule set') : _t('Pick a plan')}</h1><p class="bf-sub">${_t('Each plan is the same bot, set calmer or bolder. Every number can be changed under Customize.')}</p>`
      : `<h1>${_t('How much should it use?')}</h1><p class="bf-sub">${esc(_t('The most it will ever tie up on {venue}. Every order size follows from this.', {venue: L(S.venue)}))}</p>`;
    const extra = stg === 'pair' ? `<div class="bf-ed"><div class="bf-r"><div><span class="k">${_t('Pair with')}</span><span class="h">${esc(_t('The second coin: it trades the opposite side, sized by the hedge.'))}</span></div>` +
        `<div class="bf-ctl"><span class="bf-in"><input data-bk="coin_b" data-up="1" autocomplete="off" autocapitalize="characters" value="${esc(X.shape().coin_b || '')}" aria-label="${_t('Pair with')}"></span></div></div>${X.spH()}</div>`
      : stg === 'basket' ? `<div class="bf-ed"><p class="bf-lbl">${_t('Coins')}</p><div class="full">${X.coinsH(X.shape().coins || [])}</div></div>` : '';
    const first = (stg === 'position' ? '' : amountFieldH()) + extra + `<p class="bf-aerr" data-fv="hard" role="alert">${esc(hardWhy())}</p>`;
    const body = stg === 'position' ? extra + plansH() : sub === 0 ? first : sub === 1 ? plansH() : first + plansH();
    return `<main class="bf-w">${head}${body}</main>` +
      footH(backH(false), `<button class="bf-lnk bf-sec" type="button" id="bf-cz" style="margin-left:auto">${_t('Customize every setting')}</button>`, _t('Continue'));
  }

  /* ---------------- the Signal bot: what it does; it is set up on its own page ---------------- */
  function alertsH() {
    const h = X.hook(), n = S.me && S.me.signals ? S.me.signals.length : null;
    const pts = [_t('Alerts from TradingView, Telegram or your own tools'), _t('Each alert places the order you set up'), _t('Take profits split over the targets; the stop moves as they hit'),
      _t('Size by a fixed margin or by the % of your balance at risk'), _t('Late alerts refused; every refusal listed with its reason'), _t('Same fees and checks as any Rivemont order')];
    const rows = [[_t('Webhook'), h ? _t('On') : _t('Not set up')], [_t('Signals received'), n == null ? '–' : String(n)], [_t('Exchanges'), X.exN()]];
    return `<main class="bf-w"><h1>${_t('Signal bot')}</h1><p class="bf-sub">${esc(_t('Turns alerts from TradingView, your own tools or a Telegram channel into orders on Hyperliquid. You set it up once; each alert places the order you defined, with the same fees and checks as any Rivemont order.'))}</p>` +
      `<div class="bf-rv"><ul class="bf-list">${pts.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div><div class="bf-do"><h3>${_t('Your setup')}</h3></div>` +
      `<div class="bf-kvr">${rows.map(([k, v]) => `<div class="bf-rr"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div></div></div></main>` +
      footH(backH(true), '', _t('Set up the Signal bot'), {href: '/bots/signals'});
  }

  /* ---------------- step 3: Review ---------------- */
  function sentence() {
    const k = B.kind, c = X.cfg(), t = X.total(), long = c.side !== 'short', coin = C().mktName(S.coin), v = L(S.venue), a = t ? amt(t) : _t('your amount'), lev = (c.leverage || 1) + 'x';
    if (k === 'dca') {
      const parts = [bold(m => long ? _t('Buy {coin} on {venue} with {amount} at {lev}', m) : _t('Short {coin} on {venue} with {amount} at {lev}', m), {coin, venue: v, amount: a, lev})];
      const sc = +c.step_scale > 0 ? +c.step_scale : 1, n = c.so_count, last = sc === 1 ? c.so_step_pct * n : c.so_step_pct * (Math.pow(sc, n) - 1) / (sc - 1);
      if (n && sc !== 1) parts.push(bold(m => long ? _t('add {n} more times from {first} to {last} lower, each gap {k}x the one before', m) : _t('add {n} more times from {first} to {last} higher, each gap {k}x the one before', m),
        {n: String(n), first: pct(c.so_step_pct), last: pct(last), k: String(sc)}));
      else if (n) parts.push(bold(m => long ? _t('add {n} more times every {step} lower', m) : _t('add {n} more times every {step} higher', m), {n: String(n), step: pct(c.so_step_pct)}));
      parts.push(bold(m => _t('take profit at {tp}', m), {tp: '+' + pct(c.tp_pct)}));
      return parts.join(', ') + ' ' + (c.sl_pct ? bold(m => c.sl_base === 'avg' ? _t('and stop at {sl} from the average entry.', m) : _t('and stop at {sl} from the first order.', m), {sl: '−' + pct(c.sl_pct)}) : esc(_t('with no stop loss.'))) + (c.repeat ? ' ' + esc(_t('Then start again.')) : '');
    }
    if (k === 'trailstop') {
      const dist = c.by === 'atr' ? `${c.atr_mult}× ATR` : pct(c.trail_pct);
      if (c.entry === 'attach') return bold(m => _t('Protect the {coin} position you hold on {venue}: a stop trails {dist} behind the best price.', m), {coin, venue: v, dist});
      return bold(m => long ? _t('Open a new long {coin} position on {venue} with {amount} at {lev}, then trail a stop {dist} behind the best price.', m)
        : _t('Open a new short {coin} position on {venue} with {amount} at {lev}, then trail a stop {dist} behind the best price.', m), {coin, venue: v, amount: a, lev, dist});
    }
    if (P.GRIDS.includes(k) && c.lower && c.upper) {
      const head = bold(m => _t('Trade {coin} on {venue} between {lo} and {hi} with {amount} at {lev}', m), {coin, venue: v, lo: X.rp(c.lower), hi: X.rp(c.upper), amount: a, lev});
      const mid = bold(m => k === 'rgrid' ? _t('{n} orders that sell high and buy back one line lower.', m) : _t('{n} orders that buy low and sell one line higher.', m), {n: String(c.grids)});
      const end = k === 'infinity' ? _t('The range moves with the price.') : c.stop_outside ? _t('It stops if the price leaves the range.') : _t('It waits if the price leaves the range.');
      return `${head}: ${mid} ${esc(end)}`;
    }
    return '';
  }
  const chk = () => B.chk && B.chk.ok && B.chk.key === X.chkKey() ? B.chk : null;
  /* the line under the review's title; paint() keeps it current when the amount changes in place (the field above the
     risk figures, Max, the "Use {min}" fix) without the page being drawn again */
  function reviewMeta() {
    const t = X.total(), name = B.preset[B.kind] ? PRE()[B.preset[B.kind]] : _t('Custom');
    return [pairName(), L(S.venue), name].concat(noAmount() ? [] : (t ? [amt(t)] : [])).join(' · ');
  }
  /* the line beside "Preview" over the chart (the review's and Customize's) */
  const capTxt = () => !noAmount() ? _t('your bot\'s orders') : B.kind === 'trailstop' ? _t('the stop drawn from today\'s price; the bot trails it from the best price after it starts') : B.kind === 'liqguard' ? esc(_t('Acts within {v}% of your liquidation price', {v: X.cfg().trigger_pct})) : B.kind === 'twap' ? esc(_t('{n} slices', {n: X.cfg().slices})) : _t('targets drawn from today\'s price; the bot measures them from your entry');
  function reviewH() {
    if (B.priv) return privReviewH();
    const k = B.kind;
    const left = `<div><p class="bf-cap"><b>${_t('Preview')}</b> · ${capTxt()}${tfChips()}</p>${ctabsRow()}<div class="bf-chart" id="bf-ch"><span class="sk"></span></div>` +
      `<div class="bf-bt" data-fv="bt">${btH()}</div></div>`;
    const ask = noAmount() || X.total() > 0 ? '' : `<div class="bf-amt bf-ask"><div class="bf-amtf${amtRaw() ? ' bad' : ''}"><input data-inv="1" id="bf-amt" inputmode="decimal" autocomplete="off" value="${esc(amtRaw())}" placeholder="0" aria-label="${_t('Amount')}">` +
      `<span class="u">${esc(QT())}</span><button class="mx" type="button" id="bf-max">${_t('Max')}</button></div><div class="bf-amth"><span>${_t('Available')} <b class="num" data-fv="avail">–</b></span>` +
      `<span data-fv="minw">${_t('Minimum')} <b class="num" data-fv="min">–</b></span></div>${amtErrH()}</div>`;
    const right = `<div>${ask}<p class="bf-aerr" data-fv="hard" role="alert">${esc(hardWhy())}</p><div class="bf-risk" data-fv="risk">${riskH()}</div><div data-fv="guard">${guardH()}</div><div class="bf-blk" data-fv="blk"></div><div data-fv="warn"></div>` +
      `<div class="bf-do"><h3>${_t('What it will do')}</h3><div data-fv="sum">${sumH()}</div></div>` +
      `<button class="bf-lnk bf-cz" type="button" id="bf-cz">${_t('Customize settings')}${ICON.next}</button><p class="bf-fee2">${esc(feeNote())}</p></div>`;
    return `<main class="bf-w"><h1>${esc(_t('Review your {kind} bot', {kind: X.kindName(k)}))}</h1><p class="bf-sub" data-fv="meta">${esc(reviewMeta())}</p>${editBanner()}${sharedBanner()}<div class="bf-rv">${left}${right}</div></main>` +
      footH(backH(false), `<p class="fee bf-donly">${esc(feeNote())}</p>`, startLabel(), {off: startOff()});
  }
  const startLabel = () => B.creating ? _t('Starting…') : S.signedOut ? _t('Connect wallet') : _t('Start {kind} bot', {kind: X.kindName(B.priv ? B.priv.kind : B.kind)});
  function startOff() {
    if (B.creating) return true;
    // an amount that cannot work keeps it off, signed out too: Connect wallet would lead to a bot that cannot start (M01)
    if (!B.priv && !noAmount() && isPlanned(B.kind) && amtBad(B.plan || X.plan())) return true;
    if (hardWhy()) return true;                          // settings that cannot work: never Connect wallet for them
    if (S.signedOut) return !B.priv && !!(B.chk && B.chk.key === X.chkKey() && B.chk.ok === false);   // signed out: Start opens the sign-in in place
    const bl = B.priv ? X.privBlocks() : X.blocks();
    return bl.length > 0;
  }
  /* the server's lines name its budget for these settings ("Uses at most $999.75"), a few cents under the amount typed
     where the orders round down: they say the amount typed instead, the one figure the page shows (round-3 QA
     2026-10-07; at most is still true). bots.money's format, so the figure is found in any language */
  const money = x => '$' + (Math.abs(x - Math.round(x)) < 0.005 || Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}));
  function keepTyped(lines, r) {
    const t = X.total(), b = r && r.budget_usd;
    if (!(t > 0) || !(b > 0) || !(b < t) || t - b > Math.max(t * 0.01, 1) || money(b) === money(t)) return lines || [];
    return (lines || []).map(x => String(x).split(money(b)).join(money(t)));
  }
  function sumH() {
    const r = chk(), s = sentence();
    const list = r ? `<ol class="bf-ol">${keepTyped(r.summary, r).map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : `<ol class="bf-ol"><li>${esc(X.typeLine(B.kind))}</li></ol>`;
    return (s ? `<p class="bf-sent">${s}</p>` : '') + list;
  }
  function riskH(noLev) {
    if (noAmount()) return '';
    const r = chk(), c = X.cfg(), v = X.vals(), lv = FP.liqView(r, X.mkPrice());
    // every side the bot can hold (a neutral grid: both), each with its distance from the price the check used
    const side = s => `<span class="lq"><b class="num">${esc(X.rp(s.px))}</b>${s.pct == null ? '' : `<span class="s num" title="${esc(_t('From the price now'))}">${esc(pctS(s.pct, 0))}</span>`}</span>`;
    // two legs or a basket: no single price, but the leverage limit was checked leg by leg against its stop (per-leg
    // liquidation, bot_kinds.legs_safe_leverage), so it says that rather than a bare "Not estimated" next to a limit
    const legs = (B.kind === 'pair' || B.kind === 'rebalance') && r && r.safe_leverage >= (+c.leverage || 1);
    const liq = lv.state === 'wait' ? '–' : lv.state === 'cross' ? esc(_t('Depends on your account'))
      : lv.state === 'none' ? esc(FP.noLiq(B.kind, c.side, c.leverage) ? _t('None at {lev}x', {lev: 1}) : legs ? _t('Per leg, beyond the stop (est.)') : _t('Not estimated')) : lv.sides.map(side).join('');
    const two = lv.state === 'est' && lv.sides.length === 2;
    // a grid whose only exit is moving its range has no stop loss: the figure is named for what it is (audit H02)
    const rng = X.rangeExit(r, c);
    const loss = !r ? '–' : r.loss_at_stop_usd != null ? `<b class="num dn">−${esc(usd(r.loss_at_stop_usd))}</b>${X.total() ? `<span class="s num">−${esc(pct(r.loss_at_stop_usd / X.total() * 100, 1))}</span>` : ''}` : v.loss;
    const safe = r && r.safe_leverage >= 1 && !X.cross() ? ` <span class="s">· ${esc(_t('limit {n}x (est.)', {n: r.safe_leverage}))}</span>` : '';
    const why = _t('Where the exchange would close the position once every planned order has filled (isolated margin at this leverage). On cross margin it depends on your whole account.');
    // what the figures are measured on, in words a phone shows too (a title never shows on touch; audit C02 / H02)
    const notes = (lv.state === 'est' && lv.sides.some(s => s.pct != null) ? [_t('Liquidation % is from the price now.')] : [])
      .concat(r && r.loss_at_stop_usd != null ? [rng ? _t('Loss if the range moves: what the grid holds when the price leaves the range, closed there before it starts again; on the largest position, before fees, funding and slippage. It has no stop loss.')
        : _t('Loss at stop loss: on the largest position, before fees, funding and slippage.')] : []);
    return `<div class="bf-rr${two ? ' two' : ''}"><span title="${esc(why)}">${two ? _t('Est. liq. long / short') : _t('Est. liquidation')}</span><span>${liq}</span></div>` +
      `<div class="bf-rr"><span>${rng ? _t('Loss if the range moves') : _t('Loss at stop loss')}</span><span>${loss}</span></div>` +
      `<div class="bf-rr"><span>${_t('Fees per round')}</span><span class="num"><b>${v.rt}</b></span></div>` +
      (noLev ? '' : `<div class="bf-rr"><span>${_t('Leverage')}</span><span><b class="num">${c.leverage || 1}x</b>${safe}</span></div>`) +
      (notes.length ? `<p class="bf-rnote">${esc(notes.join(' '))}</p>` : '');
  }
  const guardNow = () => { const p = B.plan || X.plan(), c = X.cfg();
    return FP.guard({chk: B.chk && B.chk.key === X.chkKey() ? B.chk : null, cross: X.cross(), total: X.total(), minTotal: p.minTotal, noAmount: noAmount(),
      kind: B.kind, side: c.side, leverage: c.leverage}); };
  function guardH() {
    if (B.priv) return '';
    const p = B.plan || X.plan(), g = guardNow();
    const min = minAmt(p.minTotal);
    // what the limit was measured against, never more (audit H02): a bot with no stop is told the loss has no end
    // green only when the limit was measured against its stop; no stop, or one with no price, is a neutral dot
    // cross margin: the estimate is for isolated margin, the account decides here; said, never a verdict (RV-04)
    if (g.state === 'ok' && X.cross() && !g.none) return `<p class="bf-guard na">${esc(_t('Above the {min} minimum. On cross margin the liquidation depends on your whole account, so it is not estimated here.', {min}))}</p>`;
    if (g.state === 'ok') return `<p class="bf-guard${g.stop === 'none' || g.stop === 'free' || g.stop === 'range' ? ' na' : ''}">${esc(g.none ? _t('Above the {min} minimum. A long basket at 1x has no liquidation price.', {min})
      : g.stop === 'range' ? _t('Above the {min} minimum. At this leverage the estimated liquidation comes after the bot\'s last order and the point where it moves its range. It has no stop loss: each time the price leaves the range it closes the grid at a loss or a profit and starts again, so losses can add up while the price keeps moving.', {min})
      : g.stop === 'none' ? _t('Above the {min} minimum. At this leverage the estimated liquidation comes after the bot\'s last order. It has no stop loss: if the price keeps moving against it, the loss keeps growing until you stop the bot or the exchange liquidates it.', {min})
      : g.stop === 'free' ? _t('Above the {min} minimum. At this leverage the estimated liquidation comes after the bot\'s last order. Its stop has no fixed price, so it is not checked against the liquidation.', {min})
      : _t('Above the {min} minimum. At this leverage the estimated liquidation comes after the bot\'s last order and its stop loss.', {min}))}</p>`;
    // a stop just before the estimated liquidation: allowed (never blocking), said here with a warning dot and the
    // leverage that keeps the room (bots-engine-04: the block's "Use Nx" alone landed on this warning)
    if (g.state === 'gap') return `<div class="bf-guard warn"><span>${esc(g.text)}</span>${g.safe >= 1 ? `<span class="acts"><button class="bf-chip" type="button" data-blev="${g.safe}">${esc(_t('Use {n}x', {n: g.safe}))}</button></span>` : ''}</div>`;
    // not checked (a neutral dot, never the green "safe"): a held position's liquidation is the exchange's, read at start;
    // a type with no estimate (two legs, a basket) is checked leg by leg once it opens
    // the sentence on a stop only for a bot that has one (RV-26: the liquidation guard has none)
    if (g.state === 'held') return `<p class="bf-guard na">${esc(P.hasStop(B.kind, X.cfg()) ? _t('Liquidation not checked: it depends on the position you already hold (its entry, leverage and margin), which the bot reads only when it starts. A stop beyond that liquidation price never fires.')
      : _t('Liquidation not checked: it depends on the position you already hold (its entry, leverage and margin), which the bot reads only when it starts.'))}</p>`;
    if (g.state === 'unest') return `<p class="bf-guard na">${esc(_t('Above the {min} minimum. Liquidation is not estimated for this bot type: check each position\'s liquidation price once it opens.', {min}))}</p>`;
    if (g.state === 'wait') return `<p class="bf-guard wait">${esc(_t('Checking…'))}</p>`;
    // signed in, the blocking line below already says it, with its 'Set {min}' fix; signed out (or behind an account line
    // such as Connect) there is none, so the guard says it
    // the review's own amount field says its error right under it: not twice
    if (g.state === 'amount' && X.amtErr() && F.step === 'review') return '';
    if (g.state === 'amount') { const t = X.amtErr() ? X.amtErrText() : _t('Enter an amount');
      return X.blocks().some(b => b.text === t) ? '' : `<p class="bf-guard block">${esc(t)}</p>`; }
    if (g.state === 'min') return `<div class="bf-guard block"><span>${esc(_t('Below the {min} minimum for these settings: every order must meet {venue}\'s smallest order.', {min, venue: L(S.venue)}))}</span>${p.minTotal <= P.MAX_USD ? `<span class="acts"><button class="bf-chip" type="button" data-bset="${p.minTotal}">${esc(_t('Use {min}', {min}))}</button></span>` : ''}</div>`;
    // signed in the blocking lines below say it, with the fix; signed out there are none, so the guard says it
    if (g.state === 'error') return S.signedOut ? `<p class="bf-guard block">${esc(g.text)}</p>` : '';
    const fix = g.safe >= 1 ? `<span class="acts"><button class="bf-chip" type="button" data-blev="${g.safe}">${esc(_t('Use {n}x', {n: g.safe}))}</button></span>` : '';
    // cross margin: the line is the estimate for the bot's own amount alone (the liquidation row says it depends on the
    // account), so it says what it was measured on rather than stand as a verdict (audit BOT-04)
    return `<div class="bf-guard ${g.state}"><span>${g.state === 'warn' ? esc(_t('Estimated on this bot\'s own amount, as on isolated margin:')) + ' ' : ''}${esc(g.text)}${g.state === 'warn' ? ' ' + esc(_t('Cross margin: the rest of your account backs it.')) : ''}</span>${fix}</div>`;
  }
  /* a bot on a position you hold has no amount: its backtest runs on a test position opened at the start (backtest.run
     test_position), which the result is on; the page says so, with its size, side, price and leverage */
  const testPosLine = tp => { const v = {amount: usd(tp.usd, 0), lev: tp.leverage || 1, px: X.rp(tp.entry_px)};
    return tp.side === 'short' ? _t('On a test {amount} short ({lev}x) opened at {px} at the start of the period. Your own position\'s entry, size and leverage differ.', v)
      : _t('On a test {amount} long ({lev}x) opened at {px} at the start of the period. Your own position\'s entry, size and leverage differ.', v); };
  /* how far back a type's test can reach: the server reads at most 5,000 candles (radar/auto/backtest.py MAX_CANDLES)
     of the chart the type acts on (interval_for: 5m for a TWAP, a chase or a trailing stop, the bot's own chart for an
     indicator or rules bot); the auto-picked charts of the other types always cover their period. Infinity: no cap */
  const RULES = ['custom', 'recurring', 'breakout', 'meanrev', 'sar', 'ladder', 'funding', 'fundflip', 'indicator', 'volgrid'];
  function btTf(k, c) {
    if (['chase', 'trailstop', 'twap'].includes(k)) return '5m';
    if (RULES.includes(k)) return c.timeframe || null;
    return k === 'dca' && c.start ? c.start.timeframe || null : null;
  }
  const capDays = (k, c) => { const tf = btTf(k, c || {}), sec = tf && TFSEC[tf]; return sec ? 5000 * sec / 86400 : Infinity; };
  const PERIODS = [7, 30, 90];
  /* a period chip longer than that history adds nothing (round-3 QA 2026-10-07: TWAP 30d and 90d identical): the first
     chip past it stays (it tests all there is, and its result says how many days), the longer ones are off */
  const periodOff = (n, cap) => n > cap && PERIODS.some(m => m < n && m > cap);
  function btH() {
    const {d, err, stale} = X.btShown(), c0 = B.priv ? {} : X.cfg(), cap = B.priv ? Infinity : capDays(B.kind, c0), tf = btTf(B.kind, c0);
    if (periodOff(B.btDays, cap)) { B.btDays = PERIODS.filter(n => !periodOff(n, cap)).pop(); setTimeout(() => X.runBacktest(), 0); }
    const days = B.btDays;
    const offWhy = _t('Longer than the {tf} price history this bot is tested on (about {n} days)', {tf, n: Math.floor(cap)});
    const head = `<div class="bf-bth"><span class="t">${_t('Backtest')}</span><span class="bf-sim">${_t('Simulation')}</span><span class="bf-days" role="group">` +
      PERIODS.map(n => periodOff(n, cap) ? `<button type="button" data-bbt="${n}" disabled title="${esc(offWhy)}" aria-label="${esc(n + 'd: ' + offWhy)}">${n}d</button>`
        : `<button type="button" data-bbt="${n}" class="${days === n ? 'on' : ''}">${n}d</button>`).join('') + '</span></div>';
    const why = X.noBtWhy(B.kind);                     // a type with no backtest (the liquidation guard): why instead
    if (why) return `<div class="bf-bth"><span class="t">${_t('Backtest')}</span></div><p class="bf-note">${esc(why)}</p>`;
    const low = B.priv ? (privMin() && B.privIn.amount > 0 && B.privIn.amount < privMin() - 1e-9) : guardNow().state === 'min';
    if (low) return head + `<p class="bf-note">${esc(_t('The backtest runs once the amount meets the minimum.'))}</p>`;
    if (!B.priv && X.amtErr()) return head + `<p class="bf-note">${esc(_t('The backtest runs once the amount is valid.'))}</p>`;
    if (hardWhy()) return head + `<p class="bf-note">${esc(hardWhy())}</p>`;
    // settings the test cannot run (a grid without its range ...): no result, never the last one of other settings
    if (!B.priv && !X.btReady()) return head + `<p class="bf-note">${esc(P.GRIDS.includes(B.kind) && !(X.cfg().upper > X.cfg().lower) ? _t('Set the range') : _t('The backtest runs once the settings are complete.'))}</p>`;
    if (err) return head + `<p class="err">${esc(err.error)}</p>`;
    if (!d || !d.stats) return head + `<span class="sk"></span>`;
    // only a result computed for exactly these settings, coin and period (its key); another's never shows (QA RV-01)
    if (!btFresh(d)) return head + `<p class="bf-note">${esc(_t('Replaying past prices…'))}</p>`;
    const s = d.stats, u = s.pnl_usd != null ? s.pnl_usd : null, k = s.pnl_usd != null && s.fees_usd != null ? '_usd' : '_pct';
    // the total and every part to the cent (or 0.01 pp), so the parts add up to the total at any size
    const f = k === '_usd' ? (x => (x > 0 ? '+' : x < 0 ? '−' : '') + usd(Math.abs(x), 2)) : (x => pctS(x, 2));
    const grid = s.grid_profit_usd != null || s.grid_profit_pct != null;
    const a = grid ? s['grid_profit' + k] : s['closed_pnl' + k], b = grid ? s['position_pnl' + k] : s['open_pnl' + k], fee = s['fees' + k], fund = s['funding' + k];
    const part = (l, x) => x == null ? '' : `<span>${esc(l)} <b class="num ${x > 0 ? 'up' : x < 0 ? 'dn' : ''}">${esc(f(x))}</b></span>`;
    const cls = x => x > 0 ? 'up' : x < 0 ? 'dn' : '';
    // the amount typed, as the page says it everywhere (Martingale and Recurring round their orders down: the server's
    // budget reads 999.75 of a 1,000 typed); a copy's or the reference amount's test says its own
    const want = X.total() > 0 ? X.total() : Math.max((B.plan || X.plan()).minTotal || 0, X.BT_REF);
    // one figure everywhere (round-3 QA 2026-10-07): the amount typed (or the reference amount), as the title and the
    // plan's "Uses at most" line say it (keepTyped); the server's budget, a few cents under it where orders round down
    // (Martingale's 999.75 of 1,000), stays internal
    const tp = d.test_position;
    const on = tp ? null : B.priv ? d.amount : want;
    // no amount typed: the result is an example on the reference amount, said as such (audit BOT-09), never "on 1,000"
    const onTxt = !B.priv && !(X.total() > 0) ? _t('Example with {amount}', {amount: amt(on)}) : _t('on {amount}', {amount: amt(on)});
    const hold = s.hold_pct != null ? `<span class="hold">${esc(_t('Buy and hold {coin}', {coin: C().mktName(S.coin)}))} <b class="num ${cls(s.hold_pct)}">${esc(pctS(s.hold_pct))}</b></span>` : '';
    // nothing filled: a dash and why (its start price never reached, the range never touched, the rule never true),
    // never $0.00 · 0% and $0.00 parts (audit N01); a test that traded and ended flat keeps its figures
    if (window.rvEv) window.rvEv('result_view', {kind: B.priv ? B.priv.kind : B.kind, coin: S.coin, from: S.signedOut ? 'signed_out' : 'signed_in'});   // radar/analytics.py
    const idle = s.stopped_because ? '' : X.btIdleText(s), still = !!s.stopped_because && !!P.btIdle(s);
    if (idle) return head + `<div class="bf-big"><b class="num">–</b>${on ? `<span class="bfo">${esc(onTxt)}</span>` : ''}</div>` +
      periodH(d) + `<p class="bf-note bf-idle">${esc(idle)}</p>` + stopH(s) + rangeNoteH(d) + (hold ? `<div class="bf-parts">${hold}</div>` : '');
    ev('result_view', [B.priv ? B.priv.kind : B.kind, S.coin, days].join('|'));
    return head +
      `<div class="bf-big"><b class="num ${cls(u != null ? u : s.return_pct)}">${u != null ? esc(f(u)) : esc(f(s.return_pct))}</b>${u != null ? `<span class="bfp num ${cls(s.return_pct)}">${esc(pctS(s.return_pct))}</span>` : ''}` +
      (on ? `<span class="bfo">${esc(onTxt)}</span>` : '') + '</div>' + periodH(d) + rebalH(s) + stopH(s) + rangeNoteH(d) + (tp ? `<p class="bf-note bf-tpn">${esc(testPosLine(tp))}</p>` : '') +
      // more than the amount lost: how (each new position takes new margin from the account, as live; backtest.py)
      (s.return_pct < -100 ? `<p class="bf-note">${esc(_t("The loss is larger than the bot's amount: after each loss it opens its next position with new margin from the rest of your account, as the live bot does. With only this amount in the account, the exchange would refuse those orders."))}</p>` : '') +
      (still ? (hold ? `<div class="bf-parts">${hold}</div>` : '') :
      `<div class="bf-parts">${part(grid ? _t('Grid profit') : _t('Closed trades'), a)}${part(grid ? _t('Position P&L') : _t('Open position'), b)}${part(_t('Fees'), fee == null ? null : -fee)}${part(_t('Funding'), fund == null ? null : fund || 0)}` +
      hold + '</div>') + basketH(d) + asmH(d);
  }
  /* a basket's test (the rebalancing bot): its value against just holding the starting weights, in % from the start
     (terminal-bots.js basketCurve, the Backtest lab's same chart) */
  const basketH = d => d && d.hold && d.hold.basket && !B.priv && X.btCurve ? `<div class="bf-bkc">${X.btCurve(d, 64)}</div>` : '';
  /* a plan's grid range, laid around today's price, centred on the price at the start of the test (the server's
     backtest.recentred): said under the result, in the Backtest lab's words */
  const rangeNote = d => d && d.range_start ? _t('Range set from the price at the start of the test: {lo} – {hi}', {lo: X.rp(d.range_start.lower), hi: X.rp(d.range_start.upper)}) : '';
  /* a rebalancing basket closes no trade: how many rounds traded back to the weights, and the fills that paid the fees
     (a bare "Trades 0" beside the fees would read as a fault) */
  const rebalH = s => s && s.rebalances != null ? `<p class="bf-note bf-rb">${esc(_t('Rebalances'))} <b class="num">${s.rebalances}</b> · ${esc(_t('Fills'))} <b class="num">${s.fills || 0}</b></p>` : '';
  const rangeNoteH = d => rangeNote(d) ? `<p class="bf-note bf-rs">${esc(rangeNote(d))}</p>` : '';
  /* a test shorter than the period picked (its chart's history ends sooner): the days it really covers */
  const periodH = d => d && d.days != null && !B.priv && d.days < B.btDays - 0.5 ? `<p class="bf-note bf-per">${esc(_t('Tested on the last {n} days: all the {tf} price history this bot is tested on.', {n: Math.round(d.days), tf: d.interval || btTf(B.kind, X.cfg()) || ''}))}</p>` : '';
  const btFresh = d => !!d && (B.priv || !X.btKey || d.key === X.btKey());
  /* the Live check's period: the days the test really covers (its result's own span; before it is in, what the chart's
     history can hold), with the period asked for when they differ (audit BOT-16: "30 days" over a 17-day test) */
  function btLbl() {
    const {d} = X.btShown(), want = B.btDays, cap = Math.floor(capDays(B.kind, X.cfg()));
    const got = d && d.days != null && btFresh(d) ? Math.round(d.days) : Math.min(want, cap);
    return got < want ? _t('Backtest, {n} days ({m} requested)', {n: got, m: want}) : _t('Backtest, {n} days', {n: want});
  }
  /* a test in which nothing traded and nothing stopped it: a dash and why. One the bot's own rule stopped before any
     trade (a grid whose price left the range: "Stopped on Sep 7 ...") is a result, 0%, with that stop line, never the
     dash and "nothing traded" beside it (round-2 QA 2026-10-07) */
  const idleOf = s => !!P.btIdle(s) && !(s && s.stopped_because);
  /* when the test stopped the bot (its stop loss, its range, a liquidation ...): the day and the reason, in the Backtest
     lab's words (terminal-bots.js labStop), never a result that reads as if it ran to the end */
  function stopH(s) {
    if (!s || !s.stopped_because) return '';
    let when = '';
    try { when = s.stopped_at ? new Date(s.stopped_at * 1000).toLocaleString(document.documentElement.lang || undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : ''; } catch (e) { when = ''; }
    return `<p class="bf-note bf-stop" role="status">${esc(when ? _t('Stopped on {date}: {why}', {date: when, why: s.stopped_because}) : _t('It stopped: {why}', {why: s.stopped_because}))}</p>`;
  }
  /* what the simulation assumes and leaves out (the period, the fees, the slippage and the limits,
     next to every result): the period and candles, the server's own fee line and notes (radar/auto/backtest.py) */
  function asmH(d) {
    const tf = d.interval ? String(d.interval) : '', n = d.days != null ? String(Math.round(d.days)) : null;
    const items = [n != null ? _t('Period: the last {n} days of {coin} prices on Hyperliquid, {tf} candles.', {n, coin: C().mktName(S.coin), tf}) : '',
      d.fees_note || '', _t('No extra slippage: market orders fill at the price of the moment, so live fills can be worse.')].concat(d.notes || [])
      .concat(d.hold && d.hold.basket ? [_t('Just holding: the same coins bought at the starting weights and never rebalanced. Only the first buy\'s fees are counted.')] : []).filter(Boolean);
    return `<details class="bf-asm"><summary>${esc(_t('Assumptions and limits'))}</summary><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
  }
  /* before any wallet connection from the setup: what connecting allows, what it costs and how to undo it; Connect then
     opens the sign-in (terminal-bots.js start: the setup is kept for after it) */
  let info = null;
  function connectPanel() {
    const host = document.querySelector('.bf-ws') || document.body;
    let m = document.getElementById('bf-cp'); if (m) m.remove();
    const draw = () => {
      const fee = info && info.builder_fee_pct != null ? String(info.builder_fee_pct) : '0.1', cap = info && info.max_fee_rate ? String(info.max_fee_rate) : '0.1%';
      const sec = (h, ps) => `<div class="drawer-section"><h3>${esc(h)}</h3>${ps.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
      return `<div class="modal-backdrop" data-cpx="1"><section class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="bf-cpt">` +
        `<header class="modal-header"><div><h2 id="bf-cpt">${esc(_t('Before you connect'))}</h2><p>${esc(_t('What connecting lets Rivemont do, what it costs and how to undo it.'))}</p></div>` +
        `<button type="button" class="icon-button" data-cpx="1" aria-label="${esc(_t('Close'))}">${ICON.x}</button></header><div class="modal-body">` +
        sec(_t('Purpose'), [_t('Rivemont places and cancels the orders of the bots you start, in your own Hyperliquid account.')]) +
        sec(_t('Permission'), [_t('Trade-only API wallet') + ': ' + _t('Lets Rivemont place orders. It cannot withdraw.'), _t('A builder-fee approval, capped at {cap} per fill.', {cap})]) +
        sec(_t('Cost'), [_t('From {builder_fee_pct}% per fill, lower with your 30-day volume', {builder_fee_pct: fee}) + '.', _t('Hyperliquid\'s own trading fees are separate.')]) +
        sec(_t('How to undo it'), [_t('Settings > Stop everything stops every bot and deletes Rivemont\'s keys; or remove the API wallet on Hyperliquid.')]) +
        `</div><footer class="modal-footer"><button type="button" class="button ghost" data-cpx="1">${esc(_t('Cancel'))}</button>` +
        `<button type="button" class="button primary" id="bf-cpgo">${esc(_t('Connect wallet'))}</button></footer></section></div>`;
    };
    m = document.createElement('div'); m.id = 'bf-cp'; m.innerHTML = draw(); host.appendChild(m);
    const back = document.activeElement, shut = () => { m.remove(); document.removeEventListener('keydown', key); if (back && back.isConnected) back.focus(); };
    const key = e => { if (e.key === 'Escape') shut(); };
    document.addEventListener('keydown', key);
    // a double click on Start lands its second click on the backdrop that just opened: never closes it (QA 2026-10-06)
    const at = Date.now();
    m.addEventListener('click', e => { const x = e.target.closest('[data-cpx]'); if (Date.now() - at < 500) return; if (x && (x.tagName === 'BUTTON' || e.target === x)) shut(); });
    m.querySelector('#bf-cpgo').onclick = () => { ev('wallet_connect_attempt', Date.now()); shut(); X.start(); };
    m.querySelector('#bf-cpgo').focus();
    if (!info) fetch('/api/auto/info').then(r => r.ok ? r.json() : null).then(d => { if (d && m.isConnected) { info = d;
      const go = document.activeElement === m.querySelector('#bf-cpgo'); m.innerHTML = draw();
      m.querySelector('#bf-cpgo').onclick = () => { ev('wallet_connect_attempt', Date.now()); shut(); X.start(); }; if (go) m.querySelector('#bf-cpgo').focus(); } }).catch(() => {});
  }
  /* a private copy's leverage and largest position from its check (repainted once the check answers) */
  const privOk = () => B.privChk && B.privChk.ok ? B.privChk : null;
  const privLev = () => `${privOk() ? privOk().leverage : B.priv.lev}x`, privPos = () => privOk() ? esc(usd(privOk().max_position_usd)) : '–';
  function privReviewH() {
    const r = B.privChk && B.privChk.ok ? B.privChk : null;
    const rows = [[_t('Bot'), esc(X.kindName(B.priv.kind))], [_t('Settings'), esc(_t('Private'))], [_t('Leverage'), `<span data-fv="plev">${privLev()}</span>`],
      // the margin mode, changeable here too (a text button in the row, the same sheet as the amount step)
      [_t('Margin'), `<button class="bf-lnk bf-mm" type="button" id="tb-mm" aria-haspopup="dialog">${X.cross() ? _t('Cross') : _t('Isolated')}${ICON.down}</button>`],
      [_t('Largest position'), `<span data-fv="ppos">${privPos()}</span>`]];
    return `<main class="bf-w"><h1>${esc(_t('Review your {kind} bot', {kind: X.kindName(B.priv.kind)}))}</h1><p class="bf-sub">${esc([PAIR(), L(S.venue), B.privIn && B.privIn.amount ? amt(B.privIn.amount) : _t('Enter an amount')].join(' · '))}</p>` +
      `<div class="bf-rv"><div><div class="bf-kvr">${rows.map(([k, v]) => `<div class="bf-rr"><span>${esc(k)}</span><span>${v}</span></div>`).join('')}</div><div class="bf-bt" data-fv="bt">${btH()}</div></div>` +
      `<div><div class="bf-do"><h3>${_t('What it will do')}</h3><div data-fv="psum">${r ? `<ol class="bf-ol">${r.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</div></div><div class="bf-blk" data-fv="blk"></div><div data-fv="pwarn"></div><p class="bf-fee2">${esc(feeNote())}</p></div></div></main>` +
      footH(backH(false), `<p class="fee bf-donly">${esc(feeNote())}</p>`, startLabel(), {off: startOff()});
  }
  function editBanner() {
    if (!F.edit) return '';
    const b = X.bots().find(x => x.id === F.edit);
    if (!b) return '';
    const live = ['active', 'paused', 'stopping', 'error'].includes(b.status);
    const v = {coin: C().mktName(b.coin), kind: X.kindWord(b.kind)};
    return `<div class="bf-banner"><span>${live ? bold(m => _t('Your {coin} {kind} bot keeps running until you stop it; then start it again with these settings.', m), v)
      : bold(m => _t('Starting a new {coin} {kind} bot with the settings of the one you stopped.', m), v)}</span>` +
      (live && b.status !== 'stopping' ? `<button class="bf-chip bf-lnk" type="button" id="bf-stopold">${_t('Stop it')}</button>` : '') + '</div>';
  }
  const sharedBanner = () => B.shared ? `<div class="bf-banner"><span>${esc(_t('Copied from “{title}”. Set your total, then start.', {title: B.shared.title}))}</span></div>` : '';

  /* ---------------- Customize: every setting, grouped, one plain line each, with the live check (BotFlowKit, above) ---------------- */
  const K = window.BotFlowKit(X);
  const {GNAME, GLINE, row, numC, txtC, segC, selC, swC, togC, roC, n0, SIDE_LINE, levC, mmC, levRow, levLine, mmRow, gridRow, dcaRow, indRow, LINES, schemaRow, groupsNow, rowOf} = K;
  /* Customize in the review's shape: the review's chart on the left (timeframes, price and date scales, the bot's lines as they are
     typed, the price lines dragged to set them) with the backtest under it; the settings on the right, scrolling in
     their own column under a row of section tabs */
  function customH() {
    if (B.priv) { F.step = 'amount'; return amountH(); }
    const k = B.kind, s = X.shape(), c = X.cfg(), G = groupsNow(), from = F.plan ? PRE()[F.plan] : null;
    const meta = [_t('{kind} bot', {kind: X.kindName(k)}), pairName(), L(S.venue)].concat(F.edit ? [] : from ? [_t('started from {plan}', {plan: from})] : []).join(' · ');
    const t = B.total[k];
    const amountG = noAmount() ? '' : `<section class="bf-g" id="bf-g-amount"><h2>${_t('Amount')}</h2><p class="gl">${esc(_t('The most it will ever tie up on {venue}. Every order size follows from this.', {venue: L(S.venue)}))}</p>` +
      row(_t('Amount'), '', `<span class="bf-in${amtRaw() ? ' bad' : ''}"><input data-inv="1" inputmode="decimal" autocomplete="off" value="${t == null ? esc(amtRaw()) : esc(t)}" placeholder="0" aria-label="${_t('Amount')}"><span class="u">${esc(QT())}</span></span>`,
        {k: 'amount', hHtml: `${_t('Available')} <b class="num" data-fv="avail">${X.avail() == null ? '–' : esc(amt(X.avail()))}</b>${amtErrH('span')}`}) + '</section>';
    const groups = FP.GROUPS.map(g => { const rows = (G[g] || []).map(key => rowOf(key, s, c)).join(''); return rows ? `<section class="bf-g" id="bf-g-${g}"><h2>${GNAME()[g]}</h2><p class="gl">${GLINE()[g]}</p>${rows}</section>` : ''; }).join('');
    const tabs = (noAmount() ? [] : [['amount', _t('Amount')]]).concat(FP.GROUPS.filter(g => (G[g] || []).some(key => rowOf(key, s, c))).map(g => [g, GNAME()[g]]));
    const nav = `<nav class="bf-nav" aria-label="${_t('Settings')}">${tabs.map(([g, n], i) => `<a href="#bf-g-${g}" data-gnav="${g}"${i ? '' : ' class="on"'}>${n}</a>`).join('')}` +
      // the plan's settings back: quiet text, an icon where the column is narrow (its words as the icon's name)
      (F.edit || !F.plan ? '' : `<button class="bf-lnk bf-rst" type="button" id="bf-reset" title="${esc(_t('Reset to {plan}', {plan: from}))}"><span class="t">${esc(_t('Reset to {plan}', {plan: from}))}</span>${ICON.reset}</button>`) + '</nav>';
    // Market neutral trades the gap between its two coins: the chart shows the pair's spread (its z-score with the
    // entry and exit levels, terminal-bots.js psH), never the first coin's candles alone (round-3 QA 2026-10-07)
    const drag = k !== 'pair' && (X.previewLines(chartColors()).handles || []).length > 0;
    const pic = k === 'pair' ? `<div class="bf-pspr">${X.psH()}</div>` : `${ctabsRow()}<div class="bf-chart" id="bf-ch"><span class="sk"></span></div>`;
    const cap = `<p class="bf-cap"><b>${_t('Preview')}</b>${k === 'pair' ? '' : `<span class="bf-capt"> · ${drag ? esc(_t('drag a line to change it')) : capTxt()}</span>${tfChips()}`}</p>`;
    const left = `<section class="bf-czl" aria-label="${_t('Live check')}"><div class="bf-czc">${cap}${pic}</div><div class="bf-bt" data-fv="bt">${btH()}</div>` +
      `<div class="bf-czk"><div class="bf-rr"><span>${_t('Minimum')}</span><span class="num" data-fv="min2">–</span></div><div class="bf-rr"><span>${_t('Leverage limit (est.)')}</span><span class="num" data-fv="safe">–</span></div>` +
      `<div data-fv="risk2">${riskH(true)}</div><div data-fv="guard">${guardH()}</div><div class="bf-blk" data-fv="blk"></div><div data-fv="warn"></div></div></section>`;
    const right = `<div class="bf-czf">${nav}<div class="bf-czs" id="bf-czs"><p class="bf-aerr" data-fv="hard" role="alert">${esc(hardWhy())}</p>${amountG}${groups}</div></div>`;
    return `<main class="bf-w bf-czw"><h1>${_t('Customize')}</h1><p class="bf-sub">${esc(meta)}</p>${editBanner()}${sharedBanner()}` +
      `<div class="bf-rv bf-czr">${left}${right}</div></main>` +
      footH(backH(true), '', _t('Done'));
  }

  /* ---------------- the chart: live candles of the chosen timeframe with the bot's lines (terminal-bots.js previewLines),
     on the Terminal's chart (radar/web/chart-adapter.js, KLineChart): drag to move back in time, the wheel or a pinch to
     zoom, the crosshair on hover; the last candle follows the live price. One chart, moved into the step's box (#bf-ch)
     each time the page is drawn again; the plain SVG below only where the chart library could not load ---------------- */
  const CTFS = ['1m', '5m', '15m', '1h', '4h', '1d'], TFSEC = {'1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400};
  F.ctf = (() => { try { const t = localStorage.getItem('rv_bf_tf'); return CTFS.includes(t) ? t : '4h'; } catch (e) { return '4h'; } })();
  F.cv = {n: 0, off: 0}; F.cc = {};
  const tfChips = () => `<span class="bf-days bf-tfs" role="group" aria-label="${esc(_t('Timeframe'))}">` +
    CTFS.map(t => `<button type="button" data-ctf="${t}" class="${F.ctf === t ? 'on' : ''}">${t === '1d' ? '1D' : t}</button>`).join('') + '</span>';
  /* a multi-coin bot's chart shows the coin of its tab (terminal-bots.js chartTabs): another coin than the market's
     has its own candles, no bot lines and no live price of the market's */
  const vco = () => isPlanned(curKind()) && !B.priv && X.chartOther ? X.chartOther() : null;
  const ccKey = tf => { const o = vco(); return o ? `${S.venue}|${o}|${tf}|live` : `${X.mcKey(tf)}|live`; };
  const ctabsRow = () => { const h = isPlanned(curKind()) && !B.priv && X.ctabsH ? X.ctabsH() : '';
    return h ? `<div class="rv-ctabs bf-ctabs" role="tablist" aria-label="${esc(_t('Chart'))}" data-fv="ctabs">${h}</div>` : ''; };
  function loadChart(tf, again) {
    const key = ccKey(tf), coin = vco() || S.coin, venue = S.venue;
    if (F.cc[key] && !again) return;
    if (!F.cc[key]) F.cc[key] = 'loading';
    // Hyperliquid's bars from Hyperliquid itself (terminal.html __hlCandles: the visitor's connection pays for them), else the server's
    (venue === 'hyperliquid' && window.__hlCandles ? window.__hlCandles(coin, tf) : Promise.resolve(null)).catch(() => null)
      .then(d => d || fetch(`/api/auto/terminal/candles?venue=${encodeURIComponent(venue)}&coin=${encodeURIComponent(coin)}&tf=${tf}`).then(r => r.ok ? r.json() : {candles: []}).catch(() => ({candles: []})))
      .then(d => { if (d.busy) { if (!Array.isArray(F.cc[key])) delete F.cc[key]; return; }
        const rows = (d.candles || []).map(c => c.slice(0, 5)); if (rows.length) F.cc[key] = rows; else if (!Array.isArray(F.cc[key])) F.cc[key] = [];
        chartDraw(document.getElementById('bf-ch')); });
  }
  /* the candles shown: the chosen timeframe's (the 4h closed ones while it loads), the last one moved by the live price */
  function chartRows() {
    const live = F.cc[ccKey(F.ctf)], sec = TFSEC[F.ctf], o = vco();
    let rows = Array.isArray(live) && live.length >= 10 ? live : F.ctf === '4h' && !o ? B.mc[X.mcKey('4h')] : null;
    if (!Array.isArray(rows) || rows.length < 10) return null;
    const p = o ? 0 : X.mkPrice(), now = Date.now() / 1000;
    if (p > 0 && rows === live) {
      const last = rows[rows.length - 1];
      if (now < last[0] + sec) rows = rows.slice(0, -1).concat([[last[0], last[1], Math.max(last[2], p), Math.min(last[3], p), p]]);
      else rows = rows.concat([[Math.floor(now / sec) * sec, last[4], Math.max(last[4], p), Math.min(last[4], p), p]]);
    }
    return rows;
  }
  /* the chart's colours: the Terminal's (chartColors), its candles filled in the up / down colours as the preview always
     showed them, its tags on the box's own background */
  function kcTheme(slot) {
    const k = {...chartColors()}; delete k.cup; delete k.cdn;
    const bg = slot ? getComputedStyle(slot).backgroundColor : ''; if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') k.bg = bg;
    return k;
  }
  const KC = {ch: null, host: null, key: '', rows: null, push: null, lines: '', theme: '', last: 0};
  /* the dates in the site's words (QA 2026-10-06): "Sep 28" for a day, "Sep 28 14:00" within one (the axis: a day's
     first tick by its date alone) */
  const kcLoc = () => RVI18N.lang === 'en' ? 'en-US' : RVI18N.locale || 'en-US';
  function kcDate(a) {
    const d = new Date(a.timestamp), loc = kcLoc();
    const day = d.toLocaleDateString(loc, {month: 'short', day: 'numeric'});
    const intra = a.type === 'xAxis' ? /H/.test(a.template || '') && (d.getHours() || d.getMinutes()) : F.ctf !== '1d';
    return intra ? day + ' ' + d.toLocaleTimeString(loc, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}) : day;
  }
  /* the price scale without the figures the price tag would cover (its tag sits on the scale: QA 2026-10-06) */
  let kcAxisOn = false;
  function kcAxis() {
    const L = window.klinecharts;
    if (!kcAxisOn && L && L.registerYAxis) { kcAxisOn = true;
      // the tag's place read from the ticks themselves and 20px either side kept clear, as the Terminal's chart
      // (chart-adapter.js createTicks; round-3 QA 2026-10-07: a tick peeked beside the tag on a phone)
      L.registerYAxis({name: 'bfPrice', createTicks: ({defaultTicks}) => {
        const p = KC.last, t = defaultTicks || [];
        if (!(p > 0) || t.length < 2 || t[0].value === t[t.length - 1].value) return t;
        const a = t[0], z = t[t.length - 1], y = a.coord + (p - a.value) * (z.coord - a.coord) / (z.value - a.value);
        return t.filter(x => !(Math.abs(x.coord - y) <= 20)); }});
    }
    try { KC.ch.raw.overrideYAxis({paneId: 'candle_pane', name: 'bfPrice'}); } catch (e) {}
  }
  /* the candles shown at first and after a double click: about 90 of them, the newest at the right */
  function kcFit() {
    const kc = KC.ch && KC.ch.raw; if (!kc || !KC.host) return;
    const n = Math.min(90, (KC.rows || []).length || 90), w = KC.host.clientWidth - 72;
    try { if (w > 0) kc.setBarSpace(Math.max(2, w / n)); kc.scrollToRealTime(); } catch (e) {}
  }
  const kcBar = r => ({t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: 0});
  function kcMount(slot) {
    if (!window.RvChart || !RvChart.available()) return false;
    if (!KC.host) { KC.host = document.createElement('div'); KC.host.className = 'bf-kc'; }
    if (KC.host.parentNode !== slot) { slot.textContent = ''; slot.appendChild(KC.host); if (KC.ch) { KC.ch.resize(); kcFit(); } }
    if (KC.ch) return true;
    const th = kcTheme(slot);
    KC.ch = RvChart.init(KC.host, {theme: th, plain: true, locale: RVI18N.lang === 'zh-CN' ? 'zh-CN' : 'en-US',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', fmtPrice: v => X.rp(v), formatter: {formatDate: kcDate}});
    if (!KC.ch) return false;
    kcAxis();
    // past the newest candle there is nothing to show: the chart never scrolls into empty future dates, zoomed out
    // either (round-2 QA 2026-10-07); the newest candle keeps its small gap to the price scale
    try { KC.ch.raw.setMaxOffsetRightDistance(24); } catch (e) {}
    KC.host.addEventListener('dblclick', kcFit);
    KC.theme = JSON.stringify(th);
    // a phone: a sideways swipe moves the candles, an up / down one still scrolls the page (the library's box takes every touch)
    const inner = KC.host.firstElementChild; if (inner) { inner.style.touchAction = 'pan-y'; inner.style.overscrollBehavior = 'auto'; }
    let g = null;
    chartPick(KC.host);
    // a finger on one of Customize's lines drags that line: the page does not scroll under it (preventDefault), the
    // library moves the line
    const onLine = y => { const kc = KC.ch && KC.ch.raw; if (!kc || F.step !== 'custom') return false;
      const top = KC.host.getBoundingClientRect().top;
      return KC.ch.lines.ids('bfh').some(id => { const sp = KC.ch.lines.get(id); let p = null;
        try { p = kc.convertToPixel([{value: sp.price}], {paneId: 'candle_pane'}); } catch (x) {}
        return p && p[0] && isFinite(p[0].y) && Math.abs(p[0].y - (y - top)) <= 14; }); };
    KC.host.addEventListener('touchstart', e => { if (e.touches.length === 1 && onLine(e.touches[0].clientY)) { e.preventDefault(); g = null; } }, {capture: true, passive: false});
    KC.host.addEventListener('touchstart', e => { const t = e.touches[0]; g = e.touches.length === 1 && !e.defaultPrevented ? {x: t.clientX, y: t.clientY, v: null} : null; }, {capture: true, passive: true});
    KC.host.addEventListener('touchmove', e => { if (!g) return; const t = e.touches[0];
      if (e.rvOwn) return;
      if (g.v == null) { const dx = Math.abs(t.clientX - g.x), dy = Math.abs(t.clientY - g.y); if (Math.max(dx, dy) < 6) return; g.v = dy > dx;
        // the library still hears that the finger moved (a move it cannot cancel), so lifting it is no tap: no crosshair left behind
        if (g.v) try { const m = new Touch({identifier: t.identifier, target: t.target, clientX: t.clientX, clientY: t.clientY, pageX: t.pageX, pageY: t.pageY, screenX: t.screenX, screenY: t.screenY});
          const ev = new TouchEvent('touchmove', {bubbles: true, cancelable: false, touches: [m], targetTouches: [m], changedTouches: [m]}); ev.rvOwn = true; t.target.dispatchEvent(ev); } catch (x) {} }
      if (g.v) e.stopPropagation(); }, {capture: true, passive: true});
    KC.ch.setFeed({history: () => (KC.rows || []).map(kcBar), subscribe: fn => { KC.push = fn; return () => { KC.push = null; }; }, loaded: () => { KC.lines = ''; kcFit(); kcLines(); }});
    try { new ResizeObserver(() => { if (KC.host.isConnected && KC.host.clientWidth) KC.ch.resize(); }).observe(KC.host); } catch (e) {}
    addEventListener('rvtheme', () => { const s = document.getElementById('bf-ch'); if (KC.ch && s) { KC.ch.setTheme(kcTheme(s)); KC.lines = ''; kcLines(); } });
    return true;
  }
  /* the bot's lines (previewLines): the grid's or the orders' lines and the range's band; the range ends, take profit and
     stop as solid lines with their labels on the left; the price scale reaches them unless far off the candles shown */
  /* the bot's own lines stay in view on every timeframe (round-2 QA 2026-10-07: on 1m and 15m the 90 candles span a
     fraction of a grid's range, and the range ends, take profit and stop fell off the scale): any line within half the
     price either way joins the scale, the candles then sit inside the bot's range as they do on 4h */
  const nearPx = x => { const p = X.mkPrice(); return p > 0 && x > p * 0.5 && x < p * 1.5; };
  function kcLines() {
    if (!KC.ch || !KC.rows) return;
    if (vco()) { if (KC.lines !== 'other') { KC.lines = 'other'; KC.ch.lines.bundle('bfpv', null); KC.ch.keepInView('bf', 0, 0); for (const id of KC.ch.lines.ids('bfh')) KC.ch.lines.remove(id); } return; }
    const k = kcTheme(document.getElementById('bf-ch')), pv = X.previewLines(k), recent = KC.rows.slice(-90);
    let lo = Math.min(...recent.map(r => r[3])), hi = Math.max(...recent.map(r => r[2]));
    const span0 = hi - lo, keepIn = x => x > lo - span0 * 1.2 && x < hi + span0 * 1.2;
    const lines = (pv.lines || []).filter(l => l.px > 0).map(l => ({price: l.px, color: l.color, dash: l.dash, size: l.size, label: l.label, right: l.right}));
    const hs = (pv.handles || []).filter(h => h.px > 0).map(h => ({price: h.px, color: h.color, size: 1, label: String(h.title || '').split(' · ').slice(0, 2).join(' · ').slice(0, 40), which: h.which, ref: h.ref}));
    const band = pv.band && pv.band[0] < pv.band[1] ? pv.band : null;
    const drag = F.step === 'custom';                 // Customize: each handle is a line to drag (its setting follows)
    const key = JSON.stringify([lines, hs, band, k.acc, drag]);
    if (key === KC.lines) return;
    KC.lines = key;
    for (const x of lines.filter(l => !l.right).map(l => l.price).concat(hs.map(h => h.price), band || []).filter(x => keepIn(x) || nearPx(x))) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    KC.ch.keepInView('bf', lo, hi);
    // labels that would sit on top of each other (the Live check's small chart: take profit, stop and last buy a few
    // pixels apart) keep only the first of them; their lines stay (visual sweep 2026-10-07)
    const ppx = (KC.host.clientHeight || 160) * 0.7 / ((hi - lo) || 1);     // the scale pads above and below
    let lastY = null;
    for (const o of hs.concat(lines).filter(o => o.label).sort((a, b) => b.price - a.price)) {
      if (lastY != null && Math.abs(lastY - o.price) * ppx < 20) o.label = ''; else lastY = o.price;
    }
    // the handles last: their labels take the left first, a grid line close to one keeps only its line
    const fixed = drag ? lines : hs.concat(lines);
    KC.ch.lines.bundle('bfpv', fixed.length || band ? {lines: fixed, band, bandColor: alpha(k.acc, .05)} : null);
    const keep = new Set();
    if (drag) for (const h of hs) {
      const id = 'bf:' + h.which; keep.add(id);
      KC.ch.lines.upsert(id, {price: h.price, color: h.color, label: h.label, kind: 'bfh', draggable: true, style: 'handle',
        onMoving: v => dragFill(h.which, v, h.ref), onMove: v => { X.dragged(h.which, v, h.ref); KC.lines = ''; kcLines(); }});
    }
    for (const id of KC.ch.lines.ids('bfh')) if (!keep.has(id)) KC.ch.lines.remove(id);
  }
  /* a line being dragged: the fields it sets show the value it would set, as it moves (the settings change once dropped) */
  function dragFill(which, v, ref) {
    const ch = X.dragCh && X.dragCh(which, v, ref); if (!ch) return;
    for (const [key, val] of Object.entries(ch)) document.querySelectorAll(`#bf input[data-bk="${CSS.escape(key)}"]`).forEach(i => { i.value = String(val); });
  }
  /* a click on the chart while a price field (or a distance the chart's lines show) is being typed: the field takes the
     price clicked, as if typed (prices are picked on the chart) */
  const PICKS = {lower: 'lower', upper: 'upper', trigger_px: 'trigger_px', tp_px: 'tp_px', sl_px: 'sl_px', start_px: 'start_px', activation_px: 'activation_px',
    limit_px: 'limit_px', tp_pct: 'tp', sl_pct: 'sl', so_step_pct: 'last', activation_pct: 'activation', trail_pct: 'sl'};
  function chartPick(host) {
    let at = null;
    host.addEventListener('pointerdown', e => { const a = document.activeElement;
      at = F.step === 'custom' && !vco() && a && a.matches && a.matches('#bf input[data-bk]') && PICKS[a.dataset.bk] && e.button === 0 ? {x: e.clientX, y: e.clientY, key: a.dataset.bk} : null; }, true);
    host.addEventListener('click', e => {
      const p = at; at = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4 || !KC.ch) return;
      const v = KC.ch.priceAt(e.clientX, e.clientY); if (!(v > 0)) return;
      const which = PICKS[p.key], hd = (X.previewLines(chartColors()).handles || []).find(h => h.which === which);
      // a distance only where the chart draws it from the entry (a grid's or a basket's take profit is a share of the
      // money, never a price: no line, no pick)
      const ch = /_px$|^lower$|^upper$/.test(p.key) ? {[p.key]: T().niceRound(v)} : hd ? X.dragCh(which, v, hd.ref) : null;
      const i = document.querySelector(`#bf input[data-bk="${CSS.escape(p.key)}"]`);
      if (!ch || ch[p.key] == null || !i) return;
      i.value = String(ch[p.key]); i.dispatchEvent(new Event('input', {bubbles: true}));
      const j = document.querySelector(`#bf input[data-bk="${CSS.escape(p.key)}"]`);      // drawn again, maybe
      if (j) { if (j !== i) j.value = String(ch[p.key]); try { j.focus({preventScroll: true}); } catch (x) {} }
    });
  }
  const alpha = (hex, a) => /^#[0-9a-f]{6}$/i.test(hex || '') ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex;
  /* the chart in the step's box: a new market or timeframe loads its candles again; the same ones only move the last candle */
  function chartDraw(el) {
    if (!el) return;
    loadChart(F.ctf);
    if (window.__kc === 'err') return chartSvg(el);
    const rows = chartRows();
    if (!rows || !kcMount(el)) return;
    KC.last = rows[rows.length - 1][4];
    const cn = vco() || S.coin, live = F.cc[ccKey(F.ctf)], key = [cn, S.venue, F.ctf, Array.isArray(live) && live.length >= 10 ? 'live' : 'closed'].join('|');
    const th = JSON.stringify(kcTheme(el));
    if (th !== KC.theme) { KC.theme = th; KC.ch.setTheme(JSON.parse(th)); KC.lines = ''; }
    if (key !== KC.key || !KC.rows) {
      const head = KC.key.split('|').slice(0, 3).join('|'), now = key.split('|').slice(0, 3).join('|');
      KC.key = key; KC.rows = rows; KC.lines = '';
      if (head !== now) { const p = rows[rows.length - 1][4];        // the scale in five figures, as Hyperliquid prices (85,826 · 2,672.5)
        KC.ch.setMarket(PAIR(cn), '', Math.min(C().priceDecimals(p), Math.max(0, 5 - String(Math.floor(Math.abs(p))).length)), 4); KC.ch.setTimeframe(F.ctf); }
      KC.ch.reload();
      return;
    }
    // the same candles: the last two again (a new candle opens on its own), the bot's lines as they are now
    const a = KC.rows; KC.rows = rows;
    if (KC.push) for (const r of rows.slice(-2)) { const old = a.find(x => x[0] === r[0]); if (!old || old[2] !== r[2] || old[3] !== r[3] || old[4] !== r[4]) KC.push(kcBar(r)); }
    kcLines();
  }
  /* the chart library could not load: the same candles and lines as a plain picture (drag and zoom redraw it once a frame) */
  let svgQ = 0;
  const svgSoon = el => { if (!svgQ) svgQ = requestAnimationFrame(() => { svgQ = 0; chartSvg(el); }); };
  function chartBind(el) {
    if (el.dataset.ia) return; el.dataset.ia = '1';
    const clampV = () => { const n = el._len || 0; F.cv.n = Math.max(15, Math.min(F.cv.n, n)); F.cv.off = Math.max(0, Math.min(F.cv.off, n - F.cv.n)); };
    el.addEventListener('wheel', e => { if (!el._len) return; e.preventDefault();
      F.cv.n = Math.round((F.cv.n || el._n) * (e.deltaY > 0 ? 1.15 : 1 / 1.15)); clampV(); svgSoon(el); }, {passive: false});
    let drag = null;
    el.addEventListener('pointerdown', e => { if (!el._len || e.button > 0) return; drag = {x: e.clientX, off: F.cv.off, n: F.cv.n || el._n}; el.setPointerCapture(e.pointerId); el.classList.add('drag'); });
    el.addEventListener('pointermove', e => { if (!drag) return; F.cv.n = drag.n;
      F.cv.off = drag.off + Math.round((e.clientX - drag.x) / (el._cw || 6)); clampV(); svgSoon(el); });
    const up = () => { drag = null; el.classList.remove('drag'); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', () => { F.cv = {n: 0, off: 0}; svgSoon(el); });
  }
  function chartSvg(el) {
    if (!el) return;
    chartBind(el);
    const rows = chartRows();
    if (!rows) return;
    const k = chartColors(), pv = vco() ? {lines: [], handles: []} : X.previewLines(k), mini = el.closest('.bf-live') != null;
    /* drawn at the box's own size, so the labels stay 11px on a phone too */
    const W = Math.round(el.clientWidth) || (mini ? 280 : 664), H = Math.round(el.clientHeight) || (mini ? 150 : 300), R = W < 420 ? 52 : 64, B0 = 22, pad = 8;
    const n0 = W < 420 ? 60 : 90, n = Math.max(15, Math.min(F.cv.n || n0, rows.length)), off = Math.max(0, Math.min(F.cv.off, rows.length - n));
    const cs = rows.slice(rows.length - n - off, rows.length - off);
    el._len = rows.length; el._n = n0;
    let lo = Math.min(...cs.map(r => r[3])), hi = Math.max(...cs.map(r => r[2]));
    const span0 = hi - lo, keepIn = x => x > lo - span0 * 1.2 && x < hi + span0 * 1.2;
    const near = x => keepIn(x) || nearPx(x);
    const lines = (pv.lines || []).filter(l => l.px > 0 && near(l.px)), hs = (pv.handles || []).filter(h => h.px > 0 && near(h.px));
    for (const x of lines.map(l => l.px).concat(hs.map(h => h.px), (pv.band || []).filter(near))) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    const sp = (hi - lo) || hi * 0.01 || 1; lo -= sp * 0.04; hi += sp * 0.04;
    const y = v => pad + (hi - v) / (hi - lo) * (H - B0 - pad * 2), cw = (W - R) / cs.length, x = i => i * cw + cw / 2;
    el._cw = (W - R) / cs.length * (el.getBoundingClientRect().width / W || 1);
    const key = JSON.stringify([F.ctf, off, W, H, cs.length, cs[0][0], cs[cs.length - 1], lines.map(l => [l.px, l.color]), hs.map(h => [h.px, h.title]), pv.band]);
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    const f = v => v.toFixed(1), out = [];
    // price axis: three round levels
    const step = Math.pow(10, Math.floor(Math.log10(sp / 2))), ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi && ticks.length < 8; v += step) ticks.push(v);
    const pick = ticks.length > 4 ? ticks.filter((_, i) => i % Math.ceil(ticks.length / 3) === 0) : ticks;
    const pnow = vco() ? 0 : X.mkPrice();
    out.push(`<g class="ax">${pick.filter(v => !(pnow > lo && pnow < hi && Math.abs(y(v) - y(pnow)) < 16)).map(v => `<text x="${W - R + 8}" y="${f(y(v) + 4)}">${esc(X.rp(v))}</text>`).join('')}</g>`);
    if (pv.band && pv.band[0] < pv.band[1]) out.push(`<rect x="0" y="${f(y(pv.band[1]))}" width="${W - R}" height="${f(Math.max(0, y(pv.band[0]) - y(pv.band[1])))}" fill="${k.acc}" opacity=".05"/>`);
    for (const l of lines) out.push(`<line x1="0" x2="${W - R}" y1="${f(y(l.px))}" y2="${f(y(l.px))}" stroke="${l.color}" stroke-width="1" ${l.dash ? `stroke-dasharray="${l.dash.join(' ')}"` : ''} opacity=".9"/>`);
    // candles
    const bw = Math.max(1, cw * 0.62);
    cs.forEach((r, i) => { const up = r[4] >= r[1], col = up ? k.up : k.dn;
      out.push(`<line x1="${f(x(i))}" x2="${f(x(i))}" y1="${f(y(r[2]))}" y2="${f(y(r[3]))}" stroke="${col}" stroke-width="1"/>` +
        `<rect x="${f(x(i) - bw / 2)}" y="${f(Math.min(y(r[1]), y(r[4])))}" width="${f(bw)}" height="${f(Math.max(1, Math.abs(y(r[1]) - y(r[4]))))}" fill="${col}"/>`); });
    // the handles (range ends, take profit, stop): a solid line and its label on the left
    let lastLy = null;                                     // a label a few pixels from the one above it is left out
    hs.slice().sort((a, b) => b.px - a.px).forEach(h => { const yy = y(h.px); if (lastLy != null && Math.abs(yy - lastLy) < 16) h.nolbl = true; else lastLy = yy; });
    hs.forEach(h => { const yy = y(h.px), t = h.nolbl ? '' : String(h.title || '').split(' · ').slice(0, 2).join(' · ').slice(0, 40), w = t.length * (mini ? 5.6 : 6.1) + 12;
      out.push(`<line x1="0" x2="${W - R}" y1="${f(yy)}" y2="${f(yy)}" stroke="${h.color}" stroke-width="1"/>` +
        (W < 320 || !t ? '' : `<g class="lbl"><rect x="8" y="${f(yy - 9)}" width="${f(w)}" height="18" rx="4"/><text x="14" y="${f(yy + 4)}">${esc(t)}</text></g>`)); });
    // the price now
    const p = pnow;
    if (p && p > lo && p < hi) { const yy = y(p), t = X.rp(p), w = String(t).length * 6.4 + 12;
      out.push(`<line x1="0" x2="${W - R}" y1="${f(yy)}" y2="${f(yy)}" stroke="${k.text}" stroke-dasharray="1 3" stroke-width="1"/>` +
        `<g class="now"><rect x="${W - R + 2}" y="${f(yy - 9)}" width="${f(Math.min(w, R - 2))}" height="18" rx="4"/><text x="${W - R + 8}" y="${f(yy + 4)}">${esc(t)}</text></g>`); }
    // dates under the candles
    const nd = W < 420 ? 3 : 5, dl = [];
    for (let i = 0; i < nd; i++) { const j = Math.round((cs.length - 1) * (i + 0.5) / nd), d = new Date(cs[j][0] * 1000);
      const loc = RVI18N.lang === 'en' ? 'en-US' : RVI18N.locale, intra = cs[cs.length - 1][0] - cs[0][0] < 2 * 86400;
      dl.push(`<text x="${f(x(j))}" y="${H - 4}" text-anchor="middle">${esc(intra ? d.toLocaleTimeString(loc, {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString(loc, {month: 'short', day: 'numeric'}))}</text>`); }
    out.push(`<g class="ax">${dl.join('')}</g>`);
    el.innerHTML = `<svg class="bfc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(_t('Preview'))}">${out.join('')}</svg>`;
  }
  function loadCandles() {
    const key = X.mcKey('4h');
    if (B.mc[key]) return;
    B.mc[key] = 'loading';
    fetch(`/api/auto/terminal/candles?venue=${encodeURIComponent(S.venue)}&coin=${encodeURIComponent(S.coin)}&tf=4h`).then(r => r.ok ? r.json() : {candles: []}).catch(() => ({candles: []}))
      .then(d => { if (d.busy) { delete B.mc[key]; setTimeout(loadCandles, 4000); return; }   // every chart read busy: ask again
        const now = Date.now() / 1000; B.mc[key] = (d.candles || []).filter(c => c[0] + 14400 <= now).map(c => c.slice(0, 5)); render(); });
  }

  /* ---------------- the coin (a sheet, as the Terminal's picker) ---------------- */
  /* a row's name: a builder market's own exchange after its ticker (SNDK · xyz, SNDK · io), as the market's card says it
     (pairLabel), so two markets of one ticker never read the same (round-3 QA 2026-10-07) */
  const rowName = c => C().mktName(c) + (C().isHip3(c) ? ' · ' + C().mktDex(c) : '');
  function coinSheet() {
    openSheet(`<div class="sh-h"><h3>${_t('Coin')}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${ICON.x}</button></div>` +
      `<div class="sh-b"><div class="bfs-q">${ICON.search}<input id="bfs-q" placeholder="${_t('Search')}" autocomplete="off" spellcheck="false" aria-label="${_t('Search')}"></div><div class="bfs-l" id="bfs-l"></div></div>`, 'bfs');
    // the market-hours grid runs only on stock and commodity markets (HIP-3, "dex:TICKER"): those first, every crypto coin
    // listed as not for it and not pickable (round-2 QA 2026-10-07)
    const sess = curKind() === 'sessgrid', crypto = c => !hasHours(c);
    const list = () => { const w = ($('bfs-q').value || '').trim().toUpperCase();
      let rows = (S.coins || []).filter(c => !w || C().mktMatch(c.coin, w));
      if (sess) rows = rows.filter(c => !crypto(c.coin)).concat(rows.filter(c => crypto(c.coin)));
      rows = rows.slice(0, 80);
      $('bfs-l').innerHTML = rows.map(c => { const m = ((S.markets || {})[c.coin] || {})[S.venue], ch = S.tickers && S.tickers[c.coin] ? S.tickers[c.coin].change : null, off = sess && crypto(c.coin);
        return `<button type="button" class="bfs-r${c.coin === S.coin ? ' on' : ''}${off ? ' na' : ''}" data-c="${esc(c.coin)}"${off ? ' disabled' : ''}><span class="lg">${coinIcon(c.coin, 24)}</span><span><b>${esc(rowName(c.coin))}</b>` +
          `<small>${esc(off ? _t('Stocks and commodities only') : m ? L(S.venue) : _t('not on {venue}', {venue: L(S.venue)}))}</small></span><span class="r num">${esc(C().fmtPrice(listPx(c.coin)))}` +
          `<small class="${ch == null ? '' : ch >= 0 ? 'up' : 'dn'}">${ch == null ? '–' : esc(C().fmtPct(ch))}</small></span></button>`; }).join('') || `<p class="bf-note">${_t('No market matches.')}</p>`; };
    list();
    $('bfs-q').oninput = list;
    $('bfs-l').onclick = e => { const b = e.target.closest('[data-c]'); if (!b || b.disabled) return; closeSheet(); pick(b.dataset.c, S.venue); refocus('bf-coin'); };
    $('bfs-q').onkeydown = e => { const r = $('bfs-l').querySelector('.bfs-r:not([disabled])');
      if (e.key === 'Enter' && r) { e.preventDefault(); r.click(); } else if (e.key === 'ArrowDown' && r) { e.preventDefault(); r.focus(); } };
    sheetKeys($('bfs-l'), $('bfs-q'));
    if (!phone()) $('bfs-q').focus();
  }
  /* the arrow keys through a picker's rows (Up from the first goes back to its search) */
  function sheetKeys(list, back) {
    if (!list) return;
    list.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rows = [...list.querySelectorAll('.bfs-r:not([disabled])')], i = rows.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const to = e.key === 'ArrowDown' ? rows[Math.min(rows.length - 1, i + 1)] : i === 0 && back ? back : rows[Math.max(0, i - 1)];
      to.focus();
    });
  }
  const refocus = id => requestAnimationFrame(() => { const b = document.getElementById(id); if (b) b.focus(); });
  function pick(coin, venue) {
    if (coin === S.coin && venue === S.venue) return;
    select(coin, venue);
    F.pbt = {}; F.qcoinOff = true;
    loadCandles(); render();
  }

  /* ---------------- render and paint ---------------- */
  function pageH() {
    const k = curKind();
    if (F.step === 'choose') return chooseH();
    if (k === 'signal') return alertsH();
    if (F.step === 'amount') return amountH();
    if (F.step === 'custom') return customH();
    return reviewH();
  }
  /* a wider screen: the setup panel ends at the window's bottom, its body scrolls inside it between the steps and the
     footer, so nothing sits under the footer and the page itself does not scroll (no long pages).
     The panel's room is the window under its top edge, less the wrapper's bottom padding (bot-flow.css --bf-maxh) */
  function fit() {
    const el = box(); if (!el) return;
    if (phone() || innerHeight <= 700) { el.style.removeProperty('--bf-maxh'); return; }      // a short window: the page scrolls (bot-flow.css)
    const top = el.getBoundingClientRect().top + scrollY, pb = parseFloat(getComputedStyle(el.parentElement).paddingBottom) || 0;
    const h = Math.max(480, Math.floor(innerHeight - top - pb)) + 'px';
    if (el.style.getPropertyValue('--bf-maxh') !== h) el.style.setProperty('--bf-maxh', h);
  }
  let rendering = false;
  /* the tab says what the page does, as its crumb: an edit (Edit in the Bot Terminal, ?edit=) is not a new bot.
     terminal.html renderTop leaves a tm-flow page's title to this */
  function nameTab() {
    const t = F.edit ? _t('Edit bot') + ' ' + _t('· Rivemont') : _t('New bot · Rivemont');
    if (document.title !== t) document.title = t;
  }
  function render() {
    if (S.signedOut && window.rvEv) window.rvEv('demo_start', {from: 'new_bot'});    // the signed-out setup is the demo (radar/analytics.py)
    const el = box(); if (!el || !C() || !T() || rendering) return;
    if (S.signedOut) ev('demo_start');
    nameTab();
    if (F.pend && !pending()) return;
    sessFit();
    rendering = true;
    try {
      if (isPlanned(curKind())) X.plan();
      const a = document.activeElement, d = a && a.dataset;
      const keepK = a && el.contains(a) ? (d.bk ? 'bk:' + d.bk : d.inv ? 'inv' : d.pk ? 'pk:' + d.pk : d.fkind ? 'fkind:' + d.fkind : d.fplan ? 'fplan:' + d.fplan
        : d.step ? 'step:' + d.step : a.id ? 'id:' + a.id : null) : null;
      const raw = a && a.tagName === 'INPUT' ? a.value : null, caret = a && a.selectionStart;
      const h = headed(pageH());
      if (h !== F.last) {
        // the same step drawn again (a switch, a row added): its scrolling boxes stay where they were
        const same = el.dataset.step === F.step, tops = same ? ['.bf-mb', '.bf-czs', '.bf-czl'].map(q => { const b = el.querySelector(q); return b ? b.scrollTop : 0; }) : null;
        F.last = h; el.innerHTML = h; el.setAttribute('aria-busy', 'false'); el.dataset.step = F.step;
        if (tops) ['.bf-mb', '.bf-czs', '.bf-czl'].forEach((q, n) => { const b = el.querySelector(q); if (b && tops[n]) b.scrollTop = tops[n]; });
        if (F.step === 'custom' && isPlanned(curKind())) F.nk[B.kind] = [...new Set([...el.querySelectorAll('input[data-bk][inputmode="decimal"]')].map(i => i.dataset.bk))];
        bind(el);
        if (keepK) { const [t, v] = keepK.split(/:(.*)/), q = x => el.querySelector(`[data-${x}="${CSS.escape(v)}"]`);
          const i = t === 'inv' ? el.querySelector('[data-inv]') : t === 'id' ? document.getElementById(v) : q(t);
          if (i) { if (raw != null && i.tagName === 'INPUT' && i.value !== raw) i.value = raw; try { i.focus({preventScroll: true}); if (caret != null && i.setSelectionRange) i.setSelectionRange(caret, caret); } catch (e) {} } }
      }
    } finally { rendering = false; }
    fit();
    paint();
  }
  /* figures that change without the page changing: the checks, the backtests, the chart, Start */
  function paint() {
    const el = box(); if (!el || !C() || !T()) return;
    const set = (sel, html) => el.querySelectorAll(sel).forEach(e => { if (e.innerHTML !== html) e.innerHTML = html; });
    const planned = isPlanned(curKind()) && !B.priv;
    if (planned) {
      const p = B.plan || X.plan(), a = X.avail();
      set('[data-fv="avail"]', a == null ? '–' : esc(amt(a)));
      set('[data-fv="min"]', esc(minAmt(p.minTotal)));
      el.querySelectorAll('[data-fv="minw"]').forEach(e => e.classList.toggle('bad', amtBad(p)));
      el.querySelectorAll('.bf-amtf, .bf-in:has(> [data-inv])').forEach(e => e.classList.toggle('bad', !!amtRaw()));
      set('[data-fv="amterr"]', esc(amtErrTxt()));
      // the plans' tests not asked yet (a link straight to this step, the price that came in after it was drawn): asked
      if (F.step === 'amount' && !F.pbtT0) { let q = null; try { q = planBtKey(B.preset[B.kind] || 'balanced'); } catch (e) {}
        if (q && !F.pbt[q.key]) { F.pbtT0 = true; setTimeout(() => { F.pbtT0 = false; planBts(true); }, 400); } }
      for (const n of ['safe', 'balanced', 'aggressive']) set(`[data-fpbt="${n}"]`, planBtTxt(n));
      set('[data-fv="simn"]', esc(simNote())); set('[data-fv="pbterr"]', esc(planBtErr()));
      set('[data-fv="sum"]', sumH()); set('[data-fv="risk"]', riskH()); set('[data-fv="guard"]', guardH());
      set('[data-fv="meta"]', esc(reviewMeta()));
      set('[data-fv="levline"]', esc(levLine()));
      const r = chk(), {d, err} = X.btShown();
      set('[data-fv="min2"]', esc(minAmt(p.minTotal)));
      set('[data-fv="safe"]', r && r.safe_leverage >= 1 && !X.cross() ? `${r.safe_leverage}x` : '–');
      set('[data-fv="risk2"]', riskH(true)); set('[data-fv="btlbl"]', esc(btLbl()));
      // a test that failed says why (a busy minute, a coin without history), never a bare dash (QA 2026-10-06)
      set('[data-fv="btbig"]', hardWhy() || !X.btReady() ? '–' : d && d.stats && !btFresh(d) ? '…' : err && !(d && d.stats) ? `<span class="bf-aerr">${esc(sentenceOf(err.error))}</span>` : d && d.stats && idleOf(d.stats) ? '–' : d && d.stats ? `<span class="${d.stats.return_pct > 0 ? 'up' : d.stats.return_pct < 0 ? 'dn' : ''}">${d.stats.pnl_usd != null ? esc((d.stats.pnl_usd > 0 ? '+' : d.stats.pnl_usd < 0 ? '−' : '') + usd(Math.abs(d.stats.pnl_usd), 2)) : ''}</span><span class="${d.stats.return_pct > 0 ? 'up' : d.stats.return_pct < 0 ? 'dn' : ''}">${esc(pctS(d.stats.return_pct))}</span>` : B.btBusy ? '…' : '–');
      el.querySelectorAll('.bf-bt').forEach(e => e.classList.toggle('ld', X.btShown().stale));
      // the review's or the live check's test refused for a busy minute: asked again once it has passed (a few times)
      if ((F.step === 'review' || F.step === 'custom') && err && /busy|minute/i.test(err.error || '') && !F.btR && (F.btRN || 0) < 6) {
        F.btRN = (F.btRN || 0) + 1;
        F.btR = setTimeout(() => { F.btR = null; if (X.btShown().err) { B.bt = null; X.scheduleBt(true); } }, 20e3);
      }
      if (F.step === 'review' || F.step === 'custom') {
        set('[data-fv="bt"]', btH());
        // the review's amount field says its own error under it: not again as a block
        const bl = X.blocks().filter(b => !b.wait && !b.out && !b.min && !(r && r.leverage_block && b.text === r.leverage_block)
          && !(F.step === 'review' && X.amtErr() && b.text === X.amtErrText()));
        // a fix that would set more than a bot may use is no fix (Recurring with a huge number of buys): the line stays, its button goes
        set('[data-fv="blk"]', X.blocksH(bl.map(b => b.fix ? {...b, fix: b.fix.filter(f => !(f.set > P.MAX_USD))} : b)));
        set('[data-fv="warn"]', keepTyped(FP.warnList(r), r).map(w => `<p class="bf-warn">${esc(w)}</p>`).join(''));
      }
      if (X.ctabsH) set('[data-fv="ctabs"]', X.ctabsH());           // a basket's coins and weights as they are typed
      chartDraw(document.getElementById('bf-ch'));
    } else if (B.priv) {
      const r = B.privChk && B.privChk.ok ? B.privChk : null;
      set('[data-fv="psum"]', r ? `<ol class="bf-ol">${r.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : '');
      set('[data-fv="bt"]', btH());
      set('[data-fv="blk"]', X.blocksH(X.privBlocks().filter(b => !b.wait && !b.out)));
      // on cross margin the copy's own amount alone would be liquidated before its orders: said, never blocking
      set('[data-fv="pwarn"]', r && r.warnings ? r.warnings.map(w => `<p class="bf-warn">${esc(w)}</p>`).join('') : '');
      const a = X.avail(); set('[data-fv="avail"]', a == null ? '–' : esc(amt(a)));
      set('[data-fv="pminw"]', privMinH()); set('[data-fv="plev"]', privLev()); set('[data-fv="ppos"]', privPos());
    }
    if (curKind() !== 'signal') { set('[data-fv="px"]', curPrice() ? esc(C().fmtPrice(curPrice())) : '–'); }
    if (planned) paintHard(el);
    const go = document.getElementById('bf-go');
    if (go && go.tagName === 'BUTTON' && F.step === 'custom') go.disabled = !!hardWhy();
    if (go && go.tagName === 'BUTTON' && F.step === 'review') { const lab = startLabel(), h = esc(lab) + GO; if (go.innerHTML !== h) go.innerHTML = h; go.disabled = startOff(); }
    // the Amount step: an amount typed that cannot work (not above 0, under the minimum) keeps Continue off; an empty
    // field still goes on (the review asks for it)
    if (go && go.tagName === 'BUTTON' && F.step === 'amount' && planned) go.disabled = amtBad(B.plan || X.plan()) || !!hardWhy();
    if (go && go.tagName === 'BUTTON' && F.step === 'choose' && planned) go.disabled = !!hardWhy();
    const ex = document.getElementById('bf-expert'); if (ex) ex.disabled = !!hardWhy();
    if (go && go.tagName === 'BUTTON' && F.step === 'amount' && B.priv) go.disabled = privBad();
    el.querySelectorAll('[data-fv="blk"], [data-fv="guard"]').forEach(bindFix);
  }
  /* the settings that cannot work: each field marked in red with its reason under its name (as the amount field), the
     step's own line (data-fv="hard") with the reason */
  function paintHard(el) {
    const errs = F.step === 'custom' ? fieldErrs() : [], bad = new Map(errs.map(e => [e.key, e.text]));
    el.querySelectorAll('input[data-bk]').forEach(i => { const t = bad.get(i.dataset.bk), box = i.closest('.bf-in, .inp'), row = i.closest('.bf-r');
      if (box) box.classList.toggle('bad', t != null);
      // the field says it is wrong and why to a screen reader too (audit BOT-08)
      const eid = 'bf-ferr-' + i.dataset.bk.replace(/[^\w-]/g, '_');
      if (t != null) { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', eid); }
      else if (i.hasAttribute('aria-invalid')) { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }
      if (!row || !row.firstElementChild) return;
      let m = row.firstElementChild.querySelector(`[data-ferr="${CSS.escape(i.dataset.bk)}"]`);
      if (t != null && !m) { m = document.createElement('span'); m.className = 'bf-aerr'; m.dataset.ferr = i.dataset.bk; m.id = eid; m.setAttribute('role', 'alert'); row.firstElementChild.appendChild(m); }
      if (m) { if (t == null) m.remove(); else if (m.textContent !== t) m.textContent = t; } });
    const w = hardWhy();
    el.querySelectorAll('[data-fv="hard"]').forEach(e => { if (e.textContent !== w) e.textContent = w; });
  }
  /* the first field marked in red, in view and focused (Customize's Done while a setting cannot work) */
  function focusBad() {
    const b = box() && box().querySelector('input[aria-invalid="true"]');
    if (!b) return false;
    try { b.scrollIntoView({block: 'center'}); b.focus({preventScroll: true}); } catch (e) { b.focus(); }
    return true;
  }
  /* the fixes on the blocking lines and the guard: set the minimum, the safe leverage; in an edit, stop the old bot */
  function bindFix(e) {
    X.bindLinks(e);
    e.querySelectorAll('[data-bmanage]').forEach(b => { const old = F.edit && X.bots().find(x => x.id === F.edit && ['active', 'paused', 'error'].includes(x.status));
      if (old) { b.textContent = _t('Stop it'); b.onclick = ev => { ev.preventDefault(); X.stopSheet(old); }; } });
  }
  function bind(el) {
    el.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { if (!b.disabled) go(b.dataset.step); });
    if ($('bf-go') && $('bf-go').tagName === 'BUTTON') $('bf-go').onclick = next;
    // Customize's Done while a setting cannot work: a press on it (or Enter in a field) takes the focus to the first
    // field marked in red (audit BOT-08); a disabled button still passes its pointer events to its parent
    if (F.step === 'custom' && $('bf-go')) {
      const fw = $('bf-go').parentElement;
      if (fw) fw.addEventListener('pointerup', e => { const g = $('bf-go'); if (g && g.disabled && (e.target === g || g.contains(e.target))) focusBad(); });
      el.querySelectorAll('input[data-bk]').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && hardWhy()) { e.preventDefault(); focusBad(); } }));
    }
    if ($('bf-back')) $('bf-back').onclick = back;
    if ($('bf-expert')) $('bf-expert').onclick = expert;
    if ($('bf-cz')) $('bf-cz').onclick = () => go('custom');
    if ($('bf-all')) $('bf-all').onclick = () => { F.all = !F.all; render(); };
    if ($('bf-coin')) $('bf-coin').onclick = coinSheet;
    if ($('bf-reset')) $('bf-reset').onclick = () => { X.applyPreset(F.plan || 'balanced'); render(); X.schedule(true); };
    if ($('bf-editin')) $('bf-editin').onclick = () => connectPanel();
    if ($('bf-stopold')) $('bf-stopold').onclick = () => { const b = X.bots().find(x => x.id === F.edit); if (b) X.stopSheet(b); };
    el.querySelectorAll('[data-fkind]').forEach(b => b.onclick = () => { const k = b.dataset.fkind; if (k === curKind()) return;
      F.fromErr = null; X.onSeg('__kind', k); F.pbt = {}; if (isPlanned(k)) { F.plan = B.preset[k] || 'balanced'; loadCandles(); } render(); });
    el.querySelectorAll('[data-fplan]').forEach(b => b.onclick = () => { X.applyPreset(b.dataset.fplan); F.plan = b.dataset.fplan; render(); X.schedule(); planBts(); });
    el.querySelectorAll('[data-fpurp]').forEach(b => b.onclick = () => { const s = X.shape(); if (X.tsHolds(s) === (b.dataset.fpurp === 'attach')) return;
      s.entry = b.dataset.fpurp; B.bt = null; B.chk = null; F.pbt = {}; render(); X.schedule(true); });
    // a phone's plan screen: Enter on the plan picked continues, as Enter in the amount field did (Space still picks)
    if (phone() && F.step === 'amount' && F.sub === 1) el.querySelectorAll('[data-fplan]').forEach(b => b.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return; e.preventDefault();
      if (B.preset[B.kind] !== b.dataset.fplan) b.click();
      const g = $('bf-go'); if (g && !g.disabled) g.click(); }));
    if (isPlanned(curKind()) && !B.priv && F.step !== 'choose') X.bindPane(el);
    if (B.priv && $('tb-mm')) $('tb-mm').onclick = X.privMode;          // a private copy's margin mode (bindPane is not run)
    // a switch that shows or hides other settings: drawn again (the value itself went in through bindPane)
    el.querySelectorAll('.bf-sw input[data-bk]').forEach(i => i.addEventListener('change', () => { render(); X.schedule(); }));
    el.querySelectorAll('[data-inv]').forEach(i => i.addEventListener('input', () => planBts()));
    el.querySelectorAll('[data-bk="coin_b"]').forEach(i => i.addEventListener('change', () => { render(); X.schedule(); }));
    if ($('bf-max')) $('bf-max').onclick = () => { const a = X.avail(); if (a > 0) { X.setTotal(a); planBts(); } else { F.maxHint = true; paint(); } };
    // Enter in the amount field: the step's primary, as a click on it (never while it is off)
    el.querySelectorAll('#bf-amt').forEach(i => i.addEventListener('keydown', e => { if (e.key !== 'Enter' || e.isComposing) return;
      const g = $('bf-go'); e.preventDefault(); if (g && !g.disabled) g.click(); }));
    // a private copy: the amount and the copier's limits (terminal-bots.js privCheck)
    el.querySelectorAll('[data-pk]').forEach(i => i.addEventListener('input', () => { const v = +i.value.replace(',', '.');
      B.privIn[i.dataset.pk] = i.value.trim() && isFinite(v) && v > 0 ? v : null; B.bt = null; X.schedule(); paint(); }));
    if ($('bf-pmax')) $('bf-pmax').onclick = () => { const a = X.avail(); if (a > 0) { B.privIn.amount = Math.floor(a * 100) / 100; B.bt = null; F.last = ''; render(); X.schedule(true); } };
    // the backtest period: one listener on the root, since paint() redraws the card's buttons without binding them again
    if (!el.dataset.bbtOn) { el.dataset.bbtOn = '1'; el.addEventListener('click', e => { const b = e.target.closest('[data-bbt]'); if (!b || !el.contains(b)) return;
      const n = +b.dataset.bbt; if (n === B.btDays) return; B.btDays = n; X.runBacktest(); render(); });
      el.addEventListener('click', e => { const b = e.target.closest('[data-ctab]'); if (!b || !el.contains(b)) return;
        X.setChartTab(b.dataset.ctab); F.cv = {n: 0, off: 0}; paint(); const ch = document.getElementById('bf-ch'); if (ch) { ch.dataset.k = ''; chartDraw(ch); } });
      el.addEventListener('click', e => { const b = e.target.closest('[data-ctf]'); if (!b || !el.contains(b) || b.dataset.ctf === F.ctf) return;
        F.ctf = b.dataset.ctf; F.cv = {n: 0, off: 0}; try { localStorage.setItem('rv_bf_tf', F.ctf); } catch (x) {}
        el.querySelectorAll('[data-ctf]').forEach(c => c.classList.toggle('on', c.dataset.ctf === F.ctf)); const ch = document.getElementById('bf-ch'); if (ch) { ch.dataset.k = ''; chartDraw(ch); } }); }
    // Customize's section tabs: the settings column scrolls to the section (the page itself where the column does not
    // scroll: a short window, a phone); the tab of the section in view is marked as the column scrolls
    el.querySelectorAll('[data-gnav]').forEach(a => a.onclick = e => { e.preventDefault(); const g = document.getElementById('bf-g-' + a.dataset.gnav), s = $('bf-czs'); if (!g) return;
      F.navTo = a.dataset.gnav; setTimeout(() => { F.navTo = null; spy(); }, 700); spy();
      if (s && s.scrollHeight > s.clientHeight + 1 && getComputedStyle(s).overflowY !== 'visible') s.scrollTo({top: g.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 12, behavior: 'smooth'});
      else g.scrollIntoView({behavior: 'smooth', block: 'start'}); });
    if ($('bf-czs')) { $('bf-czs').addEventListener('scroll', spy, {passive: true}); spy(); }
  }
  /* the tab of the section at the top of the settings (the last one whose top has passed the tabs' bottom edge) */
  function spy() {
    const nav = document.querySelector('#bf .bf-czf .bf-nav'); if (!nav) return;
    const tabs = [...nav.querySelectorAll('[data-gnav]')], line = nav.getBoundingClientRect().bottom + 24;
    let on = F.navTo || (tabs[0] && tabs[0].dataset.gnav);
    if (!F.navTo) for (const a of tabs) { const g = document.getElementById('bf-g-' + a.dataset.gnav); if (g && g.getBoundingClientRect().top <= line) on = a.dataset.gnav; }
    const s = $('bf-czs');      // scrolled to its end: the last section, however short
    if (!F.navTo && s && s.scrollHeight > s.clientHeight + 1 && s.scrollTop + s.clientHeight >= s.scrollHeight - 2 && tabs.length) on = tabs[tabs.length - 1].dataset.gnav;
    tabs.forEach(a => { const y = a.dataset.gnav === on; a.classList.toggle('on', y); if (y) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
  }
  addEventListener('scroll', () => { if (F.step === 'custom') spy(); }, {passive: true});
  /* waiting for what the setup starts from (an edit's bot, a shared setup) before the first real screen */
  function pending() {
    const p = F.pend; if (!p) return true;
    if (p === 'edit') {
      if (!S.me && !S.signedOut) return false;
      const b = X.bots().find(x => x.id === F.edit);
      F.pend = null;
      if (S.signedOut) F.editOut = F.edit;
      if (!b || (b.config && b.config.private)) { F.edit = null; F.step = 'choose'; return true; }
      if (b.coin !== S.coin || b.venue !== S.venue) select(b.coin, b.venue);
      B.view = null; B.kind = b.kind; X.useConfig(b.kind, b.config); B.total[b.kind] = Math.round((b.budget_usd || 0) * 100) / 100 || B.total[b.kind];
      F.plan = null; F.step = 'custom'; F.ret = 'review'; X.syncUrl(); X.schedule(true);
      return true;
    }
    if (p === 'from') {
      const back = (B.priv || B.shared) && F.back && F.back.kind === B.kind ? F.back : null;
      if (B.priv || B.shared) F.back = null;
      if (B.priv) { F.pend = null; F.step = back && back.step === 'review' ? 'review' : 'amount';
        if (back && back.privIn) Object.assign(B.privIn, back.privIn);
        X.syncUrl(); X.schedule(true); return true; }
      if (B.shared) { F.pend = null; F.plan = null; F.ret = 'review';
        if (back) { if (back.shape) B.shape[B.kind] = back.shape; if (back.total != null) B.total[B.kind] = back.total; }
        F.step = back && ['review', 'amount', 'custom'].includes(back.step) ? back.step : 'custom';
        X.syncUrl(); X.schedule(true); return true; }
      // still on its way (a slow server): the page keeps its skeleton; after a real failure, or 30 s, it says so above
      // the choice of a bot (never a plain preset bot without a word: audit bots-ui-17)
      if (B.sharedLoading && Date.now() - F.at < 30000) return false;
      F.pend = null; F.back = null; F.step = 'choose'; F.fromErr = B.sharedErr || ' '; return true;
    }
    return true;
  }

  /* ---------------- start ---------------- */
  function init() {
    const q = FP.prefill(location.search, KINDS());
    F.at = Date.now();
    // the market the link asked for (radar/app.py sends a market Hyperliquid does not list on as nocoin=, showing BTC)
    const asked = new URLSearchParams(location.search).get('nocoin');
    F.qcoin = asked && /^[A-Za-z0-9:]{1,24}$/.test(asked) ? asked : q.coin || null;
    const kept = restore(q);
    if (kept && F.back && F.back.from && !q.from) X.loadShared(F.back.from);      // a copy kept without its link: load it
    if (!kept) {
      if (q.kind) { if (q.kind === 'signal') B.view = 'signal'; else { B.view = null; B.kind = q.kind; } }
      if (q.amount && isPlanned(B.kind)) B.total[B.kind] = q.amount;
      if (q.step === 'review' && isPlanned(curKind())) { if (!q.cfg) X.applyPreset('balanced'); F.step = 'review'; }
      else if (q.step === 'amount') F.step = 'amount';
      else if (q.step === 'custom') { F.step = 'custom'; F.plan = null; F.ret = 'review'; }
      if (q.edit) { F.edit = q.edit; F.pend = 'edit'; }
      if (q.step === 'from') F.pend = 'from';
    }
    nameTab();
    noteFrom();
    if (!history.__bf) {
      const rs = history.replaceState.bind(history);
      history.replaceState = (st, t, u) => rs(st == null && history.state && history.state.bf ? history.state : st, t, u);
      history.__bf = true;
    }
    addEventListener('popstate', onPop);
    try { const h = history.state && history.state.bf;
      history.replaceState({bf: {step: F.step, sub: F.sub, i: h ? h.i : 0}}, '', location.href); } catch (e) {}
    addEventListener('pagehide', () => { if (!B.creating) keep(false); });
    F.demo = !!q.try;
    if (F.demo) ev('demo_start');
    if (!isPlanned(curKind()) && !['choose', 'alerts'].includes(F.step)) F.step = 'choose';
    if (B.preset[B.kind]) F.plan = F.plan === null ? null : B.preset[B.kind];
    B.panel = 'bot';
    loadCandles();
    render();
    if (F.step === 'review' || F.step === 'custom') X.schedule(true);
    addEventListener('resize', () => { const n = subs(F.step); if (F.sub >= n) F.sub = n - 1; F.last = ''; render(); });
    try { const top = document.getElementById('rvn'); if (top) new ResizeObserver(fit).observe(top); } catch (e) {}
    setInterval(() => { if (F.step === 'choose' || F.pend) render(); }, 2000);
    setInterval(() => { const ch = document.getElementById('bf-ch'); if (ch && !document.hidden) chartDraw(ch); }, 1000);
    setInterval(() => { if (document.getElementById('bf-ch') && !document.hidden) loadChart(F.ctf, true); }, 15000);
  }
  window.BotFlow = {render, paint, chart: () => KC.ch, keep: () => keep(true), done: () => { try { sessionStorage.removeItem(KEEP); } catch (e) {} }, go, state: F, hard: () => !!hardWhy()};
  init();
})();

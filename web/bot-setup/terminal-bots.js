/* Rivemont Terminal: bots inside the Terminal (exchange-style create forms). The order panel's Bot tab: DCA / Grid /
   Indicator and the other types, each built the usual exchange way: the TOTAL investment first (a % slider
   of what is free for bots, MAX), then the preset and the direction; every other number (base order, extra orders, grid
   count, first order) is derived from the total and the preset and sits under a collapsed Advanced. Advanced edits keep
   the total and recompute the rest. The chart lines, the key numbers and "what this bot will do" are computed here from
   the total, instantly on every input; the server check (/api/auto/bots/check, bots.validate) follows 150 ms later for
   the warnings, the liquidation estimate and the final word. Every reason the Create button is off is on screen, one
   line each, directly above it, with the fix (a number to set, or a page to open). The server stays authoritative:
   /api/auto/bots/create enforces every rule (one bot per coin and exchange, the money limits). Also the Bots tab of the
   bottom panel (every bot, and the Funding Arbitrage bots still running from before 2026-10-06), the bot lines on the chart
   (preview: dashed and draggable; running bots: solid) and the phone layout. Loaded after terminal.html's own script, so
   it uses its state and helpers (S, api, openSheet, chart ...). BotPlan (below) is pure and tested with node
   (tests/js/bot-plan.test.mjs). */

/* ---------------- BotPlan: every setting of a bot from its total investment and its preset ----------------
   total: the investment in USDC, i.e. the margin the bot may tie up (the server's budget: largest position / leverage).
   shape: the preset's settings (terminal-core.js BOT_PRESETS) plus what the customer changed under Advanced; auto: the
   number of orders (DCA extra orders, grid lines, split parts, entry orders) may come down so that the smallest order
   still meets the exchange's minimum, until the customer sets it by hand. */
(function (root) {
  const pow = (m, n) => { let s = 0; for (let k = 0; k <= n; k++) s += Math.pow(m, k); return s; };
  const minW = (m, n) => { let w = Infinity; for (let k = 0; k <= n; k++) w = Math.min(w, Math.pow(m, k)); return w; };
  const down2 = x => Math.floor(x * 100 + 1e-7) / 100;               // amounts rounded down: never above the total
  const up2 = x => Math.ceil(x * 100 - 1e-7) / 100;
  const nice = v => { if (!(v > 0)) return v; const d = Math.pow(10, Math.floor(Math.log10(v)) - 3); return +(Math.round(v / d) * d).toPrecision(12); };
  const clone = o => JSON.parse(JSON.stringify(o));
  /* the most orders of each count the server takes (radar/auto/bot_limits.py LIMITS, tests/test_bot_limits.py keeps the
     two equal): every count is clamped to it before a plan is built, so a count typed as 1e12 cannot run the loops below
     a trillion times (round-2 QA 2026-10-07: the tab froze); Customize says the field is past its limit (bot-flow.js
     fieldErrs) */
  const CAPS = {dca: {so_count: 50}, indicator: {'entry.parts': 50, 'entry.so_count': 50}, grid: {grids: 200}, rgrid: {grids: 200},
    infinity: {grids: 200}, martingale: {max_adds: 20}, scaleout: {levels: 20}, scalp: {levels: 50}, volgrid: {grids: 200},
    sessgrid: {grids: 100}, twap: {slices: 500}, recurring: {times: 1000}, ladder: {count: 50}, pair: {levels: 5}};
  /* a count as the plan uses it: a whole number from lo to the type's cap (NaN or empty: lo; 1e12 or Infinity: the cap) */
  const cnt = (kind, path, v, lo) => { const x = Math.round(+v); return Math.min(Math.max(lo, isFinite(x) ? x : x > 0 ? Infinity : lo), (CAPS[kind] || {})[path] || 200); };
  /* the ladder of a DCA / entry: order k sits k steps from the first price (below for a long), mult^k times the first */
  function ladder(side, first, n, step, mult, px) {
    const s = side === 'long' ? -1 : 1, out = [];
    for (let k = 0; k <= n; k++) out.push({k, px: px ? px * (1 + s * step / 100 * k) : null, usd: first * Math.pow(mult, k)});
    return out;
  }
  /* a DCA round (radar/auto/bots.py dca_ladder): safety order k sits step x (1 + scale + ... + scale^(k-1)) from the
     first price and is mult^k times the base order */
  function dcaLadder(side, first, n, step, scale, mult, px) {
    const s = side === 'long' ? -1 : 1, out = [{k: 0, px: px || null, usd: first}];
    let dev = 0;
    for (let k = 1; k <= n; k++) { dev += step * Math.pow(scale, k - 1); out.push({k, px: px ? px * (1 + s * dev / 100) : null, usd: first * Math.pow(mult, k)}); }
    return out;
  }
  /* -> {cfg (the settings the server takes, without coin / venue), minTotal (the smallest total that meets the minimum
     order with these settings), orders ([{px, usd}] for the chart), per (grid: an order's size), n (orders counted)} */
  function derive(kind, shape, total, ctx) {
    const px = (ctx && ctx.px) || null, mo = (ctx && ctx.minOrder) || 10, sh = clone(shape || {});
    const lev = Math.max(1, Math.round(+sh.leverage || 1)), T = Math.max(0, +total || 0), P = T * lev;
    if (MORE.includes(kind)) return deriveMore(kind, sh, P, lev, px, mo);
    if (kind === 'dca') {
      const m = +sh.so_mult > 0 ? +sh.so_mult : 1;
      let n = cnt('dca', 'so_count', sh.so_count, 0);
      if (sh.auto && P > 0) while (n > 0 && P * minW(m, n) / pow(m, n) < mo) n--;
      const base = P ? down2(P / pow(m, n)) : 0, nMin = sh.auto ? 0 : n;
      const sc = +sh.step_scale > 0 ? +sh.step_scale : 1;
      const cfg = {side: sh.side || 'long', base_usd: base, so_count: n, so_step_pct: +sh.so_step_pct || 0, so_mult: m, tp_pct: sh.tp_pct,
                   sl_pct: sh.sl_pct || null, leverage: lev, repeat: sh.repeat !== false, start: sh.start || null,
                   ...pick(sh, DCA_MORE)};
      if (sc !== 1) cfg.step_scale = sc;
      if (!cfg.sl_pct) delete cfg.sl_base;
      if (cfg.max_active >= n) delete cfg.max_active;           // at or above the extra orders: no cap
      return {cfg, minTotal: up2(mo * pow(m, nMin) / minW(m, nMin) / lev), n, orders: dcaLadder(cfg.side, base, n, cfg.so_step_pct, sc, m, px)};
    }
    if (GRIDS.includes(kind)) {
      let lower = +sh.lower || null, upper = +sh.upper || null;
      if ((!lower || !upper) && px && sh.range) { lower = nice(px * (1 - sh.range)); upper = nice(px * (1 + sh.range)); }
      // the grid's step and its count are linked (Bitsgap): the one typed last stays, the other follows from the range
      if (sh.grid_by === 'step' && +sh.step_pct > 0 && lower && upper) sh.grids = gridsOf(lower, upper, +sh.step_pct, sh.spacing);
      let g = cnt(kind, 'grids', sh.grids, 2);
      const ref = lower && upper && px ? Math.min(Math.max(px, lower), upper) : (lower || 1), f = lower && ref ? lower / ref : 1;
      if (sh.auto && P > 0) while (g > 2 && P / g * f < mo) g--;
      if (sh.auto && g > 2 && g % 2) g--;
      const cfg = {mode: kind === 'rgrid' ? 'short' : sh.mode || 'neutral', lower, upper, grids: g, total_usd: down2(P), leverage: lev, stop_outside: sh.stop_outside !== false,
                   ...pick(sh, ['spacing', 'trigger_px', 'tp_px', 'sl_px', 'tp_pct', 'sl_pct', 'trail_up_limit', 'trail_down_limit', 'max_active', 'stop_action'])};
      if (cfg.max_active >= g) delete cfg.max_active;
      if (cfg.stop_action !== 'keep') delete cfg.stop_action;
      if (kind === 'infinity') { cfg.trail_up = sh.trail_up !== false; cfg.trail_down = !!sh.trail_down; }
      if (cfg.spacing !== 'geometric') delete cfg.spacing;
      return {cfg, minTotal: up2(mo * (sh.auto ? 2 : g) / f / lev), n: g, per: P / g, orders: []};
    }
    const e = clone(sh.side === 'neutral' ? {mode: 'all'} : sh.entry || {mode: 'all'});
    let size = P, minT = mo / lev, n = 0, orders;
    if (e.mode === 'split') {
      let parts = cnt('indicator', 'entry.parts', e.parts, 2);
      if (sh.auto && P > 0) while (parts > 2 && P / parts < mo) parts--;
      e.parts = parts; n = parts - 1; minT = mo * (sh.auto ? 2 : parts) / lev;
      orders = ladder(sh.side || 'long', P / parts, e.by === 'price' ? parts - 1 : 0, e.step_pct || 0, 1, px);
    } else if (e.mode === 'dca' || e.mode === 'martingale') {
      const m = +e.so_mult > 0 ? +e.so_mult : 1;
      let k = cnt('indicator', 'entry.so_count', e.so_count, 1);
      if (sh.auto && P > 0) while (k > 1 && P * minW(m, k) / pow(m, k) < mo) k--;
      e.so_count = k; n = k; size = P ? down2(P / pow(m, k)) : 0;
      if (e.mode === 'martingale') e.max_total_usd = down2(P);
      minT = mo * pow(m, sh.auto ? 1 : k) / minW(m, sh.auto ? 1 : k) / lev;
      orders = ladder(sh.side || 'long', size, k, e.so_step_pct || 0, m, px);
    } else orders = ladder(sh.side || 'long', P, 0, 0, 1, px);
    const cfg = {side: sh.side || 'long', timeframe: sh.timeframe || '1h', conditions: sh.conditions || [], size_usd: down2(size), entry: e,
                 tp_pct: sh.tp_pct, sl_pct: sh.sl_pct, leverage: lev, exit_opposite: !!sh.exit_opposite, ...pick(sh, ['trail_pct', 'order_type', 'exit_logic', 'exit'])};
    if (sh.logic === 'or') cfg.logic = 'or';
    if (cfg.side === 'neutral') { delete cfg.exit_opposite; if (!(cfg.conditions || []).some(c => c.ind === 'bb')) delete cfg.exit; }
    return {cfg, minTotal: up2(minT), n, orders};
  }
  /* the types built from the schema (radar/auto/bot_kinds.py and friends): the total sets every amount; counts come
     down for a small total while `auto` holds (as for DCA and grid). -> the same {cfg, minTotal, n, orders} as derive */
  const GRIDS = ['grid', 'rgrid', 'infinity'];
  const MORE = ['martingale', 'recurring', 'rebalance', 'breakout', 'meanrev', 'pair', 'trailstop', 'scalp', 'sar', 'ladder', 'funding', 'chase', 'scaleout', 'custom',
    'volgrid', 'sessgrid', 'twap', 'liqguard', 'fundflip'];
  /* the grids that lay their own range around the price from the market (radar/auto/bot_adaptive.py): the server's check
     draws their lines (its preview), as the ATR or the session decides them */
  const ADAPT = ['volgrid', 'sessgrid'];
  const ADAPT_KEYS = {volgrid: ['mode', 'timeframe', 'atr_period', 'step_atr', 'spike_pause', 'spike_mult', 'tp_pct', 'sl_pct', 'max_active'],
    sessgrid: ['mode', 'step_open_pct', 'off_hours', 'step_off_pct', 'weekend_flat', 'flat_min', 'gap_guard', 'gap_wait_min', 'gap_pct', 'tp_pct', 'sl_pct', 'max_active']};
  /* the types that follow a position you hold (bots.attaches): no amount, the side is the position's. A trailing stop
     protects a position you hold unless it was told to open one (Protect is the default purpose; the
     server reads a missing entry the same way, bot_kinds._v_trailstop) */
  const tsHolds = s => (s || {}).entry !== 'new';
  const holds = (kind, s) => kind === 'scaleout' || kind === 'liqguard' || (kind === 'trailstop' && tsHolds(s)) || (kind === 'twap' && s.mode === 'unwind');
  const EXITS = ['tp_pct', 'sl_pct', 'trail_pct'];
  const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] != null && o[k] !== '') r[k] = o[k]; return r; };
  /* the value the server gives a setting left empty (radar/auto/bot_kinds.py, bot_twap.py, bot_guard.py: the _num
     defaults; tests/test_bot_audit1007.py keeps the two equal). The plan sends it, Customize fills it in when the setting
     appears (a trail switched to ATR, a chase) and shows it as the empty field's placeholder, so the form, the chart, the
     review and the engine read one number (audit BOT-02: ATR fields empty and a 5m chart, the review "3 x ATR(14, 1h)";
     BOT-15: Max chase empty, the review 1%) */
  const DEFAULTS = {trailstop: {trail_pct: 2, timeframe: '1h', atr_period: 14, atr_mult: 3}, chase: {callback_pct: 1, max_chase_pct: 1},
    twap: {close_pct: 100}, liqguard: {reduce_pct: 25}};
  const withDef = (kind, keys, o) => { const d = DEFAULTS[kind] || {}; for (const k of keys) if ((o[k] == null || o[k] === '') && d[k] != null) o[k] = d[k]; return o; };
  /* the DCA bot's finer controls (radar/auto/bots.py _dca_more), sent when set */
  /* stop-loss losses in a row before a DCA bot stops (radar/auto/bots.py DCA_MAX_LOSSES): 3 when left empty; a saved
     bot without the setting is from before 2026-10-03 and keeps 1 */
  const DCA_MAX_LOSSES = 3, DCA_MAX_LOSSES_OLD = 1;
  const DCA_MORE = ['tp_trail_pct', 'cooldown_min', 'start_px', 'max_active', 'tp_base', 'sl_base', 'be_pct', 'max_losses', 'max_rounds'];
  /* a grid's step in % between two lines (arithmetic: the gap over the lowest line, geometric: the ratio) and back */
  function stepOf(lower, upper, grids, spacing) {
    if (!(lower > 0) || !(upper > lower) || !(grids >= 1)) return null;
    return spacing === 'geometric' ? (Math.pow(upper / lower, 1 / grids) - 1) * 100 : (upper - lower) / grids / lower * 100;
  }
  function gridsOf(lower, upper, step, spacing) {
    const n = spacing === 'geometric' ? Math.log(upper / lower) / Math.log(1 + step / 100) : (upper - lower) / (lower * step / 100);
    return Math.max(2, Math.min(200, Math.round(n)));
  }
  function deriveMore(kind, sh, P, lev, px, mo) {
    const at = (x, usd) => ({px: x, usd});
    const side = sh.side || 'long', sgn = side === 'long' ? -1 : 1, ex = pick(sh, EXITS);
    let cfg, orders = [], n = 0, unit = 1;                 // unit: the smallest order's share of the position
    if (kind === 'chase') {
      cfg = {side, size_usd: down2(P), leverage: lev, ...ex, ...pick(sh, ['mode', 'activation_px', 'callback_pct', 'max_chase_pct', 'repeat'])};
      withDef('chase', [cfg.mode === 'chase' ? 'max_chase_pct' : 'callback_pct'], cfg);
      orders = [at(px, P)];
      if (cfg.mode !== 'chase' && px) orders = [at((+cfg.activation_px || px) * (1 - sgn * (+cfg.callback_pct || 0) / 100), P)];
    } else if (kind === 'trailstop') {
      const attach = tsHolds(sh);
      cfg = {side, entry: attach ? 'attach' : 'new', by: sh.by === 'atr' ? 'atr' : 'pct', leverage: attach ? 1 : lev,
             ...withDef('trailstop', sh.by === 'atr' ? ['timeframe', 'atr_period', 'atr_mult'] : ['trail_pct'], pick(sh, sh.by === 'atr' ? ['timeframe', 'atr_period', 'atr_mult'] : ['trail_pct'])),
             ...pick(sh, ['activation_pct', 'sl_pct', 'tp_pct'])};
      if (!attach) cfg.size_usd = down2(P);
      orders = [at(px, attach ? 0 : P)];
      if (attach) return {cfg, minTotal: 0, n: 1, orders, noAmount: true};
    } else if (kind === 'twap') {
      const unwind = sh.mode === 'unwind';
      cfg = {side, mode: unwind ? 'unwind' : 'accumulate', leverage: unwind ? 1 : lev, randomize: sh.randomize !== false,
             ...pick(sh, ['duration_min', 'slices', 'limit_px', 'max_spread_pct']), ...(unwind ? withDef('twap', ['close_pct'], pick(sh, ['close_pct'])) : pick(sh, ['sl_pct']))};
      if (unwind) { if (cfg.slices != null) cfg.slices = cnt('twap', 'slices', cfg.slices, 2); return {cfg, minTotal: 0, n: cfg.slices || 1, orders: [at(px, 0)], noAmount: true}; }
      let k = cnt('twap', 'slices', sh.slices, 2);
      const shrink = cfg.randomize ? 0.8 : 1;
      if (sh.auto && P > 0) while (k > 2 && P / k * shrink < mo) k--;
      cfg.slices = k; cfg.total_usd = down2(P);
      orders = [at(px, P)]; n = k; unit = shrink / (sh.auto ? 2 : k);
    } else if (kind === 'liqguard') {
      cfg = {side, leverage: 1, ...pick(sh, ['action', 'trigger_pct', 'max_day', 'cooldown_min'])};
      if (cfg.action !== 'reduce' && cfg.action !== 'alert') Object.assign(cfg, pick(sh, ['margin_usd', 'max_margin_day_usd']));
      if (cfg.action === 'reduce' || cfg.action === 'margin_reduce' || !cfg.action) Object.assign(cfg, withDef('liqguard', ['reduce_pct'], pick(sh, ['reduce_pct'])));
      return {cfg, minTotal: 0, n: 1, orders: [], noAmount: true};
    } else if (kind === 'scaleout') {
      cfg = {side, leverage: 1, ...pick(sh, ['levels', 'first_pct', 'step_pct', 'sl_pct', 'trail_pct'])};
      const k = cnt('scaleout', 'levels', cfg.levels, 1);
      if (cfg.levels != null) cfg.levels = k;
      orders = px ? Array.from({length: k}, (_, i) => at(px * (1 - sgn * ((+cfg.first_pct || 0) + (+cfg.step_pct || 0) * i) / 100), 0)) : [];
      return {cfg, minTotal: 0, n: k, orders, noAmount: true};
    } else if (kind === 'martingale') {
      const m = +sh.mult > 0 ? +sh.mult : 1;
      let k = cnt('martingale', 'max_adds', sh.max_adds, 1);
      if (sh.auto && P > 0) while (k > 1 && P * minW(m, k) / pow(m, k) < mo) k--;
      const first = P ? down2(P / pow(m, k)) : 0;
      cfg = {side, first_usd: first, max_total_usd: down2(P), max_adds: k, mult: m, leverage: lev, add_on: sh.add_on === 'profit' ? 'profit' : 'loss',
             repeat: sh.repeat !== false, ...pick(sh, ['step_pct']), ...ex};
      const dir = cfg.add_on === 'loss' ? sgn : -sgn;
      orders = ladder('long', first, k, 0, m, px).map((o, i) => at(px ? px * (1 + dir * (+sh.step_pct || 0) / 100 * i) : null, o.usd));
      n = k; unit = minW(m, sh.auto ? 1 : k) / pow(m, sh.auto ? 1 : k);
    } else if (kind === 'scalp') {
      let lv = cnt('scalp', 'levels', sh.levels, 1);
      if (sh.auto && P > 0) while (lv > 1 && P / (2 * lv) < mo * 1.05) lv--;
      cfg = {total_usd: down2(P), levels: lv, leverage: lev, recenter: sh.recenter !== false, ...pick(sh, ['spread_pct', 'sl_pct'])};
      const g = 1 + (+sh.spread_pct || 0) / 100;
      orders = px ? Array.from({length: 2 * lv + 1}, (_, i) => at(px * Math.pow(g, i - lv), P / (2 * lv))) : [];
      n = 2 * lv; unit = 1 / (2 * (sh.auto ? 1 : lv)) / 1.05;
    } else if (ADAPT.includes(kind)) {
      const lo = kind === 'volgrid' ? 4 : 2;
      let g = cnt(kind, 'grids', sh.grids, lo);
      if (sh.auto && P > 0) while (g > lo && P / g < mo * 1.05) g--;
      cfg = {total_usd: down2(P), grids: g, leverage: lev, ...pick(sh, ADAPT_KEYS[kind])};
      if (kind === 'sessgrid' && cfg.off_hours !== 'wide') delete cfg.step_off_pct;
      const q = 1 + (+sh.step_open_pct || 0) / 100;
      if (kind === 'sessgrid' && px) orders = Array.from({length: g + 1}, (_, i) => at(px * Math.pow(q, i - g / 2), P / g));
      n = g; unit = 1 / (sh.auto ? lo : g) / 1.05;
    } else if (kind === 'recurring') {
      let t = cnt('recurring', 'times', sh.times, 1);
      if (sh.auto && P > 0) while (t > 1 && P / t < mo) t--;
      cfg = {...pick(sh, ['side', 'every', 'at_hour', 'weekday']), times: t, usd: P ? down2(P / t) : 0, leverage: lev, ...ex};
      orders = [at(px, P / t)]; n = t; unit = 1 / (sh.auto ? 1 : t);
    } else if (kind === 'ladder') {
      let k = cnt('ladder', 'count', sh.count, 1);
      if (sh.auto && P > 0) while (k > 1 && P / k < mo) k--;
      cfg = {...pick(sh, ['side', 'timeframe', 'lookback', 'offset_pct', 'step_pct', 'refresh']), count: k, usd: P ? down2(P / k) : 0, leverage: lev, ...ex};
      orders = px ? Array.from({length: k}, (_, i) => at(px * (1 + sgn * ((+sh.offset_pct || 0) + (+sh.step_pct || 0) * i) / 100), P / k)) : [];
      n = k; unit = 1 / (sh.auto ? 1 : k);
    } else if (kind === 'breakout' || kind === 'meanrev' || kind === 'sar' || kind === 'funding' || kind === 'fundflip') {
      const keys = {breakout: ['side', 'timeframe', 'lookback', 'confirm', 'buffer_pct', 'retest_pct', 'expire'], meanrev: ['side', 'timeframe', 'period', 'std', 'exit'],
                    sar: ['timeframe', 'signal', 'period', 'mult', 'fast', 'slow', 'ma', 'signal_len'], funding: ['side', 'min_rate', 'exit_rate'], fundflip: ['side', 'min_rate', 'hours', 'exit_rate']}[kind];
      cfg = {...pick(sh, keys), usd: down2(P), leverage: lev, ...ex};
      orders = [at(px, P)];
    } else if (kind === 'pair') {
      cfg = {coin_b: coinKey(sh.coin_b), size_usd: down2(P / 2), leverage: lev, repeat: sh.repeat !== false,
             ...pick(sh, ['venue_b', 'hedge', 'beta', 'mode', 'timeframe', 'window', 'entry_z', 'exit_z', 'levels', 'level_step_z', 'level_weights', 'max_half_life', 'stop_z', 'sl_pct', 'max_loss_usd', 'tp_pct', 'max_hold_h'])};
      unit = 1 / 2; n = 2;
    } else if (kind === 'rebalance') {
      const coins = (sh.coins || []).filter(x => x && x.coin);
      cfg = {side: sh.side || 'long', coins: coins.map(x => ({coin: coinKey(x.coin), weight: +x.weight || 0})), total_usd: down2(P), leverage: lev,
             ...pick(sh, ['mode', 'drift_pct', 'every_h', 'order_type', 'tp_pct', 'sl_pct'])};
      const w = coins.length ? Math.min(...coins.map(x => +x.weight || 0)) : 0;
      unit = w > 0 ? w / 100 : 1; n = coins.length;
    } else {                                               // custom rules: each action's share of the largest position
      const rules = clone(sh.rules || []);
      const pcts = [];
      for (const r of rules) for (const a of r.then || []) if (a.pct != null && a.do !== 'close') { a.usd = P ? down2(P * (+a.pct || 0) / 100) : 0; pcts.push(+a.pct || 0); }
      cfg = {timeframe: sh.timeframe || '1h', rules: rules.map(r => ({...r, then: (r.then || []).map(a => { const b = {...a}; if (b.do !== 'close') delete b.pct; return b; })})),
             max_position_usd: down2(P), leverage: lev, ...ex};
      unit = pcts.length ? Math.max(0.0001, Math.min(...pcts)) / 100 : 1; n = rules.length;
      orders = [at(px, P)];
    }
    return {cfg, minTotal: up2(mo / unit / lev), n, orders};
  }
  /* a full config (a backtest pick, a shared setup) -> the shape and the total that give it back exactly */
  function fromConfig(kind, c) {
    const sh = clone(c || {}), lev = Math.max(1, +sh.leverage || 1);
    delete sh.coin; delete sh.venue; delete sh.account; delete sh.account_b; sh.auto = false;
    if (MORE.includes(kind)) {
      const p = sh.preset ? {...sh.preset, ...pick(sh, EXITS), leverage: lev, auto: false} : sh;
      let P = +sh.size_usd || +sh.total_usd || +sh.max_total_usd || 0;
      if (kind === 'pair') { P = 2 * (+sh.size_usd || 0); if (!sh.hedge) sh.hedge = 'equal'; }     // a setup from before the hedge setting: equal amounts
      if (kind === 'martingale' && +sh.first_usd > 0) {    /* the first order and the adds that fit under the cap (what the
        server places), so the copy sends the same first order: from the cap alone it came back $32.25 for $32 */
        const m = +sh.mult > 0 ? +sh.mult : 1, cap = +sh.max_total_usd || Infinity;
        let n = 0; const most = cnt('martingale', 'max_adds', sh.max_adds, 0); while (n < most && sh.first_usd * pow(m, n + 1) <= cap + 1e-9) n++;
        sh.max_adds = Math.max(1, n); P = sh.first_usd * pow(m, sh.max_adds);
      }
      if (sh.preset) P = kind === 'recurring' ? (+p.usd || 0) * (+p.times || 1) : kind === 'ladder' ? (+p.usd || 0) * (+p.count || 1) : +p.usd || 0;
      if (kind === 'custom') {
        P = +sh.max_position_usd || 0;
        for (const r of p.rules || []) for (const a of r.then || []) if (a.usd != null && a.do !== 'close') { a.pct = P ? Math.round(a.usd / P * 10000) / 100 : 0; delete a.usd; }
      }
      delete p.preset; delete p.min_usd;
      return {shape: p, total: Math.round(P / lev * 100) / 100};
    }
    let P = 0;
    if (kind === 'dca') {
      P = (+sh.base_usd || 0) * pow(+sh.so_mult || 1, +sh.so_count || 0);
      if (sh.max_losses == null) sh.max_losses = DCA_MAX_LOSSES_OLD;  // saved before the default became 3: its rule was 1
    }
    else if (GRIDS.includes(kind)) P = +sh.total_usd || 0;
    else { const e = sh.entry || {mode: 'all'}; P = e.mode === 'dca' || e.mode === 'martingale' ? (+sh.size_usd || 0) * pow(+e.so_mult || 1, +e.so_count || 1) : +sh.size_usd || 0; }
    return {shape: sh, total: Math.round(P / lev * 100) / 100};
  }
  /* a preset (terminal-core.js BOT_PRESETS entry) as a shape: its counts may come down for a small total */
  function shapeOf(kind, preset) { const s = clone(preset); if (GRIDS.includes(kind)) { s.range = s.range || .08; delete s.total_usd; delete s.lower; delete s.upper; } s.auto = true; return s; }
  /* the tabs that build a bot from a plan: the Signal bot tab hands over to its own screen and has no preset or plan (a
     repaint asking one for it threw: QA 2026-10-03). Funding Arbitrage, which needed two exchanges, left on 2026-10-06:
     its running bots keep their rows (and Stop) in the Bots tab below */
  const planned = kind => !!kind && kind !== 'signal';
  /* does the bot have a stop of any kind (the risk line's "Loss at stop loss": a figure, "Not estimated" when the server
     has none for it, "No stop loss" only when there truly is none)? A loss limit, a stop price, a trailing stop, the
     Market Neutral bot's z or dollar stop, a trailing-stop bot itself, a grid that stops outside its range, a neutral
     grid whose take-profit price above closes its short side (a short grid's take profit is below: a profit, never a
     stop; its stop is sl_px), a grid that moves its range (it closes what it holds, the loss taken). As bots.has_stop */
  function hasStop(kind, c) {
    if (!c) return false;
    if (c.sl_pct || c.sl_px || c.trail_pct || c.max_loss_usd || c.stop_z || c.guard || kind === 'trailstop') return true;
    if (GRIDS.includes(kind)) {
      // a range move counts only on a side the grid trades (bots.grid_exits): a long grid's move up sells at a profit
      const mode = kind === 'rgrid' ? 'short' : c.mode || 'neutral';
      return !!(c.stop_outside || (mode !== 'short' && c.trail_down) || (mode !== 'long' && c.trail_up) || (c.tp_px && mode === 'neutral'));
    }
    return false;
  }
  /* a grid whose only exit on a losing side is moving its range (an Infinity grid with no stop of its own): it has no
     stop loss; what it loses when the range moves is said under that name, never as a stop loss (audit H02).
     As bots.range_only */
  const rangeOnly = (kind, c) => GRIDS.includes(kind) && hasStop(kind, c) && !hasStop(kind, {...c, trail_up: false, trail_down: false});
  /* the most a bot may use (bots.MAX_USD) and what an amount field's text says: null (a usable amount or nothing typed),
     'zero' (0, negative or not a number) or 'max' (above MAX_USD) (audit M01) */
  const MAX_USD = 10000000;
  function amountError(raw) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) return null;
    const v = +t.replace(',', '.');
    return !isFinite(v) || !(v > 0) ? 'zero' : v > MAX_USD ? 'max' : null;
  }
  /* a backtest in which nothing filled: why, never a bare $0.00 · 0% (audit N01; the /s/ setup page's bt_caption):
     its start price never reached ('start', backtest.simulate idle_start_px), a grid that never filled ('out'), another
     bot whose entry never triggered ('never'). null when it traded, even if it ended flat. */
  function btIdle(s) {
    if (!s || s.trades || s.fills || s.cycles) return null;
    if (s.idle_start_px) return {why: 'start', px: s.idle_start_px};
    return {why: s.cycles != null ? 'out' : 'never'};
  }
  /* ---- the rebalancing bot's basket (radar/auto/bot_rebalance.py coins_of: 2 to MAX_COINS coins, each once, weights
     above 0 that add up to 100) ---- */
  const BASKET = {min: 2, max: 10};
  /* a coin as the server names it (bots.coin_name): "xyz:TSLA" for a builder-dex market, BTC otherwise */
  const coinKey = c => { const t = String(c == null ? '' : c).trim(), i = t.indexOf(':'); return !t ? '' : i > 0 ? t.slice(0, i).toLowerCase() + ':' + t.slice(i + 1).toUpperCase() : t.toUpperCase(); };
  /* n weights that add up to exactly 100 (two decimals; the first rows take the rounding: 33.34 / 33.33 / 33.33) */
  function equalWeights(n) {
    if (!(n > 0)) return [];
    const base = Math.floor(10000 / n) / 100, out = Array(n).fill(base);
    for (let i = 0, left = Math.round((100 - base * n) * 100); left > 0; i++, left--) out[i] = Math.round((out[i] + 0.01) * 100) / 100;
    return out;
  }
  const wsum = list => Math.round((list || []).reduce((a, x) => a + (+x.weight || 0), 0) * 100) / 100;
  /* may `coin` go into row `i` (-1: a new row)? not when another row holds it already */
  const basketHas = (list, coin, i) => (list || []).some((x, j) => j !== i && coinKey(x.coin) === coinKey(coin));
  /* a coin added: it takes what is missing to 100 when something is, else 0% for the user to set; the weights already
     set are never changed (audit BOT-10: adding a coin split everything equally; "Split equally" does that on request).
     Past MAX or a coin already in it: unchanged. */
  function basketAdd(list, coin) {
    const l = (list || []).map(x => ({...x})), c = coinKey(coin);
    if (!c || l.length >= BASKET.max || basketHas(l, c, -1)) return l;
    const rest = Math.round((100 - wsum(l)) * 100) / 100;
    l.push({coin: c, weight: rest > 0 ? rest : 0});
    return l;
  }
  /* a coin removed (never below MIN): equal weights stay equal; set weights are kept and the total says what is missing */
  function basketRemove(list, i) {
    const l = (list || []).map(x => ({...x}));
    if (l.length <= BASKET.min || !(i >= 0 && i < l.length)) return l;
    const even = equalWeights(l.length).every((w, j) => Math.abs(w - (+l[j].weight || 0)) < 0.011) || l.every(x => Math.abs((+x.weight || 0) - (+l[0].weight || 0)) < 0.011);
    l.splice(i, 1);
    if (even) equalWeights(l.length).forEach((w, j) => { l[j].weight = w; });
    return l;
  }
  /* the coins a multi-coin bot's chart switches between: a basket's coins with their weights, a
     pair's two coins; none for a one-coin bot (no tabs). Rows without a coin yet are left out, each coin once */
  function chartCoins(kind, s, coin) {
    const seen = new Set(), out = [];
    const add = (c, w) => { const k = coinKey(c); if (k && !seen.has(k)) { seen.add(k); out.push(w == null ? {coin: k} : {coin: k, weight: w}); } };
    if (kind === 'rebalance') for (const x of (s && s.coins) || []) add(x && x.coin, Math.round((+(x && x.weight) || 0) * 100) / 100);
    else if (kind === 'pair' && s && s.coin_b) { add(coin); add(s.coin_b); }
    return out.length > 1 ? out : [];
  }
  /* the tab shown: the one picked while it is still there (a coin removed: the first) */
  const chartCoinOn = (tabs, cur) => !tabs || !tabs.length ? null : tabs.some(t => t.coin === coinKey(cur)) ? coinKey(cur) : tabs[0].coin;
  /* the types with no backtest: what the page says instead (radar/auto/backtest.run refuses them with the same words) */
  const NO_BT = ['liqguard'];
  const api = {CAPS, cnt, derive, fromConfig, shapeOf, planned, ladder, dcaLadder, pow, down2, up2, MORE, GRIDS, ADAPT, stepOf, gridsOf, DCA_MORE, DCA_MAX_LOSSES, hasStop,
               rangeOnly, MAX_USD, amountError, btIdle, holds, NO_BT, BASKET, coinKey, equalWeights, wsum, basketHas, basketAdd, basketRemove,
               chartCoins, chartCoinOn, DEFAULTS, tsHolds};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BotPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof window !== 'undefined' && typeof S !== 'undefined') (function () {
  const T = () => window.TerminalCore, P = window.BotPlan;
  const LIVE = ['active', 'paused', 'stopping', 'error'];
  const KINDS = window.TerminalCore.BOT_KINDS;           // every type (terminal-core.js BOT_CATALOG)
  /* the Bot Terminal (/bots/terminal: class tm-bot on <html>) is where bots are built and listed; the Terminal is manual
     trading only: there this file keeps only what guards hand trades (claim) and draws nothing */
  const BOTMODE = document.documentElement.classList.contains('tm-bot');
  /* /bots/new (radar/bot_flow.py, class tm-flow): the guided bot setup (radar/web/bot-flow.js draws it, with this file's
     plan, checks, backtest and Start); the Bot Terminal itself (WS, the workspace) keeps the chart, the bots and their
     actions, and opens /bots/new for a new bot or an edit */
  const FLOW = BOTMODE && document.documentElement.classList.contains('tm-flow'), WS = BOTMODE && !FLOW;
  const flowHook = f => { if (FLOW && window.BotFlow) BotFlow[f](); };
  const B = S.bot = {panel: BOTMODE ? 'bot' : 'order', kind: KINDS.includes(pref.get('botkind', '')) ? pref.get('botkind') : 'grid',
    preset: Object.fromEntries(KINDS.map(k => [k, 'balanced'])), shape: {}, total: {}, bad: {}, adv: pref.get('botadv', '') === '1',
    chk: null, bt: null, btBusy: false, btDays: 30, shared: null, flash: null, pick: 0, inds: '', plan: null,
    showBots: pref.get('showbots', '1') === '1', timer: null, raf: 0, seq: 0};

  /* ---------------- styles (the Terminal's 4px scale, its tokens and type sizes) ---------------- */
  const css = document.createElement('style');
  css.textContent = `
  .fsw { display: none; }
  .form .tabs button[data-p] { font-size: var(--fs-m); }
  .seg.lg.n3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } .seg.lg.n4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .seg.lg.kinds { grid-template-columns: repeat(2, minmax(0, 1fr)); height: auto; }   /* the order panel is narrow: two rows, so no bot name is cut */
  .seg.lg.two { grid-template-columns: repeat(2, minmax(0, 1fr)); height: auto; }   /* four long names: two rows, so none is cut */
  .seg.lg.sm { height: 28px; } .seg.lg.sm button { height: 22px; line-height: 22px; font-size: var(--fs-s); padding: 0 4px; }
  .seg.lg button { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .seg.lg:is(.n3, .n4, .n5, .kinds) button { font-size: var(--fs-s); padding: 0 4px; }   /* three or more choices: the 12px data size, so every language fits */
  .tb-g { display: grid; gap: 8px; }
  .dc { display: contents; }
  .btk-pick { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 4px 12px 4px 8px;
             border: 0; border-radius: var(--rv-r-xs); background: var(--rv-sunk); color: var(--rv-text); text-align: left; cursor: pointer; }
  .btk-pick b { font-size: var(--fs-m); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .btk-pick > svg.i:last-child { width: 12px; height: 12px; color: var(--rv-muted); }
  /* the Bot Terminal's type tabs (pickerH): the site's tab look, grey words, the chosen one in text colour over a 2px line */
  .btk-strip { display: flex; align-items: stretch; gap: 20px; height: 44px; box-shadow: inset 0 -1px var(--rv-line); overflow: hidden; white-space: nowrap; }
  .btk-strip button { position: relative; flex: none; height: 100%; padding: 0; border: 0; background: none; color: var(--rv-muted); font: 500 var(--fs-m)/20px var(--rv-font); cursor: pointer; }
  .btk-strip button[hidden] { display: none; }
  .btk-strip button:hover, .btk-strip button.on { color: var(--rv-text); }
  .btk-strip button.on::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: var(--rv-r-xs); background: var(--rv-accent); }
  .btk-strip .more { display: inline-flex; align-items: center; gap: 4px; min-width: 0; } .btk-strip.shr .more { flex: 0 1 auto; }
  .btk-strip .more span { overflow: hidden; text-overflow: ellipsis; }
  .btk-strip .more svg.i { width: 12px; height: 12px; flex: none; color: var(--rv-muted); }
  svg.btk-i { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; color: var(--rv-accent); flex: none; }
  .sheet.btk { width: 720px; }
  .btk-list { display: grid; gap: 12px; } .btk-sec { display: grid; gap: 4px; } .btk-sec[hidden], .btk-it[hidden] { display: none; }
  .btk-list .btk-gh { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); }
  /* the market filter: hairline tabs (the site's tab look: grey words, the chosen one in text colour over a 2px line) */
  .btk-mk { display: flex; gap: 20px; height: 36px; margin: 0 0 12px; border-bottom: 1px solid var(--rv-line); overflow-x: auto; scrollbar-width: none; }
  .btk-mk::-webkit-scrollbar { display: none; }
  .btk-mk button { position: relative; flex: none; height: 100%; padding: 0; border: 0; background: none; color: var(--rv-muted); font: 500 var(--fs-m)/20px var(--rv-font); cursor: pointer; white-space: nowrap; }
  .btk-mk button:hover, .btk-mk button.on { color: var(--rv-text); }
  .btk-mk button.on::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: var(--rv-r-xs); background: var(--rv-accent); }
  .btk-grp { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
  @media (max-width: 860px) { .sheet.btk { width: auto; } .btk-grp { grid-template-columns: minmax(0, 1fr); } }
  .btk-it { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0 12px; align-items: start; width: 100%; padding: 8px; border: 0; border-radius: var(--rv-r-xs);
           background: none; color: var(--rv-text); text-align: left; cursor: pointer; }
  .btk-it:hover { background: var(--rv-panel2); } .btk-it.on { background: var(--rv-accent-soft); }
  .btk-it b { font-size: var(--fs-m); line-height: 20px; font-weight: 500; } .btk-it span { grid-column: 2; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); }
  .btk-it .rk { color: var(--rv-neg); font-weight: 500; }
  .tb-gcap { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); margin: 4px 0 -4px; }
  .seg.lg.n5 { grid-template-columns: repeat(5, minmax(0, 1fr)); } .seg.lg.n7 { grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .fld { display: grid; gap: 4px; } .fld .fl { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); display: flex; align-items: center; gap: 4px; }
  .crow { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) 28px; gap: 4px; align-items: center; } .crow .xb { width: 28px; height: 28px; }
  .crow .inp input[data-up] { text-align: left; padding-left: 12px; }
  .crow.chd { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); margin-bottom: -2px; } .crow.chd span:nth-child(2) { text-align: right; padding-right: 12px; }
  .rcard { display: grid; gap: 8px; padding: 8px; border-radius: var(--rv-r-xs); box-shadow: inset 0 0 0 1px var(--rv-line); }
  .rc-h { display: flex; justify-content: space-between; align-items: center; font-size: var(--fs-s); } .rc-h .xb { width: 28px; height: 28px; }
  .rc-k { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); }
  .dys { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; }
  .dys button { height: 28px; border: 0; border-radius: var(--rv-r-xs); background: var(--rv-sunk); font-size: var(--fs-xs); color: var(--rv-muted); padding: 0; }
  .dys button.on { background: var(--rv-accent-soft); color: var(--rv-accent); }
  .tb-line { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); margin: 0; }
  /* bots v2: a parameter's plain line and live read-out under it; Advanced switches with their fields under them */
  .tb-f2 { display: grid; gap: 2px; min-width: 0; }
  .tb-hint { margin: 0; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); overflow-wrap: anywhere; }
  .tb-hint .ro { color: var(--rv-muted); font-variant-numeric: tabular-nums; }
  .tb-hint .ro:empty { display: none; }
  .tb-sx { gap: 4px; } .tb-sx > .k { font-size: var(--fs-s); line-height: 16px; color: var(--rv-muted); padding-top: 4px; }
  .tb-tog { display: grid; gap: 2px; min-width: 0; }
  .tb-tog > .ck { min-height: 28px; }
  .tb-tog > .tb-hint, .tb-tog > .tb-in { padding-left: 22px; }
  .tb-tog > .tb-in { padding-top: 6px; padding-bottom: 4px; gap: 4px; }
  .tb-on { margin-left: 8px; color: var(--rv-accent); font-size: var(--fs-xs); font-weight: 400; }
  .tb-adv > summary > span { display: inline-flex; align-items: center; }
  .tb-tipx { padding: 2px 0 4px; }
  .tb-risk .v .dn { color: var(--rv-neg); } .tb-risk .v .up { color: var(--rv-pos); }
  /* the backtest against buying and holding, and its trades that open into their orders */
  .tb-leg { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); font-variant-numeric: tabular-nums; }
  .tb-leg i { display: inline-block; width: 12px; height: 0; margin-right: 6px; vertical-align: 3px; border-top: 1.5px solid var(--rv-pos); }
  .tb-leg i.h { border-top: 1.5px dashed var(--rv-dim); } .tb-leg i.dnl { border-top-color: var(--rv-neg); }
  .tb-trs { min-width: 0; }
  .tb-trs > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 32px; font-size: var(--fs-s); color: var(--rv-muted); cursor: pointer; }
  .tb-trs > summary::-webkit-details-marker { display: none; }
  .tb-trs > summary:hover { color: var(--rv-text); }
  .tb-trs > summary svg.i { width: 12px; height: 12px; transition: transform .15s; } .tb-trs[open] > summary svg.i { transform: rotate(180deg); }
  .tb-trl { display: grid; max-height: 280px; overflow-y: auto; scrollbar-width: thin; }
  .tb-tr { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; min-height: 32px; padding: 0; border: 0; border-top: 1px solid var(--rv-line);
           background: none; color: var(--rv-text); text-align: left; font-size: var(--fs-s); font-variant-numeric: tabular-nums; cursor: pointer; width: 100%; }
  .tb-tr:hover { background: var(--rv-panel2); } .tb-tr .m { color: var(--rv-muted); font-size: var(--fs-xs); }
  .tb-tr svg.i { width: 12px; height: 12px; color: var(--rv-muted); transition: transform .15s; } .tb-tr.on svg.i { transform: rotate(180deg); }
  .tb-ord { display: grid; gap: 0; padding: 0 0 8px 12px; font-size: var(--fs-xs); line-height: 20px; font-variant-numeric: tabular-nums; color: var(--rv-muted); }
  .tb-ord > div { display: grid; grid-template-columns: 76px 40px minmax(0, 1fr) auto; gap: 8px; }
  .tb-ord .r { text-align: right; } .tb-ord b { font-weight: 400; color: var(--rv-text); }
  .tb-csv { border: 0; background: none; padding: 0; font-size: var(--fs-xs); color: var(--rv-accent); cursor: pointer; }
  .tb-csv:hover { text-decoration: underline; }
  /* a bot's shared result: the card image, its link */
  .tb-card { display: grid; gap: 12px; } .tb-card img { width: 100%; height: auto; border-radius: var(--rv-r-xs); box-shadow: inset 0 0 0 1px var(--rv-line); background: var(--rv-sunk); aspect-ratio: 1200 / 630; }
  .tb-line .tb-tip { vertical-align: -2px; margin-left: 2px; }
  .pchips { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
  .pchips button { height: 28px; border-radius: var(--rv-r-xs); border: 1px solid transparent; background: var(--rv-sunk); font-size: var(--fs-xs); color: var(--rv-muted); padding: 0 2px;
                   white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pchips button.on { color: var(--rv-accent); border-color: var(--rv-accent-line); background: var(--rv-accent-soft); }
  .tb-amt { height: 40px; } .tb-amt input { font-size: var(--fs-l); font-weight: 500; height: 38px; }
  .tb-amt .mx { flex: none; height: 24px; border: 0; border-left: 1px solid var(--rv-line2); background: none; color: var(--rv-accent); font-size: var(--fs-s); font-weight: 500; padding: 0 12px; }
  .tb-amt .u { padding-right: 8px; color: var(--rv-text); }
  .tb-rng { width: 100%; margin: 0; accent-color: var(--rv-accent); height: 16px; }
  .tb-tk { display: flex; justify-content: space-between; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); margin-top: -4px; }
  .inp select { flex: 1; min-width: 0; width: 0; height: 34px; border: 0; background: none; outline: none; padding: 0 4px 0 8px; font-size: var(--fs-m);
                text-align: right; text-align-last: right; appearance: none; -webkit-appearance: none; cursor: pointer; color: var(--rv-text); }
  .inp select option { background: var(--rv-panel); color: var(--rv-text); }
  .inp > svg.i { width: 12px; height: 12px; color: var(--rv-muted); margin-right: 12px; flex: none; pointer-events: none; }
  .cnd { display: grid; gap: 8px; padding: 8px; border-radius: var(--rv-r-xs); box-shadow: inset 0 0 0 1px var(--rv-line); }
  .cnd-h { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; align-items: center; }
  .cnd .g2 > .inp:has(.tb-tip) { grid-column: 1 / -1; }   /* a label with its (i) and a unit: a half-width cell cut "100" to "1(" */
  .rcard .g2 { grid-template-columns: repeat(auto-fit, minmax(144px, 1fr)); }   /* a narrow rule card: one field per row, never a cut value */
  .cnd-h .xb { width: 36px; height: 36px; }
  .cnd-and { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); text-align: center; }
  .tb-lnk { border: 0; background: none; padding: 0; font-size: var(--fs-s); line-height: 16px; color: var(--rv-accent); justify-self: start; text-align: left; }
  .tb-lnk:hover { text-decoration: underline; } .tb-lnk:disabled { color: var(--rv-dim); cursor: default; text-decoration: none; }
  .tb-der { padding: 2px 0; } .tb-der div { min-height: 28px; } .tb-der .v { font-variant-numeric: tabular-nums; text-align: right; }
  .tb-der .chg { color: var(--rv-accent); }
  .tb-sum { display: grid; gap: 4px; }
  .tb-sum .k { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); }
  .tb-sum ol { margin: 0; padding: 0 0 0 16px; display: grid; gap: 2px; font-size: var(--fs-s); line-height: 16px; color: var(--rv-text); }
  .tb-adv { border-radius: var(--rv-r-xs); box-shadow: inset 0 0 0 1px var(--rv-line); }
  .tb-adv > summary { list-style: none; display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 12px; font-size: var(--fs-s); color: var(--rv-text); cursor: pointer; }
  .tb-adv > summary::-webkit-details-marker { display: none; }
  .tb-adv > summary svg.i { width: 12px; height: 12px; color: var(--rv-muted); transition: transform .15s; } .tb-adv[open] > summary svg.i { transform: rotate(180deg); }
  .tb-adv > .tb-g { padding: 0 12px 12px; }
  .tb-blk { display: grid; gap: 4px; }
  .tb-b { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: var(--fs-s); line-height: 16px; color: var(--rv-neg); }
  .tb-b > span { flex: 1; min-width: 0; }
  .tb-b .sb { flex: none; height: 28px; padding: 0 10px; font-size: var(--fs-xs); } .tb-b a.sb { color: var(--rv-text); text-decoration: none; }
  .tb-err { font-size: var(--fs-s); line-height: 16px; color: var(--rv-neg); }
  .tb-chk { display: grid; gap: 8px; }
  .tb-acts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; }   /* Backtest at its own width, Create takes the rest */
  .btn2 { height: 40px; border-radius: var(--rv-r-xs); border:1px solid transparent; background:var(--rv-btn2); font-size: var(--fs-m); font-weight: 500; color: var(--rv-text); padding: 0 8px; white-space: nowrap; }
  .btn2:hover:not(:disabled) { background: var(--rv-line); } .btn2:disabled { opacity: .4; cursor: default; }
  .tb-bt { display: grid; gap: 8px; padding: 12px; border-radius: var(--rv-r-xs); box-shadow: inset 0 0 0 1px var(--rv-line); }
  .tb-bt-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--fs-s); font-weight: 500; }
  .bst4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
  .bst4 div { display: grid; min-width: 0; } .bst4 .k { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); }
  .bst4 b { font-size: var(--fs-m); line-height: 20px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .tb-eq { width: 100%; height: 48px; display: block; }
  div.tb-ps { display: grid; gap: 8px; } div.tb-ps .tb-sub { display: flex; align-items: center; gap: 4px; }
  .tb-psc { display: grid; gap: 4px; }
  svg.tb-psg { width: 100%; height: 64px; display: block; overflow: visible; }
  svg.tb-psg path { fill: none; vector-effect: non-scaling-stroke; stroke-width: 1; }
  svg.tb-psg .z0 { stroke: var(--rv-line2); } svg.tb-psg .ze { stroke: var(--rv-dim); stroke-dasharray: 4 3; } svg.tb-psg .zx { stroke: var(--rv-line2); stroke-dasharray: 1 3; }
  svg.tb-psg .zs { stroke: var(--rv-line2); stroke-dasharray: 6 3; } svg.tb-psg .zl { stroke: var(--rv-accent); stroke-width: 1.5; stroke-linejoin: round; }
  .tb-psa { display: flex; justify-content: space-between; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); font-variant-numeric: tabular-nums; }
  .tb-psf { grid-template-columns: repeat(4, auto); justify-content: space-between; column-gap: 8px; }     /* four figures, edge to edge with the rows */
  .tb-psf .k { white-space: nowrap; } .tb-ps .hot { color: var(--rv-accent); }
  .tb-al { display: flex; justify-content: space-between; gap: 8px; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); white-space: nowrap; }
  .tb-al b { color: var(--rv-text); font-weight: 500; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; }
  /* the (i) tip: the shared 14px info icon (radar/theme.py --rv-i-info), the text in its title */
  .tb-tip { display: inline-block; width: 14px; height: 14px; background: currentColor; color: var(--rv-dim); cursor: help; flex: none;
            -webkit-mask: var(--rv-i-info) center / 14px no-repeat; mask: var(--rv-i-info) center / 14px no-repeat; }
  .tb-tip:hover, .tb-tip:focus-visible { color: var(--rv-text); }
  .tb-arb { display: grid; }
  .tb-ar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 8px; align-items: center; padding: 8px 4px; border: 0; border-top: 1px solid var(--rv-line); background: none;
           text-align: left; width: 100%; color: var(--rv-text); text-decoration: none; }
  .tb-ar:hover { background: var(--rv-panel2); text-decoration: none; }
  .tb-ar b { font-size: var(--fs-m); font-weight: 500; } .tb-ar .a { font-size: var(--fs-m); font-variant-numeric: tabular-nums; color: var(--rv-pos); text-align: right; }
  .tb-ar .v { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tb-ar .go2 { font-size: var(--fs-xs); color: var(--rv-accent); text-align: right; }
  .tb-ar.off b, .tb-ar.off .a { color: var(--rv-dim); } .tb-ar.off .v:last-child { color: var(--rv-neg); }
  .tb-sp .tb-ar .a { color: var(--rv-text); } .tb-sp .tb-ar .a.hot { color: var(--rv-accent); } .tb-sp .tb-ar .r { text-align: right; }
  .tb-sp .tb-ar.on b { color: var(--rv-accent); }   /* the chosen pair: its name in the accent, the rows stay on one left edge */ .tb-sp .tb-arb { max-height: 264px; overflow-y: auto; scrollbar-width: thin; }
  .tb-sp .tb-arh > span:first-child { display: flex; align-items: center; gap: 4px; }
  .tb-sp .tb-arh { padding: 0 0 4px; } .tb-sp .tb-ar { padding: 8px 0; }     /* flush with the panel's other rows (Larger leg, Spread) */
  .tb-arh { display: grid; grid-template-columns: minmax(0, 1fr) auto; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); padding: 0 4px 4px; }
  .tb-al > span { white-space: normal; min-width: 0; } .tb-al > b { white-space: nowrap; }   /* a long label wraps; the figure stays whole */
  .bk-r.gl { box-shadow: inset 2px 0 var(--rv-pos); } .bk-r.gl.s { box-shadow: inset 2px 0 var(--rv-neg); }
  .bdot { width: 6px; height: 6px; border-radius: 999px; display: inline-block; margin-right: 6px; vertical-align: 1px; background: var(--rv-dim); }
  .bdot.ok { background: var(--rv-pos); } .bdot.wait { background: var(--rv-accent); } .bdot.bad { background: var(--rv-neg); }
  tr.bot-row { cursor: pointer; } tr.bot-row:hover td { background: var(--rv-line); } tr.bot-row.off td { color: var(--rv-muted); }
  td .acts { display: inline-flex; gap: 4px; vertical-align: middle; }
  .sb.ic { width: 24px; padding: 0; display: inline-grid; place-items: center; } .sb.ic svg.i { width: 14px; height: 14px; }
  /* one width on every row in English; a longer word in another language widens its button instead of spilling past it */
  td .acts [data-bact=amount] { min-width: 56px; } td .acts [data-bact=pause], td .acts [data-bact=resume] { min-width: 60px; } td .acts [data-bact=stop] { min-width: 44px; }
  td .acts [data-bact=remove] { min-width: 64px; } td .acts [data-bact=edit] { min-width: 44px; }
  table.bt-t th, table.bt-t td { padding: 0 6px; } table.bt-t th:first-child, table.bt-t td:first-child { padding-left: 12px; }
  table.bt-t th:last-child, table.bt-t td:last-child { padding-right: 12px; }
  table.bt-t td.rule { max-width: 128px; overflow: hidden; text-overflow: ellipsis; }
  table.bt-t .act { position: sticky; right: 0; background: var(--rv-panel); z-index: 1; }
  table.bt-t thead .act { z-index: 2; } table.bt-t tr.bot-row:hover td.act { background: var(--rv-line); }
  .sbadge.k { background: var(--rv-accent); }
  .pc.bot { cursor: pointer; }
  .pc .rl { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); }
  .bst { display: inline-flex; align-items: center; font-size: var(--fs-xs); line-height: 16px; color: var(--rv-muted); white-space: nowrap; flex: none; }
  @keyframes tbflash { from { background: var(--rv-accent-soft); } to { background: transparent; } }
  tr.flash td, .pc.flash { animation: tbflash 1.6s ease-out 1; }
  #tabs .oh { margin-left: auto; font-size: var(--fs-xs); color: var(--rv-muted); }
  .own[data-bot] { cursor: pointer; } .own[data-bot]:hover { color: var(--rv-text); }
  .sheet .sh-f.stick { position: sticky; bottom: 0; background: var(--rv-panel); padding-top: 12px; box-shadow: 0 -1px var(--rv-line); }
  .sheet ol.tb-ol { margin: 0; padding: 0 0 0 16px; display: grid; gap: 4px; font-size: var(--fs-s); line-height: 16px; }
  .sheet .sec { font-size: var(--fs-xs); line-height: 16px; color: var(--rv-dim); margin: 0; }
  .sheet table { font-size: var(--fs-s); } .sheet th { position: static; }
  .tb-share { display: grid; gap: 8px; } .tb-share textarea { width: 100%; min-height: 64px; resize: vertical; border-radius: var(--rv-r-xs); border:1px solid transparent;
    background: var(--rv-panel2); padding: 8px 12px; font-size: var(--fs-m); line-height: 20px; outline: none; }
  .tb-share textarea:focus { border-color: var(--rv-accent); }
  .tb-share .inp input { text-align: left; }
  @media (max-width: 860px) {
    /* a field brought into view (typing, Tab) stops above the fixed Create button and the tab bar (audit 3c: it covered a field) */
    html.tm-bot { scroll-padding-bottom: calc(var(--tb-h, 56px) + 76px + env(safe-area-inset-bottom)); }
    .pchips { grid-template-columns: repeat(3, auto); }   /* the narrow phone column: one row, a longer name (Осторожно) gets the room it needs */
    .fsw { display: flex; grid-column: 1 / 3; grid-row: 1; gap: 16px; padding: 0; height: 36px; border-bottom: 1px solid var(--rv-line); }
    .fsw button { height: 36px; border: 0; background: none; padding: 0; font-size: var(--fs-m); color: var(--rv-muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .fsw button.on { color: var(--rv-text); border-bottom-color: var(--rv-accent); font-weight: 500; }
    .term > .form, .term > .book { grid-row: 2; }
    .term > .bottom { grid-row: 3; }
    .term { grid-template-rows: auto auto auto; }
    #bot-pane { padding: 0; gap: 8px; overflow: visible; }
    .tb-der div { min-height: 28px; }
    #tabs .oh { display: none; }
    #bot-pane .seg.lg:is(.n3, .n4, .kinds) button { padding: 0 2px; font-size: var(--fs-s); }
    .seg.lg.kinds { grid-template-columns: repeat(2, minmax(0, 1fr)); height: auto; }
    .bottom .tabs .ol { display: none; } .bottom .tabs .os { display: inline; }
    .tb-acts { grid-template-columns: auto minmax(0, 1fr); }
  }`;
  document.head.appendChild(css);

  /* ---------------- small helpers ---------------- */
  const fmtU = (x, d) => C().fmtUsd(x, d);
  const MN = s => String(s).replace(/^-/, '\u2212');        /* a negative figure on screen: the true minus sign */
  const num = x => C().fmtUsd(x, 2).replace('$', '');
  const bots = () => (S.me && S.me.bots) || [];
  const live = () => bots().filter(b => LIVE.includes(b.status));
  const arbs = () => (S.me && S.me.arb_bots) || [];
  const liveArbs = () => arbs().filter(a => a.status !== 'stopped');
  const kindName = k => T().BOT_NAME[k];
  const kindWord = k => k === 'dca' ? 'DCA' : RVI18N.lang === 'en' ? kindName(k).toLowerCase() : kindName(k);
  const botName = b => _t('{coin} {kind} bot', {coin: b.coin, kind: kindWord(b.kind)});
  /* a type with no backtest (BotPlan.NO_BT): what the backtest's place says instead */
  const noBtWhy = kind => P.NO_BT.includes(kind) ? _t('No backtest for a liquidation guard: it acts on your own position\'s liquidation price, which depends on your account\'s margin and other positions, so past prices cannot replay it. Its plan says exactly when it acts and what it does each time.') : null;
  const SIDE_W = () => ({neutral: _t('Neutral'), long: _t('Long'), short: _t('Short'), both: _t('Both')});
  const sideOf = (k, c) => P.GRIDS.includes(k) || k === 'scalp' || P.ADAPT.includes(k) ? SIDE_W()[c.mode || 'neutral'] : k === 'pair' ? `${c.coin || ''}/${c.coin_b || ''}`
    : SIDE_W()[(c.preset || {}).side || c.side] || '';
  const sideTxt = b => sideOf(b.kind, b.config);
  const dot = s => ({active: 'ok', paused: 'wait', stopping: 'wait', error: 'bad'}[s] || '');
  const mkPrice = () => (S.mk && S.mk.price) || curPrice();
  const maxL = () => (S.mk && S.mk.max_leverage) || 20;
  const minOrder = () => Math.max(10, (S.mk && S.mk.min_usd) || 10);
  const cross = () => curMode() === 'cross';          /* the bot's margin mode: the pick for this coin (terminal.html openMode) */
  const clone = o => JSON.parse(JSON.stringify(o));
  const tip = t => `<i class="tb-tip" tabindex="0" title="${esc(t)}" aria-label="${esc(t)}"></i>`;
  const rp = v => v >= 1000 ? Math.round(v).toLocaleString('en-US') : px(v);          // a price in a label: 3,686 not 3,686.00
  const pctTxt = x => (+(+x).toFixed(4)).toString() + '%';
  function setPath(o, path, v) { const p = path.split('.'); let x = o; for (let i = 0; i < p.length - 1; i++) x = x[/^\d+$/.test(p[i]) ? +p[i] : p[i]]; x[p[p.length - 1]] = v; }
  function getPath(o, path) { return path.split('.').reduce((x, k) => x == null ? x : x[/^\d+$/.test(k) ? +k : k], o); }
  /* the kind's shape: the preset's settings plus what was changed under Advanced */
  /* ---------------- market-based presets (terminal-core.js marketPreset) ----------------
     Each preset reads its own chart; the candles come from the chart's candles API once per coin, exchange and
     timeframe (closed candles only). Until they are here the fixed preset stands, then an untouched preset is redone. */
  const TF_S = {'5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400};
  B.mc = B.mc || {}; B.basis = {}; B.rangePre = {}; B.rangeWait = null; B.strat = pref.get('botstrat', 'rsi');
  if (!T0().IND_STRATS.includes(B.strat)) B.strat = 'rsi';
  function T0() { return window.TerminalCore; }
  function presetTfs(kind, name) {
    if (kind === 'indicator') return [T().IND_PRESETS[B.strat][name][0]];
    return T().presetCharts(kind, name, S.coin, rangeOf(kind));
  }
  /* a grid's range method (Advanced): centred ± % from the volatility (default) or the last N candles' low-high */
  function rangeOf(kind) { const s = B.shape[kind] || {}; return {range_by: s.range_by === 'swing' ? 'swing' : 'vol', range_n: s.range_n}; }
  function byTfOf(kind, name) { const o = {}; for (const t of presetTfs(kind, name)) if (Array.isArray(B.mc[mcKey(t)])) o[t] = B.mc[mcKey(t)]; return o; }
  /* the range again from the market after the range method changed (the preset and the other settings stay) */
  function reRange() {
    const k = B.kind, s = shape(), name = B.preset[k] || B.rangePre[k] || 'balanced';
    const m = T().marketPreset(k, name, byTfOf(k, name), {px: mkPrice(), coin: S.coin, fees: feesNow(), ...rangeOf(k)});
    B.rangeWait = m ? null : k;
    loadMC(k, name);
    if (!m) return;
    s.lower = m.set.lower; s.upper = m.set.upper; delete s.range; delete s.range_man;
    if (s.auto !== false) s.grids = m.set.grids;
    B.basis[k] = m.basis;
  }
  function mcKey(tf) { return `${S.venue}|${S.coin}|${tf}`; }
  function loadMC(kind, name) {
    for (const tf of presetTfs(kind, name)) {
      const k = mcKey(tf);
      if (B.mc[k]) continue;
      B.mc[k] = 'loading';
      fetch(`/api/auto/terminal/candles?venue=${encodeURIComponent(S.venue)}&coin=${encodeURIComponent(S.coin)}&tf=${tf}`)
        .then(r => r.ok ? r.json() : {candles: []}).catch(() => ({candles: []}))
        .then(d => {
          const now = Date.now() / 1000;
          B.mc[k] = (d.candles || []).filter(c => c[0] + TF_S[tf] <= now).map(c => c.slice(0, 5));
          // an untouched preset of the type on screen takes the market's numbers now
          if (B.kind === kind && B.preset[kind] === name && B.panel === 'bot') { applyPreset(name); render(); schedule(true); }
          else if (B.kind === kind && B.rangeWait === kind && B.panel === 'bot') { reRange(); render(); schedule(true); }
        });
    }
  }
  function presetShape(kind, name) {
    const s = P.shapeOf(kind, T().BOT_PRESETS[kind][name]);
    let tf;
    if (kind === 'indicator') {
      const sig = T().indSignal(B.strat, name, s.side === 'short' ? 'short' : 'long');
      s.timeframe = sig.timeframe; s.conditions = sig.conditions; tf = sig.timeframe;
    }
    const rg = rangeOf(kind);
    if (P.GRIDS.includes(kind) && rg.range_by === 'swing') { s.range_by = 'swing'; if (rg.range_n) s.range_n = rg.range_n; }
    B.rangePre[kind] = name;
    const m = T().marketPreset(kind, name, byTfOf(kind, name), {px: mkPrice(), coin: S.coin, fees: feesNow(), tf, ...rg});
    if (m) Object.assign(s, m.set);
    B.basis[kind] = m ? m.basis : null;
    loadMC(kind, name);
    fillShown(kind, s);
    return s;
  }
  /* the settings on screen that are empty but have the server's default (BotPlan.DEFAULTS): filled in when they appear,
     so the field shows the number the bot will use; a value typed before (Rebound, then Chase, then Rebound) stays */
  function fillShown(kind, s) {
    const d = P.DEFAULTS[kind]; if (!d) return false;
    let tf = false;
    for (const f of T().BOT_SCHEMA[kind] || []) if (d[f.k] != null && (s[f.k] == null || s[f.k] === '') && (!f.show || f.show(s))) { s[f.k] = d[f.k]; if (f.k === 'timeframe') tf = true; }
    return tf;
  }
  /* the position held on this market (one of the customer's own first): what a take-profit ladder or a trailing stop on
     "one I hold" works on */
  function heldPos() {
    const ps = ((S.me && S.me.positions) || []).filter(p => p.venue === S.venue && p.coin === S.coin && +p.size);
    return ps.find(p => p.owner && p.owner.id === 'outside') || ps[0] || null;
  }
  /* a trailing stop set to protect a position you hold, on an account read with no such position here: why it cannot
     start (the server refuses it too, api.py create), never a new position opened instead. '' when there is one, or
     while the account is not read yet */
  function noHeldWhy() {
    if (B.kind !== 'trailstop' || !P.tsHolds(shape()) || !S.me || !Array.isArray(S.me.positions)) return '';
    const side = shape().side === 'short' ? 'short' : 'long', v = L(S.venue), coin = C().mktName(S.coin);
    if (((S.me && S.me.positions) || []).some(p => p.venue === S.venue && p.coin === S.coin && +p.size && p.side === side)) return '';
    return side === 'long' ? _t('You hold no long {coin} position on {venue}, so there is nothing to protect. Open one first, or switch the bot to open a new position.', {coin, venue: v})
      : _t('You hold no short {coin} position on {venue}, so there is nothing to protect. Open one first, or switch the bot to open a new position.', {coin, venue: v});
  }
  function shape() {
    if (!B.shape[B.kind]) B.shape[B.kind] = presetShape(B.kind, B.preset[B.kind] || 'balanced');
    const s = B.shape[B.kind];
    if (P.holds(B.kind, s) && !B.sideSet) { const h = heldPos(); if (h && (h.side === 'long' || h.side === 'short')) s.side = h.side; }
    if (B.kind === 'rebalance' && !s.coins) s.coins = T().DEFAULT_BASKET(S.coin);
    if (B.kind === 'pair' && !s.coin_b) s.coin_b = T().pairOf(S.coin);
    if (s.leverage > maxL()) s.leverage = maxL();
    return s;
  }
  const total = () => B.total[B.kind] == null ? 0 : B.total[B.kind];
  /* an amount typed that cannot work (0, negative, a word, above MAX_USD): kept as typed, so every screen says so, the
     backtest shows nothing (never the reference amount's result) and Start stays off (audit M01) */
  const amtErr = () => P.amountError(B.bad[B.kind]);
  const amtErrText = () => amtErr() === 'max' ? _t('Enter an amount up to {max}', {max: C().fmtUsd(P.MAX_USD, 0).replace('$', '')}) : _t('Enter an amount above 0');
  function plan() { B.plan = P.derive(B.kind, shape(), total(), {px: mkPrice(), minOrder: minOrder()}); return B.plan; }
  const cfg = () => (B.plan || plan()).cfg;
  const payload = () => ({...clone(plan().cfg), coin: S.coin, venue: S.venue, margin_mode: curMode()});
  const chkKey = () => JSON.stringify({kind: B.kind, config: payload()});
  function claimOf(coin, venue) { return ((S.me && S.me.claims) || []).find(x => x.venue === venue && x.coin === coin) || null; }
  /* the exchange's row of the one money model (me.money, radar/auto/money.py): balance, room, withdrawable. Never recomputed here. */
  function moneyAt(v) { return ((S.me && S.me.money && S.me.money.venues) || []).find(x => x.venue === v) || null; }
  const avail = () => { const r = T().botRoom(moneyAt(S.venue)); return r == null ? null : Math.floor(r * 100) / 100; };

  /* ---------------- why Create is off: every reason, one line each, with its fix ---------------- */
  function blocks() { const out = acctBlocks(); return out.length ? out : setBlocks(); }
  /* what the settings themselves allow, whatever the account (test: the Backtest lab's test, which needs no free balance
     and runs at any leverage: the liquidation is in the simulation) */
  function setBlocks(test) {
    const out = [], v = L(S.venue);
    const t = total(), p = plan(), room = test ? null : avail();
    if (p.noAmount) { /* it follows a position you hold: no amount */ }
    else if (amtErr()) out.push({text: amtErrText(), fix: [{label: _t('Set ${0}').replace('{0}', num(p.minTotal)), set: p.minTotal}]});
    else if (!(t > 0)) out.push({text: _t('Enter an amount'), fix: [{label: _t('Set ${0}').replace('{0}', num(p.minTotal)), set: p.minTotal}]});
    else if (t < p.minTotal - 1e-9) out.push({text: _t('Minimum order ${0}').replace('{0}', minOrder()), fix: [{label: _t('Set ${0}').replace('{0}', num(p.minTotal)), set: p.minTotal}], min: true});
    if (!p.noAmount && t > 0 && room != null && t > room + 0.005)
      out.push({text: _t('Not enough free on {0} (${1} free)').replace('{0}', v).replace('{1}', num(room)),
                fix: (room >= p.minTotal ? [{label: _t('Use ${0}').replace('{0}', num(room)), set: room}] : []).concat([{label: _t('Deposit'), href: '/app#exchanges'}])});
    if (P.GRIDS.includes(B.kind) && !(cfg().upper > cfg().lower)) out.push({text: _t('Set the range')});
    if (B.kind === 'sessgrid' && !String(S.coin || '').includes(':')) out.push({text: _t('Choose a stock or commodity market: this grid follows its market hours')});
    if (B.kind === 'rebalance' && (cfg().coins || []).some(x => !(+x.weight > 0))) out.push({text: _t('Give every coin an allocation above 0%')});
    else if (B.kind === 'rebalance' && Math.abs((cfg().coins || []).reduce((a, x) => a + x.weight, 0) - 100) > 0.01) out.push({text: _t('Make the allocations add up to 100%')});
    if (B.kind === 'pair' && !cfg().coin_b) out.push({text: _t('Pick the second coin')});
    const r = B.chk && B.chk.key === chkKey() ? B.chk : null;
    if (!out.length && r && !r.ok) out.push({text: r.error || _t('Check this setting')});
    // liquidated before its own last order or stop loss at this leverage: Create stays off on isolated margin (the line
    // with the leverage that works is under the amount, levH); on cross the rest of the account backs it, so it only warns
    if (!test && r && r.ok && r.leverage_block && !cross()) out.push({text: r.leverage_block, quiet: NEW});
    return out;
  }
  /* the leverage line under the amount (/api/auto/bots/check: bots.max_safe_leverage and leverage_block) */
  function levH(r) {
    if (!r || !r.ok || !r.leverage_block) return '';
    const n = r.safe_leverage;
    return `<div class="tb-b tb-lw"><span>${esc(r.leverage_block)}</span>${n >= 1 ? `<button class="sb" type="button" data-blev="${n}">${_t('Use {n}x', {n})}</button>` : ''}</div>`;
  }
  /* what the account and the exchange allow, whatever the settings (also a private setup's copy) */
  function acctBlocks() {
    const out = [], v = L(S.venue);
    if (S.signedOut) return [{out: true}];            // signed out: Create reads Connect wallet (as the order form), no line
    if (!S.venues || (!S.me && !S.st)) return [{text: _t('Loading…'), wait: true}];
    const vi = venueInfo(S.venue);
    if (!vi.connected) out.push({text: _t('Connect {venue}', {venue: v}), fix: [{label: _t('Connect'), href: '/assets/exchanges?connect=' + S.venue}]});
    if (S.mk && S.mk.error) out.push({text: S.mk.error});
    const bv = ((S.me && S.me.blocked && S.me.blocked.bot_venues) || {})[S.venue];
    if (bv) out.push({text: bv.split('. ')[0]});
    const c = claimOf(S.coin, S.venue);
    if (c) out.push({text: c.why, fix: [{label: _t('Manage'), act: 'manage'}]});
    if (live().length >= 10) out.push({text: _t('At most 10 bots'), fix: [{label: _t('Manage'), act: 'manage'}]});
    const nh = vi.connected ? noHeldWhy() : '';
    if (nh) out.push({text: nh});
    if (cross() && live().some(b => b.venue === S.venue)) out.push({text: _t('One bot per {venue} account', {venue: v})});
    if (S.mk && S.mk.bots_open === false) out.push({text: _t('Bots are coming soon'), soon: true});
    else if (((S.me && S.me.bots_held) || []).includes(B.kind)) out.push({text: _t('Bots are coming soon'), soon: true});   // this kind held (AUTO_BOTS_HOLD)
    return out;
  }
  function blocksH(list) {
    return list.filter(b => !b.wait && !b.out && !b.quiet).map(b => `<div class="tb-b"><span>${esc(b.text)}</span>${(b.fix || []).map(f => f.href ? `<a class="sb" href="${esc(f.href)}">${esc(f.label)}</a>`
      : `<button class="sb" type="button" ${f.set != null ? `data-bset="${f.set}"` : f.act ? `data-bact="${esc(f.act)}"` : 'data-bmanage="1"'}>${esc(f.label)}</button>`).join('')}</div>`).join('');
  }

  /* ---------------- the Bot pane ---------------- */
  const segH = (key, val, opts, n, cls = '') => `<div class="seg lg n${n || opts.length}${cls}" data-bseg="${key}" role="group">${opts.map(([v, l, c]) =>
    `<button type="button" data-v="${esc(v)}" class="${String(val) === String(v) ? 'on' + (c ? ' ' + c : '') : ''}">${l}</button>`).join('')}</div>`;
  const tipI = t => t ? ' ' + tip(t) : '';
  const numH = (key, label, v, unit, ph, t) => `<div class="inp"><span class="pre">${label}${tipI(t)}</span><input data-bk="${key}" inputmode="decimal" autocomplete="off" value="${v == null ? '' : esc(v)}" placeholder="${esc(ph || '')}" aria-label="${esc(label)}">${unit ? `<span class="u">${unit}</span>` : ''}</div>`;
  const txtH = (key, label, v, ph, t) => `<div class="inp"><span class="pre">${label}${tipI(t)}</span><input data-bk="${key}" data-up="1" autocomplete="off" autocapitalize="characters" value="${v == null ? '' : esc(v)}" placeholder="${esc(ph || '')}" aria-label="${esc(label)}"></div>`;
  const selH = (key, label, v, opts, t) => `<div class="inp"><span class="pre">${label}${tipI(t)}</span><select data-bk="${key}" aria-label="${esc(label)}">${opts.map(([a, l, off]) => `<option value="${a}" ${String(v) === String(a) ? 'selected' : ''}${off ? ' disabled' : ''}>${l}</option>`).join('')}</select>${I.chev}</div>`;
  const ckH = (key, on, text, id, t) => `<label class="ck"><input type="checkbox" ${key ? `data-bk="${key}"` : ''}${id ? ` id="${id}"` : ''} ${on ? 'checked' : ''}>${text}${tipI(t)}</label>`;
  /* what the chosen exchange lets a bot do (bot_venues.caps, from /api/auto/bots/market): an option it lacks is off with the reason */
  const capWhy = c => { const x = S.mk && S.mk.caps; return x && x[c] === false ? ((x.why || {})[c] || _t('Not on {v}', {v: L(S.venue)})) : null; };

  function levRow() {
    const s = shape();
    return `<div class="mrow"><button class="chip" id="tb-mm" type="button"><span>${cross() ? _t('Cross') : _t('Isolated')}</span>${I.chev}</button>` +
      `<button class="chip" id="tb-lev" type="button" aria-haspopup="dialog"><span class="num">${s.leverage}x</span>${I.chev}</button></div>`;
  }
  const IND_LABEL = () => ({rsi: 'RSI', price_ma: _t('Price × average'), ma_cross: _t('Averages cross'), bb: _t('Bollinger Bands'), macd: 'MACD', supertrend: 'Supertrend',
    price: _t('Price'), change: _t('Price change'), breakout: _t('Breakout'), bb_mid: _t('Bollinger middle'), position: _t('Position'), pnl: _t('Profit'),
    time: _t('Time of day'), weekday: _t('Day of week'), funding: _t('Funding'), always: _t('Every candle')});
  /* one condition's fields (the indicator bot's and the rules bot's) */
  function condFields(c, p) {
    const ab = [['above', _t('Above')], ['below', _t('Below')]], cr = [['crosses_above', _t('Above')], ['crosses_below', _t('Below')]];
    switch (c.ind) {
      case 'rsi': return numH(`${p}.period`, _t('Period'), c.period) + numH(`${p}.value`, _t('Level'), c.value) + selH(`${p}.op`, _t('Is'), c.op, [['below', _t('Below')], ['above', _t('Above')]]);
      case 'price_ma': return selH(`${p}.ma`, _t('Avg.'), c.ma, [['ema', 'EMA'], ['sma', 'SMA']]) + numH(`${p}.period`, _t('Period'), c.period) + selH(`${p}.op`, _t('Crosses'), c.op, cr);
      case 'ma_cross': return numH(`${p}.fast`, _t('Fast'), c.fast) + numH(`${p}.slow`, _t('Slow'), c.slow) + selH(`${p}.ma`, _t('Avg.'), c.ma, [['ema', 'EMA'], ['sma', 'SMA']]) + selH(`${p}.op`, _t('Crosses'), c.op, cr);
      case 'bb': return numH(`${p}.period`, _t('Period'), c.period) + numH(`${p}.std`, _t('Width'), c.std) + selH(`${p}.op`, _t('Touches'), c.op, [['touches_lower', _t('Lower')], ['touches_upper', _t('Upper')]]);
      case 'macd': return numH(`${p}.fast`, _t('Fast'), c.fast) + numH(`${p}.slow`, _t('Slow'), c.slow) + numH(`${p}.signal`, _t('Signal'), c.signal) +
        selH(`${p}.op`, _t('Is'), c.op, [['crosses_above', _t('Crosses up')], ['crosses_below', _t('Crosses down')], ['above_zero', _t('Above 0')], ['below_zero', _t('Below 0')]]);
      case 'supertrend': return numH(`${p}.period`, 'ATR', c.period) + numH(`${p}.mult`, _t('Mult.'), c.mult) +
        selH(`${p}.op`, _t('Is'), c.op, [['turns_up', _t('Turns up')], ['turns_down', _t('Turns down')], ['is_up', _t('Up')], ['is_down', _t('Down')]]);
      case 'price': return selH(`${p}.op`, _t('Closes'), c.op, ab) + numH(`${p}.value`, _t('Price'), c.value, null, rp(mkPrice() || 0));
      case 'change': return selH(`${p}.op`, _t('Moves'), c.op, [['up', _t('Up')], ['down', _t('Down')]]) + numH(`${p}.pct`, _t('By'), c.pct, '%') + numH(`${p}.candles`, _t('In'), c.candles, _t('candles'));
      case 'breakout': return selH(`${p}.op`, _t('Breaks'), c.op, [['above_high', _t('High')], ['below_low', _t('Low')]]) + numH(`${p}.period`, _t('Of'), c.period, _t('candles'));
      case 'bb_mid': return numH(`${p}.period`, _t('Period'), c.period) + selH(`${p}.op`, _t('Crosses'), c.op, cr);
      case 'position': return selH(`${p}.op`, _t('Is'), c.op, [['flat', _t('None')], ['long', _t('Long')], ['short', _t('Short')], ['open', _t('Any')]]);
      case 'pnl': return selH(`${p}.op`, _t('Is'), c.op, ab) + numH(`${p}.pct`, _t('Move'), c.pct, '%', '', _t('From the average entry, in your favour.'));
      case 'time': return numH(`${p}.from_h`, _t('From'), c.from_h, 'UTC') + numH(`${p}.to_h`, _t('To'), c.to_h, 'UTC');
      case 'weekday': return `<div class="dys">${[0, 1, 2, 3, 4, 5, 6].map(d => `<button type="button" data-bday="${p}.days" data-v="${d}" class="${(c.days || []).includes(d) ? 'on' : ''}">${[_t('Mo'), _t('Tu'), _t('We'), _t('Th'), _t('Fr'), _t('Sa'), _t('Su')][d]}</button>`).join('')}</div>`;
      case 'funding': return selH(`${p}.op`, _t('Is'), c.op, ab) + numH(`${p}.rate`, _t('Funding rate'), c.rate, '%/h');
      default: return '';
    }
  }
  /* the indicator bot's entry signal names its side: Long signal / Short signal; a Both bot shows, under the long
     signal, the short one the engine takes from it (its mirror, read-only, following every edit: data-bv mir) */
  const sigSide = base => base === 'conditions' && B.kind === 'indicator' ? shape().side || 'long' : null;
  function mirTxt() {
    const s = shape(), c = s.conditions || [], j = ` ${s.logic === 'or' ? _t('or') : _t('and')} `;
    return _t('Short signal: {cond}', {cond: c.map(x => T().condText(T().mirrorCond(x), true)).join(j)});
  }
  function condsH(list, base, kinds, logicKey) {
    const side = sigSide(base);
    // both directions take these six only (bot_rules.NEUTRAL_INDS); one set before stays listed, the check says why it is refused
    if (side === 'neutral') kinds = T().IND_STRATS.concat(list.map(c => c.ind).filter(k => !T().IND_STRATS.includes(k)));
    const L0 = IND_LABEL(), inds = (kinds || T().IND_CONDS).map(k => [k, L0[k]]), s = shape();
    const logic = logicKey ? getPath(s, logicKey) || 'and' : 'and';
    const join = `<div class="cnd-and">${logic === 'or' ? _t('or') : _t('and')}</div>`;
    return (side ? `<div class="cnd-sig ${side === 'short' ? 's' : 'l'}">${side === 'short' ? _t('Short signal') : _t('Long signal')}</div>` : '') +
      (logicKey && list.length > 1 ? segH(logicKey, logic, [['and', _t('All true')], ['or', _t('Any true')]], 2, ' sm') : '') +
      list.map((c, i) => (i ? join : '') + `<div class="cnd"><div class="cnd-h">${selH(`${base}.${i}.ind`, _t('If'), c.ind, inds)}` +
      (list.length > 1 ? `<button class="xb" type="button" data-brm="${base}.${i}" aria-label="${_t('Remove this condition')}">${I.x}</button>` : '') + '</div>' +
      (c.ind === 'always' ? '' : `<div class="g2">${condFields(c, `${base}.${i}`)}</div>`) + '</div>').join('') +
      (list.length < 5 ? `<button class="tb-lnk" type="button" data-badd="${base}" data-bnew="cond">${_t('+ Add a condition')}</button>` : '') +
      (side === 'neutral' ? `<p class="cnd-mir" data-bv="mir">${esc(mirTxt())}</p>` : '');
  }
  /* the rules bot: each rule is IF (conditions) THEN (actions), with a cooldown and a run limit */
  function actionFields(a, p) {
    const pc = numH(`${p}.pct`, _t('Size'), a.pct, '%', '', _t('A share of the largest position (your total × leverage).'));
    switch (a.do) {
      case 'buy': case 'sell': return pc + segH(`${p}.type`, a.type || 'market', [['market', _t('Market [order]')], ['limit', _t('Limit [order]')]], 2, ' sm') +
        (a.type === 'limit' ? numH(`${p}.offset_pct`, _t('Away'), a.offset_pct, '%') + numH(`${p}.expire`, _t('Waits'), a.expire, _t('candles')) : '');
      case 'close': return numH(`${p}.pct`, _t('Close [position]'), a.pct, '%');
      case 'target': return segH(`${p}.side`, a.side, [['long', _t('Long'), 'l'], ['short', _t('Short'), 's']], 2, ' sm') + pc;
      case 'ladder': return segH(`${p}.side`, a.side, [['long', _t('Buy'), 'l'], ['short', _t('Sell'), 's']], 2, ' sm') +
        selH(`${p}.anchor`, _t('From'), a.anchor, [['price', _t('Price')], ['low', _t('Recent low')], ['high', _t('Recent high')]]) +
        numH(`${p}.count`, _t('Orders'), a.count) + numH(`${p}.step_pct`, _t('Every'), a.step_pct, '%') + numH(`${p}.offset_pct`, _t('Away'), a.offset_pct, '%') +
        numH(`${p}.pct`, _t('Each'), a.pct, '%') + (a.anchor !== 'price' ? numH(`${p}.lookback`, _t('Look back'), a.lookback, _t('candles')) : '') + numH(`${p}.expire`, _t('Waits'), a.expire, _t('candles'));
      default: return '';
    }
  }
  function rulesH(rules) {
    const acts = [['buy', _t('Buy')], ['sell', _t('Sell')], ['close', _t('Close [position]')], ['target', _t('Go long / short')], ['ladder', _t('Ladder')], ['cancel', _t('Cancel orders')]];
    return rules.map((r, i) => `<div class="rcard"><div class="rc-h"><b>${_t('Rule {n}', {n: i + 1})}</b>${rules.length > 1 ? `<button class="xb" type="button" data-brm="rules.${i}" aria-label="${_t('Remove this rule')}">${I.x}</button>` : ''}</div>` +
      `<div class="rc-k">${_t('If')}</div>${condsH(r.if || [], `rules.${i}.if`, T().RULE_CONDS, `rules.${i}.logic`)}` +
      `<div class="rc-k">${_t('Then')}</div>` + (r.then || []).map((a, j) => `<div class="cnd"><div class="cnd-h">${selH(`rules.${i}.then.${j}.do`, _t('Do'), a.do, acts)}` +
        ((r.then || []).length > 1 ? `<button class="xb" type="button" data-brm="rules.${i}.then.${j}" aria-label="${_t('Remove this action')}">${I.x}</button>` : '') + '</div>' +
        (a.do === 'cancel' ? '' : `<div class="g2">${actionFields(a, `rules.${i}.then.${j}`)}</div>`) + '</div>').join('') +
      ((r.then || []).length < 4 ? `<button class="tb-lnk" type="button" data-badd="rules.${i}.then" data-bnew="action">${_t('+ Add an action')}</button>` : '') +
      `<div class="g2">${numH(`rules.${i}.cooldown_min`, _t('Cooldown'), r.cooldown_min, _t('min'), '0', _t('Minutes this rule waits after it fires before it may fire again.'))}${numH(`rules.${i}.max_runs`, _t('Runs'), r.max_runs, '', '∞', _t('How many times it may fire; empty or 0 = no limit.'))}</div></div>`).join('') +
      (rules.length < 10 ? `<button class="tb-lnk" type="button" data-badd="rules" data-bnew="rule">${_t('+ Add a rule')}</button>` : '');
  }
  /* a coin field: a button with the market's logo and name that opens the market list (coinSheet); never free text that
     reads like a fixed label */
  const coinName = c => c ? C().mktName(c) + (C().isHip3(c) ? ' · ' + C().mktDex(c) : '') : '';
  const coinBtn = (key, coin, label) => `<button type="button" class="cpk${coin ? '' : ' ph'}" data-bcoin="${esc(key)}" aria-haspopup="dialog" aria-label="${esc(label + (coin ? ': ' + coinName(coin) : ''))}">` +
    (coin && window.rvCoin ? rvCoin(coin, 18) : '') + `<b>${esc(coin ? coinName(coin) : _t('Pick a coin'))}</b>${I.chev}</button>`;
  /* the rebalancing bot's basket: a coin (picked from the market list) and a weight per row, 2 to 10 rows, the weights
     adding up to 100% (the total follows every keystroke: data-bv wsum) */
  function coinsH(list) {
    const N = P.BASKET, sum = P.wsum(list);
    /* one "Allocation" header over the % column instead of the word in every field */
    const al = _t('Allocation');
    return `<div class="crow chd"><span></span><span>${al}</span><span></span></div>` + list.map((x, i) => `<div class="crow">${coinBtn(`coins.${i}.coin`, x.coin, _t('Coin'))}` +
      `<div class="inp"><input data-bk="coins.${i}.weight" inputmode="decimal" autocomplete="off" value="${x.weight == null ? '' : esc(x.weight)}" aria-label="${esc(_t('{coin} allocation', {coin: x.coin ? coinName(x.coin) : _t('Coin')}))}"><span class="u">%</span></div>` + (list.length > N.min ? `<button class="xb" type="button" data-brm="coins.${i}" aria-label="${_t('Remove this coin')}">${I.x}</button>`
        : `<button class="xb" type="button" disabled title="${esc(_t('A basket needs at least {n} coins', {n: N.min}))}" aria-label="${esc(_t('A basket needs at least {n} coins', {n: N.min}))}">${I.x}</button>`) + '</div>').join('') +
      `<div class="tb-al"><span>${list.length < N.max ? `<button class="tb-lnk" type="button" data-bcoin="coins.+">${_t('+ Add a coin')}</button>` : esc(_t('At most {n} coins', {n: N.max}))}</span>` +
      `<span><button class="tb-lnk" type="button" data-beq="1">${_t('Split equally')}</button> <b data-bv="wsum" class="${Math.abs(sum - 100) > 0.01 ? 'dn' : ''}">${_t('Total {v}%', {v: sum})}</b></span></div>`;
  }
  /* the market list for a coin field (a basket row, a new basket row "coins.+", the pair bot's second coin): every
     market this exchange trades, logo first, searchable; a coin the bot uses elsewhere is shown and not pickable */
  function coinSheet(key) {
    const s = shape(), add = key === 'coins.+', basket = key.startsWith('coins.'), at = basket && !add ? +key.split('.')[1] : -1;
    const used = c => basket ? P.basketHas(s.coins, c, at) : P.coinKey(c) === P.coinKey(S.coin);
    const cur = add ? '' : P.coinKey(getPath(s, key));
    openSheet(`<div class="sh-h"><h3>${add ? _t('Add a coin') : _t('Coin')}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>` +
      `<div class="sh-b"><div class="bfs-q">${I.search}<input id="cps-q" placeholder="${_t('Search')}" autocomplete="off" spellcheck="false" aria-label="${_t('Search')}"></div><div class="bfs-l" id="cps-l"></div></div>`, 'bfs');
    const list = () => { const w = ($('cps-q').value || '').trim().toUpperCase();
      const rows = (S.coins || []).filter(c => ((S.markets || {})[c.coin] || {})[S.venue] && (!w || C().mktMatch(c.coin, w))).slice(0, 80);
      $('cps-l').innerHTML = rows.map(c => { const off = used(c.coin), ch = S.tickers && S.tickers[c.coin] ? S.tickers[c.coin].change : null;
        return `<button type="button" class="bfs-r${P.coinKey(c.coin) === cur ? ' on' : ''}${off ? ' na' : ''}" data-c="${esc(c.coin)}"${off ? ' disabled' : ''}><span class="lg">${window.rvCoin ? rvCoin(c.coin, 24) : ''}</span>` +
          `<span><b>${esc(coinName(c.coin))}</b><small>${esc(off ? (basket ? _t('In the basket') : _t('The bot\'s first coin')) : L(S.venue))}</small></span>` +
          `<span class="r num">${esc(C().fmtPrice(listPx(c.coin)))}<small class="${ch == null ? '' : ch >= 0 ? 'up' : 'dn'}">${ch == null ? '–' : esc(C().fmtPct(ch))}</small></span></button>`; }).join('') ||
        `<p class="bf-note">${S.coins ? _t('No market matches.') : _t('Loading…')}</p>`; };
    list();
    $('cps-q').oninput = list;
    $('cps-l').onclick = e => { const b = e.target.closest('[data-c]'); if (!b || b.disabled) return; closeSheet(); setCoin(key, b.dataset.c); };
    $('cps-q').onkeydown = e => { const r = $('cps-l').querySelector('.bfs-r:not([disabled])');
      if (e.key === 'Enter' && r) { e.preventDefault(); r.click(); } else if (e.key === 'ArrowDown' && r) { e.preventDefault(); r.focus(); } };
    $('cps-l').addEventListener('keydown', e => { if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const rs = [...$('cps-l').querySelectorAll('.bfs-r:not([disabled])')], i = rs.indexOf(document.activeElement); if (i < 0) return;
      e.preventDefault(); (e.key === 'ArrowDown' ? rs[Math.min(rs.length - 1, i + 1)] : i === 0 ? $('cps-q') : rs[i - 1]).focus(); });
    if (!isPhone()) $('cps-q').focus();
  }
  function setCoin(key, coin) {
    const s = shape();
    if (key === 'coins.+') s.coins = P.basketAdd(s.coins || [], coin);
    else if (key.startsWith('coins.') && P.basketHas(s.coins, coin, +key.split('.')[1])) return;
    else setPath(s, key, P.coinKey(coin));
    edited(); render(); renderReview(); schedule();
  }
  /* the exchanges a pair bot's second leg may use: the same one, or another connected one */
  function venueOpts() {
    const o = [['', _t('Same exchange')]].concat((S.venues || []).filter(v => v.connected && v.id !== S.venue).map(v => [v.id, esc(L(v.id))]));
    const cur = B.kind === 'pair' && shape().venue_b;       // a suggested pair's exchange not connected yet: shown, the check says what to do
    return cur && cur !== S.venue && !o.some(x => x[0] === cur) ? o.concat([[cur, esc(L(cur))]]) : o;
  }
  /* one schema field (terminal-core.js BOT_SCHEMA) */
  const HARD = ['post_only', 'reduce_only_resting', 'isolated'];      // the rest (trigger, trailing) only change who watches it
  function fieldH(f, s) {
    if (f.show && !f.show(s)) return '';
    const v = getPath(s, f.k), t = [f.tip, f.cap && !HARD.includes(f.cap) ? capWhy(f.cap) : null].filter(x => x).join(' ');
    if (f.t === 'num') return numH(f.k, f.l, v, f.u, f.ph, t);
    if (f.t === 'coin') return `<div class="fld"><span class="fl">${f.l}${tipI(t)}</span>${coinBtn(f.k, v, f.l)}</div>`;
    if (f.t === 'venue') return selH(f.k, f.l, v || '', venueOpts(), t);
    if (f.t === 'ck') return ckH(f.k, v !== false && v != null && v !== '' && v !== 0, f.l, null, t);
    if (f.t === 'sel') return selH(f.k, f.l, v, f.opts.map(([a, l, c]) => [a, l, c && HARD.includes(c) && capWhy(c)]), t);
    if (f.t === 'seg') {
      const opts = f.opts.map(([a, l, c]) => [a, l, '']).filter((o, i) => !(f.opts[i][2] && HARD.includes(f.opts[i][2]) && capWhy(f.opts[i][2])));
      return `<div class="fld"><span class="fl">${f.l}${tipI(t)}</span>${segH(f.k, v == null ? f.opts[0][0] : v, opts, opts.length, ' sm')}</div>`;
    }
    if (f.t === 'coins') return coinsH(s.coins || []);
    if (f.t === 'rules') return rulesH(s.rules || []);
    return '';
  }
  /* a schema type's fields in their groups (Entry / Exit / Risk / Schedule), two short fields to a row */
  function schemaH(k) {
    const s = shape(), list = T().BOT_SCHEMA[k] || [], out = [];
    for (const [g, name] of T().BOT_GROUPS) {
      const fs = list.filter(f => f.g === g).map(f => [f, fieldH(f, s)]).filter(x => x[1]);
      if (!fs.length) continue;
      out.push(`<p class="tb-gcap">${name}</p>`);
      let pend = null;
      for (const [f, h] of fs) {
        // two to a row only when the label, its unit and its tip fit half the panel (in every language)
        const half = (f.t === 'num' || f.t === 'coin' || f.t === 'sel') && String(f.l).length + String(f.u || '').length + (f.tip ? 3 : 0) <= 11;
        if (half && pend) { out.push(`<div class="g2">${pend}${h}</div>`); pend = null; }
        else if (half) pend = h;
        else { if (pend) { out.push(pend); pend = null; } out.push(h); }
      }
      if (pend) out.push(pend);
    }
    return out.join('');
  }
  /* the direction (as on exchanges: Neutral / Long / Short for grids, Long / Short otherwise; both for the two-sided types;
     none where the type decides) */
  function sideH() {
    const s = shape(), k = B.kind, sides = T().BOT_SIDES[k];
    if (k === 'grid' || k === 'infinity') return segH('mode', s.mode, [['neutral', _t('Neutral')], ['long', _t('Long'), 'l'], ['short', _t('Short'), 's']]);
    if (k === 'indicator') return segH('side', s.side || 'long', [['long', _t('Long'), 'l'], ['short', _t('Short'), 's'], ['neutral', _t('Both')]]);
    if (sides && !sides.length) return '';
    const W = {long: [_t('Long'), 'l'], short: [_t('Short'), 's'], both: [_t('Both'), '']};
    return segH('side', s.side || 'long', (sides || ['long', 'short']).map(x => [x, W[x][0], W[x][1]]));
  }
  /* the grid's range method: exchange-style ± % around the price from the coin's volatility, or the swing of the last
     N candles of the preset's chart */
  function rangeByH() {
    const s = shape(), by = s.range_by === 'swing' ? 'swing' : 'vol';
    return `<div class="fld"><span class="fl">${_t('Range from')}${tipI(_t('± % of the price: centred on the price, as wide as the coin usually moves (30 days of 4h volatility). Last candles: the low and high of the last candles of the preset\'s chart.'))}</span>` +
      segH('range_by', by, [['vol', _t('± % of price')], ['swing', _t('Last candles')]], 2, ' sm') + '</div>' +
      (by === 'swing' ? numH('range_n', _t('Candles'), s.range_n || 30, '', '30', _t('How many closed candles the low and high are read from (10 to 250).')) : '');
  }
  /* Advanced: every setting the total and the preset derive; an edit keeps the total */
  function advH() {
    const s = shape(), c = cfg(), k = B.kind, out = [];
    if (k === 'grid' || k === 'rgrid' || k === 'infinity') {
      out.push(`<div class="g2">${numH('lower', _t('Low'), c.lower)}${numH('upper', _t('High'), c.upper)}</div>`);
      out.push(`<button class="tb-lnk" type="button" id="tb-pick">${B.pick ? _t('Click both ends · Esc') : _t('Pick on the chart')}</button>`);
      out.push(numH('grids', _t('Grids'), c.grids));
      out.push(rangeByH());
      if (k === 'infinity') {
        out.push(ckH('trail_up', s.trail_up !== false, _t('Move up with the price'), null, _t('When the price goes above the range, the grid closes and starts again around the new price.')));
        out.push(ckH('trail_down', !!s.trail_down, _t('Move down with the price'), null, _t('When the price falls under the range, the grid closes and starts again around the new price.')));
      }
      out.push(ckH('stop_outside', s.stop_outside !== false, _t('Stop outside range')));
      return out.join('');
    }
    if (T().BOT_SCHEMA[k]) return schemaH(k);
    if (k === 'dca') {
      out.push(`<div class="g2">${numH('so_count', _t('Extra orders'), c.so_count)}${numH('so_step_pct', _t('Every'), s.so_step_pct, '%')}</div>`);
      out.push(`<div class="g2">${numH('so_mult', _t('Size ×'), s.so_mult)}${numH('tp_pct', _t('Take profit'), s.tp_pct, '%')}</div>`);
      out.push(numH('step_scale', _t('Step scale'), s.step_scale || 1, '', '1', _t('Each next gap between extra orders is this many times the one before (1 = evenly spaced).')));
      out.push(numH('sl_pct', _t('Stop loss'), s.sl_pct, '%', _t('None')));
      out.push(ckH('repeat', s.repeat !== false, _t('Repeat after profit')));
      out.push(ckH(null, !!s.start, _t('Wait for a signal'), 'tb-start'));
      if (s.start) out.push(segH('start.timeframe', s.start.timeframe, T().BOT_TFS.map(t => [t, t])) + condsH(s.start.conditions, 'start.conditions'));
      return out.join('');
    }
    const e = s.entry || {mode: 'all'};
    out.push(segH('timeframe', s.timeframe, T().BOT_TFS.map(t => [t, t])));
    out.push(condsH(s.conditions, 'conditions'));
    out.push(`<div class="g2">${numH('tp_pct', 'TP', s.tp_pct, '%')}${numH('sl_pct', 'SL', s.sl_pct, '%')}</div>`);
    if (s.side === 'neutral') {
      if ((s.conditions || []).some(c => c.ind === 'bb'))
        out.push(`<div class="fld"><span class="fl">${_t('Exit at')}</span>${segH('exit', s.exit || 'mid', [['mid', _t('Middle')], ['flip', _t('Opposite signal')]], 2, ' sm')}</div>`);
      out.push(`<p class="tb-line">${_t('Long on the signal, short on its mirror; each signal closes the open side first.')}</p>`);
      return out.join('');
    }
    out.push(segH('entry.mode', e.mode, [['all', _t('At once')], ['split', _t('Split')], ['dca', 'DCA'], ['martingale', _t('Martingale')]], 4, ' sm two'));
    const ce = c.entry || {};
    if (e.mode === 'split') out.push(segH('entry.by', e.by, [['price', _t('Price steps')], ['candles', _t('Per candle')]], 2, ' sm') +
      `<div class="g2">${numH('entry.parts', _t('Parts'), ce.parts)}${e.by === 'price' ? numH('entry.step_pct', _t('Every'), e.step_pct, '%') : ''}</div>`);
    if (e.mode === 'dca' || e.mode === 'martingale') out.push(`<div class="g2">${numH('entry.so_count', _t('Extra orders'), ce.so_count)}${numH('entry.so_step_pct', _t('Every'), e.so_step_pct, '%')}</div>` +
      numH('entry.so_mult', _t('Size ×'), e.so_mult));
    out.push(ckH('exit_opposite', s.exit_opposite, _t('Close on opposite signal')));
    return out.join('');
  }
  /* the key numbers the total gives (instant): what Advanced holds, read-only */
  function derH() {
    const p = B.plan || plan(), c = p.cfg, t = total(), rows = [], q = QT();
    const val = (x, chg) => `<span class="v${chg ? ' chg' : ''}">${x}</span>`;
    if (B.kind === 'dca') {
      rows.push(row(_t('Base order'), val(t ? fmtU(c.base_usd) : '–')));
      rows.push(row(_t('Extra orders'), val(c.so_count ? `${c.so_count} × ${pctTxt(c.so_step_pct)}` : _t('None'), shape().auto && c.so_count < shape().so_count)));
      rows.push(row(_t('Take profit'), val(`+${pctTxt(c.tp_pct)}`)));
    } else if (B.kind === 'grid') {
      const g = c.lower && c.upper ? T().gridProfit(c, feesNow()) : null;
      rows.push(row(_t('Range'), val(c.lower && c.upper ? `${rp(c.lower)} – ${rp(c.upper)}` : '–')));
      rows.push(row(_t('Grids'), val(`${c.grids}`, shape().auto && c.grids < shape().grids)));
      rows.push(row(_t('Per order'), val(t ? fmtU(p.per) : '–')));
      rows.push(row(_t('Profit/grid'), val(g ? `<span class="${g.min < 0 ? 'dn' : ''}">${fmtLine(g)}</span>` : '–')));
    } else if (P.GRIDS.includes(B.kind)) {
      const g = c.lower && c.upper ? T().gridProfit(c, feesNow()) : null;
      rows.push(row(_t('Range'), val(c.lower && c.upper ? `${rp(c.lower)} – ${rp(c.upper)}` : '–')));
      rows.push(row(_t('Grids'), val(`${c.grids}`, shape().auto && c.grids < shape().grids)));
      rows.push(row(_t('Profit/grid'), val(g ? `<span class="${g.min < 0 ? 'dn' : ''}">${fmtLine(g)}</span>` : '–')));
    } else if (P.MORE.includes(B.kind)) {
      rows.push(row(_t('Plan'), val(esc(T().presetLine(B.kind, {...shape(), ...c})))));
      if (B.kind === 'martingale') rows.push(row(_t('First order'), val(t ? fmtU(c.first_usd) : '–')), row(_t('Most it may hold'), val(t ? fmtU(c.max_total_usd) : '–')));
      else if (B.kind === 'pair') rows.push(row(_t('Each leg'), val(t ? fmtU(c.size_usd) : '–')));
      else if (B.kind === 'recurring') rows.push(row(_t('Each buy'), val(t ? fmtU(c.usd) : '–', shape().auto && c.times < shape().times)));
      if (p.noAmount) return rows.join('');
    } else {
      const e = c.entry || {};
      rows.push(row(_t('Signal'), val(esc(`${c.timeframe} ${T().sigLine(c)}`))));
      rows.push(row(e.mode === 'all' ? _t('Order') : _t('First order'), val(t ? fmtU(e.mode === 'split' ? c.size_usd / e.parts : c.size_usd) : '–')));
      rows.push(row(_t('TP / SL'), val(`+${pctTxt(c.tp_pct)} / −${pctTxt(c.sl_pct)}`)));
    }
    rows.push(row(_t('Position'), val(t ? `${fmtU(t * c.leverage)}${c.leverage > 1 ? ` · ${c.leverage}x` : ''}` : '–') + (q !== 'USD' ? '' : '')));
    return rows.join('');
  }
  /* "What this bot will do": a few short lines from the plan (instant); the server's full sentences are in the review */
  function sumH() {
    const p = B.plan || plan(), c = p.cfg, t = total(), long = c.side === 'long', L2 = [];
    const u = x => t ? fmtU(x) : '…';
    if (B.kind === 'dca') {
      L2.push((long ? _t('Buys {usd} now', {usd: u(c.base_usd)}) : _t('Sells {usd} now', {usd: u(c.base_usd)})));
      if (c.so_count) L2.push((long ? _t('Up to {n} more buys, every {step} lower', {n: c.so_count, step: pctTxt(c.so_step_pct)}) : _t('Up to {n} more sells, every {step} higher', {n: c.so_count, step: pctTxt(c.so_step_pct)})));
      L2.push((long ? _t('Sells all at +{tp} over the average', {tp: pctTxt(c.tp_pct)}) : _t('Buys back at −{tp} under the average', {tp: pctTxt(c.tp_pct)})));
      if (c.sl_pct) L2.push(_t('Stops at −{sl} from the start', {sl: pctTxt(c.sl_pct)}));
      if (c.repeat) L2.push(_t('Then starts again'));
    } else if (P.GRIDS.includes(B.kind)) {
      L2.push(c.lower && c.upper ? _t('{n} lines from {lo} to {hi}', {n: c.grids, lo: rp(c.lower), hi: rp(c.upper)}) : _t('Set the range'));
      L2.push(B.kind === 'rgrid' ? _t('Sells high, buys back one line lower') : _t('Buys low, sells one line higher'));
      if (B.kind === 'infinity') L2.push(_t('Moves the range when the price leaves it'));
      else if (c.stop_outside) L2.push(_t('Closes all if the price leaves'));
    } else if (P.MORE.includes(B.kind) || c.side === 'neutral' || (c.entry && c.entry.mode && c.entry.mode !== 'all')) {
      // (an entry in parts or with extra orders: the server's sentences say the parts; "buys $400" alone would not)
      // the server's own sentences (translated at the edge) once the check has answered; the one-line plan until then
      const r = B.chk && B.chk.ok && B.chk.key === chkKey() ? B.chk : null;
      if (r) r.summary.slice(0, 4).forEach(x => L2.push(x));
      else L2.push(T().BOT_LINE[B.kind]);
    } else {
      L2.push((long ? _t('On the signal: buys {usd}', {usd: u(c.size_usd)}) : _t('On the signal: sells {usd}', {usd: u(c.size_usd)})));
      L2.push(_t('Take profit +{tp} · stop −{sl}', {tp: pctTxt(c.tp_pct), sl: pctTxt(c.sl_pct)}));
    }
    return `<div class="k">${_t('What this bot will do')}</div><ol>${L2.map(x => `<li>${esc(x)}</li>`).join('')}</ol>`;
  }
  const PRE = {safe: _t('Safe'), balanced: _t('Balanced'), aggressive: _t('Aggressive')};
  function feesNow() { const f = fees(); return {maker: f.maker || 0, taker: f.taker || 0, rivemont: f.rivemont || 0}; }
  const fmtLine = g => `${g.min >= 0 ? '+' : ''}${MN(g.min.toFixed(2))}%${g.max.toFixed(2) !== g.min.toFixed(2) ? '–' + MN(g.max.toFixed(2)) + '%' : ''}`;   /* one figure when both ends round alike (not "+0.15%–0.15%") */
  function chipsH() {
    const L0 = IND_LABEL(), b = B.basis[B.kind];
    const strat = B.kind === 'indicator' ? selH('__strat', _t('Indicator'), B.strat, T().IND_STRATS.map(k => [k, L0[k]])) : '';
    const basis = b ? `<p class="tb-line" data-bt="basis">${esc(T().basisText(b))}</p>` : '';
    return strat + chipsRow() + basis;
  }
  function chipsRow() {
    return `<div class="pchips" data-bseg="__pre">${['safe', 'balanced', 'aggressive'].map(n => `<button type="button" data-bpre="${n}" class="${B.preset[B.kind] === n ? 'on' : ''}">${n === 'aggressive' && isPhone() ? _t('Aggr.') : PRE[n]}</button>`).join('')}</div>`;
  }
  function invH() {
    const t = B.total[B.kind], a = avail();
    return `<div class="tb-g"><div class="tb-al"><span>${_t('Total investment')}</span></div><div class="inp tb-amt"><input data-inv="1" inputmode="decimal" autocomplete="off" value="${t == null ? '' : esc(t)}" placeholder="${esc(_t('Min {0}').replace('{0}', num(plan().minTotal)))}" aria-label="${_t('Total investment')}"><span class="u">USDC</span><button class="mx" type="button" id="tb-max">${_t('MAX')}</button></div>` +
      `<div><input class="tb-rng" id="tb-rng" type="range" min="0" max="100" step="1" value="${a && t ? Math.min(100, Math.round(t / a * 100)) : 0}" aria-label="${_t('Share of available')}"><div class="tb-tk"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div></div>` +
      `<div class="tb-al"><span>${_t('Available')} ${tip(_t('Margin free on {v} now: what the exchange reports as free, not held by open positions or orders.', {v: L(S.venue)}))}</span><b data-bt="avail">${a == null ? '–' : num(a) + ' USDC'}</b></div></div>`;
  }
  /* ---------------- the Bot Terminal's setup panel, designs 1-3 (RV_BOTPANEL, radar/nav.py bot_terminal),
     optimized for its real size. The usual exchange grid-bot form as the pattern: the bot type tabs,
     the strategy (preset, direction, leverage), the few parameters that matter as labelled rows with their units (the
     rest under Advanced), the investment (amount, % of what is free, available, all-in fees), the backtest of these
     exact settings, one Create button. 1 "Guided column": one ~440px column in three numbered steps, Create pinned at
     its foot. 2 "Two-pane": Settings | what the bot will do, fees, backtest and Create when the panel is 720px or wider
     (one column below). 3 the Arbitrage Terminal's format: a strip over chart and settings with the key figures and
     Create, chart and settings side by side with a divider, My bots below. Every figure that the total or a field
     changes is a [data-bv] cell repainted on each input (paintLive), so the field being typed in is never redrawn. */
  const BP = BOTMODE ? (document.documentElement.dataset.bp || '0') : '0', NEW = FLOW || BP !== '0';
  const secH = (n, title, extra) => `<div class="tb-h">${BP === '1' ? `<span class="tb-n">${n}</span>` : ''}<span class="t">${title}</span>${extra || ''}</div>`;
  const prIn = (key, label, v, unit, ph, t, up) => `<div class="tb-pr"><label class="k" for="tbk-${key}">${label}${tipI(t)}</label><span class="inp tb-pi"><input id="tbk-${key}" data-bk="${key}" ${up ? 'data-up="1" autocapitalize="characters"' : 'inputmode="decimal"'} autocomplete="off" value="${v == null ? '' : esc(v)}" placeholder="${esc(ph || '')}">${unit ? `<span class="u">${unit}</span>` : ''}</span></div>`;
  const prSel = (key, label, v, opts, t) => `<div class="tb-pr"><label class="k" for="tbk-${key}">${label}${tipI(t)}</label><span class="inp tb-pi tb-ps"><select id="tbk-${key}" data-bk="${key}">` +
    `${opts.map(([a, l, off]) => `<option value="${a}" ${String(v) === String(a) ? 'selected' : ''}${off ? ' disabled' : ''}>${l}</option>`).join('')}</select>${I.chev}</span></div>`;
  /* a schema field (terminal-core.js BOT_SCHEMA) as a labelled row: the label left, the field on the row's right edge */
  function rowField(f, s) {
    if (f.show && !f.show(s)) return '';
    const v = getPath(s, f.k), t = [f.tip, f.cap && !HARD.includes(f.cap) ? capWhy(f.cap) : null].filter(x => x).join(' ');
    if (f.t === 'num') return prIn(f.k, f.l, v, f.u, f.ph, t);
    if (f.t === 'coin') return `<div class="tb-pr"><span class="k">${f.l}${tipI(t)}</span>${coinBtn(f.k, v, f.l)}</div>`;
    if (f.t === 'venue') return prSel(f.k, f.l, v || '', venueOpts(), t);
    if (f.t === 'sel') return prSel(f.k, f.l, v, f.opts.map(([a, l, c]) => [a, l, c && HARD.includes(c) && capWhy(c)]), t);
    if (f.t === 'ck') return `<div class="tb-pr">${ckH(f.k, v !== false && v != null && v !== '' && v !== 0, f.l, null, t)}</div>`;
    if (f.t === 'seg') {
      const opts = f.opts.map(([a, l]) => [a, l, '']).filter((o, i) => !(f.opts[i][2] && HARD.includes(f.opts[i][2]) && capWhy(f.opts[i][2])));
      return `<div class="tb-pr tb-psg"><span class="k">${f.l}${tipI(t)}</span>${segH(f.k, v == null ? f.opts[0][0] : v, opts, opts.length, ' sm')}</div>`;
    }
    if (f.t === 'coins') return `</div>${coinsH(s.coins || [])}<div class="tb-rows">`;
    if (f.t === 'rules') return `</div>${rulesH(s.rules || [])}<div class="tb-rows">`;
    return '';
  }
  /* a schema type's settings as rows in their groups (Entry / Exit / Risk / Schedule) */
  const GROUP_ORDER = {recurring: ['schedule', 'entry', 'exit', 'risk'], rebalance: ['entry', 'schedule', 'exit', 'risk'], trailstop: ['entry', 'risk', 'exit', 'schedule']};
  function schemaRows(k) {
    const s = shape(), list = T().BOT_SCHEMA[k] || [], ord = GROUP_ORDER[k];
    const groups = ord ? ord.map(g => T().BOT_GROUPS.find(x => x[0] === g)) : T().BOT_GROUPS;     // what the type is about first
    return groups.map(([g, name]) => {
      const rows = list.filter(f => f.g === g).map(f => rowField(f, s)).join('');
      return rows ? `<div class="tb-sub">${name}</div><div class="tb-rows">${rows}</div>`.replace(/<div class="tb-rows"><\/div>/g, '') : '';
    }).join('');
  }
  const prRo = (label, key, cls) => `<div class="tb-pr${cls ? ' ' + cls : ''}"><span class="k">${label}</span><span class="v" data-bv="${key}">${vals()[key]}</span></div>`;
  /* ---------------- bots v2: three layers (every setting explained so a beginner understands what it is for and what
     changes when it changes) ----------------
     Strategy (preset, direction, leverage) / Parameters (the few that matter) / Advanced (switches). Each parameter has
     one plain line under it, always visible (the tablet has no hover): what it is for and what changes when it goes up,
     then its live read-out in the text colour, a [data-bv] cell repainted on every input (vals). Each Advanced option is a
     switch with its line; switched on, its fields show under it. */
  const hintH = (t, ro) => t || ro ? `<p class="tb-hint">${t || ''}${ro ? ` <span class="ro" data-bv="${ro}">${vals()[ro] || ''}</span>` : ''}</p>` : '';
  const prX = (key, label, v, unit, o = {}) => `<div class="tb-f2">${prIn(key, label, v, unit, o.ph, o.tip)}${hintH(o.hint, o.ro)}</div>`;
  const roX = (label, key, hint) => `<div class="tb-f2">${prRo(label, key)}${hintH(hint)}</div>`;
  const segX = (key, label, v, opts, hint) => `<div class="tb-f2 tb-sx"><span class="k">${label}</span>${segH(key, v, opts, opts.length, ' sm')}${hintH(hint)}</div>`;
  /* an Advanced switch: def undefined = a true/false setting (data-bk); else switching on sets the setting to def, off clears it */
  function togH(key, on, label, hint, inner, def) {
    const attr = def === undefined ? `data-bk="${key}"` : `data-btog="${key}" data-def="${esc(JSON.stringify(def))}"`;
    return `<div class="tb-tog"><label class="ck"><input type="checkbox" ${attr} ${on ? 'checked' : ''}>${label}</label>${hintH(hint)}` +
      (on && inner ? `<div class="tb-rows tb-in">${inner}</div>` : '') + '</div>';
  }
  /* a DCA stop's basis in words, per side (audit BOT-03): from the first order it stays where it is; from the average entry
     it moves with each add (down for a long, up for a short), as the runner places it (bots.dca_sl_px) */
  const slBaseLine = c => c.sl_base === 'avg'
    ? (c.side === 'short' ? _t('Average entry: the stop sits above your average sell price and moves up with each add.') : _t('Average entry: the stop sits below your average buy price and moves down with each add.'))
    : (c.side === 'short' ? _t('First order: the stop stays at a fixed price above the first sell; adds do not move it.') : _t('First order: the stop stays at a fixed price below the first buy; adds do not move it.'));
  /* where a DCA's stop lands: from the first order, or from the average of the whole ladder (every add filled), the
     price the server's risk figures use (bots.stops_by_side) */
  function dcaStopRef(c, od) {
    const first = od[0] && od[0].px;
    if (c.sl_base !== 'avg' || !first) return first;
    const q = od.reduce((a, x) => a + (x.usd > 0 && x.px > 0 ? x.usd / x.px : 0), 0), u = od.reduce((a, x) => a + (x.usd > 0 && x.px > 0 ? x.usd : 0), 0);
    return q > 0 ? u / q : first;
  }
  const sgnPct = x => (x > 0 ? '+' : x < 0 ? '\u2212' : '') + Math.abs(x).toFixed(Math.abs(x) < 10 ? 2 : 1) + '%';
  const r2 = x => Math.round(x * 100) / 100;
  /* a grid's step between two lines in % as the plan has it (BotPlan.stepOf) */
  const stepNow = c => { const x = P.stepOf(c.lower, c.upper, c.grids, c.spacing); return x == null ? '' : r2(x); };
  function feeTxt() {
    /* fees(): the coin's own level (HIP-3); before the exchange's fees have loaded it reads 0: '–' then, never "0%" */
    if (typeof venueInfo === 'function' && !(S.venues || []).some(v => v.id === S.venue && v.fee)) return '–';
    const fr = typeof venueInfo === 'function' && !venueInfo(S.venue).fee ? null : (typeof fees === 'function' && fees()) || (typeof venueInfo === 'function' && venueInfo(S.venue).fee) || null;
    if (!fr) return '–';
    return (fr.maker === fr.taker ? C().fmtRate(fr.maker) : C().fmtRate(fr.maker) + '–' + C().fmtRate(fr.taker)) + (fr.rivemont ? ' + ' + C().fmtRate(fr.rivemont) : '');
  }
  const feeTip = () => tip(_t('{venue} fee per fill (maker–taker), plus Rivemont\'s fee where it applies.', {venue: L(S.venue)}));
  /* the figures of the plan, as they are painted into the [data-bv] cells and the strip */
  function vals() {
    const p = B.plan || plan(), c = p.cfg, t = total(), a = avail(), o = {};
    o.avail = a == null ? '–' : num(a) + ' USDC';
    o.min = p.noAmount || !(p.minTotal > 0) ? '–' : num(p.minTotal) + ' USDC';
    o.pos = t ? `${fmtU(t * c.leverage)}${c.leverage > 1 ? ` · ${c.leverage}x` : ''}` : '–';
    o.fee = esc(feeTxt());
    if (P.GRIDS.includes(B.kind)) {
      const g = c.lower && c.upper ? T().gridProfit(c, feesNow()) : null;
      o.range = c.lower && c.upper ? `${rp(c.lower)} – ${rp(c.upper)}` : '–';
      o.grids = `${c.grids}`; o.per = t && p.per ? fmtU(p.per) : '–';
      o.pg = g ? `<span class="${g.min < 0 ? 'dn' : 'up'}">${fmtLine(g)}</span>` : '–';
    } else if (B.kind === 'dca') {
      o.base = t ? fmtU(c.base_usd) : '–'; o.so = c.so_count ? `${c.so_count} × ${pctTxt(c.so_step_pct)}` : _t('None');
      o.tp = `<span class="up">+${pctTxt(c.tp_pct)}</span>`;
    } else if (P.MORE.includes(B.kind)) {
      o.plan = esc(T().presetLine(B.kind, {...shape(), ...c}));
      o.first = t && c.first_usd ? fmtU(c.first_usd) : '–'; o.most = t && c.max_total_usd ? fmtU(c.max_total_usd) : '–';
      o.leg = t && c.size_usd ? fmtU(c.size_usd) : '–'; o.each = t && c.usd ? fmtU(c.usd) : '–';
      o.tpsl = `${c.tp_pct ? `<span class="up">+${pctTxt(c.tp_pct)}</span>` : '–'} / ${c.sl_pct ? `<span class="dn">−${pctTxt(c.sl_pct)}</span>` : '–'}`;
    } else if (c.conditions) {
      const e = c.entry || {};
      o.sig = esc(`${c.timeframe} ${T().sigLine(c)}`);
      o.first = t ? fmtU(e.mode === 'split' ? c.size_usd / e.parts : c.size_usd) : '–';
      o.tpsl = `<span class="up">+${pctTxt(c.tp_pct)}</span> / <span class="dn">−${pctTxt(c.sl_pct)}</span>`;
    }
    if (B.kind === 'indicator' && shape().side === 'neutral') o.mir = esc(mirTxt());
    if (B.kind === 'rebalance') o.wsum = esc(_t('Total {v}%', {v: P.wsum(shape().coins)}));
    const d = btShown().d;           // the last result while the test of changed settings runs
    o.bt = d && d.stats && P.btIdle(d.stats) ? '–' : d && d.stats ? `<span class="${clsOf(d.stats.return_pct)}">${C().fmtPct(d.stats.return_pct / 100, Math.abs(d.stats.return_pct) < 10 ? 2 : 1)}</span>` : B.btBusy ? '…' : '–';
    Object.assign(o, readouts(p, c, t), riskVals(p, c, t, d));
    return o;
  }
  const DERIVED = ['lower', 'upper', 'grids', 'so_count', 'entry.parts', 'entry.so_count', 'max_adds', 'times', 'levels'];     // fields the total may change
  /* a value typed that the bot cannot use (2.5 where a whole number goes, past its limit, a word): the field keeps what
     was typed beside its reason, never the plan's rounded number, so what it shows and its error agree and the next
     valid number clears it (audit BOT-07: "Each side" 2.5 read 3 and stayed in error) */
  function typedBad(key) {
    const s = shape(), sv = getPath(s, key);
    if (sv == null || sv === '') return false;
    if (typeof sv !== 'number' || !isFinite(sv)) return true;
    const K = window.BotFlowKit && kit(), l = K && K.limOf ? K.limOf(B.kind, key, s) : null;
    return l ? !!K.limWhy(l, sv, true) : key !== 'lower' && key !== 'upper' && !Number.isInteger(sv);
  }
  function paintVals() {
    if (!P.planned(B.view === 'signal' ? 'signal' : B.kind)) { paintStrip(); return; }     // no plan there (a backtest repaint once threw on it)
    const v = vals();
    document.querySelectorAll('[data-bv]').forEach(e => { const x = v[e.dataset.bv]; if (x != null && e.innerHTML !== x) e.innerHTML = x; });
    wsumMark(document);
    const c = cfg();
    document.querySelectorAll('#bot-pane input[data-bk], #bf input[data-bk], #lab-set input[data-bk]').forEach(i => { if (i === document.activeElement || !DERIVED.includes(i.dataset.bk)) return;
      if (typedBad(i.dataset.bk)) return;
      const x = getPath(c, i.dataset.bk); if (x != null && i.value !== String(x)) i.value = x; });
    // a grid's step follows its count (and the count its step): the one not being typed in is repainted
    const st = P.GRIDS.includes(B.kind) && document.querySelector('#bot-pane input[data-bk="step_pct"], #bf input[data-bk="step_pct"], #lab-set input[data-bk="step_pct"]');
    if (st && st !== document.activeElement) { const x = String(stepNow(c)); if (st.value !== x) st.value = x; }
    paintStrip();
  }
  /* the basket's total in red while the weights do not add up to 100% */
  const wsumMark = root => root.querySelectorAll('[data-bv="wsum"]').forEach(e => e.classList.toggle('dn', Math.abs(P.wsum(shape().coins) - 100) > 0.01));
  /* the live read-outs under the parameters: where the orders land with these numbers, at the price now */
  function readouts(p, c, t) {
    const o = {}, mk = mkPrice();
    if (B.kind === 'dca') {
      const od = (p.orders || []).filter(x => x.px), sg = c.side === 'short' ? 1 : -1, first = od[0] && od[0].px, last = od[od.length - 1];
      o.so_rd = c.so_count && first && last ? _t('Covers a move to {px} ({pct})', {px: rp(last.px), pct: sgnPct((last.px / first - 1) * 100)}) : '';
      o.step_rd = od[1] ? _t('First add at {px}', {px: rp(od[1].px)}) : '';
      o.mult_rd = c.so_count && t && last ? _t('Last add {usd}', {usd: fmtU(last.usd)}) : '';
      o.tp_rd = first && c.tp_pct ? _t('Exits near {px} if no add fills', {px: rp(first * (1 - sg * c.tp_pct / 100))}) : '';
      o.sl_rd = first && c.sl_pct ? (c.sl_base === 'avg' && od.length > 1 && dcaStopRef(c, od) ? _t('Near {px} once every add fills; it moves with the average', {px: rp(dcaStopRef(c, od) * (1 + sg * c.sl_pct / 100))}) : _t('Stops near {px}', {px: rp(first * (1 + sg * c.sl_pct / 100))})) : '';
      o.be_rd = first && c.be_pct ? _t('Moves once the price reaches {px}', {px: rp(first * (1 - sg * c.be_pct / 100))}) : '';
    } else if (P.GRIDS.includes(B.kind)) {
      const g = c.lower && c.upper ? T().gridProfit(c, feesNow()) : null;
      o.rng_rd = c.lower && c.upper && mk ? _t('{lo} to {hi} from the price now', {lo: sgnPct((c.lower / mk - 1) * 100), hi: sgnPct((c.upper / mk - 1) * 100)}) : '';
      o.gstep_rd = g ? _t('About {pct} a round after fees', {pct: fmtLine(g)}) : '';
      o.cap_rd = c.max_active ? _t('{n} of {m} lines rest at once', {n: c.max_active, m: c.grids}) : '';
    } else if (c.conditions && c.side !== 'neutral' && mk) {
      const sg = c.side === 'short' ? 1 : -1;
      o.tp_rd = c.tp_pct ? _t('Exits near {px} from the price now', {px: rp(mk * (1 - sg * c.tp_pct / 100))}) : '';
      o.sl_rd = c.sl_pct ? _t('Stops near {px} from the price now', {px: rp(mk * (1 + sg * c.sl_pct / 100))}) : '';
    }
    return o;
  }
  /* the bot has a stop: the server's word when it sends one (has_stop), else the settings' (BotPlan.hasStop) */
  const stopOf = (r, c) => r && r.has_stop != null ? !!r.has_stop : P.hasStop(B.kind, c);
  /* a grid whose only exit is moving its range has no stop loss: its figure is the loss when the range moves (the
     server's range_exit, else the settings', BotPlan.rangeOnly; audit H02) */
  const rangeExit = (r, c) => r && r.range_exit != null ? !!r.range_exit : P.rangeOnly(B.kind, c);
  const lossLabel = (r, c) => rangeExit(r, c) ? _t('Loss if the range moves') : _t('Loss at stop loss');
  /* the risk rows above Create: where it is liquidated, what the stop loss costs with every
     planned order filled (/api/auto/bots/check loss_at_stop_usd), the fees of one round, the backtest against holding */
  function riskVals(p, c, t, d) {
    const r = B.chk && B.chk.ok && B.chk.key === chkKey() ? B.chk : null, f = feesNow(), o = {};
    o.liq = r ? liqTxt(r) : '–';
    // its label names both sides when the figure shows both (a neutral grid), as the review does (audit C02)
    o.liqk = r && !r.cross_margin && r.est_liq_px && r.est_liq_px.long && r.est_liq_px.short ? _t('Est. liq. long / short') : _t('Est. liquidation');
    o.lossk = lossLabel(r, c);
    o.loss = !r ? '–' : r.loss_at_stop_usd != null ? `<span class="dn">\u2212${fmtU(r.loss_at_stop_usd)}</span>` : stopOf(r, c) ? _t('Not estimated') : _t('No stop loss');
    const pos = t * (c.leverage || 1);
    o.rt = !t ? '–' : P.GRIDS.includes(B.kind) && p.per ? _t('{usd} a grid round', {usd: fmtU(p.per * 2 * ((f.maker || 0) + (f.rivemont || 0)))})
      : fmtU(pos * 2 * ((f.taker || 0) + (f.rivemont || 0)));
    const s = d && d.stats;
    o.vs = s && P.btIdle(s) ? '–' : s && s.hold_pct != null ? `<span class="${clsOf(s.return_pct)}">${sgnPct(s.return_pct)}</span> · ${_t('hold')} <span class="${clsOf(s.hold_pct)}">${sgnPct(s.hold_pct)}</span>` : B.btBusy ? '…' : '–';
    return o;
  }
  function presetH() {
    const cur = B.preset[B.kind];
    return `<div class="seg lg n3 tb-pre" data-bseg="__pre" role="group">${['safe', 'balanced', 'aggressive'].map(n => `<button type="button" data-bpre="${n}" class="${cur === n ? 'on' : ''}">${PRE[n]}</button>`).join('')}</div>`;
  }
  function stratH() {
    const s = shape();
    const L0 = IND_LABEL(), b = B.basis[B.kind];
    const ind = B.kind === 'indicator' ? `<div class="tb-rows">${prSel('__strat', _t('Indicator'), B.strat, T().IND_STRATS.map(k => [k, L0[k]]))}</div>` : '';
    const basis = b ? `<p class="tb-line" data-bt="basis">${esc(T().basisText(b))}</p>` : '';
    return `<section class="tb-s">${secH(1, _t('Strategy'), B.preset[B.kind] ? '' : `<span class="tb-x">${_t('Custom')}</span>`)}${ind}${presetH()}${basis}` +
      sideH() + ((B.plan || plan()).noAmount ? '</section>' : `<div class="tb-rows"><div class="tb-pr"><span class="k">${_t('Leverage')}</span><span class="tb-lv"><button class="tb-tx" id="tb-mm" type="button">${cross() ? _t('Cross') : _t('Isolated')}${I.chev}</button>` +
      `<button class="tb-tx" id="tb-lev" type="button" aria-haspopup="dialog" aria-label="${_t('Leverage')}"><span class="num">${s.leverage}x</span>${I.chev}</button></span></div></div></section>`);
  }
  /* the few parameters that matter, as rows (the rest under Advanced) */
  function paramsH() {
    const s = shape(), c = cfg(), k = B.kind;
    let rows;
    if (P.GRIDS.includes(k)) rows = `<div class="tb-f2"><div class="tb-pr"><span class="k">${_t('Price range')}</span><span class="tb-rg"><span class="inp tb-pi"><input data-bk="lower" inputmode="decimal" autocomplete="off" value="${c.lower == null ? '' : esc(c.lower)}" aria-label="${_t('Low')}"></span>` +
        `<span class="dash">–</span><span class="inp tb-pi"><input data-bk="upper" inputmode="decimal" autocomplete="off" value="${c.upper == null ? '' : esc(c.upper)}" aria-label="${_t('High')}"></span></span></div>` +
        hintH(_t('It trades only inside this range.'), 'rng_rd') + '</div>' +
        prX('grids', _t('Grids'), c.grids, '', {hint: _t('More lines: more, smaller trades. Fewer: bigger, rarer ones.')}) +
        prX('step_pct', _t('Step'), s.grid_by === 'step' && s.step_pct ? s.step_pct : stepNow(c), '%', {hint: _t('The gap between two lines; typing it sets the grids.'), ro: 'gstep_rd'}) +
        segX('spacing', _t('Spacing'), c.spacing === 'geometric' ? 'geometric' : 'arithmetic', [['arithmetic', _t('Same $ gap')], ['geometric', _t('Same % gap')]],
          _t('Same % gap earns the same share on every line.')) +
        prRo(_t('Per order'), 'per');
    else if (k === 'dca') rows = roX(_t('Base order'), 'base', _t('Bought when a round starts; the rest waits for the adds.')) +
      prX('so_count', _t('Extra orders'), c.so_count, '', {hint: _t('More adds survive a bigger move but tie up more money.'), ro: 'so_rd'}) +
      prX('so_step_pct', _t('Price step'), s.so_step_pct, '%', {hint: _t('The gap between adds. Wider covers a bigger move.'), ro: 'step_rd'}) +
      prX('so_mult', _t('Size ×'), s.so_mult, '', {hint: _t('Each add against the one before. Above 1 averages faster, risks more.'), ro: 'mult_rd'}) +
      prX('step_scale', _t('Step scale'), s.step_scale || 1, '', {ph: '1', hint: _t('Each gap against the one before. Above 1 spreads the adds out.')}) +
      prX('tp_pct', _t('Take profit'), s.tp_pct, '%', {hint: _t('Beyond the average entry. Smaller: quicker, smaller wins.'), ro: 'tp_rd'});
    else if (P.MORE.includes(k)) {
      // the settings the schema lists, in their groups; the figures the total gives on top (Martingale: its first order
      // and the most it may hold, both from the total, so the cap is always in view)
      const top = k === 'martingale' ? prRo(_t('First order'), 'first') + prRo(_t('Most it may hold'), 'most') : k === 'pair' ? prRo(legLabel(), 'leg')
        : k === 'recurring' ? prRo(_t('Each buy'), 'each') : '';
      return `<section class="tb-s">${secH(2, _t('Parameters'))}${top ? `<div class="tb-rows">${top}</div>` : ''}${k === 'pair' ? spH() + psH() : ''}${schemaRows(k)}</section>`;
    }
    else rows = prRo(_t('Signal'), 'sig') + prX('tp_pct', _t('Take profit'), s.tp_pct, '%', {hint: _t('Closes everything this far in your favour.'), ro: 'tp_rd'}) +
      prX('sl_pct', _t('Stop loss'), s.sl_pct, '%', {hint: _t('Closes everything this far against you.'), ro: 'sl_rd'}) + prRo((c.entry || {}).mode === 'all' ? _t('Order') : _t('First order'), 'first');
    const pick = P.GRIDS.includes(k) ? `<button class="tb-lnk tb-x" type="button" id="tb-pick">${B.pick ? _t('Click both ends · Esc') : _t('Pick on the chart')}</button>` : '';
    const n = advOn(k, s, cfg());
    return `<section class="tb-s">${secH(2, _t('Parameters'), pick)}<div class="tb-rows">${rows}</div>` +
      `<details class="tb-adv" id="tb-adv" ${B.adv ? 'open' : ''}><summary><span>${_t('Advanced')}${n ? `<span class="tb-on">${_t('{n} on', {n})}</span>` : ''}</span>${I.chev}</summary><div class="tb-g">${advRestH()}</div></details></section>`;
  }
  /* Advanced: what the parameter rows leave out */
  function advRestH() {
    const s = shape(), c = cfg(), k = B.kind, out = [];
    if (P.GRIDS.includes(k)) return gridAdv(k, s, c);
    if (k === 'dca') return dcaAdv(s, c);
    const e = s.entry || {mode: 'all'}, ce = c.entry || {};
    out.push(`<div class="tb-sub">${_t('Signal')}</div>`);
    if (s.side === 'neutral') {
      // both directions: one position at a time, each signal closes the open side before the mirror opens
      out.push(segH('timeframe', s.timeframe, T().BOT_TFS.map(t => [t, t])));
      out.push(condsH(s.conditions, 'conditions'));
      if ((s.conditions || []).some(x => x.ind === 'bb'))
        out.push(`<div class="tb-rows"><div class="tb-pr tb-psg"><span class="k">${_t('Exit at')}</span>${segH('exit', s.exit || 'mid', [['mid', _t('Middle')], ['flip', _t('Opposite signal')]], 2, ' sm')}</div></div>`);
      out.push(`<p class="tb-line">${_t('Long on the signal, short on its mirror; each signal closes the open side first.')}</p>`);
      return out.join('');
    }
    out.push(segH('timeframe', s.timeframe, T().BOT_TFS.map(t => [t, t])));
    out.push(condsH(s.conditions, 'conditions'));
    out.push(`<div class="tb-sub">${_t('Entry')}</div>`);
    out.push(segH('entry.mode', e.mode, [['all', _t('At once')], ['split', _t('Split')], ['dca', 'DCA'], ['martingale', _t('Martingale')]], 4, ' sm two'));     // two rows: no name is cut in any language
    if (e.mode === 'split') out.push(segH('entry.by', e.by, [['price', _t('Price steps')], ['candles', _t('Per candle')]], 2, ' sm') +
      `<div class="tb-rows">${prIn('entry.parts', _t('Parts'), ce.parts)}${e.by === 'price' ? prIn('entry.step_pct', _t('Price step'), e.step_pct, '%') : ''}</div>`);
    if (e.mode === 'dca' || e.mode === 'martingale') out.push(`<div class="tb-rows">${prIn('entry.so_count', _t('Extra orders'), ce.so_count)}${prIn('entry.so_step_pct', _t('Price step'), e.so_step_pct, '%')}${prIn('entry.so_mult', _t('Size ×'), e.so_mult)}</div>`);
    out.push(ckH('exit_opposite', s.exit_opposite, _t('Close on opposite signal')));
    out.push(togH('trail_pct', !!s.trail_pct, _t('Trailing stop'), _t('The stop follows the best price this far behind it, never back.'),
      prX('trail_pct', _t('Distance'), s.trail_pct, '%'), 1));
    return out.join('');
  }
  /* how many Advanced options differ from the plain bot (the Advanced line says "3 on") */
  function advOn(k, s, c) {
    if (k === 'dca') return [c.sl_pct, c.be_pct, c.tp_trail_pct, c.tp_base === 'first', c.max_active, s.start, c.start_px, c.repeat === false,
      c.cooldown_min, c.max_rounds, c.max_losses != null && +c.max_losses !== P.DCA_MAX_LOSSES].filter(x => x).length;
    if (P.GRIDS.includes(k)) return [c.trigger_px, c.tp_px, c.sl_px, c.tp_pct, c.sl_pct, c.max_active, c.stop_action === 'keep', s.range_by === 'swing'].filter(x => x).length;
    if (c.conditions) return [c.exit_opposite, c.trail_pct, (c.entry || {}).mode && c.entry.mode !== 'all'].filter(x => x).length;
    return 0;
  }
  /* DCA, Advanced: each option a switch with its plain line (bench section 9.1) */
  function dcaAdv(s, c) {
    const px0 = mkPrice() || 0, sl0 = Math.max(+s.sl_pct || 0, 10);
    return [
      togH('sl_pct', !!s.sl_pct, _t('Stop loss'), _t('Closes everything at this loss and stops the round. Off: no limit to the loss.'),
        prX('sl_pct', _t('Loss'), s.sl_pct, '%', {ro: 'sl_rd'}) + segX('sl_base', _t('Measured from'), s.sl_base === 'avg' ? 'avg' : 'first',
          [['first', _t('First order')], ['avg', _t('Average entry')]], slBaseLine(c)) +
        prX('max_losses', _t('Losses in a row'), s.max_losses || P.DCA_MAX_LOSSES, '', {hint: _t('Stop losses in a row before the bot stops; until then it starts a new round.')}), sl0),
      togH('be_pct', !!s.be_pct, _t('Move stop to breakeven'), _t('Once the price is this far in your favour, the stop moves to your average entry.'),
        prX('be_pct', _t('After'), s.be_pct, '%', {ro: 'be_rd'}), Math.max(r2((+s.tp_pct || 1) / 2), 0.2)),
      togH('tp_trail_pct', !!s.tp_trail_pct, _t('Trailing take profit'), _t('At the target it follows the price and closes on a pullback of this much.'),
        prX('tp_trail_pct', _t('Pullback'), s.tp_trail_pct, '%'), 0.3),
      togH('tp_base', s.tp_base === 'first', _t('Take profit from the first order'), _t('Measured from the first buy, not the average: later exits, more per round.'), '', 'first'),
      togH('max_active', !!s.max_active, _t('Limit orders on the exchange'), _t('Only this many adds rest at once; the next goes out when one fills. Frees margin.'),
        prX('max_active', _t('At once'), s.max_active, '', {hint: _t('Of {n} extra orders.', {n: c.so_count})}), Math.min(2, Math.max(1, c.so_count - 1))),
      togH('start_px', !!s.start_px, _t('Start at a price'), _t('The first round waits until the price reaches this.'),
        prX('start_px', _t('Price'), s.start_px, ''), px0 ? +rp(px0 * (c.side === 'short' ? 1.01 : 0.99)).replace(/,/g, '') : null),
      `<div class="tb-tog"><label class="ck"><input type="checkbox" id="tb-start" ${s.start ? 'checked' : ''}>${_t('Wait for a signal')}</label>${hintH(_t('Each round starts only when these chart conditions are true.'))}` +
        (s.start ? `<div class="tb-in">${segH('start.timeframe', s.start.timeframe, T().BOT_TFS.map(t => [t, t]))}${condsH(s.start.conditions, 'start.conditions')}</div>` : '') + '</div>',
      togH('repeat', s.repeat !== false, _t('Repeat after profit'), _t('Starts a new round after each take profit. Off: one round only.'),
        prX('cooldown_min', _t('Wait between rounds'), s.cooldown_min, _t('min'), {ph: '0'}) +
        prX('max_rounds', _t('Stop after'), s.max_rounds, _t('rounds'), {ph: '∞', hint: _t('Empty: it keeps going until you stop it.')}))].join('');
  }
  /* Grid, Advanced: range method, start and stop prices, what happens at a stop, the cap on resting orders (section 9.2) */
  function gridAdv(k, s, c) {
    const out = [rangeByH()], mk = mkPrice() || 0, num0 = x => x ? +String(rp(x)).replace(/,/g, '') : null;
    if (k === 'infinity') {
      out.push(ckH('trail_up', s.trail_up !== false, _t('Move up with the price'), null, _t('When the price goes above the range, the grid closes and starts again around the new price.')));
      out.push(ckH('trail_down', !!s.trail_down, _t('Move down with the price'), null, _t('When the price falls under the range, the grid closes and starts again around the new price.')));
    }
    out.push(togH('trigger_px', !!s.trigger_px, _t('Start at a price'), _t('Places no order until the price reaches this.'), prX('trigger_px', _t('Price'), s.trigger_px, ''), num0(mk)));
    const short = c.mode === 'short';          // a short grid: its take profit below the range, its stop above it
    out.push(togH('tp_px', !!s.tp_px, _t('Take-profit price'), short ? _t('Stops the grid when the price falls to it.') : _t('Stops the grid when the price reaches it.'), prX('tp_px', _t('Price'), s.tp_px, ''), num0(short ? c.lower && c.lower * 0.98 : c.upper && c.upper * 1.02)));
    out.push(togH('sl_px', !!s.sl_px, _t('Stop-loss price'), short ? _t('Stops the grid when the price rises to it.') : _t('Stops the grid when the price falls to it.'), prX('sl_px', _t('Price'), s.sl_px, ''), num0(short ? c.upper && c.upper * 1.02 : c.lower && c.lower * 0.98)));
    out.push(togH('tp_pct', !!s.tp_pct, _t('Take profit on the investment'), _t('Stops once the grid has made this share of its amount.'), prX('tp_pct', _t('Profit'), s.tp_pct, '%'), 20));
    out.push(togH('sl_pct', !!s.sl_pct, _t('Stop loss on the investment'), _t('Stops once the grid has lost this share of its amount.'), prX('sl_pct', _t('Loss'), s.sl_pct, '%'), 10));
    out.push(togH('stop_outside', s.stop_outside !== false, _t('Stop when the price leaves the range'), _t('Off: it waits for the price to come back.')));
    out.push(segX('stop_action', _t('At a stop'), s.stop_action === 'keep' ? 'keep' : 'close', [['close', _t('Close position')], ['keep', _t('Keep position')]],
      s.stop_action === 'keep' ? _t('Cancels the orders and leaves what it holds open for you.') : _t('Cancels the orders and closes what it holds at market.')));
    out.push(togH('max_active', !!s.max_active, _t('Limit orders on the exchange'), _t('Only the lines nearest the price rest; for exchanges with an order cap.'),
      prX('max_active', _t('At once'), s.max_active, '', {ro: 'cap_rd'}), Math.min(20, Math.max(2, Math.floor((c.grids || 4) / 2)))));
    return out.join('');
  }
  function invNew() {
    const t = B.total[B.kind], a = avail();
    return `<section class="tb-s">${secH(3, _t('Investment'))}<div class="inp tb-amt"><input data-inv="1" inputmode="decimal" autocomplete="off" value="${t == null ? '' : esc(t)}" placeholder="${esc(_t('Min {0}').replace('{0}', num(plan().minTotal)))}" aria-label="${_t('Total investment')}"><span class="u">USDC</span><button class="mx" type="button" id="tb-max">${_t('MAX')}</button></div>` +
      `<div class="tb-sl"><input class="tb-rng" id="tb-rng" type="range" min="0" max="100" step="1" value="${a && t ? Math.min(100, Math.round(t / a * 100)) : 0}" aria-label="${_t('Share of available')}"><div class="tb-tk"><span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div></div>` +
      '<div class="dc" data-bt="levw"></div>' +
      `<div class="tb-rows">${prRo(`${_t('Min. investment')} ${tip(_t('The smallest amount for these settings: every order the bot places meets {v}\'s minimum order. It changes with the leverage, the range or the steps and the number of orders.', {v: L(S.venue)}))}`, 'min')}` +
      `${prRo(`${_t('Available')} ${tip(_t('Margin free on {v} now: what the exchange reports as free, not held by open positions or orders.', {v: L(S.venue)}))}`, 'avail')}` +
      (BP === '2' ? '' : prRo(`${_t('Fees per fill')} ${feeTip()}`, 'fee') + (P.GRIDS.includes(B.kind) ? prRo(_t('Profit/grid'), 'pg') : prRo(_t('Position'), 'pos'))) + '</div>' +
      riskH() + (BP !== '2' ? '<div class="dc" data-bt="fund"></div><div class="dc" data-bt="warn"></div>' : '') + '</section>';
  }
  /* the risk rows, always above Create (bench section 9, point 6) */
  function riskH() {
    if ((B.plan || plan()).noAmount) return '';
    return `<div class="tb-sub">${_t('Risk')}</div><div class="tb-rows tb-risk">` +
      prRo(`<span data-bv="liqk">${vals().liqk}</span> ${tip(_t('Where the exchange would close the position once every planned order has filled (isolated margin at this leverage). On cross margin it depends on your whole account.'))}`, 'liq') +
      prRo(`<span data-bv="lossk">${vals().lossk}</span> ${tip(_t('What the stop loss costs with every planned order filled, before fees and funding. A grid that only moves its range has no stop loss: the figure is then what it loses when the range moves.'))}`, 'loss') +
      prRo(`${_t('Fees per round')} ${tip(_t('Exchange and Rivemont fees to open and close one round at full size.'))}`, 'rt') +
      prRo(`${_t('Backtest vs holding')} ${tip(_t('The backtest\'s result against buying the coin with the same amount and holding it, over the same days. A simulation.'))}`, 'vs') + '</div>';
  }
  /* design 2's right pane and design 3's second column: what the bot will do, the key figures, the checks */
  function sideNew() {
    const key = P.GRIDS.includes(B.kind) ? prRo(_t('Range'), 'range') + prRo(_t('Profit/grid'), 'pg') : B.kind === 'dca' ? prRo(_t('Extra orders'), 'so') + prRo(_t('Take profit'), 'tp')
      : P.MORE.includes(B.kind) ? prRo(_t('Plan'), 'plan') + prRo(_t('TP / SL'), 'tpsl') : prRo(_t('Signal'), 'sig') + prRo(_t('TP / SL'), 'tpsl');
    return `<section class="tb-s tb-sd"><div class="tb-sum" data-bt="sum">${sumH()}</div>` +
      (BP === '2' ? `<div class="tb-rows">${key}${prRo(_t('Position'), 'pos')}${prRo(`${_t('Fees per fill')} ${feeTip()}`, 'fee')}</div>` : '') +
      (BP === '3' ? '' : '<div class="dc" data-bt="fund"></div><div class="dc" data-bt="warn"></div>') + '</section>';     // design 3: under the investment
  }
  function btNew() { return `<section class="tb-s tb-bts"><div class="dc" data-bt="bt">${btH()}</div><button class="tb-lnk" type="button" id="tb-share">${_t('Share settings')}</button></section>`; }
  const footNew = () => `<div class="tb-foot"><div class="tb-blk" data-bt="blk"></div>${BP === '3' ? '' : `<button class="go n" id="tb-go" type="button">${_t('Create bot')}</button>`}</div>`;
  /* the panel header's right edge in line with the settings' when the panel shows a scrollbar (terminal.html .bp3 .form > .ph) */
  const gutter = pane => requestAnimationFrame(() => { const f = pane.parentElement; if (f) f.style.setProperty('--sbw', Math.max(0, pane.offsetWidth - pane.clientWidth) + 'px'); });
  function renderNew(pane, tabs) {
    const kt = `<div class="tb-kt">${tabs}</div>`;
    gutter(pane);
    if (BP === '3' && B.view === 'signal') {
      pane.innerHTML = kt + sig3();
      fitStrip(); bindPane(pane); bindLinks(pane); paintChartNote(); drawLines2(); paintStrip();
      return;
    }
    if (B.view === 'signal') {
      pane.innerHTML = kt + `<div class="tb-one">${sigPane()}</div>`;
      fitStrip(); bindPane(pane); bindLinks(pane); paintChartNote(); drawLines2(); paintStrip(); return;
    }
    plan();
    const shared = B.shared ? `<div class="hint">${_t('Copied from “{title}”. Set your total, then start.', {title: esc(B.shared.title)})}</div>` : '';
    if (BP === '1') pane.innerHTML = kt + shared + stratH() + paramsH() + invNew() + btNew() + footNew();
    else if (BP === '2') pane.innerHTML = kt + shared + `<div class="tb-split"><div class="tb-c1">${stratH() + paramsH() + invNew()}</div><div class="tb-c2">${sideNew() + btNew() + footNew()}</div></div>`;
    else pane.innerHTML = kt + shared + `<div class="tb-split"><div class="tb-c1">${stratH() + paramsH() + sideNew()}</div><div class="tb-c2">${invNew() + footNew() + btNew()}</div></div>`;
    fitStrip();
    bindPane(pane);
    paintLive(true);
    paintChartNote();
  }
  /* design 3's Signal bot tab in the Grid tab's structure: what the bot does on
     the left; the setup's figures on the right; the strip over the chart shows the key figures and the one primary (as
     Create for the other bots: no second button in the panel), which hands over to the bot's own screen */
  const kvRow = (label, v) => `<div class="tb-pr"><span class="k">${label}</span><span class="v">${v}</span></div>`;
  const hook = () => (S.me && S.me.hook && S.me.hook.enabled) ? S.me.hook : null;
  const exN = () => S.me ? String((S.venues || []).filter(v => v.connected).length) : '–';      // exchanges an alert can trade on
  function sig3() {
    const h = hook(), n = S.me && S.me.signals ? S.me.signals.length : null;
    const left = `<section class="tb-s">${secH(1, _t('Signal bot'))}<ul class="tb-ul">` +
        [_t('Alerts from TradingView, Telegram or your own tools'), _t('Each alert places the order you set up'), _t('Take profits split over the targets; the stop moves as they hit'),
          _t('Size by a fixed margin or by the % of your balance at risk'), _t('Late alerts refused; every refusal listed with its reason'), _t('Same fees and checks as any Rivemont order')].map(x => `<li>${x}</li>`).join('') + '</ul></section>' +
      `<section class="tb-s tb-q">${secH(2, _t('Sources'))}<div class="tb-rows">${kvRow('TradingView', _t('Webhook'))}${kvRow(_t('Your own tools'), _t('Webhook'))}${kvRow(_t('Telegram channels'), 'Telegram')}</div></section>`;
    const right = `<section class="tb-s">${secH(3, _t('Your setup'))}<div class="tb-rows">` +
        kvRow(_t('Webhook'), h ? _t('On') : _t('Not set up')) + (h && h.max_leverage ? kvRow(_t('Max leverage'), h.max_leverage + 'x') : '') +
        kvRow(_t('Signals received'), n == null ? '–' : String(n)) + (S.me && (S.me.signals_failed || []).length ? kvRow(_t('Failed signals'), `<a class="tb-lnk" href="/bots/signals">${S.me.signals_failed.length}</a>`) : '') +
        (h ? kvRow(_t('Max signal age'), h.max_lag_s ? _t('{n} s', {n: h.max_lag_s}) : _t('No check')) : '') + kvRow(_t('Exchanges'), exN()) +
        kvRow(`${_t('Fees per fill')} ${feeTip()}`, esc(feeTxt())) + '</div></section>';
    return `<div class="tb-split tb-2"><div class="tb-c1">${left}</div><div class="tb-c2">${right}</div></div>`;
  }
  /* design 3: the bot's key figures in the market bar, Create at its right end (radar/web/terminal.html statsHtml puts them
     into the bar's one grid of labels and values on a desktop; on a phone they are a two-column strip over the chart).
     [key, label, value, rank]: when the bar is too narrow the highest rank goes first (statsMore), never cut */
  function stripItems() {
    if (BP !== '3' || !C() || !T()) return [];
    if (B.view === 'signal') { const h = hook(), n = S.me && S.me.signals ? S.me.signals.length : null;
      return [['wh', _t('Webhook'), h ? _t('On') : _t('Not set up'), 1], ['sr', _t('Signals received'), n == null ? '–' : String(n), 2], ['ex', _t('Exchanges'), exN(), 4]].concat(h && h.max_leverage ? [['ml', _t('Max leverage'), h.max_leverage + 'x', 3]] : []); }
    if (B.priv) return privStrip();
    const v = vals(), bt = `${_t('Backtest')} <i class="tb-sim">${_t('Simulation')}</i>`;
    const a = P.GRIDS.includes(B.kind) ? [['range', _t('Price range'), v.range, 3], ['pg', _t('Profit/grid'), v.pg, 1], ['per', _t('Per order'), v.per, 5]]
      : B.kind === 'martingale' ? [['first', _t('First order'), v.first, 3], ['most', _t('Most it may hold'), v.most, 1], ['tpsl', _t('TP / SL'), v.tpsl, 5]]
      : B.kind === 'pair' ? [['leg', legLabel(), v.leg, 3], ['tpsl', _t('TP / SL'), v.tpsl, 5]].concat(B.ps && B.ps.d && B.ps.d.ok ? [['beta', _t('Beta'), B.ps.d.beta.toFixed(2), 6]] : [])
      : B.kind === 'recurring' ? [['each', _t('Each buy'), v.each, 3], ['tpsl', _t('TP / SL'), v.tpsl, 5]]
      : P.MORE.includes(B.kind) ? [['pos', _t('Position'), v.pos, 3], ['tpsl', _t('TP / SL'), v.tpsl, 5]]
      : B.kind === 'dca' ? [['base', _t('Base order'), v.base, 3], ['so', _t('Extra orders'), v.so, 5], ['tp', _t('Take profit'), v.tp, 1]]
      : [['sig', _t('Signal'), v.sig, 1], ['tpsl', _t('TP / SL'), v.tpsl, 3], ['first', _t('Order'), v.first, 5]];
    return a.concat([['fee', _t('Fees per fill'), v.fee, 4], ['bt', bt, v.bt, 2]]);
  }
  const stripStats = () => stripItems().map(([k, l, v, r]) => `<div class="stat bf" data-f="${k}" data-rank="${r}"><span class="k">${l}</span><span class="v">${v}</span></div>`).join('');
  /* the workspace's one primary: New bot, to the guided setup on this market and exchange (radar/web/bot-flow.js) */
  const newHref = () => `/bots/new?coin=${encodeURIComponent(S.coin)}&venue=${encodeURIComponent(S.venue)}`;
  function paintStrip() {
    const el = $('tb-strip'); if (!el) return;
    if (WS) { const h = newHref(); if (el.dataset.h !== h) { el.innerHTML = `<a class="go n button primary" id="tb-new" href="${esc(h)}" title="${_t('New bot')}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true"><path d="M12 4v16M4 12h16"/></svg><span class="tbn-l">${_t('New bot')}</span></a>`; el.dataset.h = h; } if ($('lab-cfg') && LAB.at !== S.coin + '|' + S.venue) { LAB.at = S.coin + '|' + S.venue; labMarket(); } return; }
    const items = stripItems();
    const h = items.map(([k, l, v]) => `<div class="tb-f" data-f="${k}"><span>${l}</span><b>${v}</b></div>`).join('');
    let fs = el.querySelector('.tb-fs');
    if (!fs) { el.innerHTML = `<div class="tb-fs"></div><button class="go n" id="tb-go" type="button">${_t('Create bot')}</button>`; fs = el.querySelector('.tb-fs');
      $('tb-go').onclick = () => { const to = $('tb-go').dataset.href; if (to) location.href = to; else openReview(); }; }
    if (fs.dataset.h !== h) { fs.innerHTML = h; fs.dataset.h = h; }
    // the strip's primary: Create for the bots set up here; the Signal bot tab hands over to its screen
    const go = $('tb-go');
    const [lab, to] = B.view === 'signal' ? [_t('Set up the Signal bot') + ' ›', '/bots/signals'] : [S.signedOut ? _t('Connect wallet') : _t('Create bot'), ''];
    if (go.textContent !== lab) go.textContent = lab;
    if (to) go.dataset.href = to; else delete go.dataset.href;
    go.hidden = !items.length && !to;
    if (!isPhone() && typeof statsHtml === 'function' && $('stats')) { const x = statsHtml(); if ($('stats').dataset.h !== x) { $('stats').innerHTML = x; $('stats').dataset.h = x; statsMore(); } }
  }
  /* design 3: the divider between chart and settings (dragged; double-click: half and half; kept in this browser) */
  function initSplit() {
    const term = $('term'), form = $('p-form'); if (!term || !form || $('tb-div')) return;
    const d = document.createElement('div'); d.className = 'tb-div'; d.id = 'tb-div'; d.setAttribute('role', 'separator'); d.setAttribute('aria-orientation', 'vertical');
    d.title = _t('Drag to resize · double-click to reset');
    form.appendChild(d);
    const apply = r => { r = Math.max(.3, Math.min(.7, +r || .5)); term.style.setProperty('--bs1', r.toFixed(3) + 'fr'); term.style.setProperty('--bs2', (1 - r).toFixed(3) + 'fr'); return r; };
    apply(pref.get('bsplit', '.5'));
    d.addEventListener('pointerdown', e => {
      if (isPhone()) return;
      e.preventDefault(); d.setPointerCapture(e.pointerId); d.classList.add('on');
      const b = term.getBoundingClientRect(), pad = parseFloat(getComputedStyle(term).paddingLeft) || 0;
      let r = null;
      const mv = ev => { r = apply((ev.clientX - b.left - pad) / (b.width - 2 * pad)); };
      const up = () => { d.classList.remove('on'); d.removeEventListener('pointermove', mv); d.removeEventListener('pointerup', up); if (r != null) pref.set('bsplit', r.toFixed(3)); };
      d.addEventListener('pointermove', mv); d.addEventListener('pointerup', up);
    });
    d.addEventListener('dblclick', () => { apply(.5); pref.set('bsplit', null); });
  }
  function initStrip() {
    if (FLOW || (BP !== '3' && !WS) || $('tb-strip')) return;
    const s = document.createElement('div'); s.className = 'tb-strip'; s.id = 'tb-strip';
    const place = () => { const st = $('stats'), term = $('term'), ha = $('tm-hact'), pc = $('p-chart');
      if (WS && ha) { if (s.parentElement !== ha) ha.prepend(s); }        /* the workspace design: New bot beside the page title */
      else if (isPhone()) { if (s.parentElement !== pc.parentElement) pc.parentElement.insertBefore(s, pc); }
      else if (st && s.parentElement !== st.parentElement) ($('st-more') || st).after(s);
      paintStrip(); };
    place();
    matchMedia('(max-width: 860px)').addEventListener('change', place);
    if (WS) return;
    initSplit();
  }
  function render() {
    if (!C() || !T()) return;
    if (FLOW) { flowHook('render'); return; }
    if (WS) { paintStrip(); labPaint(); return; }          /* the workspace: no setup panel, a New bot entry (paintStrip), the Backtest lab */
    const pane = $('bot-pane'); if (!pane) return;
    const on = B.panel === 'bot';
    pane.hidden = !on; $('form').hidden = on;
    document.querySelectorAll('[data-p]').forEach(b => { if (b.closest('#f-tabs, #fsw')) b.classList.toggle('on', b.dataset.p === B.panel); });
    if (!on) { paintChartNote(); return; }
    if (typeof loadMM === 'function') loadMM();         /* the coin's margin mode on the exchange (the default pick) */
    if (B.priv) { renderPriv(pane); return; }
    const keep = document.activeElement && pane.contains(document.activeElement) ? (document.activeElement.dataset.bk || (document.activeElement.dataset.inv ? '__inv' : null)) : null;
    // the bot type: one row with the current type; the catalog opens in a sheet (the same picker in every panel design)
    if (NEW) { renderNew(pane, pickerH()); refocus(pane, keep); return; }
    let h = `<div class="tb-g">${pickerH()}</div>`;
    // the Signal bot is set up on its own page (alerts, webhook, channels): this tab hands over to it
    if (B.view === 'signal') { pane.innerHTML = h + sigPane(); bindPane(pane); paintChartNote(); drawLines2(); return; }
    plan();
    if (B.shared) h += `<div class="hint">${_t('Copied from “{title}”. Set your total, then start.', {title: esc(B.shared.title)})}</div>`;
    const der = `<div class="kv tb-der" data-bt="der">${derH()}</div>`, sum = `<div class="tb-sum" data-bt="sum">${sumH()}</div>`,
      adv = `<details class="tb-adv" id="tb-adv" ${B.adv ? 'open' : ''}><summary>${_t('Advanced')}${I.chev}</summary><div class="tb-g">${advH()}</div></details>`,
      checks = `<div class="dc" data-bt="fund"></div><div class="dc" data-bt="warn"></div><div class="tb-blk" data-bt="blk"></div>`,
      acts = `<div class="tb-acts"><button class="btn2" id="tb-bt" type="button">${_t('Backtest [button]')}</button><button class="go n" id="tb-go" type="button">${_t('Create bot')}</button></div>`,
      btc = `<div class="dc" data-bt="bt">${btH()}</div>`, share = `<button class="tb-lnk" type="button" id="tb-share">${_t('Share settings')}</button>`, bt = btc + share;
    // all-in fees in view before Create (the bot's orders pay the exchange's fee, plus Rivemont's where it applies)
    const fr = (typeof fees === 'function' && fees()) || (typeof venueInfo === 'function' && venueInfo(S.venue).fee) || null;   /* fees(): the coin's own level (HIP-3) */
    const feeRow = fr ? `<div class="tb-al tb-fee"><span>${_t('Fees per fill')}</span><b>${esc(L(S.venue))} ${fr.maker === fr.taker ? C().fmtRate(fr.maker) : C().fmtRate(fr.maker) + '–' + C().fmtRate(fr.taker)}${fr.rivemont ? ` + Rivemont ${C().fmtRate(fr.rivemont)}` : ''}</b></div>` : '';
    // the Bot Terminal's wide panel: what the bot does on the left, the money, the checks and the backtest on the right
    // what the bot does and how it would have done on the left; the money, the checks and Create on the right
    h += BOTMODE ? `<div class="tb-cols"><div class="tb-col"><div class="tb-cap">${_t('Parameters')}</div>${chipsH() + sideH() + levRow() + der + (B.kind === 'pair' ? spH() + psH() : '') + adv}</div>` +
        `<div class="tb-col">${invH() + feeRow + sum + checks + acts + share}</div></div>` + btc
      : invH() + chipsH() + sideH() + levRow() + der + sum + adv + checks + acts + bt;
    pane.innerHTML = h;
    bindPane(pane);
    paintLive(true);
    paintChartNote();
    refocus(pane, keep);
  }
  function refocus(pane, keep) {
    if (keep) { const i = keep === '__inv' ? pane.querySelector('[data-inv]') : pane.querySelector(`[data-bk="${keep}"]`); if (i) { i.focus(); if (i.setSelectionRange && i.value) i.setSelectionRange(i.value.length, i.value.length); } }
  }
  /* the bot type: one row with the current type; the catalog (groups, icons, one line each) opens in a sheet */
  const extraName = () => _t('Signal bot');
  /* the Bot Terminal's panels (designs 1-3): the most used types as tabs at the top of the setup, as on exchanges, and
     More ▾ (the chosen type's name when it is another) for the whole catalog, as the chart's timeframes (a one-row
     picker read as a heading). The tabs
     that do not fit the panel go to More, never the chosen one (fitStrip) */
  const QUICK = ['grid', 'dca', 'infinity', 'pair', 'signal'];
  const typeName = k => k === 'signal' ? extraName(k) : kindName(k);
  const typeLine = k => k === 'signal' ? _t('Turns your alerts into orders.') : (T().BOT_CATALOG.find(x => x.id === k) || {}).line || '';
  function pickerH() {
    const k = B.view === 'signal' ? 'signal' : B.kind, icon = k === 'signal' ? 'sig' : (T().BOT_CATALOG.find(x => x.id === k) || {}).icon;
    const name = typeName(k);
    if (NEW) {
      const other = !QUICK.includes(k);
      return `<div class="btk-strip" id="tb-types" role="tablist" aria-label="${_t('Bot type')}">` +
        QUICK.map(q => `<button type="button" role="tab" data-bkind="${q}" class="${q === k ? 'on' : ''}" aria-selected="${q === k}" title="${esc(typeLine(q))}">${esc(typeName(q))}</button>`).join('') +
        `<button type="button" class="more${other ? ' on' : ''}" id="tb-kind" aria-haspopup="dialog" aria-label="${_t('Bot types')}"${other ? ` title="${esc(typeLine(k))}"` : ''}>` +
        `<span>${esc(other ? name : _t('More'))}</span>${I.chev}</button></div>`;
    }
    return `<button class="btk-pick" type="button" id="tb-kind" aria-haspopup="dialog" aria-label="${_t('Bot type')}">${T().botIcon(icon)}<b>${esc(name)}</b>${I.chev}</button>`;
  }
  /* the tabs that do not fit go to More, from the end; the chosen one always stays */
  function fitStrip() {
    const s = $('tb-types'); if (!s) return;
    const qs = [...s.querySelectorAll('[data-bkind]')];
    qs.forEach(b => { b.hidden = false; }); s.classList.remove('shr');
    for (let i = qs.length - 1; i >= 0 && s.scrollWidth > s.clientWidth + 1; i--) if (!qs[i].classList.contains('on')) qs[i].hidden = true;
    if (s.scrollWidth > s.clientWidth + 1) s.classList.add('shr');          // a long type name on a phone: More's name is cut last
  }
  addEventListener('resize', () => requestAnimationFrame(fitStrip));
  function openKinds() {
    const cur = B.view === 'signal' ? 'signal' : B.kind, cat = T().BOT_CATALOG;
    const item = (id, icon, name, line, risk) => `<button class="btk-it${id === cur ? ' on' : ''}" type="button" data-bkind="${id}">${T().botIcon(icon)}<b>${esc(name)}</b>` +
      `<span>${esc(line)}${risk ? ` <em class="rk">${_t('High risk')}</em>` : ''}</span></button>`;
    const extra = {custom: [item('signal', 'sig', extraName('signal'), _t('Turns your alerts into orders.'))]};
    const groups = Object.entries(T().BOT_GROUP).map(([g, name]) => {
      const its = cat.filter(x => x.group === g).map(x => item(x.id, x.icon, x.name, x.line, x.risk === 'high')).concat(extra[g] || []);
      return its.length ? `<section class="btk-sec"><div class="btk-gh">${esc(name)}</div><div class="btk-grp">${its.join('')}</div></section>` : '';
    }).join('');
    /* the market filter (the Bots overview's tabs, the same remembered choice): All | Sideways | Uptrend | Downtrend | Hedged */
    const mk = botMarket(), tabs = [['', _t('All')]].concat(Object.entries(T().BOT_MARKET));
    openSheet(`<div class="sh-h"><h3>${_t('Bot type')}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b"><div class="btk-mk" role="tablist" aria-label="${_t('Market')}">${tabs.map(([k, l]) => `<button type="button" role="tab" data-mk="${k}" class="${k === mk ? 'on' : ''}" aria-selected="${k === mk}">${esc(l)}</button>`).join('')}</div>
      <div class="btk-list">${groups}</div></div>`, 'btk');
    const filt = k => {
      document.querySelectorAll('.btk-mk [data-mk]').forEach(b => { b.classList.toggle('on', b.dataset.mk === k); b.setAttribute('aria-selected', b.dataset.mk === k); });
      document.querySelectorAll('.btk-list [data-bkind]').forEach(b => { b.hidden = !!k && !(T().BOT_MARKETS[b.dataset.bkind] || []).includes(k); });
      document.querySelectorAll('.btk-list .btk-sec').forEach(s => { s.hidden = !s.querySelector('[data-bkind]:not([hidden])'); });
    };
    filt(mk);
    document.querySelectorAll('.btk-mk [data-mk]').forEach(b => b.onclick = () => { botMarket(b.dataset.mk); filt(b.dataset.mk); });
    document.querySelectorAll('.btk-list [data-bkind]').forEach(b => b.onclick = () => { closeSheet(); setPanel('bot'); onSeg('__kind', b.dataset.bkind); });
  }
  /* the chosen market tab, remembered for this browser (shared with the Bots overview; '' = All) */
  function botMarket(set) {
    try { if (set != null) localStorage.setItem('rv_bot_market', set); const v = localStorage.getItem('rv_bot_market') || ''; return v in T().BOT_MARKET ? v : ''; }
    catch (e) { return set || ''; }
  }
  /* everything the numbers change, without touching the inputs (focus and caret stay): the derived rows, the summary,
     the blocking lines, the button, the chart lines. Called on every input; the server check follows (schedule) */
  function paintLive(now) { paintLive0(now); flowHook('paint'); if (WS) labLive(); }
  function paintLive0(now) {
    if (B.priv && B.panel === 'bot') { paintPriv(); return; }
    if (B.panel !== 'bot' || (NEW && B.view === 'signal')) { paintStrip(); return; }
    plan();
    if (NEW) paintVals();
    const r = B.chk && B.chk.key === chkKey() ? B.chk : null, bl = blocks();
    document.querySelectorAll('[data-bt="der"]').forEach(e => { e.innerHTML = derH(); });
    document.querySelectorAll('[data-bt="sum"]').forEach(e => { e.innerHTML = sumH(); });
    document.querySelectorAll('[data-bt="blk"]').forEach(e => { e.innerHTML = blocksH(bl); bindLinks(e); });
    document.querySelectorAll('[data-bt="warn"]').forEach(e => { e.innerHTML = r && r.ok ? r.warnings.slice(0, 2).map(w => `<div class="warn">${esc(w)}</div>`).join('') : ''; });
    document.querySelectorAll('[data-bt="fund"]').forEach(e => { e.innerHTML = fundH(); bindLinks(e); });
    document.querySelectorAll('[data-bt="levw"]').forEach(e => { const x = levH(r); if (e.innerHTML !== x) { e.innerHTML = x; bindLinks(e); } });
    const a = avail(); document.querySelectorAll('[data-bt="avail"]').forEach(e => { e.textContent = a == null ? '–' : num(a) + ' USDC'; });
    const inv = document.querySelector('#bot-pane [data-inv], #bf [data-inv]'); if (inv) inv.placeholder = _t('Min {0}').replace('{0}', num(B.plan.minTotal));
    const g = $('tb-go');
    if (g && S.signedOut) { g.disabled = false; g.textContent = _t('Connect wallet'); }
    else if (g) { g.disabled = bl.length > 0; g.textContent = bl.some(b => b.soon) ? _t('Coming soon') : bl.some(b => b.wait) ? _t('Loading…') : _t('Create bot'); }
    if ($('tb-share')) $('tb-share').disabled = !(r && r.ok);
    if ($('sh-go-bot')) $('sh-go-bot').disabled = !(r && r.ok) || bl.length > 0;
    if (now) drawLines2();
    else { cancelAnimationFrame(B.raf); B.raf = requestAnimationFrame(drawLines2); }
  }

  /* ---------------- the server check (150 ms after the last input) ---------------- */
  window.TB_REFRESH = () => { if (B.panel === 'bot') { render(); schedule(true); } };
  function schedule(now) {
    if (WS) { if (labOn()) { clearTimeout(B.timer); B.timer = setTimeout(runCheck, now ? 0 : 150); } return; }     /* the lab: the check (liquidation, errors), its own test on Run */
    clearTimeout(B.timer); B.timer = setTimeout(runCheck, now ? 0 : 150); scheduleBt();
  }
  async function runCheck() {
    if (B.priv) return privCheck();
    loadPs();
    if (B.panel !== 'bot' || !C() || !(total() > 0 || plan().noAmount) || (P.GRIDS.includes(B.kind) && !(cfg().upper > cfg().lower))) { paintReviewCheck(); return; }
    const body = {kind: B.kind, config: payload()}, want = JSON.stringify(body), seq = ++B.seq;
    try { const r = await api0('/api/auto/bots/check', body); if (seq === B.seq && want === chkKey()) { B.chk = {...r, key: want}; paintLive(); paintReviewCheck(); } }
    catch (e) { if (seq === B.seq) { B.chk = {ok: false, error: e.message, key: want}; paintLive(); paintReviewCheck(); } }
  }
  const liqTxt = r => { if (!r) return '–'; if (r.cross_margin) return _t('Depends on your account'); const l = r.est_liq_px || {};
    const a = [l.long, l.short].filter(x => x); return a.length ? a.map(x => px(x)).join(' / ') : '–'; };
  function factsRows(r) {
    const c = r.config || cfg(), rows = [];
    rows.push(row(_t('Investment'), fmtU(r.budget_usd)));
    rows.push(row(_t('Largest position'), fmtU(r.max_position_usd) + (c.leverage > 1 ? `<span class="sub">${c.leverage}x</span>` : '')));
    rows.push(row(r.est_liq_px && r.est_liq_px.long && r.est_liq_px.short ? _t('Est. liq. long / short') : _t('Est. liquidation'), liqTxt(r)));
    if (r.grid_profit_pct) rows.push(row(_t('Profit/grid'), `<span class="${r.grid_profit_pct.min < 0 ? 'dn' : ''}">${fmtLine(r.grid_profit_pct)}</span><span class="sub">${_t('after fees')}</span>`));
    rows.push(row(_t('Fees'), `${esc(r.venue_label || L(S.venue))} ${C().fmtRate((r.maker_pct || 0) / 100)}<span class="sub">${_t('Rivemont {C}', {C: C().fmtRate((r.fee_pct || 0) / 100)})}</span>`));
    rows.push(row(_t('TP / SL'), r.native_triggers ? _t('On the exchange') : _t('Watched by Rivemont')));
    if (!r.cross_margin || r.loss_at_stop_usd != null)
      rows.push(row(lossLabel(r, c), r.loss_at_stop_usd != null ? `<span class="dn">\u2212${fmtU(r.loss_at_stop_usd)}</span><span class="sub">${_t('every order filled')}</span>` : stopOf(r, c) ? _t('Not estimated') : _t('No stop loss')));
    return rows.join('');
  }
  function fundH() {
    const side = T().botSide(B.kind, cfg());
    if (!side || !S.markets) return '';
    const ok = (S.venues || []).filter(v => v.connected && !(((S.me && S.me.blocked && S.me.blocked.bot_venues) || {})[v.id])).map(v => v.id);
    const p = T().fundingPick(S.markets, S.coin, side, S.venue, ok.length ? ok : null);
    if (!p || !(p.rate > 0) || p.venue === S.venue || (p.here != null && p.rate - p.here < 0.000002)) return '';
    const r = x => C().fmtPct(x, 4).replace('+', '');
    return `<p class="tb-line">${(side === 'long' ? _t('Longs earn {rate}/h on {venue}', {venue: esc(L(p.venue)), rate: r(p.rate)}) : _t('Shorts earn {rate}/h on {venue}', {venue: esc(L(p.venue)), rate: r(p.rate)}))} · <a href="#" data-bven="${p.venue}">${_t('Use {v}', {v: esc(L(p.venue))})}</a></p>`;
  }

  /* ---------------- wiring ---------------- */
  function applyPreset(n) {
    // a trailing stop's purpose (protect a position held / open one) is the user's, never a plan's (audit BOT-05)
    const keepSide = shape().side, keepMode = shape().mode, keep = {coins: shape().coins, coin_b: shape().coin_b, venue_b: shape().venue_b, entry: B.kind === 'trailstop' ? shape().entry : null};
    B.preset[B.kind] = n; B.bt = null;
    if (B.shared) { B.shared = null; syncUrl(); }                     // a plan over a copy: the copy's link goes too
    const sides = B.kind === 'indicator' ? ['long', 'short', 'neutral'] : T().BOT_SIDES[B.kind] || ['long', 'short'];
    const base = T().BOT_PRESETS[B.kind][n];
    const s = B.shape[B.kind] = presetShape(B.kind, n);
    if (keepSide && !P.GRIDS.includes(B.kind) && sides.includes(keepSide) && keepSide !== base.side) {
      s.side = keepSide;
      if (B.kind === 'indicator') { const sig = T().indSignal(B.strat, n, keepSide === 'short' ? 'short' : 'long'); s.conditions = sig.conditions; }
    }
    if (keepMode && (B.kind === 'grid' || B.kind === 'infinity')) s.mode = keepMode;
    for (const [k, v] of Object.entries(keep)) if (v != null) s[k] = v;
    syncTf();
  }
  function syncTf() { if (B.view === 'signal') return; const s = shape(), t = s.timeframe || (s.start || {}).timeframe;
    if ((B.kind === 'indicator' || P.MORE.includes(B.kind)) && t && t !== S.tf && typeof setTf === 'function') setTf(t); }
  function edited() { B.preset[B.kind] = null; B.bt = null; }
  function setTotal(v) {
    B.total[B.kind] = v == null || !(v > 0) ? null : Math.floor(v * 100 + 1e-7) / 100; B.bad[B.kind] = null;
    const i = document.querySelector('#bot-pane [data-inv], #bf [data-inv], #lab-cfg [data-inv]'); if (i && i !== document.activeElement) i.value = B.total[B.kind] == null ? '' : B.total[B.kind];
    syncRng(); B.bt = null; paintLive(); schedule();
  }
  function syncRng() { const r = $('tb-rng'), a = avail(), t = total(); if (r) r.value = a && t ? Math.min(100, Math.round(t / a * 100)) : 0; }
  function sigPane() {
    return `<div class="tb-sig"><h4>${_t('Signal bot')}</h4><p>${_t('Turns alerts from TradingView, your own tools or a Telegram channel into orders on Hyperliquid. You set it up once; each alert places the order you defined, with the same fees and checks as any Rivemont order.')}</p>` +
      `<a class="go n" href="/bots/signals">${_t('Set up the Signal bot')} ›</a></div>`;
  }
  function onSeg(key, v) {
    if (key === '__kind' && v === 'signal') { B.view = 'signal'; B.shared = null; syncUrl(); render(); return; }
    if (key === '__kind') B.view = null;
    if (key === '__kind') { B.priv = null; B.shared = null; B.kind = v; pref.set('botkind', v); B.bt = B.btLast = null; B.chk = null; syncTf(); syncUrl(); render(); schedule(true); return; }
    const s = shape();
    if (key === 'range_by') { s.range_by = v; if (v === 'swing' && !s.range_n) s.range_n = 30; reRange(); render(); renderReview(); schedule(true); return; }
    if (key === 'entry.mode') { s.entry = clone(T().ENTRY_DEF[v]); edited(); }
    else if (key === 'side' && B.kind === 'indicator') {
      /* the signal stored is the entry of the side shown (Long and Both: the long signal; Short: its mirror), so a signal
         set by hand turns with the side: an RSI-below-30 long becomes an RSI-above-70 short, never a short on oversold */
      const was = s.side === 'short', now = v === 'short';
      s.side = v;
      if (B.preset.indicator) applyPreset(B.preset.indicator);
      else { if (was !== now) s.conditions = (s.conditions || []).map(T().mirrorCond); edited(); }
    }
    else if ((key === 'mode' && B.kind !== 'pair' && B.kind !== 'rebalance') || key === 'side') {
      // a grid turned to or from Short: its take profit and stop change sides of the range (a short grid takes its profit
      // below and stops above), so the two prices swap rather than land on the wrong sides (residual audit bots-engine-08)
      if (key === 'mode' && P.GRIDS.includes(B.kind) && ((s.mode || 'neutral') === 'short') !== (v === 'short') && (s.tp_px != null || s.sl_px != null)) [s.tp_px, s.sl_px] = [s.sl_px, s.tp_px];
      s[key] = v; if (key === 'side') B.sideSet = true;
      // a grid's direction stays across plans (applyPreset); another type's mode is a setting of the plan: one's own now
      // (audit BOT-15: Rebound -> Chase still read Balanced)
      if (key === 'mode' && !P.GRIDS.includes(B.kind)) edited();
    }
    else { setPath(s, key, v); edited(); if (key === 'timeframe' || key === 'start.timeframe') syncTf(); if (key === 'hedge' && v === 'fixed' && s.beta == null) s.beta = 1; }
    if (fillShown(B.kind, s)) syncTf();
    render(); renderReview(); schedule();
  }
  const AUTO = ['so_count', 'grids', 'entry.parts', 'entry.so_count', 'max_adds', 'times', 'levels', 'count'];     // a count set by hand is kept as it is
  function onInput(el) {
    const key = el.dataset.bk, s = shape();
    let v = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : el.value.replace(',', '.').trim();
    /* another indicator: an untouched plan becomes the same plan for the new signal; settings of one's own keep every
       field (take profit, stop loss, entry, chart, leverage ...) and only the signal changes, to the new indicator's
       standard settings for the side shown (audit BOT-01: RSI -> MACD rewrote TP 8% / SL 4% / At once / 1h without a
       word). "Reset to {plan}" stays the explicit way to take a plan's settings. */
    if (key === '__strat') {
      B.strat = v; pref.set('botstrat', v);
      if (B.preset.indicator) applyPreset(B.preset.indicator);
      else { s.conditions = T().indSignal(v, B.rangePre.indicator || 'balanced', s.side === 'short' ? 'short' : 'long').conditions; B.bt = null; }
      render(); renderReview(); schedule(true); return;
    }
    if (el.tagName === 'SELECT' && key.endsWith('.ind')) { setPath(s, key.slice(0, -4), clone(T().COND_DEF[v])); edited(); render(); renderReview(); schedule(); return; }
    if (el.tagName === 'SELECT' && /\.then\.\d+\.do$/.test(key)) { setPath(s, key.slice(0, -3), clone(T().ACTION_DEF[v])); edited(); render(); renderReview(); schedule(); return; }
    if (el.dataset.up) { v = String(el.value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15); if (el.value !== v) el.value = v; v = v || null; }
    else if (el.tagName === 'SELECT' && key === 'venue_b') v = v || null;
    else if (el.tagName !== 'SELECT' && el.type !== 'checkbox') v = v === '' ? null : isFinite(+v) ? +v : v;
    if (key === 'range_n') { const n = +v; if (n >= 10 && n <= 250) { s.range_n = Math.round(n); reRange(); paintLive(); schedule(); } return; }
    // a grid's step and count are linked: the one typed last stays (BotPlan.derive), the other is repainted (paintVals)
    if (P.GRIDS.includes(B.kind) && key === 'step_pct') { s.grid_by = 'step'; s.auto = false; }
    else if (P.GRIDS.includes(B.kind) && key === 'grids') s.grid_by = 'count';
    // Stop and reverse: its fast / slow lengths follow the signal picked (EMA 9 / 21, MACD 12 / 26) unless set by hand
    if (B.kind === 'sar' && key === 'signal') { const STD = {ma_cross: [9, 21], macd: [12, 26]}, was = STD[s.signal], now = STD[v];
      if (now && (!was || (+s.fast === was[0] && +s.slow === was[1]) || s.fast == null)) { s.fast = now[0]; s.slow = now[1]; } }
    setPath(s, key, v); edited();
    if (AUTO.includes(key)) s.auto = false;
    if (key === 'lower' || key === 'upper') { delete s.range; s.range_man = true; }
    paintLive(); schedule();
    // a choice from a list may show or hide other settings (Stop and reverse's signal, the rules' indicator): drawn again
    if (el.tagName === 'SELECT' && key !== '__strat') { render(); renderReview(); }
  }
  function bindPane(box) {
    bindSp(box);
    box.querySelectorAll('[data-bseg]').forEach(s => s.onclick = e => { const b = e.target.closest('button'); if (!b || !s.contains(b)) return;
      if (b.dataset.bpre) { applyPreset(b.dataset.bpre); render(); renderReview(); schedule(true); return; }
      if (b.dataset.v != null) onSeg(s.dataset.bseg, b.dataset.v); });
    box.querySelectorAll('[data-bk]').forEach(el => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => onInput(el)));
    // a number other fields depend on (the pair bot's entry levels show their step and split): drawn again once typed
    box.querySelectorAll('[data-bk=levels]').forEach(el => el.addEventListener('change', () => { render(); schedule(); }));
    box.querySelectorAll('[data-inv]').forEach(el => el.addEventListener('input', () => {
      const v = +el.value.replace(',', '.'), bad = P.amountError(el.value); B.bad[B.kind] = bad ? el.value.trim() : null;
      B.total[B.kind] = !bad && el.value.trim() && isFinite(v) && v > 0 ? v : null; B.bt = null; syncRng(); paintLive(); schedule(); }));
    const rng = box.querySelector('#tb-rng');
    if (rng) rng.addEventListener('input', () => { const a = avail(); if (a > 0) setTotal(Math.floor(a * rng.value) / 100); });
    if (box.querySelector('#tb-max')) box.querySelector('#tb-max').onclick = () => { const a = avail(); if (a > 0) setTotal(a); };
    const NEW = {cond: () => clone(T().COND_DEF.rsi), action: () => clone(T().ACTION_DEF.close), coin: () => ({coin: '', weight: 0}),
                 rule: () => ({logic: 'and', if: [clone(T().COND_DEF.rsi)], then: [clone(T().ACTION_DEF.buy)], cooldown_min: 0, max_runs: 0})};
    box.querySelectorAll('[data-badd]').forEach(b => b.onclick = () => { getPath(shape(), b.dataset.badd).push(NEW[b.dataset.bnew || 'cond']()); edited(); render(); renderReview(); schedule(); });
    box.querySelectorAll('[data-bday]').forEach(b => b.onclick = () => { const list = getPath(shape(), b.dataset.bday) || [], d = +b.dataset.v, i = list.indexOf(d);
      if (i >= 0) { if (list.length > 1) list.splice(i, 1); } else { list.push(d); list.sort(); } edited(); render(); renderReview(); schedule(); });
    if ($('tb-kind')) $('tb-kind').onclick = openKinds;
    box.querySelectorAll('[data-brm]').forEach(b => b.onclick = () => { const p = b.dataset.brm.split('.'), i = +p.pop(), s = shape();
      if (p.join('.') === 'coins') s.coins = P.basketRemove(s.coins, i); else getPath(s, p.join('.')).splice(i, 1); edited(); render(); renderReview(); schedule(); });
    box.querySelectorAll('[data-bcoin]').forEach(b => b.onclick = () => coinSheet(b.dataset.bcoin));
    box.querySelectorAll('[data-beq]').forEach(b => b.onclick = () => { const s = shape(); P.equalWeights((s.coins || []).length).forEach((w, j) => { s.coins[j].weight = w; }); edited(); render(); renderReview(); schedule(); });
    if (box.querySelector('#tb-start')) box.querySelector('#tb-start').onchange = e => { shape().start = e.target.checked ? {timeframe: '1h', conditions: [clone(T().COND_DEF.rsi)]} : null; edited(); render(); schedule(); };
    // an Advanced switch: on sets its setting to the suggested value (its field shows under it), off clears it
    box.querySelectorAll('[data-btog]').forEach(el => el.onchange = () => { const s = shape(), k = el.dataset.btog;
      setPath(s, k, el.checked ? JSON.parse(el.dataset.def || 'null') : null); edited(); render(); renderReview(); schedule(); });
    box.querySelectorAll('.tb-tog > label > input[data-bk]').forEach(el => el.addEventListener('change', () => { render(); renderReview(); }));
    // a (i) tip opens its text in place on a tap: the tablet has no hover
    box.querySelectorAll('.tb-tip').forEach(i => i.onclick = e => { e.preventDefault(); e.stopPropagation(); tipOpen(i); });
    const adv = box.querySelector('#tb-adv'); if (adv) adv.addEventListener('toggle', () => { B.adv = adv.open; pref.set('botadv', adv.open ? '1' : ''); });
    if ($('tb-lev')) $('tb-lev').onclick = openLev2;
    if ($('tb-mm')) $('tb-mm').onclick = () => openMode(() => { render(); schedule(true); });
    if ($('tb-pick')) $('tb-pick').onclick = () => { B.pick = B.pick ? 0 : 1; if (B.pick && isPhone() && !S.chartOpen) toggleChart(true); render(); dhint(B.pick ? _t('Click the chart at one end of the range · Esc to cancel') : null); };
    // the strip's primary hands over to the Signal bot screen (its data-href): never the review sheet there (QA 2026-09-30)
    if ($('tb-go')) $('tb-go').onclick = () => { const to = $('tb-go').dataset.href; if (to) location.href = to; else if (B.view !== 'signal') openReview(); };
    if ($('tb-bt')) $('tb-bt').onclick = () => runBacktest();
    if ($('tb-share')) $('tb-share').onclick = shareSheet;
    bindLinks(box);
    bindTrades(box);
  }
  function tipOpen(i) {
    const host = i.closest('.tb-pr, .fld, .ck, .tb-al, .tb-arh, .tb-bt-h, .tb-h') || i.parentElement, nx = host.nextElementSibling;
    if (nx && nx.classList.contains('tb-tipx')) { nx.remove(); return; }
    const p = document.createElement('p'); p.className = 'tb-hint tb-tipx'; p.textContent = i.getAttribute('title') || i.getAttribute('aria-label') || '';
    host.after(p);
  }
  function bindLinks(box) {
    box.querySelectorAll('[data-bven]').forEach(a => a.onclick = e => { e.preventDefault(); select(S.coin, a.dataset.bven); });
    box.querySelectorAll('[data-bmanage]').forEach(a => a.onclick = e => { e.preventDefault(); showBots(); });
    box.querySelectorAll('[data-bset]').forEach(a => a.onclick = e => { e.preventDefault(); if (B.priv) setPrivAmount(+a.dataset.bset); else setTotal(+a.dataset.bset); });
    box.querySelectorAll('[data-blev]').forEach(a => a.onclick = e => { e.preventDefault(); const s = shape(), v = +a.dataset.blev;
      if (v >= 1 && v !== s.leverage) { s.leverage = v; edited(); render(); schedule(true); } });
    // a private copy blocked on isolated margin: its one fix is Cross, the copier's own pick (as the margin chip)
    box.querySelectorAll('[data-bact="cross"]').forEach(a => a.onclick = e => { e.preventDefault(); useCross(); });
    box.querySelectorAll('[data-bbt]').forEach(b => b.onclick = () => { B.btDays = +b.dataset.bbt; runBacktest(); });
    box.querySelectorAll('[data-brun]').forEach(b => b.onclick = () => runBacktest());
    box.querySelectorAll('[data-bkind]').forEach(b => b.onclick = () => { setPanel('bot'); onSeg('__kind', b.dataset.bkind); });
  }
  /* leverage for the bot: the Terminal's leverage sheet, writing the bot's setting (the total stays: the position grows) */
  function openLev2() {
    const ml = maxL(), s = shape(); let v = s.leverage || 1;
    const ticks = C().levTicks(ml), at = x => `calc(8px + (100% - 16px) * ${((x - 1) / Math.max(1, ml - 1)).toFixed(4)})`;
    openSheet(`<div class="sh-h"><h3>${_t('Bot leverage · {v}', {v: esc(PAIR())})}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b"><div class="stp"><button id="bl-m" type="button" aria-label="${_t('Less')}">−</button><div class="inp"><input id="bl-v" inputmode="numeric" aria-label="${_t('Leverage')}"></div><button id="bl-p" type="button" aria-label="${_t('More')}">+</button></div>
        <div class="lvp" id="bl-pre">${C().levPresets(ml).map(x => `<button data-x="${x}" type="button">${x}x</button>`).join('')}</div>
        <div><input type="range" id="bl-r" min="1" max="${ml}" step="1" aria-label="${_t('Leverage')}"><div class="ticks">${ticks.map(t => `<span style="left:${at(t)}">${t}x</span>`).join('')}</div></div>
        <p class="explain" id="bl-t"></p></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Cancel')}</button><button class="go n" id="bl-go" type="button">${_t('Confirm')}</button></div>`, 'sm');
    const set = x => { v = Math.max(1, Math.min(ml, Math.round(+x || 1)));
      $('bl-v').value = v + 'x'; $('bl-r').value = v; $('bl-m').disabled = v <= 1; $('bl-p').disabled = v >= ml;
      $('bl-pre').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.x === v));
      $('bl-t').textContent = total() > 0 ? _t('Position {usd} at {v}x', {usd: fmtU(total() * v, 0), v}) + (v > 1 ? ' · ' + _t('about {v2}% against it loses the margin', {v2: (100 / v).toFixed(v >= 10 ? 0 : 1)}) : '') : ''; };
    set(v);
    $('bl-m').onclick = () => set(v - 1); $('bl-p').onclick = () => set(v + 1);
    $('bl-r').oninput = e => set(e.target.value); $('bl-v').onchange = e => set(parseInt(e.target.value, 10));
    $('bl-v').onfocus = e => { e.target.value = v; e.target.select(); };
    $('bl-pre').querySelectorAll('button').forEach(b => b.onclick = () => set(b.dataset.x));
    // a leverage of one's own is no longer the preset ("Safe" must not read next to 10x): the preset reads Custom
    $('bl-go').onclick = () => { if (v !== s.leverage) { s.leverage = v; edited(); } closeSheet(); render(); schedule(true); };
  }

  /* ---------------- review / confirm (desktop: centred sheet; phone: the bottom sheet) ---------------- */
  function reviewH() {
    if (B.priv) return privReviewH();
    const r = B.chk && B.chk.ok && B.chk.key === chkKey() ? B.chk : null, c = cfg(), bl = blocks();
    const title = `${_t('Start {coin} {kind} bot on {v}?', {coin: esc(S.coin), kind: kindWord(B.kind), v: esc(L(S.venue))})}`;
    let b = `<div class="kv">${row(_t('Exchange'), esc(L(S.venue)))}${row(_t('Market'), _t('{pair} perpetual', {pair: esc(PAIR())}))}${row(_t('Bot'), `${kindName(B.kind)}<span class="sub">${esc(sideOf(B.kind, {...c, coin: S.coin}))} · ${c.leverage}x</span>`)}` +
      (r ? factsRows(r) : row(_t('Investment'), fmtU(total()))) + '</div>';
    b += r ? `<div class="tb-sum"><div class="k">${_t('What this bot will do')}</div><ol class="tb-ol">${r.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>` + r.warnings.map(w => `<div class="warn">${esc(w)}</div>`).join('')
      : `<div class="tb-sum" data-bt="sum">${sumH()}</div>`;
    b += `<div class="tb-blk">${blocksH(bl.length ? bl : B.chk && B.chk.key === chkKey() && !B.chk.ok ? [{text: B.chk.error}] : [])}</div>`;
    b += `<p class="explain">${_t('Pause or stop it any time under Bots.')} ${tip(_t('Non-custodial: the bot trades in your own {v} account. Rivemont\'s key can trade but can\'t withdraw.', {v: L(S.venue)}))}</p>`;
    const go = `<button class="go n" id="sh-go-bot" type="button" ${r && !bl.length ? '' : 'disabled'}>${r || bl.length ? _t('Start bot') : _t('Checking…')}</button>`;
    return `<div class="sh-h"><h3>${title}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>` +
      `<div class="sh-b" id="tb-sheet">${b}</div><div class="sh-f${isPhone() ? ' stick' : ''}"><button class="bt" data-close type="button">${_t('Cancel')}</button>${go}</div>`;
  }
  let reviewOpen = false;
  function openReview() {
    if (S.signedOut) { if (typeof loginModal === 'function') loginModal(); else location.href = '/assets'; return; }
    if (B.view === 'signal') return;      /* that tab starts on its own screen */
    if (B.priv ? privBlocks().length : blocks().length) return;
    reviewOpen = true;
    openSheet(reviewH());
    $('sheet').dataset.tb = '1';
    bindReview(); schedule(true);
  }
  function renderReview() {
    if (!reviewOpen || $('sheet').hidden || !$('tb-sheet')) { reviewOpen = false; return; }
    const top = $('sheet').scrollTop;
    $('sheet').innerHTML = reviewH();
    $('sheet').querySelectorAll('[data-close]').forEach(b => b.onclick = closeSheet);
    bindReview(); $('sheet').scrollTop = top;
  }
  const paintReviewCheck = () => renderReview();
  function bindReview() {
    const sh = $('sheet');
    bindLinks(sh);
    if ($('sh-go-bot')) $('sh-go-bot').onclick = create;
    new MutationObserver((_, o) => { if (sh.hidden) { reviewOpen = false; sh.dataset.tb = ''; o.disconnect(); } }).observe(sh, {attributes: true, attributeFilter: ['hidden']});
  }
  async function create() {
    const from = B.priv ? B.priv.slug : B.shared && B.shared.slug, btn = () => $('sh-go-bot') || $('bf-go');
    if (B.creating) return;                                  /* one Start, one bot: a second tap while it is sent does nothing */
    B.creating = true; if (btn()) btn().disabled = true; flowHook('paint');
    try {
      const r = await api('/api/auto/bots/create', B.priv ? {key: S.key, kind: B.priv.kind, setup: B.priv.slug, config: privPayload()} : {key: S.key, kind: B.kind, config: payload()});
      if (from) api0(`/api/setups/${encodeURIComponent(from)}/copy`, {key: S.key}).catch(() => {});
      if (FLOW) {                                            /* started: to the Bot Terminal, the new bot lit in its list */
        S.me = {...S.me, ...r};
        const mine = bots().filter(b => b.coin === S.coin && b.venue === S.venue && LIVE.includes(b.status));
        if (window.BotFlow) BotFlow.done();
        location.href = `/bots/terminal?coin=${encodeURIComponent(S.coin)}&venue=${encodeURIComponent(S.venue)}&panel=bots` + (mine.length ? `&bot=${Math.max(...mine.map(b => b.id))}` : '');
        return;
      }
      B.creating = false;
      mergeMe(r); closeSheet(); reviewOpen = false;
      const mine = bots().filter(b => b.coin === S.coin && b.venue === S.venue && LIVE.includes(b.status));
      B.flash = mine.length ? Math.max(...mine.map(b => b.id)) : null;
      B.shared = null; B.priv = null; showBots();
      loadMe();
    } catch (e) { B.creating = false; if (btn()) btn().disabled = false; flowHook('paint'); notice('err', _t('The bot did not start'), e.message); }
  }
  /* the guided setup's Start: signed out, the in-place sign-in (the setup is kept for after it, radar/web/bot-flow.js);
     else the bot starts once nothing blocks it (the same rules as the review sheet) */
  function start() {
    if (S.signedOut) { flowHook('keep'); if (typeof loginModal === 'function') loginModal(); else location.href = '/assets'; return; }
    if (B.priv ? privBlocks().length : blocks().length) return;
    create();
  }

  /* ---------------- backtest these settings, inline ----------------
     It runs on its own: every change of a setting, the
     amount, the period, the market or the type goes through schedule(), and 300 ms after the last one the test of exactly
     those settings runs (scheduleBt). The previous result stays on screen, dimmed, until the new one is in; an answer for
     settings that changed meanwhile is dropped. Before an amount is typed it tests the reference amount below and says so
     ("on $1,000 invested"). */
  const BT_REF = 1000;
  function btReady() {
    if (!BOTMODE || B.panel !== 'bot' || !C() || B.view === 'signal') return false;
    if (B.priv) return true;
    if (amtErr()) return false;
    // an amount under these settings' minimum: the server refuses that test (400), so none is sent; the page says it
    // runs once the amount meets the minimum (round-2 QA 2026-10-07: tests went out at 5 USDC)
    if (total() > 0 && total() < (plan().minTotal || 0) - 1e-9) return false;
    if (P.NO_BT.includes(B.kind)) return false;                                  // no backtest: noBtWhy says why
    if (FLOW && window.BotFlow && BotFlow.hard && BotFlow.hard()) return false;  // the guided setup: settings that cannot work (bot-flow.js hardWhy)
    const c = cfg();
    if (P.GRIDS.includes(B.kind) && !(c.upper > c.lower)) return false;
    if (B.kind === 'pair' && !c.coin_b) return false;
    if (B.kind === 'rebalance' && Math.abs((c.coins || []).reduce((a, x) => a + x.weight, 0) - 100) > 0.01) return false;
    return true;
  }
  /* what the test is asked: the copy of a private setup with the copier's amount and limits, else these settings at the
     amount typed (or BT_REF, at least the minimum, while none is) */
  function btReq() {
    if (B.priv) {
      const a = B.privIn.amount > 0 ? B.privIn.amount : Math.max(100, Math.ceil(B.priv.ref / Math.max(1, B.priv.lev)));
      return {url: `/api/setups/${encodeURIComponent(B.priv.slug)}/hidden/backtest`, body: {...privPayload(), amount: a, days: B.btDays}, amount: a};
    }
    const p = plan(), ref = !(total() > 0) && !p.noAmount;
    const c = ref ? P.derive(B.kind, shape(), Math.max(p.minTotal || 0, BT_REF), {px: mkPrice(), minOrder: minOrder()}).cfg : p.cfg;
    // a grid range the customer did not set (a plan's): centred on the test's first price, as the Backtest lab asks (labReq);
    // the guided setup says so under its result (bot-flow.js rangeNote)
    const auto = FLOW && P.GRIDS.includes(B.kind) && !shape().range_man;
    return {url: '/api/auto/bots/backtest', body: {kind: B.kind, config: {...clone(c), coin: S.coin, venue: S.venue, margin_mode: curMode()}, days: B.btDays, ...(auto ? {recenter: true} : {})}};
  }
  const btKey = () => { const q = btReq(); return JSON.stringify([q.url, q.body]); };
  function scheduleBt(now) {
    clearTimeout(B.btTimer);
    if (!btReady()) { if (B.btBusy) { B.btBusy = false; B.btSeq = (B.btSeq || 0) + 1; } paintBt(); return; }
    const k = btKey();
    if ((B.bt && B.bt.key === k) || (B.btBusy && B.btWant === k)) return;      // this test is on screen or on its way
    B.btTimer = setTimeout(runBacktest, now ? 0 : 300);
    paintBt();                                                                   // the old result dims at once
  }
  async function runBacktest() {
    clearTimeout(B.btTimer);
    if (!btReady()) return;
    const q = btReq(), key = JSON.stringify([q.url, q.body]), seq = B.btSeq = (B.btSeq || 0) + 1;
    B.btBusy = true; B.btWant = key; paintBt();
    let d;
    try { d = await api0(q.url, q.body); if (B.priv) d = {...d, curve: d.curve_pct, amount: q.amount}; }
    catch (e) { d = {error: e.message}; }
    if (seq !== B.btSeq) return;                                                 // newer settings: their test is on its way
    B.btBusy = false; B.btWant = null;
    if (!B.bt || B.bt.key !== key) B.btTr = {};
    B.bt = {...d, key};
    if (!d.error) B.btLast = B.bt;
    paintBt(); if (B.priv) paintStrip();
  }
  const sgnU = x => (x > 0 ? '+' : x < 0 ? '−' : '') + fmtU(Math.abs(x), 2);
  const sgnP = x => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2) + '%';
  const clsOf = x => x > 0 ? 'up' : x < 0 ? 'dn' : '';
  /* the result in dollars: the server's, or (a private setup's copy, sent in percent) the copier's amount times the % */
  const btUsd = d => d.stats.pnl_usd != null ? d.stats.pnl_usd : d.amount ? Math.round(d.stats.return_pct * d.amount) / 100 : null;
  /* the four figures: the result in % of the amount and in dollars, the worst drop, and the trades (with how many won)
     or a grid's closed cycles (backtest.simulate: each cycle wins by design, so a grid has no win rate) */
  function btCells(d) {
    const s = d.stats, u = btUsd(d);
    if (P.btIdle(s)) return `<div><span class="k">${_t('Result')}</span><b>–</b></div><div><span class="k">${_t('Profit')}</span><b>–</b></div>` +
      `<div><span class="k">${_t('Worst drop')}</span><b>–</b></div><div><span class="k">${s.cycles != null ? _t('Grid cycles') : s.rebalances != null ? _t('Rebalances') : _t('Trades')}</span><b>0</b></div>`;
    // a rebalancing basket closes no trade: its rounds back to the weights and the fills that paid the fees
    const n = s.cycles != null ? [_t('Grid cycles'), String(s.cycles)]
      : s.rebalances != null ? [_t('Rebalances'), `${s.rebalances}<span class="m"> · ${_t('Fills')} ${s.fills || 0}</span>`]
      : [_t('Trades'), `${s.trades}${s.wins != null && s.trades ? `<span class="m"> · ${_t('{n} won', {n: s.wins})}</span>` : ''}`];
    // two decimals under 10%: +0.43% reads against the parts below, where +0.4% hid a cent-level sum; parts in percent
    // (a private setup's copy) are to 0.01 pp at any size, so the result is too
    const pd = s.pnl_usd != null && s.fees_usd != null && Math.abs(s.return_pct) >= 10 ? 1 : 2;
    return `<div><span class="k">${_t('Result')}</span><b class="${clsOf(s.return_pct)}">${C().fmtPct(s.return_pct / 100, pd)}</b></div>` +
      `<div><span class="k">${_t('Profit')}</span><b class="${clsOf(u)}">${u == null ? '–' : sgnU(u)}</b></div>` +
      `<div><span class="k">${_t('Worst drop')}</span><b>${ddTxt(s.max_drawdown_pct)}</b></div>` +
      `<div><span class="k">${n[0]}</span><b>${n[1]}</b></div>`;
  }
  /* the result over the test, and buying and holding the coin with the same amount over the same days (dashed): both
     as profit from the start (the server sends equity; a private setup's copy sends %), on one scale with zero in it */
  const hoverJs = () => { if (window.RvHover || document.getElementById('rvh-js')) return;
    const s = document.createElement('script'); s.id = 'rvh-js'; s.src = '/app/chart-hover.js'; s.defer = true; document.head.appendChild(s); };
  function btCurve(d, h) {
    if (d.hold && d.hold.basket && !d.curve_pct) return basketCurve(d, h);
    const s = d.stats, pts = d.curve || [], base = d.budget_usd && !d.curve_pct ? d.budget_usd : 0;
    if (pts.length < 2) return '';
    const hold = (d.hold_curve || []).map(p => [p[0], p[1] - base]), bot = pts.map(p => [p[0], p[1] - base]);
    const ys = bot.concat(hold).map(p => p[1]), lo = Math.min(...ys, 0), hi = Math.max(...ys, 0), sp = (hi - lo) || 1, t0 = bot[0][0], t1 = bot[bot.length - 1][0];
    const line = q => q.map((p, i) => `${i ? 'L' : 'M'}${((p[0] - t0) / Math.max(1, t1 - t0) * 300).toFixed(1)},${(h - 2 - (p[1] - lo) / sp * (h - 4)).toFixed(1)}`).join('');
    const up = (s.pnl_usd != null ? s.pnl_usd : s.return_pct) >= 0;
    /* the hover readout (/app/chart-hover.js, loaded on first use): the bot's line as drawn, profit from the start at
       each point's time */
    const X = t => +((t - t0) / Math.max(1, t1 - t0) * 300).toFixed(1), Y = v => +(h - 2 - (v - lo) / sp * (h - 4)).toFixed(1);
    const hv = JSON.stringify({k: d.curve_pct ? 'pcts' : 'usds', c: up ? 'pos' : 'neg', p: bot.map(p => [p[0], p[1], X(p[0]), Y(p[1])])});
    hoverJs();
    return `<svg class="tb-eq" viewBox="0 0 300 ${h}" preserveAspectRatio="none" aria-label="${esc(_t('Backtest'))}" data-rv-hover='${hv}'>` +
      (hold.length > 1 ? `<path d="${line(hold)}" fill="none" stroke="var(--rv-dim)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : '') +
      `<path d="${line(bot)}" fill="none" stroke="var(--rv-${up ? 'pos' : 'neg'})" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>` +
      (s.hold_pct != null ? `<div class="tb-leg"><span><i class="${up ? '' : 'dnl'}"></i>${_t('This bot')} ${sgnPct(s.return_pct)}</span>` +
        `<span><i class="h"></i>${_t('Buy and hold {coin}', {coin: esc(d.coin || S.coin)})} ${sgnPct(s.hold_pct)}</span></div>` : '');
  }
  /* a basket (the rebalancing bot): its value against "Just holding", the starting weights bought once
     and never rebalanced (backtest hold_curve: only that first buy's fee), both in % from the start on one scale with
     zero in it; the holding line dashed and muted, colour only on the figures */
  const HOLD_TIP = () => _t('Just holding: the same coins bought at the starting weights and never rebalanced. Only the first buy\'s fees are counted.');
  function basketCurve(d, h) {
    const b = d.budget_usd, s = d.stats || {}, hd = d.hold || {};
    if (!(b > 0) || (d.curve || []).length < 2) return '';
    const pc = q => (q || []).map(p => [p[0], (p[1] - b) / b * 100]), bot = pc(d.curve), hold = pc(d.hold_curve);
    const ys = bot.concat(hold).map(p => p[1]), lo = Math.min(...ys, 0), hi = Math.max(...ys, 0), sp = (hi - lo) || 1, t0 = bot[0][0], t1 = bot[bot.length - 1][0];
    const X = t => +((t - t0) / Math.max(1, t1 - t0) * 300).toFixed(1), Y = v => +(h - 2 - (v - lo) / sp * (h - 4)).toFixed(1);
    const line = q => q.map((p, i) => `${i ? 'L' : 'M'}${X(p[0])},${Y(p[1])}`).join('');
    const r = s.return_pct != null ? s.return_pct : bot[bot.length - 1][1], hp = hd.hold_pct != null ? hd.hold_pct : hold.length ? hold[hold.length - 1][1] : null, up = r >= 0;
    const hv = JSON.stringify({k: 'pcts', c: up ? 'pos' : 'neg', p: bot.map(p => [p[0], +p[1].toFixed(3), X(p[0]), Y(p[1])])});
    hoverJs();
    return `<svg class="tb-eq tb-bk" viewBox="0 0 300 ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(_t('Basket value') + ' · ' + _t('Just holding'))}" data-rv-hover='${hv}'>` +
      `<line x1="0" x2="300" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--border, var(--rv-line))" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
      (hold.length > 1 ? `<path d="${line(hold)}" fill="none" stroke="var(--muted, var(--rv-dim))" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : '') +
      `<path d="${line(bot)}" fill="none" stroke="var(--rv-${up ? 'pos' : 'neg'})" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>` +
      `<div class="tb-leg tb-bkl"><span><i class="${up ? 'up' : 'dn'}"></i>${esc(_t('Basket value'))} <b class="${clsOf(r)}">${sgnPct(r)}</b></span>` +
      (hp != null ? `<span title="${esc(HOLD_TIP())}"><i class="h"></i>${esc(_t('Just holding'))} <b class="${clsOf(hp)}">${sgnPct(hp)}</b></span>` : '') +
      `<span class="tb-bkn">${esc(_t('From the start, in %'))}</span></div>` +
      (hp != null ? `<p class="tb-bkt">${esc(HOLD_TIP())}</p>` : '');
  }
  /* ---- the coin tabs over a multi-coin bot's chart: a basket's coins with their weights, a pair's
     two coins; one picks the candles the chart shows (same timeframe), never a setting. The first coin when the type is
     picked; a coin taken out of the basket hands the chart to the first ---- */
  function chartTabs() {
    if (!B.ctab || B.ctab.kind !== B.kind) B.ctab = {kind: B.kind, coin: null};
    const tabs = P.planned(B.kind) && !B.view ? P.chartCoins(B.kind, shape(), S.coin) : [];
    return {tabs, on: P.chartCoinOn(tabs, B.ctab.coin)};
  }
  const setChartTab = c => { B.ctab = {kind: B.kind, coin: P.coinKey(c)}; };
  /* the coin shown when it is not the market's own (the market's own: the page's chart as it is) */
  const chartOther = () => { const {tabs, on} = chartTabs(); return tabs.length && on && on !== P.coinKey(S.coin) ? on : null; };
  const wTxt = w => (Math.round(w * 100) / 100).toLocaleString(document.documentElement.lang || undefined, {maximumFractionDigits: 2}) + '%';
  function ctabsH() {
    const {tabs, on} = chartTabs();
    return tabs.map(t => `<button type="button" role="tab" data-ctab="${esc(t.coin)}" class="${t.coin === on ? 'on' : ''}" aria-selected="${t.coin === on}">` +
      (window.rvCoin ? rvCoin(t.coin, 16) : '') + `<b>${esc(C().mktName(t.coin))}</b>${t.weight != null ? `<span class="w">${esc(wTxt(t.weight))}</span>` : ''}</button>`).join('');
  }
  /* the Backtest lab: the tabs between the market's header and the chart; another coin's candles on a chart of their own
     over the page's chart (its drawings, lines and live price stay the market's), at the page's timeframe */
  function labTabs() {
    const top = $('top'); if (!top) return;
    let row = $('lab-ctabs');
    const h = labOn() ? ctabsH() : '';
    if (!h) { if (row) row.remove(); labVch(); return; }
    if (!row) {
      row = document.createElement('div'); row.id = 'lab-ctabs'; row.className = 'rv-ctabs lab-ctabs'; row.setAttribute('role', 'tablist');
      top.after(row);
      row.addEventListener('click', e => { const b = e.target.closest('[data-ctab]'); if (!b) return; setChartTab(b.dataset.ctab); labTabs(); });
    }
    row.setAttribute('aria-label', _t('Chart'));
    if (row.innerHTML !== h) { row.innerHTML = h; const on = row.querySelector('.on'); if (on && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, on.offsetLeft - 16); }
    labVch();
  }
  const VCH = {ch: null, host: null, key: '', rows: null, push: null, timer: 0};
  const vchBar = r => ({t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r.length > 5 && r[5] != null ? r[5] : 0});
  function vchRead(coin, tf) {
    return (S.venue === 'hyperliquid' && window.__hlCandles ? window.__hlCandles(coin, tf) : Promise.resolve(null)).catch(() => null)
      .then(d => d || fetch(`/api/auto/terminal/candles?venue=${encodeURIComponent(S.venue)}&coin=${encodeURIComponent(coin)}&tf=${encodeURIComponent(tf)}`).then(r => r.ok ? r.json() : null).catch(() => null))
      .then(d => d && Array.isArray(d.candles) ? d.candles : null);
  }
  function labVch() {
    const pb = document.querySelector('#p-chart > .pb'), coin = labOn() ? chartOther() : null;
    if (!coin || !pb) { if (VCH.host) VCH.host.hidden = true; VCH.key = ''; clearInterval(VCH.timer); VCH.timer = 0; return; }
    if (!window.RvChart || !RvChart.available()) return;
    if (!VCH.host) { VCH.host = document.createElement('div'); VCH.host.className = 'lab-vch'; VCH.host.id = 'lab-vch'; VCH.host.innerHTML = '<div class="lab-vchc"></div>'; }
    if (VCH.host.parentNode !== pb) pb.appendChild(VCH.host);
    VCH.host.hidden = false;
    if (!VCH.ch) {          // where the page's chart sits (right of its drawing tools, which draw on the market's own chart)
      VCH.ch = RvChart.init(VCH.host.firstElementChild, {theme: chartColors(), locale: RVI18N.lang === 'zh-CN' ? 'zh-CN' : 'en-US', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', fmtPrice: v => C().fmtPrice(v)});
      if (!VCH.ch) return;
      if (typeof isPhone === 'function' && isPhone() && VCH.ch.rightGap) VCH.ch.rightGap(14);     // as the page's chart on a phone
      VCH.ch.setFeed({history: () => (VCH.rows || []).map(vchBar), subscribe: fn => { VCH.push = fn; return () => { VCH.push = null; }; }, loaded: () => {}});
      const ind = S.ind || {on: ['VOL'], params: {}};               // the page's own indicators, as its chart shows them
      for (const n of ind.on || []) try { VCH.ch.indicators.add(n, (ind.params || {})[n] || C().IND[n].params); } catch (e) {}
      try { new ResizeObserver(() => { if (VCH.host.isConnected && VCH.host.clientWidth && !VCH.host.hidden) VCH.ch.resize(); }).observe(VCH.host.firstElementChild); } catch (e) {}
      addEventListener('rvtheme', () => { if (VCH.ch) VCH.ch.setTheme(chartColors()); });
    }
    const key = [coin, S.venue, S.tf].join('|');
    if (key === VCH.key) return;
    VCH.key = key; VCH.rows = null; VCH.ch.reload();             // never the last coin's candles while this one loads
    const load = again => vchRead(coin, S.tf).then(rows => {
      if (VCH.key !== key || !rows || !rows.length) return;
      if (again && VCH.rows && VCH.push) { const a = VCH.rows; VCH.rows = rows; for (const r of rows.slice(-2)) { const o = a.find(x => x[0] === r[0]); if (!o || o[2] !== r[2] || o[3] !== r[3] || o[4] !== r[4]) VCH.push(vchBar(r)); } return; }
      VCH.rows = rows;
      const p = rows[rows.length - 1][4];
      VCH.ch.setMarket(PAIR(coin, S.venue), L(S.venue), C().priceDecimals(p), C().sizeDecimals(p));
      VCH.ch.setTimeframe(S.tf); VCH.ch.reload(); });
    load(false);
    clearInterval(VCH.timer);
    VCH.timer = setInterval(() => { if (VCH.key === key && !document.hidden) load(true); }, 15000);
  }
  /* the test's trades, newest first, each opening into its orders; CSV of all of them */

  const tmS = t => { if (!t) return '–'; const d = new Date(t * 1000), z = n => String(n).padStart(2, '0');
    return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
  const WHY = () => ({market: _t('Market [order]'), limit: _t('Limit [order]'), tp: _t('Take profit'), sl: _t('Stop loss'), liquidation: _t('Liquidation')});
  function btTradesH(d) {
    const tr = d.trades || [];
    if (!tr.length) return '';
    const W = WHY(), open = B.btTr || {};
    const rows = tr.map((x, i) => [x, i]).reverse().map(([x, i]) => {
      const pnl = x.pnl == null ? `<span class="m">${_t('Open at the end')}</span>` : `<b class="${clsOf(x.pnl)}">${sgnU(x.pnl)}</b>`;
      const ord = open[i] ? `<div class="tb-ord">${x.orders.map(o => `<div><span>${tmS(o.t)}</span><span class="${o.side === 'buy' ? 'up' : 'dn'}">${o.side === 'buy' ? _t('Buy') : _t('Sell')}</span>` +
        `<span><b>${px(o.px)}</b> · ${fmtU(o.usd)}</span><span class="r">${esc(W[o.why] || o.why)}</span></div>`).join('')}` +
        (x.n > x.orders.length ? `<div><span class="m">${_t('{n} orders in all; the first and last are shown', {n: x.n})}</span></div>` : '') + '</div>' : '';
      return `<button type="button" class="tb-tr${open[i] ? ' on' : ''}" data-btr="${i}"><span>${tmS(x.start)} – ${x.end ? tmS(x.end) : '…'} <span class="m">${_t('{n} orders', {n: x.n})}</span></span>${pnl}${I.chev}</button>${ord}`;
    }).join('');
    return `<details class="tb-trs" id="tb-trs"${B.btTrOpen ? ' open' : ''}><summary><span>${_t('Trades · {n}', {n: tr.length})}</span>` +
      `<span><button type="button" class="tb-csv" data-bcsv="1">${_t('Export CSV')}</button> ${I.chev}</span></summary><div class="tb-trl">${rows}</div></details>`;
  }
  /* a CSV file the browser saves (no server: the data is on screen) */
  function saveCsv(name, head, rows) {
    const q = v => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const txt = [head].concat(rows).map(r => r.map(q).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], {type: 'text/csv;charset=utf-8'}));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const iso = t => t ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : '';
  function btCsv() {
    const d = btShown().d; if (!d || !d.trades) return;
    const rows = [];
    d.trades.forEach((x, i) => x.orders.forEach(o => rows.push([i + 1, iso(x.start), iso(x.end), x.pnl, iso(o.t), o.side, o.px, o.size, o.usd, o.fee, o.why])));
    saveCsv(`rivemont-backtest-${S.coin}-${B.kind}-${B.btDays}d.csv`, ['trade', 'start', 'end', 'result_usd', 'order_time', 'side', 'price', 'size', 'value_usd', 'fee_usd', 'type'], rows);
  }
  /* the result on screen: this test's, or the last one dimmed while the test of the new settings runs */
  function btShown() {
    if (!B.priv && amtErr()) return {d: null, err: null, stale: false, bad: true};
    const k = btReady() ? btKey() : null, cur = B.bt && B.bt.key === k ? B.bt : null;
    const d = cur && !cur.error ? cur : B.btLast && !(cur && cur.error) ? B.btLast : null;
    return {d, err: cur && cur.error ? cur : null, stale: !!d && (d !== cur || B.btBusy)};
  }
  function btBody(d, stale, h) {
    const s = d.stats, idle = btIdleText(s);
    return `<div class="tb-btr${stale ? ' ld' : ''}"${stale ? ' aria-busy="true"' : ''}><div class="bst4">${btCells(d)}</div>` +
      (idle ? `<p class="explain">${esc(idle)}</p>` + btNotes(d) + '</div>' : `${btCurve(d, h)}` +
      (s.stopped_because ? `<p class="explain">${_t('It stopped: {why}', {why: esc(s.stopped_because)})}</p>` : '') + btParts(d) + btTradesH(d) + '</div>' + btNotes(d));
  }
  /* why a test in which nothing filled shows dashes (BotPlan.btIdle), in the /s/ setup page's words */
  function btIdleText(s) {
    const w = P.btIdle(s);
    return !w ? '' : w.why === 'start' ? _t('Nothing traded in this test: the start price {px} was never reached.', {px: '$' + (+w.px).toLocaleString('en-US', {maximumFractionDigits: 8})})
      : w.why === 'out' ? _t('Nothing traded in this test: the price stayed outside this range.') : _t('Nothing traded in this test: its entry rule never triggered on these prices.');
  }
  function btH() {
    const days = `<div class="seg" role="group">${[7, 30, 90].map(n => `<button type="button" data-bbt="${n}" class="${B.btDays === n ? 'on' : ''}">${n}d</button>`).join('')}</div>`;
    const {d, err, stale, bad} = btShown();
    const why = noBtWhy(B.kind);
    if (why) return `<div class="tb-bt tb-bt0"><div class="tb-bt-h"><span class="t">${_t('Backtest')}</span></div><p class="explain">${esc(why)}</p></div>`;
    if (NEW) return btNewH(d, err, stale, days, bad);
    const head = t => `<div class="tb-bt-h"><span>${t}<span class="tb-sim">${_t('Simulation')}</span></span>${days}</div>`;
    if (bad) return `<div class="tb-bt tb-bt0">${head(_t('Backtest'))}<p class="explain">${_t('The backtest runs once the amount is valid.')}</p></div>`;
    if (err) return `<div class="tb-bt">${head(_t('Backtest · {btDays} days', {btDays: B.btDays}))}<p class="tb-err">${esc(err.error)}</p></div>`;
    if (!d) return BOTMODE ? `<div class="tb-bt tb-bt0">${head(_t('Backtest'))}<p class="explain">${B.btBusy || B.btTimer && btReady() ? _t('Replaying past prices…') : _t('The backtest of these exact settings shows here as soon as they are complete.')}</p></div>` : '';
    return `<div class="tb-bt">${head(_t('Backtest · {days} days', {days: d.days}))}${btBody(d, stale, 48)}</div>`;
  }
  /* the new panel designs: one card, the same head in every state (the name, Simulation, the period); Run again only
     after an error */
  function btNewH(d, err, stale, days, bad) {
    const head = `<div class="tb-bt-h"><span class="t">${_t('Backtest')}</span><i class="tb-sim">${_t('Simulation')}</i><span class="sp"></span>${days}</div>`;
    if (bad) return `<div class="tb-bt tb-bt0">${head}<p class="explain">${_t('The backtest runs once the amount is valid.')}</p></div>`;
    if (err) return `<div class="tb-bt tb-bt0">${head}<p class="tb-err">${esc(err.error)}</p><button class="btn2 tb-run" id="tb-bt" type="button" data-brun="1">${_t('Run backtest')}</button></div>`;
    if (!d) return `<div class="tb-bt tb-bt0">${head}<p class="explain">${B.btBusy || btReady() ? _t('Replaying past prices…') : _t('The backtest of these exact settings shows here as soon as they are complete.')}</p></div>`;
    return `<div class="tb-bt">${head}${btBody(d, stale, 40)}</div>`;
  }
  /* what the result is made of, adding up to it (the parts must add up to the result):
     backtest.breakdown's parts in dollars, or in % of the amount for a private setup's copy. A grid: what its closed
     cycles made on their lines' gaps, and what the coins it held made or lost (open or already sold); the other bots:
     closed trades before fees, and the position still open at the end. Then the fees and the funding, and the result
     on the amount the test used (the margin, not the position: the position is the amount times the leverage). */
  function btParts(d) {
    // to the cent (or 0.01 pp) for the total and every part alike, so they add up at any size ($2,816 beside $465.19 did not)
    const s = d.stats || {}, usd = s.pnl_usd != null && s.fees_usd != null, k = usd ? '_usd' : '_pct', f = usd ? (x => (x > 0 ? '+' : x < 0 ? '−' : '') + fmtU(Math.abs(x), 2)) : sgnP;
    const grid = s.grid_profit_usd != null || s.grid_profit_pct != null;
    const a = grid ? s['grid_profit' + k] : s['closed_pnl' + k], b = grid ? s['position_pnl' + k] : s['open_pnl' + k];
    const fee = s['fees' + k], fund = s['funding' + k];
    if (a == null || b == null || fee == null) return '';
    const amt = usd ? d.budget_usd : d.amount;
    const rows = [[grid ? _t('Grid profit') : _t('Closed trades'), a, grid ? _t('What the closed buy-and-sell cycles made on their lines\' gaps, before fees.') : _t('What the closed trades made, before fees.')],
      [grid ? _t('Position P&L') : _t('Open position'), b, grid ? _t('What the coins the grid held gained or lost as the price moved, sold since or still open at the end.') : _t('What the position still open at the end of the test is worth.')],
      [_t('Fees'), -fee], [_t('Funding'), fund || 0]];
    const tot = usd ? s.pnl_usd : s.return_pct;
    return `<div class="tb-brk">${rows.map(([l, v, t]) => `<div><span class="k">${l}${t ? ' ' + tip(t) : ''}</span><b class="${clsOf(v)}">${f(v)}</b></div>`).join('')}` +
      `<div class="tot"><span class="k">${amt ? _t('Result on {usd} invested', {usd: fmtU(amt, 0)}) : _t('Result')}</span><b class="${clsOf(tot)}">${f(tot)}</b></div></div>`;
  }
  /* the fee rates and the test's own notes (funding included or not, liquidation, candle limits, one reaction per
     candle) as the server sends them (backtest.run); the costs themselves are in the parts above. An older answer without
     the parts keeps the one line of costs. */
  function btNotes(d) {
    const s = d.stats || {}, sg = (x, f) => x == null ? null : (x > 0 ? '+' : x < 0 ? '−' : '') + f(Math.abs(x));
    const parts = s.closed_pnl_usd != null || s.closed_pnl_pct != null || s.grid_profit_usd != null || s.grid_profit_pct != null;
    const fee = s.fees_usd != null ? sg(-s.fees_usd, x => fmtU(x)) : sg(-s.fees_pct, x => x.toFixed(2) + '%');
    const fund = s.funding_usd != null ? sg(s.funding_usd, x => fmtU(x)) : sg(s.funding_pct, x => x.toFixed(2) + '%');
    const rows = (fee != null && !parts ? [_t('Included in the result: fees {fees}, funding {funding}', {fees: fee, funding: fund == null ? '–' : fund})] : [])
      .concat(d.fees_note ? [d.fees_note] : [], d.notes || []);
    return rows.length ? `<ul class="tb-bnl">${rows.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  }
  function paintBt() { document.querySelectorAll('[data-bt="bt"]').forEach(e => { e.innerHTML = btH(); bindLinks(e); bindTrades(e); }); if (NEW) paintVals(); flowHook('paint'); }
  function bindTrades(e) {
    const dt = e.querySelector('#tb-trs'); if (dt) dt.addEventListener('toggle', () => { B.btTrOpen = dt.open; });
    e.querySelectorAll('[data-btr]').forEach(b => b.onclick = () => { const i = +b.dataset.btr; B.btTr = B.btTr || {}; B.btTr[i] = !B.btTr[i];
      const l = e.querySelector('.tb-trl'), top = l ? l.scrollTop : 0; paintBt(); const l2 = document.querySelector('[data-bt="bt"] .tb-trl'); if (l2) l2.scrollTop = top; });
    e.querySelectorAll('[data-bcsv]').forEach(b => b.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); btCsv(); });
  }

  /* ---------------- Market Neutral: the pair's spread (radar/auto/bot_pair.stats via /api/auto/bots/pair-stats) ----------------
     The z-score of the spread over the last candles with the entry (dashed) and exit (dotted) levels of these settings,
     and the four figures a pair trader reads: z now, beta (the hedge ratio), half-life, correlation. Past prices only. */
  const PS_KEYS = ['coin', 'coin_b', 'venue', 'venue_b', 'hedge', 'beta', 'timeframe', 'window'];
  const psKey = c => JSON.stringify(PS_KEYS.map(k => c[k] == null ? null : c[k]));
  async function loadPs() {
    if (B.kind !== 'pair' || B.panel !== 'bot') return;
    const c = payload(), k = psKey(c);
    if (!c.coin_b || (B.ps && B.ps.key === k)) return;
    B.ps = {key: k, busy: true}; paintPs();
    let d;
    try { d = await api0('/api/auto/bots/pair-stats', {kind: 'pair', config: {...c, size_usd: Math.max(+c.size_usd || 0, 1000)}}); }   // the figures need no amount
    catch (e) { d = {ok: false, error: e.message}; }
    if (!B.ps || B.ps.key !== k) return;
    B.ps = {key: k, d}; paintPs();
  }
  const hlTxt = h => h == null ? '–' : h < 48 ? _t('{h} h', {h: h < 10 ? h.toFixed(1) : Math.round(h)}) : _t('{d} d', {d: (h / 24).toFixed(1)});
  function psInner() {
    const p = B.ps, d = p && p.d, c = cfg(), coins = {a: esc(S.coin), b: esc(c.coin_b || '')};
    const head = `<div class="tb-sub">${_t('Spread')} ${tip(_t('The z-score of {a} − beta × {b} over the look back: how far the pair is from its usual gap, in standard deviations. Past prices, not a promise.', coins))}</div>`;
    if (!p || p.busy) return head + '<div class="tb-psc"><span class="sk" style="display:block;height:64px"></span></div>';
    if (!d || !d.ok) return head + `<p class="explain">${esc((d && d.error) || '')}</p>`;
    const pts = d.series || [], ez = +c.entry_z || 0, xz = +c.exit_z || 0, sz = c.mode !== 'trend' ? +c.stop_z || 0 : 0;
    const nl = Math.max(1, Math.min(5, Math.floor(+c.levels || 1))), st = +c.level_step_z || .5;
    const lz = ez ? [...Array(nl).keys()].map(i => ez + i * st) : [];          // every entry level (grid scale-in)
    const lim = Math.min(8, Math.max(3, (lz[lz.length - 1] || 0) + .5, sz + .3, ...pts.map(x => Math.abs(x[1]) + .2)));
    const W = 300, H = 64, y = z => (H / 2 - z / lim * (H / 2 - 2)).toFixed(1);
    const hl = (z, cls) => `<path class="${cls}" d="M0,${y(z)}H${W}"/>`;
    let path = '';
    if (pts.length > 1) { const t0 = pts[0][0], t1 = pts[pts.length - 1][0], x = t => ((t - t0) / Math.max(1, t1 - t0) * W).toFixed(1);
      path = pts.map((q, i) => `${i ? 'L' : 'M'}${x(q[0])},${y(q[1])}`).join(''); }
    const svg = `<svg class="tb-psg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(_t('Spread z-score'))}">` +
      hl(0, 'z0') + lz.map(z => hl(z, 'ze') + hl(-z, 'ze')).join('') + (xz ? hl(xz, 'zx') + hl(-xz, 'zx') : '') + (sz ? hl(sz, 'zs') + hl(-sz, 'zs') : '') +
      `<path class="zl" d="${path}"/></svg>`;
    const z = d.z, zc = ez && Math.abs(z) >= ez ? 'hot' : '';     // past the entry level: the one figure in the accent
    const fig = (k, v, t) => `<div${t ? ` title="${esc(t)}"` : ''}><span class="k">${k}</span><b>${v}</b></div>`;     // the why on hover: four labels fit the narrow panel
    return head + `<div class="tb-psc">${svg}<div class="tb-psa"><span>${_t('{n} candles', {n: pts.length})} · ${esc(d.timeframe)}</span><span>${_t('Enter at z')} ±${lz.length > 1 ? lz.map(z => +z.toFixed(2)).join(' / ') : ez}</span></div></div>` +
      `<div class="bst4 tb-psf">${fig(_t('Z-score'), `<span class="${zc}">${(z > 0 ? '+' : '') + z.toFixed(2)}</span>`)}` +
      fig(_t('Beta'), d.beta.toFixed(2), _t('The hedge ratio: {a} moves about this many times as much as {b}. The bot sizes the legs by it.', coins)) +
      fig(_t('Half-life'), hlTxt(d.half_life_h), d.half_life == null ? _t('The spread has not been closing its gaps over the look back.') : _t('A gap in the spread has halved in about {n} candles.', {n: Math.round(d.half_life)})) +
      fig(_t('Correlation'), d.corr == null ? '–' : d.corr.toFixed(2), _t('How closely the two coins move together, from -1 to 1.')) + '</div>';
  }
  function paintPs() { document.querySelectorAll('[data-bt="ps"]').forEach(e => { e.innerHTML = psInner(); }); }
  const legLabel = () => (shape().hedge || 'beta') === 'equal' ? _t('Each leg') : _t('Larger leg');
  const psH = () => `<div class="tb-ps" data-bt="ps">${psInner()}</div>`;
  /* ---------------- Market Neutral: suggested pairs (radar/auto/pair_finder.py via /api/auto/bots/pairs) ----------------
     Pairs a background job found cointegrated over the last 90 days of 4h candles, best first: the pair and its
     exchange(s), the half-life and the test's confidence, the z-score now (in the accent past the entry level). A click
     fills the pair: coin A becomes the market (on its exchange), coin B and its exchange the second leg. Past data only. */
  function loadSp() {
    if (B.spBusy || (B.sp && Date.now() - B.spAt < 300000)) return;
    B.spBusy = true;
    fetch('/api/auto/bots/pairs?limit=12').then(r => r.json()).then(d => { B.sp = (d && d.pairs) || []; })
      .catch(() => { B.sp = B.sp || []; }).finally(() => { B.spBusy = false; B.spAt = Date.now(); paintSp(); });
  }
  function spInner() {
    const c = cfg(), ez = +c.entry_z || 2;
    const head = `<div class="tb-arh"><span>${_t('Suggested pairs')}${tip(_t('Coins whose prices moved together over the last 90 days of 4-hour candles (Engle-Granger cointegration test). The % is the confidence of the test; z now is how far apart they are now. Statistics from past prices, not a promise: a pair can break apart.'))}</span><span>${_t('z now')}</span></div>`;
    if (!B.sp) return head + '<div class="tb-arb">' + [0, 1, 2].map(() => '<div class="tb-ar"><span class="sk" style="height:12px;width:50%"></span><span class="sk" style="height:12px;width:40px"></span></div>').join('') + '</div>';
    if (!B.sp.length) return head + `<div class="hint">${_t('No suggested pairs yet: the list is built every 6 hours.')}</div>`;
    const hl = h => h == null ? '–' : h < 48 ? _t('{h} h', {h: Math.round(h)}) : _t('{d} d', {d: (h / 24).toFixed(1)});
    return head + '<div class="tb-arb">' + B.sp.map((p, i) => {
      const on = S.coin === p.a && (c.coin_b || shape().coin_b) === p.b ? ' on' : '', hot = Math.abs(p.z) >= ez ? ' hot' : '';
      const where = p.venue_a === p.venue_b ? esc(L(p.venue_a)) : `${esc(L(p.venue_a))} · ${esc(L(p.venue_b))}`;
      return `<button type="button" class="tb-ar${on}" data-sp="${i}"><b>${esc(p.a)} / ${esc(p.b)}</b><span class="a${hot}">${(p.z > 0 ? '+' : p.z < 0 ? '−' : '') + Math.abs(p.z).toFixed(2)}</span>` +
        `<span class="v">${where} · ${_t('half-life')} ${hl(p.half_life_h)}</span><span class="v r">${p.conf}%</span></button>`; }).join('') + '</div>';
  }
  function usePair(p) {
    if (!p) return;
    select(p.a, p.venue_a);
    const s = shape();
    s.coin_b = p.b; s.venue_b = p.venue_b === S.venue ? '' : p.venue_b;
    B.plan = null; B.chk = null; B.bt = B.btLast = null; B.ps = null;
    render(); schedule(true);
  }
  function bindSp(box) { box.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => usePair((B.sp || [])[+b.dataset.sp])); }
  function paintSp() { document.querySelectorAll('[data-bt="sp"]').forEach(e => { e.innerHTML = spInner(); bindSp(e); }); }
  const spH = () => { loadSp(); return `<div class="tb-sp" data-bt="sp">${spInner()}</div>`; };

  /* ---------------- share these settings ---------------- */
  function shareSheet() {
    if (!(B.chk && B.chk.ok)) return;
    if (S.signedOut) return typeof loginModal === 'function' ? loginModal() : notice('err', _t('Connect wallet'), _t('Connect a wallet to share a setup.'));
    openSheet(`<div class="sh-h"><h3>${_t('Share these settings')}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b tb-share" id="sh-body"><p class="explain">${_t('Anyone with the link sees the settings and a backtest. Your amounts and balance are never shown.')}</p>
        <div class="inp"><span class="pre">${_t('Title')}</span><input id="sh-t" maxlength="60" value="${esc(`${S.coin} ${kindName(B.kind)} bot`)}"></div>
        <textarea id="sh-d" maxlength="280" placeholder="${_t('What it is for (optional)')}"></textarea>
        <label class="ck"><input type="checkbox" id="sh-h">${_t('Keep the settings private')}${tipI(_t('The page shows the backtest and results only; people who copy it set just their amount and their own stop loss and max loss.'))}</label><p class="tb-err" id="sh-m" hidden></p></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Cancel')}</button><button class="go n" id="sh-go" type="button">${_t('Share')}</button></div>`, 'sm');
    $('sh-go').onclick = async () => {
      try { const r = await api('/api/auto/setups/create', {key: S.key, title: $('sh-t').value, description: $('sh-d').value, kind: B.kind, config: payload(), hide_settings: $('sh-h').checked});
        $('sh-body').innerHTML = `<p class="explain">${_t('Your setup is public. Edit it or stop sharing any time in the app, under Trading bots.')}</p><div class="inp"><input id="sh-u" readonly value="${esc(r.setup.url)}"><button class="ub" id="sh-c" type="button">${_t('Copy')}</button></div>`;
        $('sh-go').outerHTML = `<a class="go n" href="${esc(r.setup.url)}" target="_blank" rel="noopener">${_t('Open page')}</a>`;
        $('sh-c').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(r.setup.url) : Promise.reject()).then(() => { $('sh-c').textContent = _t('Copied'); }, () => $('sh-u').select()); };
      } catch (e) { $('sh-m').hidden = false; $('sh-m').textContent = e.message; }
    };
  }

  /* ---------------- Funding Arbitrage bots already running (the type left on 2026-10-06: it needs two exchanges) ----------
     its rows in the Bots tab: one per bot, from me.arb_bots (radar/auto/api.arb_views), each with Stop (closes both legs
     together) until the customer removes it; nothing new starts */
  const arbStatus = a => a.status === 'stopped' ? _t('Stopped') : a.status === 'stopping' ? _t('Closing…') : a.position_id ? _t('Running') : _t('Opening');
  const arbDot = a => a.status === 'stopped' ? '' : a.status === 'active' && a.position_id ? 'ok' : 'wait';
  const arbRule = a => a.turn_hours ? _t('Close after {h}h against', {h: a.turn_hours}) : _t('Hold');
  function arbActs(a, phone) {
    const x = a.status === 'stopped' ? `<button class="sb" type="button" data-aact="remove" data-id="${a.id}">${_t('Remove')}</button>`
      : `<button class="sb" type="button" data-aact="stop" data-id="${a.id}" ${a.status === 'stopping' ? 'disabled' : ''}>${_t('Stop')}</button>`;
    return x;
  }
  const arbPl = a => `<span class="${a.pnl > 0 ? 'up' : a.pnl < 0 ? 'dn' : ''}" title="${_t('Funding {f} · fees {fees}', {f: sgn(a.funding), fees: a.fees == null ? '–' : C().fmtUsd(a.fees)})}">${sgn(a.pnl)}</span>`;
  function arbTr(a) {
    return `<tr class="bot-row${a.status === 'stopped' ? ' off' : ''}${B.flash === 'a' + a.id ? ' flash' : ''}" data-aid="${a.id}"><td><b style="font-weight:500">${esc(a.coin)}</b><span class="sub">S ${esc(L(a.short_venue))} / L ${esc(L(a.long_venue))}</span></td>` +
      `<td>${_t('Funding Arbitrage')}<span class="sub">${_t('Hedged')} · ${(S.st && S.st.leverage) || 3}x</span></td><td title="${esc(a.note || a.close_reason || '')}"><i class="bdot ${arbDot(a)}"></i>${esc(arbStatus(a))}</td>` +
      `<td class="mut rule" title="${esc(a.note || arbRule(a))}">${esc(a.note ? a.note.replace(/^Waiting: /, '') : arbRule(a))}</td><td class="r">${num(a.amount_usd)}</td>` +
      `<td class="r">${a.size ? C().fmtSize(a.size, a.long_px) : '–'}</td><td class="r">–</td><td class="r">${arbPl(a)}</td><td class="r act"><span class="acts">${arbActs(a, false)}</span></td></tr>`;
  }
  function arbCard(a) {
    return `<div class="pc bot${B.flash === 'a' + a.id ? ' flash' : ''}" data-aid="${a.id}"><div class="pc-h"><span class="sbadge k">A</span><b>${esc(a.coin)}</b><span class="sub">S ${esc(L(a.short_venue))} / L ${esc(L(a.long_venue))}</span><span class="sp"></span><span class="bst"><i class="bdot ${arbDot(a)}"></i>${esc(arbStatus(a))}</span></div>` +
      `<div class="pc-pl"><span>P&amp;L (USD)</span><b>${arbPl(a)}</b></div>` +
      `<div class="pc-g"><div><span class="k">${_t('Investment')}</span><span class="v">${num(a.amount_usd)}</span></div><div><span class="k">${_t('Funding')}</span><span class="v">${sgn(a.funding)}</span></div><div><span class="k">${_t('Fees')}</span><span class="v">${a.fees == null ? '–' : num(a.fees)}</span></div></div>` +
      `<div class="rl">${esc(a.note || arbRule(a))}</div><div class="pc-a">${arbActs(a, true)}</div></div>`;
  }
  function arbAct(what, id) {
    const a = arbs().find(x => x.id === id); if (!a) return;
    if (what === 'remove' || !a.position_id) return arbStopNow(a);
    openSheet(`<div class="sh-h"><h3>${_t('Stop the {coin} Funding Arbitrage bot?', {coin: esc(a.coin)})}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b"><div class="kv">${row(_t('Pair'), `S ${esc(L(a.short_venue))} / L ${esc(L(a.long_venue))}`)}${row(_t('Investment'), fmtU(a.amount_usd))}${row('P&amp;L', arbPl(a))}</div>
        <p class="explain">${_t('Closes both legs of the pair together.')}</p></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Cancel')}</button><button class="go s" id="arb-st" type="button">${_t('Stop and close')}</button></div>`, 'sm');
    $('arb-st').onclick = () => arbStopNow(a, true);
  }
  async function arbStopNow(a, sheet) {
    try { const r = await api('/api/auto/arb/stop', {key: S.key, id: a.id}); if (sheet) closeSheet(); mergeMe(r); }
    catch (e) { notice('err', _t('That didn\'t work'), e.message); }
  }
  function arbDetail(a) {
    openSheet(`<div class="sh-h"><h3>${_t('{coin} Funding Arbitrage', {coin: esc(a.coin)})}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b">${a.note ? `<p class="explain">${esc(a.note)}</p>` : ''}<div class="kv">${row(_t('Status'), `<i class="bdot ${arbDot(a)}"></i>${esc(arbStatus(a))}`)}${row(_t('Pair'), `S ${esc(L(a.short_venue))} / L ${esc(L(a.long_venue))}`)}` +
        row(_t('Investment'), fmtU(a.amount_usd)) + row('P&amp;L', `${sgn(a.pnl)}<span class="sub">${_t('after fees')}</span>`) + row(_t('Funding earned'), sgn(a.funding)) +
        row(_t('Fees'), a.fees == null ? '–' : fmtU(a.fees)) + row(_t('Exit'), esc(arbRule(a))) + row(_t('Started'), tm(a.started)) + (a.stopped ? row(_t('Stopped'), tm(a.stopped)) : '') +
        (a.close_reason && a.status === 'stopped' ? row(_t('Closed'), esc(a.close_reason)) : '') + `</div></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Close')}</button></div>`);
  }

  /* ---------------- the Bots tab of the bottom panel ---------------- */
  /* Edit: the guided setup's Customize page with this bot's settings (/bots/new?edit=<id>, radar/web/bot-flow.js) */
  const editHref = b => `/bots/new?edit=${b.id}&coin=${encodeURIComponent(b.coin)}&venue=${encodeURIComponent(b.venue)}&kind=${b.kind}`;
  const tm = t => t ? new Date(t * 1000).toLocaleString(RVI18N.lang === 'en' ? 'en-GB' : RVI18N.locale, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '–';
  const sgn = x => x == null ? '–' : (x > 0 ? '+' : '') + C().fmtUsd(x).replace('$', '');
  const CHART = '<svg class="i" viewBox="0 0 24 24"><path d="M4 19h16M7 15l3-4 3 2 4-6"/></svg>';
  const posTxt = b => b.position && b.position.size ? `${C().fmtSize(Math.abs(b.position.size), b.position.entry_px)}${b.position.entry_px ? ' @ ' + rp(b.position.entry_px) : ''}` : '–';
  function actsH(b, phone) {
    const on = LIVE.includes(b.status) && b.status !== 'stopping', a = [];
    if (!phone) a.push(`<button class="sb ic" type="button" data-bact="chart" data-id="${b.id}" title="${_t('Show on the chart')}" aria-label="${_t('Show on the chart')}">${CHART}</button>`);
    if (LIVE.includes(b.status)) {
      a.push(`<button class="sb" type="button" data-bact="amount" data-id="${b.id}" ${['active', 'paused', 'error'].includes(b.status) ? '' : 'disabled'}>${_t('Amount')}</button>`);
      if (b.config && !b.config.private) a.push(`<button class="sb" type="button" data-bact="edit" data-id="${b.id}">${_t('Edit')}</button>`);
      a.push(b.status === 'active' ? `<button class="sb" type="button" data-bact="pause" data-id="${b.id}">${_t('Pause')}</button>`
        : `<button class="sb" type="button" data-bact="resume" data-id="${b.id}" ${['paused', 'error'].includes(b.status) ? '' : 'disabled'}>${_t('Resume')}</button>`);
      a.push(`<button class="sb" type="button" data-bact="stop" data-id="${b.id}" ${on ? '' : 'disabled'}>${_t('Stop')}</button>`);
    } else {
      if (b.config && !b.config.private) a.push(`<button class="sb" type="button" data-bact="edit" data-id="${b.id}" title="${_t('Start a new bot with these settings')}">${_t('Edit')}</button>`);
      a.push(`<button class="sb" type="button" data-bact="remove" data-id="${b.id}">${_t('Remove')}</button>`);
    }
    return a.join(phone ? '' : ' ');
  }
  /* the workspace keeps whether its list showed bots, so its next first paint gives the chart their one-line room
     (bt-has, radar/bot_flow.py WS_HAS / WS_CSS) instead of the empty block's. Only the next paint: switching the class
     now would move the chart under the trader's eyes (an emptied list grows its room by itself, :has(#tbl>.empty)) */
  const keepBots = k => { if (WS) try { localStorage.setItem('rv_bt_n', String(k)); } catch (e) {} };
  function renderTab(el) {
    const phone = isPhone(), all = bots(), n = live().length + liveArbs().length;
    if (S.signedOut) { keepBots(0); el.innerHTML = `<div class="empty"><b>${_t('Connect a wallet to see your bots.')}</b><span>${_t('Your Hyperliquid bots show here.')}</span><a class="sb" href="/assets">${_t('Connect wallet')}</a></div>`; return; }
    if (!S.me) { el.innerHTML = '<div class="skl">' + [0, 1, 2].map(() => '<span class="sk" style="height:12px"></span>').join('') + '</div>'; return; }
    const here = b => b.coin === S.coin && b.venue === S.venue;
    const rank = b => ({active: 0, paused: 1, stopping: 2, error: 3}[b.status] ?? 4);
    const list = all.filter(b => !S.thisMkt || here(b)).sort((a, b) => rank(a) - rank(b) || b.id - a.id);
    const ar = arbs().filter(a => !S.thisMkt || (a.coin === S.coin && [a.short_venue, a.long_venue].includes(S.venue)))
      .sort((a, b) => (a.status === 'stopped') - (b.status === 'stopped') || b.id - a.id);
    keepBots(list.length + ar.length);
    // the new panel designs: one quiet line, the setup is right above
    if (!all.length && !arbs().length && WS) { el.innerHTML = `<div class="empty tb-e1"><b>${_t('No bots yet')}</b><span>${_t('Set one up in three steps: the type, the amount, a review with its backtest.')}</span><a class="sb" href="${esc(newHref())}">${_t('New bot')}</a></div>`; return; }
    if (!all.length && !arbs().length && NEW) { el.innerHTML = `<div class="empty tb-e1"><b>${_t('No bots yet')}</b><span>${_t('Build one with the bot settings: it starts with this market and exchange.')}</span></div>`; return; }
    if (!all.length && !arbs().length) { el.innerHTML = `<div class="empty"><b>${_t('No bots yet')}</b><span>${_t('Build one with the bot settings: it starts with this market and exchange.')}</span><button class="sb" type="button" id="tb-new">${_t('Create a bot')}</button></div>`; $('tb-new').onclick = () => setPanel('bot'); return; }
    if (!list.length && !ar.length) { el.innerHTML = `<div class="empty"><b>${_t('No bots on {v} at {v2}', {v: esc(PAIR()), v2: esc(L(S.venue))})}</b><span>${_t('{count} bots on other markets.', {count: n})}</span><button class="sb" type="button" id="tb-all">${_t('Show all bots')}</button></div>`;
      $('tb-all').onclick = () => { S.thisMkt = false; pref.set('thismkt', null); renderBottom(); }; return; }
    const pl = b => `<span class="${b.pnl.total > 0 ? 'up' : b.pnl.total < 0 ? 'dn' : ''}" title="${_t('closed {realized} · open {unrealized}', {realized: sgn(b.pnl.realized), unrealized: sgn(b.pnl.unrealized)})} · ${_t('fees {usd}', {usd: C().fmtUsd(b.pnl.fees)})}${b.pnl_estimated ? ' · ' + _t('estimated: Rivemont\'s own count of its fills') : ''}">${sgn(b.pnl.total)}${b.pnl_estimated ? '*' : ''}</span>`;
    const note = b => esc(b.error || b.note || '');
    const liveAr = ar.filter(a => a.status !== 'stopped'), doneAr = ar.filter(a => a.status === 'stopped');
    if (phone) {
      el.innerHTML = '<div class="cards">' + liveAr.map(arbCard).join('') + list.map(b => `<div class="pc bot${B.flash === b.id ? ' flash' : ''}" data-bid="${b.id}"><div class="pc-h"><span class="sbadge k">${b.kind[0].toUpperCase()}</span>${window.rvCoin ? rvCoin(b.coin, 20) : ''}<b>${esc(PAIR(b.coin, b.venue))}</b>` +
        `<span class="sub">${esc(L(b.venue))} · ${esc(sideTxt(b))} · ${b.config.leverage}x</span><span class="sp"></span><span class="bst" title="${note(b)}"><i class="bdot ${dot(b.status)}"></i>${esc(b.status_text)}</span></div>` +
        `<div class="pc-pl"><span>P&amp;L (${esc(QT(b.venue))})${b.pnl_estimated ? (' ' + _t('· est.')) : ''}</span><b>${pl(b)}</b></div>` +
        `<div class="pc-g"><div><span class="k">${_t('Margin')}</span><span class="v">${C().fmtUsd(b.budget_usd).replace('$', '')}</span></div><div><span class="k">${_t('Position')}</span><span class="v">${posTxt(b)}</span></div><div><span class="k">${_t('Orders')}</span><span class="v">${b.orders.length}</span></div></div>` +
        `<div class="rl">${esc(P.GRIDS.includes(b.kind) || b.kind === 'scalp' || P.ADAPT.includes(b.kind) ? _t('Range') : b.kind === 'dca' ? _t('Ladder') : _t('Rule'))} ${esc(T().botRule(b.kind, b.config))}${b.error || (b.note && b.status !== 'active') ? ' · ' + note(b) : ''}</div>` +
        `<div class="pc-a">${actsH(b, true)}</div></div>`).join('') + doneAr.map(arbCard).join('') + '</div>';
    } else {
      el.innerHTML = `<div class="tw"><table class="bt-t"><thead><tr><th>${_t('Market')}</th><th>${_t('Bot')}</th><th>${_t('Status')}</th><th>${_t('Rule')}</th><th class="r">${_t('Margin')}</th><th class="r">${_t('Position')}</th><th class="r">${_t('Orders')}</th><th class="r">P&amp;L</th><th class="r act"></th></tr></thead><tbody>` + liveAr.map(arbTr).join('') +
        list.map(b => `<tr class="bot-row${LIVE.includes(b.status) ? '' : ' off'}${B.flash === b.id ? ' flash' : ''}" data-bid="${b.id}"><td>${window.rvCoin ? rvCoin(b.coin, 20, 'rv-ci-pi') : ''}<b style="font-weight:500">${esc(PAIR(b.coin, b.venue))}</b><span class="sub">${esc(L(b.venue))}</span></td>` +
          `<td>${esc(kindName(b.kind))}<span class="sub">${esc(sideTxt(b))} · ${b.config.leverage}x</span></td>` +
          `<td title="${esc([b.kept ? _t('Stopped; its position was kept for you.') : '', b.error || b.note || '', _t('Started {time}', {time: tm(b.started)})].filter(x => x).join(' '))}"><i class="bdot ${dot(b.status)}"></i>${esc(b.status_text)}</td>` +
          `<td class="mut rule" title="${esc(T().botRule(b.kind, b.config))}">${esc(T().botRule(b.kind, b.config))}</td>` +
          `<td class="r">${C().fmtUsd(b.budget_usd).replace('$', '')}${b.budget_held_usd ? `<span class="sub" title="${_t('Held for its older orders until they close')}">+${C().fmtUsd(b.budget_held_usd - b.budget_usd, 0).replace('$', '')}</span>` : ''}</td>` +
          `<td class="r">${posTxt(b)}</td><td class="r">${b.orders.length}</td><td class="r">${pl(b)}</td>` +
          `<td class="r act"><span class="acts">${actsH(b, false)}</span></td></tr>`).join('') + doneAr.map(arbTr).join('') + '</tbody></table></div>';
    }
    el.querySelectorAll('[data-bact]').forEach(x => x.onclick = e => { e.stopPropagation(); act(x.dataset.bact, +x.dataset.id); });
    el.querySelectorAll('[data-aact]').forEach(x => x.onclick = e => { e.stopPropagation(); arbAct(x.dataset.aact, +x.dataset.id); });
    el.querySelectorAll('[data-bid]').forEach(x => x.onclick = e => { if (!e.target.closest('button, a')) detail(+x.dataset.bid); });
    el.querySelectorAll('[data-aid]').forEach(x => x.onclick = e => { if (!e.target.closest('button, a')) arbDetail(arbs().find(a => a.id === +x.dataset.aid)); });
    if (B.flash && B.flashSeen !== B.flash) { const r = el.querySelector('.flash');
      if (r) { B.flashSeen = B.flash; const rc = r.getBoundingClientRect(); if (rc.top < 0 || rc.bottom > innerHeight) r.scrollIntoView({block: 'center'}); } }
    if (B.flash) setTimeout(() => { B.flash = null; }, 1700);
  }
  function tabCount() {
    const n = $('n-bots'); if (!n) return;
    const k = live().length + liveArbs().length; n.textContent = S.me ? `(${k})` : '';
  }
  function mergeMe(r) { S.me = {...S.me, ...r}; renderBottom(); drawLines2(); render(); if (typeof renderForm === 'function') renderForm(); }
  async function act(what, id) {
    const b = bots().find(x => x.id === id); if (!b) return;
    if (what === 'chart') { if (b.coin !== S.coin || b.venue !== S.venue) select(b.coin, b.venue); if (isPhone()) toggleChart(true); return; }
    if (what === 'amount') return amountSheet(b);
    if (what === 'edit') { location.href = editHref(b); return; }
    if (what === 'stop') return stopSheet(b);
    try {
      const r = await api('/api/auto/bots/' + (what === 'remove' ? 'delete' : what), {key: S.key, id});
      mergeMe(r);
    } catch (e) { notice('err', _t('That didn\'t work'), e.message); }
  }
  function stopSheet(b) {
    const native = b.native_triggers, held = b.position && b.position.size, c = b.config || {};
    /* a Stop ends every order the bot placed, its take profit / stop loss too (radar/auto/bots.py step_keep); keeping
       the position is the usual "No, I'll handle it myself". A recurring buy keeps what it bought by default (as a
       recurring buy plan usually does: stopping the plan never sells); a type that follows a position the customer already held
       (b.attached) only ever leaves it, so it has no close choice */
    const recurring = b.kind === 'recurring', exits = !!(c.tp_pct || c.sl_pct || c.trail_pct || (b.lines && (b.lines.tp || b.lines.sl)));
    const close = ['close', _t('Stop and close at market'), held ? _t('Cancels its orders and sells what it holds ({b}) at the market price.', {b: posTxt(b)}) : _t('Cancels its orders and closes anything it opened.')];
    const keep = recurring ? ['keep', _t('Stop buying, keep what it bought'), `${_t('No more buys; what it bought stays open for you to manage by hand.')}${exits ? ' ' + _t('Its take profit and stop loss are cancelled too.') : ''}`]
      : ['keep', _t('Stop and keep the position'), `${_t('Cancels its orders; the position stays open for you to manage by hand.')}${exits ? ' ' + _t('Its take profit and stop loss are cancelled too.') : ''}`];
    const opts = (b.status === 'active' ? [['pause', _t('Pause: no new orders'), (native ? _t('What it holds keeps its take profit and stop loss on {venue}.', {venue: L(b.venue)}) : _t('What it holds keeps its take profit and stop loss (Rivemont keeps watching them).')) + ' ' + _t('Resume any time.')]] : [])
      .concat(b.attached ? [keep] : recurring ? [keep, close] : [close, keep]);
    let pick = recurring || b.attached ? 'keep' : opts[0][0];
    openSheet(`<div class="sh-h"><h3>${_t('Stop the {v}?', {v: esc(botName(b))})}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b" id="st-o">${opts.map(([v, t, d]) => `<button class="opt${v === pick ? ' on' : ''}" type="button" data-o="${v}"><b>${esc(t)}</b><span>${esc(d)}</span></button>`).join('')}
        <p class="explain">${held ? `${_t('It holds {b} on {v}.', {b: posTxt(b), v: esc(L(b.venue))})}` : _t('It holds no position right now.')}</p></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Cancel')}</button><button class="go n" id="st-go" type="button">${_t('Confirm')}</button></div>`, 'sm');
    const paint = () => { $('st-o').querySelectorAll('[data-o]').forEach(x => x.classList.toggle('on', x.dataset.o === pick));
      $('st-go').className = 'go ' + (pick === 'close' ? 's' : 'n'); $('st-go').textContent = {pause: _t('Pause bot'), close: _t('Stop and close'), keep: recurring ? _t('Stop buying') : _t('Stop, keep position')}[pick]; };
    $('st-o').querySelectorAll('[data-o]').forEach(x => x.onclick = () => { pick = x.dataset.o; paint(); }); paint();
    $('st-go').onclick = async () => {
      try { const r = pick === 'pause' ? await api('/api/auto/bots/pause', {key: S.key, id: b.id}) : await api('/api/auto/bots/delete', {key: S.key, id: b.id, keep_position: pick === 'keep'});
        closeSheet(); mergeMe(r); }
      catch (e) { notice('err', _t('That didn\'t work'), e.message); }
    };
  }
  function amountSheet(b) {
    const now = Math.round(b.budget_usd), inUse = b.budget_in_use_usd || 0, lev = b.config.leverage || 1, mx = moneyAt(b.venue), avl = mx ? mx.balance : null;
    const lim = 0, aside = 0;   // no Rivemont cap on bots (CEX-style): what is free on the exchange bounds it
    let add = true;
    openSheet(`<div class="sh-h"><h3>${_t('Margin of the {v}', {v: esc(botName(b))})}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b"><div class="seg lg" id="am-m"><button type="button" data-v="add" class="on l">${_t('Increase')}</button><button type="button" data-v="reduce">${_t('Reduce')}</button></div>
        <p class="explain">${_t('Margin now')} <b>${fmtU(now, 0)}</b>${inUse ? ` ${_t('· {inUse} in use by open orders', {inUse: fmtU(inUse, 0)})}` : ''}${avl != null ? ` ${_t('· {avail} on {v}', {avail: fmtU(avl, 0), v: esc(L(b.venue))})}` : ''}</p>
        <div class="inp"><span class="pre" id="am-l">${_t('Add')}</span><input id="am-v" inputmode="decimal" placeholder="0" aria-label="${_t('Amount')}"><span class="u">${esc(QT(b.venue))}</span></div>
        <div class="chips" id="am-q" style="grid-template-columns:repeat(3,1fr)">${[50, 100, 250].map(x => `<button type="button" data-d="${x}">${x}</button>`).join('')}</div>
        <div class="kv" id="am-s"></div><div id="am-c"></div>
        <p class="explain">${_t('Applies to the next orders; open ones stay as they are.')}</p></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Cancel')}</button><button class="go n" id="am-go" type="button" disabled>${_t('Save')}</button></div>`, 'sm');
    const upd = () => {
      const o = T().budgetChange({add, now, delta: $('am-v').value, inUse, limit: lim, others: Math.max(0, aside - b.budget_usd), money: mx});
      $('am-q').querySelectorAll('button').forEach(x => x.textContent = (add ? '+' : '−') + C().fmtUsd(+x.dataset.d, 0));
      $('am-s').innerHTML = row(_t('Now'), fmtU(now, 0)) + row(_t('After'), o.d ? `<b>${fmtU(Math.max(0, o.after), 0)}</b><span class="sub ${add ? 'up' : 'dn'}">(${add ? '+' : '−'}${fmtU(o.d, 0)})</span>` : '–') +
        row(_t('Largest position'), o.d ? fmtU(Math.max(0, o.after) * lev, 0) + (lev > 1 ? `<span class="sub">${_t('at {lev}x', {lev})}</span>` : '') : '–');
      $('am-c').innerHTML = o.why ? `<div class="hint">${esc(o.why)}${o.stop ? (' <a href="#" id="am-stop">' + _t('Stop instead') + '</a>') : ''}</div>`
        : o.deposit ? `<div class="warn">${_t('Not enough is free on {venue} now (the rest holds open positions or orders). Deposit about {amount} to {venue} first.', {venue: esc(L(b.venue)), amount: `<b>${fmtU(o.deposit, 0)}</b>`})} <a href="/app#exchanges" style="color:var(--rv-accent)">${_t('Deposit')}</a></div>` : '';
      if ($('am-stop')) $('am-stop').onclick = e => { e.preventDefault(); stopSheet(b); };
      $('am-go').disabled = !!o.block; $('am-go').dataset.after = o.after;
    };
    $('am-m').querySelectorAll('button').forEach(x => x.onclick = () => { add = x.dataset.v === 'add';
      $('am-m').querySelectorAll('button').forEach(y => y.className = y === x ? 'on ' + (add ? 'l' : 's') : ''); $('am-l').textContent = add ? _t('Add') : _t('Take off'); upd(); });
    $('am-v').oninput = upd;
    $('am-q').querySelectorAll('button').forEach(x => x.onclick = () => { $('am-v').value = Math.round(((+$('am-v').value || 0) + +x.dataset.d) * 100) / 100; upd(); });
    upd(); if (!isPhone()) $('am-v').focus();
    $('am-go').onclick = async () => {
      try { const r = await api('/api/auto/bots/budget', {key: S.key, id: b.id, budget_usd: +$('am-go').dataset.after}); closeSheet(); mergeMe(r); }
      catch (e) { notice('err', _t('The amount didn\'t change'), e.message); }
    };
  }
  function detail(id) {
    const b = bots().find(x => x.id === id); if (!b) return;
    const o = b.orders, h = (b.history || []).slice().reverse(), ch = (b.budget_changes || []).slice().reverse();
    openSheet(`<div class="sh-h"><h3>${esc(botName(b))} · ${esc(L(b.venue))}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b">${b.error ? `<div class="warn">${esc(b.error)}</div>` : b.note ? `<p class="explain">${esc(b.note)}</p>` : ''}
        <div class="kv">${row(_t('Status'), `<i class="bdot ${dot(b.status)}"></i>${esc(b.status_text)}`)}${row('P&amp;L', `${sgn(b.pnl.total)}<span class="sub">${_t('closed {realized} · open {unrealized}', {realized: sgn(b.pnl.realized), unrealized: sgn(b.pnl.unrealized)})}</span>`)}` +
        row(_t('Margin'), fmtU(b.budget_usd)) + row(_t('Position'), posTxt(b)) + row(_t('Rule'), esc(T().botRule(b.kind, b.config))) + row(_t('Rounds'), `${b.rounds}`) + row(_t('Started'), tm(b.started)) + (b.stopped ? row(_t('Stopped'), tm(b.stopped)) : '') + `</div>
        <p class="sec">${_t('What it does')}</p><ol class="tb-ol">${b.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
        <p class="sec">${_t('Orders on {v} · {length}', {v: esc(L(b.venue)), length: o.length})}</p>${o.length ? `<div class="kv">${o.slice(0, 12).map(x => row(`<span class="${x.side === 'buy' ? 'up' : 'dn'}">${x.side === 'buy' ? _t('Buy') : _t('Sell')}</span> ${esc({limit: _t('limit'), tp: _t('take profit'), sl: _t('stop loss'), ioc: _t('market')}[x.kind] || x.kind)}`, `${px(x.px)}<span class="sub">${fmtU(x.usd)}</span>`)).join('')}</div>` : ('<p class="explain">' + _t('No open orders.') + '</p>')}
        ${h.length ? `<p class="sec">${_t('Finished rounds')}</p><div class="kv">${h.slice(0, 12).map(x => row(tm(x.end), `${esc({tp: _t('Take profit'), sl: _t('Stop loss')}[x.exit] || x.exit || '')}<span class="sub">${sgn(x.pnl)}</span>`)).join('')}</div>` : ''}
        ${ch.length ? `<p class="sec">${_t('Amount changes')}</p><div class="kv">${ch.map(x => row(tm(x.ts), `${fmtU(x.from, 0)} → ${fmtU(x.to, 0)}`)).join('')}</div>` : ''}</div>
      <div class="sh-f"><button class="bt" id="bd-csv" type="button"${h.length ? '' : ' disabled'}>${_t('Export CSV')}</button><button class="bt" id="bd-share" type="button"${b.started ? '' : ' disabled'}>${_t('Share result')}</button><button class="go n" id="bd-chart" type="button">${_t('Show on chart')}</button></div>`);
    $('bd-chart').onclick = () => { closeSheet(); act('chart', b.id); };
    $('bd-csv').onclick = () => saveCsv(`rivemont-${b.coin}-${b.kind}-bot-${b.id}.csv`, ['round', 'start', 'end', 'exit', 'result_usd'],
      (b.history || []).map(x => [x.n, iso(x.start), iso(x.end), x.exit, x.pnl]));
    $('bd-share').onclick = () => resultSheet(b);
  }
  /* a bot's result as a public card (radar/auto/setups.py: the setup page /s/<slug> with live results in % of its margin,
     never an amount or an address; its image /og/setup/<slug>.png): made once, then the link and the image to save */
  function resultSheet(b) {
    openSheet(`<div class="sh-h"><h3>${_t('Share the result of the {v}', {v: esc(botName(b))})}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>
      <div class="sh-b tb-share" id="rs-b"><p class="explain">${_t('A public page with this bot\'s result in % of its margin and its settings. Your amounts, balance and address are never shown.')}</p>
        <label class="ck"><input type="checkbox" id="rs-h">${_t('Keep the settings private')}</label><p class="tb-err" id="rs-m" hidden></p></div>
      <div class="sh-f"><button class="bt" data-close type="button">${_t('Cancel')}</button><button class="go n" id="rs-go" type="button">${_t('Make the card')}</button></div>`, 'sm');
    $('rs-go').onclick = async () => {
      $('rs-go').disabled = true;
      try {
        const r = await api('/api/auto/setups/create', {key: S.key, title: `${b.coin} ${kindName(b.kind)} bot`, bot_id: b.id, show_results: true, hide_settings: $('rs-h').checked});
        const u = r.setup.url, img = new URL(u).origin + '/og/setup/' + encodeURIComponent(r.setup.slug) + '.png';
        $('rs-b').innerHTML = `<div class="tb-card"><img src="${esc(img)}" alt="${esc(_t('Result card'))}"><div class="inp"><input id="rs-u" readonly value="${esc(u)}"><button class="ub" id="rs-c" type="button">${_t('Copy')}</button></div></div>`;
        $('rs-go').outerHTML = `<a class="go n" href="${esc(img)}" download="rivemont-${esc(b.coin)}-${esc(b.kind)}.png" target="_blank" rel="noopener">${_t('Save image')}</a>`;
        $('rs-c').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject()).then(() => { $('rs-c').textContent = _t('Copied'); }, () => $('rs-u').select()); };
      } catch (e) { $('rs-go').disabled = false; $('rs-m').hidden = false; $('rs-m').textContent = e.message; }
    };
  }

  /* ---------------- chart: preview (dashed, draggable) and running bots (solid) ----------------
     Every chart call goes through the Terminal's chart adapter (radar/web/chart-adapter.js, `chart` in terminal.html).
     The preview is drawn from the plan (BotPlan.derive), so it follows every input at once; only the estimated
     liquidation waits for the server check. */
  const alpha = (hex, a) => /^#[0-9a-f]{6}$/i.test(hex || '') ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex;
  function previewLines(k) {
    const r = B.chk && B.chk.ok && B.chk.key === chkKey() ? B.chk : null, p = mkPrice(), out = {lines: [], handles: []};
    if (!p || B.priv) return out;
    const pl = plan(), c = pl.cfg, t = total();
    if (P.MORE.includes(B.kind) && B.kind !== 'scalp' && !P.ADAPT.includes(B.kind)) {
      const tone = {up: k.up, dn: k.dn, acc: k.acc, dim: k.dim};
      const ov = T().botOverlay(B.kind, {...shape(), ...c, coin: S.coin}, pl.orders, p, (S.candles || []).slice(0, -1));
      if (ov.band) out.band = ov.band;
      for (const l of ov.lines) out.lines.push({px: l.px, color: l.tone === 'acc' || l.tone === 'dim' ? tone[l.tone] : alpha(tone[l.tone], .8), dash: l.dash, label: l.label, ink: k.ink});
      for (const h of ov.handles) out.handles.push({which: h.which, px: h.px, color: tone[h.tone], title: h.title});
      out.note = ov.note;
    } else if (P.GRIDS.includes(B.kind) || B.kind === 'scalp' || P.ADAPT.includes(B.kind)) {
      if (P.ADAPT.includes(B.kind)) {                           // its range comes from the market: the server's check lays it
        const sv = (r && r.config) || {};
        if (!(sv.upper > sv.lower) || !(sv.grids >= 1)) return out;
        for (const l of T().gridLines(sv.lower, sv.upper, Math.min(sv.grids, 200), p, sv.spacing).slice(1, -1))
          out.lines.push({px: l.px, color: l.side === 'empty' ? k.dim : alpha(l.side === 'buy' ? k.up : k.dn, .8), dash: l.side === 'empty' ? [1, 3] : [4, 3]});
        out.band = [sv.lower, sv.upper];
        return out;
      }
      if (!(c.upper > c.lower) || !(c.grids >= 1)) return out;
      const lines = T().gridLines(c.lower, c.upper, Math.min(c.grids, 200), p, c.spacing), g = T().gridProfit(c, feesNow());
      out.band = [c.lower, c.upper];
      for (const l of lines.slice(1, -1)) out.lines.push({px: l.px, color: l.side === 'empty' ? k.dim : alpha(l.side === 'buy' ? k.up : k.dn, .8), dash: l.side === 'empty' ? [1, 3] : [4, 3]});
      out.handles.push({which: 'upper', px: c.upper, color: k.dn, title: `${_t('Grid top {upper} · {grids} grids{v}', {upper: rp(c.upper), grids: c.grids, v: g ? ' · ' + fmtLine(g) + '/line' : ''})}`});
      out.handles.push({which: 'lower', px: c.lower, color: k.up, title: _t('Grid bottom {lower}', {lower: rp(c.lower)}), drag: true});
      if (B.kind === 'scalp') out.handles = [];                 // its lines follow the gap, not a range you drag
    } else {
      const long = c.side === 'long', ladder = c.side === 'neutral' ? [] : pl.orders || [];
      if (c.side === 'neutral') { out.lines.push({px: p, color: k.acc, dash: [4, 3], label: _t('Long on the signal, short on its mirror'), ink: k.ink}); return out; }
      ladder.forEach((x, i) => { if (i && i === ladder.length - 1 && B.kind === 'dca') return;
        out.lines.push({px: x.px, color: i ? alpha(long ? k.up : k.dn, .8) : k.acc, dash: [4, 3], label: ladder.length <= 9 || !i ? `${i ? (long ? _t('Buy') : _t('Sell')) : _t('First')}${t ? ' ' + C().fmtUsd(x.usd, 0) : ''}` : null, ink: k.ink}); });
      if (B.kind === 'dca' && ladder.length > 1) { const x = ladder[ladder.length - 1]; out.handles.push({which: 'last', px: x.px, color: long ? k.up : k.dn, drag: true,
        title: long ? _t('Last buy {usd}', {usd: t ? C().fmtUsd(x.usd, 0) : ''}) : _t('Last sell {usd}', {usd: t ? C().fmtUsd(x.usd, 0) : ''})}); }
      const first = ladder.length ? ladder[0].px : p;
      if (c.tp_pct > 0) out.handles.push({which: 'tp', px: first * (1 + (long ? 1 : -1) * c.tp_pct / 100), color: k.up, title: `${_t('TP {v}{tp_pct}%{v2}', {v: long ? '+' : '−', tp_pct: c.tp_pct, v2: B.kind === 'dca' ? (' ' + (c.tp_base === 'first' ? _t('from the first price') : _t('(moves with the average)'))) : (' ' + _t('from the entry'))})}`});
      // a DCA stop from the average entry is drawn where it lands once every add fills (BOT-03), and dragged from there
      const slRef = B.kind === 'dca' && c.sl_base === 'avg' && ladder.length > 1 ? dcaStopRef(c, ladder) : first;
      if (c.sl_pct > 0) out.handles.push({which: 'sl', ref: slRef, px: slRef * (1 - (long ? 1 : -1) * c.sl_pct / 100), color: k.dn, title: `${_t('SL {v}{sl_pct}%{v2}', {v: long ? '−' : '+', sl_pct: c.sl_pct, v2: B.kind === 'dca' ? (' ' + (slRef !== first ? _t('from the average, every add filled') : _t('from the first price'))) : (' ' + _t('from the entry'))})}`});
    }
    // the price settings with no line of their own: a handle each once set, dragged on the chart as the range ends are
    // (every price can be set from the chart in Customize); a trailing stop's start too
    const pxh = P.GRIDS.includes(B.kind) && B.kind !== 'scalp' ? [['trigger_px', _t('Start at a price'), k.acc], ['tp_px', _t('Take-profit price'), k.up], ['sl_px', _t('Stop-loss price'), k.dn]]
      : B.kind === 'dca' ? [['start_px', _t('Start at a price'), k.acc]] : B.kind === 'chase' ? [['activation_px', _t('Activation'), k.acc]]
      : B.kind === 'twap' ? [['limit_px', _t('Price limit'), k.dim]] : [];
    if (B.kind === 'trailstop' && +c.activation_pct > 0) pxh.push(['activation', _t('Trailing starts'), k.dim, p * (1 + (c.side === 'short' ? -1 : 1) * c.activation_pct / 100)]);
    for (const [which, title, color, at] of pxh) {
      const v = at || +c[which]; if (!(v > 0)) continue;
      out.lines = out.lines.filter(l => l.right || Math.abs(l.px - v) > v * 1e-9);
      out.handles.push({which, px: v, color, title: `${title} ${rp(v)}`});
    }
    const lq = r && r.est_liq_px;
    if (lq) for (const [sd, v] of [['long', lq.long], ['short', lq.short]]) if (v) out.lines.push({px: v, color: k.dn, dash: [2, 2], size: 1, label: `${_t('Est. liq.')}${lq.long && lq.short ? ' (' + (sd === 'long' ? _t('Long') : _t('Short')) + ')' : ''} ${rp(v)}`, ink: k.ink, right: true});
    return out;
  }
  function runningLines(k) {
    const out = [];
    for (const b of live()) {
      if (b.coin !== S.coin || b.venue !== S.venue) continue;
      const L2 = b.lines || {}, mid = curPrice(), name = `${kindName(b.kind)} bot`;
      (L2.levels || []).forEach((v, i, a) => out.push({px: v, color: alpha(mid && v < mid ? k.up : k.dn, .55), size: 1, label: i === a.length - 1 ? `${_t('{name} · {v} grids', {name, v: a.length - 1})}` : null, ink: k.ink, right: true}));
      if (L2.entry) out.push({px: L2.entry, color: k.acc, size: 1, label: `${_t('{name} · entry', {name})}`, ink: k.ink});
      if (L2.tp) out.push({px: L2.tp, color: k.up, size: 1, label: `${_t('{name} · TP', {name})}`, ink: k.ink});
      if (L2.sl) out.push({px: L2.sl, color: k.dn, size: 1, label: `${_t('{name} · SL', {name})}`, ink: k.ink});
      for (const o of b.orders || []) out.push({px: o.px, color: 'rgba(0,0,0,0)', tick: o.side === 'buy' ? k.up : k.dn});
    }
    return out;
  }
  function indicators() {
    if (!chart) return;
    const s = B.panel === 'bot' && !B.priv ? shape() : null;
    const want = !s ? '' : B.kind === 'indicator' ? JSON.stringify(s.conditions || []) : B.kind === 'dca' && s.start ? JSON.stringify(s.start.conditions)
      : B.kind === 'meanrev' ? JSON.stringify([{ind: 'bb', period: +s.period || 20, std: +s.std || 2}])
      // Stop and reverse: the averages it crosses (EMA or SMA, as chosen) or its MACD with the signal line it runs
      : B.kind === 'sar' && s.signal === 'ma_cross' ? JSON.stringify([{ind: 'ma_cross', ma: s.ma === 'sma' ? 'sma' : 'ema', fast: +s.fast || 9, slow: +s.slow || 21}])
      : B.kind === 'sar' && s.signal === 'macd' ? JSON.stringify([{ind: 'macd', fast: +s.fast || 12, slow: +s.slow || 26, signal: +s.signal_len || 9}]) : '';
    if (want === B.inds) return;
    B.inds = want;
    const cs = want ? JSON.parse(want) : [], ema = [], sma = [], list = [];
    let boll = null, rsi = null, macd = null;
    for (const c of cs) {
      if (c.ind === 'macd' && B.kind === 'sar') macd = [c.fast, c.slow, c.signal];
      if (c.ind === 'price_ma') (c.ma === 'sma' ? sma : ema).push(c.period);
      if (c.ind === 'ma_cross') (c.ma === 'sma' ? sma : ema).push(c.fast, c.slow);
      if (c.ind === 'bb') boll = [c.period, c.std];
      if (c.ind === 'rsi') rsi = c;
    }
    if (ema.length) list.push({name: 'EMA', params: [...new Set(ema)].slice(0, 5)});
    if (sma.length) list.push({name: 'MA', params: [...new Set(sma)].slice(0, 5)});
    if (boll) list.push({name: 'BOLL', params: boll});
    if (rsi) list.push({name: 'RSI', params: [rsi.period]});
    if (macd) list.push({name: 'MACD', params: macd});
    try { chart.indicators.preview(list); } catch (e) {}
  }
  const asLine = l => ({price: l.px, color: l.color, dash: l.dash, size: l.size, label: l.label, right: l.right, tick: l.tick});
  function drawLines2() {
    if (WS && $('lab-ctabs')) labVch();             /* the page's timeframe changed: another coin's chart follows it */
    if (!chart || !S.candles || !S.candles.length) return;
    if (!BOTMODE) { chart.lines.bundle('bots', null); chart.lines.bundle('botPreview', null); for (const id of chart.lines.ids('botPreview')) chart.lines.remove(id); return; }
    indicators();
    const k = chartColors(), span = [];
    const run = runningLines(k);
    chart.lines.bundle('bots', B.showBots && run.length ? {lines: run.map(asLine)} : null);
    if (B.showBots) span.push(...run.filter(l => !l.tick).map(l => l.px));
    const ch = $('tb-show'); if (ch) ch.hidden = !run.length;
    const on = WS ? labOn() && !B.view && P.planned(B.kind) : B.panel === 'bot' && !B.view && !claimOf(S.coin, S.venue);   /* the lab: the settings being tested */
    const pv = on ? previewLines(k) : {lines: [], handles: []};
    span.push(...(pv.band || []), ...pv.handles.map(h => h.px), ...pv.lines.filter(l => !l.right).map(l => l.px));
    chart.keepInView('bots', span.length ? Math.min(...span) : 0, span.length ? Math.max(...span) : 0);
    chart.lines.bundle('botPreview', on && (pv.band || pv.lines.length) ? {lines: pv.lines.map(asLine), band: pv.band, bandColor: alpha(k.acc, .06)} : null);
    const keep = new Set();
    for (const hd of pv.handles) {
      const id = 'bot:' + hd.which; keep.add(id);
      chart.lines.upsert(id, {price: hd.px, color: hd.color, label: hd.drag ? _t('{label} · drag', {label: hd.title}) : hd.title, kind: 'botPreview', draggable: true, style: 'handle',
        onMoving: v => { const i = hd.which === 'lower' || hd.which === 'upper' || /_px$/.test(hd.which) ? document.querySelector(`#bot-pane [data-bk="${hd.which}"], #lab-set [data-bk="${hd.which}"]`) : null; if (i && v) i.value = T().niceRound(v); },
        onMove: v => dragged(hd.which, v, hd.ref)});
    }
    for (const id of chart.lines.ids('botPreview')) if (!keep.has(id)) chart.lines.remove(id);
  }
  /* a chart line dragged to v -> the settings it changes ({key: value}), or null when the move cannot be (a range's low
     above its high); the guided setup fills its fields with it while the line moves (bot-flow.js) */
  function dragCh(which, v, ref) {
    const c = cfg(), first = (which === 'sl' && ref > 0 && ref) || (B.plan.orders && B.plan.orders.length && B.plan.orders[0].px) || mkPrice();
    const ch = T().dragSetting(B.kind, which, {...c, side: c.side}, first, v);
    if (!ch) return null;
    if ('lower' in ch && c.upper && ch.lower >= c.upper) return null;
    if ('upper' in ch && c.lower && ch.upper <= c.lower) return null;
    if (B.kind === 'trailstop' && 'sl_pct' in ch && !c.activation_pct && c.by !== 'atr') { ch.trail_pct = ch.sl_pct; delete ch.sl_pct; }
    return ch;
  }
  function dragged(which, v, ref) {
    const s = shape(), c = cfg(), ch = dragCh(which, v, ref);
    if (!ch) return drawLines2();
    if (P.GRIDS.includes(B.kind) && ('lower' in ch || 'upper' in ch)) { s.lower = c.lower; s.upper = c.upper; delete s.range; s.range_man = true; }
    Object.assign(s, ch); edited();
    render(); renderReview(); schedule(true);
  }
  /* two clicks on the chart set the grid's range (after "Pick on the chart") */
  let down = null;
  function chartClicks() {
    const el = $('chart'); if (!el || el.dataset.tb) return; el.dataset.tb = '1';
    el.addEventListener('pointerdown', e => { down = {x: e.clientX, y: e.clientY}; }, true);
    el.addEventListener('click', e => {
      if (!B.pick || !chart || B.panel !== 'bot' || !P.GRIDS.includes(B.kind)) return;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const v = chart.priceAt(e.clientX, e.clientY); if (!(v > 0)) return;
      const s = shape();
      if (B.pick === 1) { B.pickA = v; B.pick = 2; dhint(`${_t('{v} · now click the other end of the range · Esc to cancel', {v: px(v)})}`); return; }
      const lo = Math.min(B.pickA, v), hi = Math.max(B.pickA, v); B.pick = 0; dhint(null);
      if (hi / lo < 1.002) return;
      s.lower = T().niceRound(lo); s.upper = T().niceRound(hi); delete s.range; s.range_man = true; edited();
      render(); schedule(true);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && B.pick) { B.pick = 0; dhint(null); render(); } });
  }
  function chartToggle() {
    if (!BOTMODE) return;
    const ph = document.querySelector('#p-chart .ph'), src = $('chart-src');
    if (!ph || !src || $('tb-show')) return;
    const b = document.createElement('button'); b.className = 'fv'; b.id = 'tb-show'; b.type = 'button'; b.hidden = true; b.title = _t('Show the lines of your bots on this market');
    b.setAttribute('aria-pressed', String(B.showBots));
    const paint = () => { b.innerHTML = `${B.showBots ? I.check : '<svg class="i" viewBox="0 0 24 24"></svg>'}<span>${_t('Bots')}</span>`; b.setAttribute('aria-pressed', String(B.showBots)); };
    b.onclick = () => { B.showBots = !B.showBots; pref.set('showbots', B.showBots ? '1' : '0'); paint(); drawLines2(); };
    paint(); ph.insertBefore(b, src);
  }
  function paintChartNote() { const l = $('cbar-l'); if (l && C()) l.textContent = PAIR() + ' chart' + chartNote(); }
  function chartNote() {
    if (WS) return '';
    if (B.panel !== 'bot' || B.view === 'signal' || B.priv) return '';
    const n = P.MORE.includes(B.kind) && T().botOverlay(B.kind, {...shape(), ...cfg(), coin: S.coin}, [], mkPrice() || 1, []).note;
    return ' · ' + _t('{kind} preview', {kind: kindName(B.kind)}) + (n ? ' · ' + n : '');
  }

  /* the book: rows at a grid line get the line's side colour (a preview and a running grid on this market) */
  function markBook(el, step) {
    if (!el || !T() || !BOTMODE) return;
    let lines = [];
    const run = live().find(b => b.coin === S.coin && b.venue === S.venue && T().isGrid(b.kind));
    if (run && !run.config.private) lines = T().gridLines(run.config.lower, run.config.upper, run.config.grids, curPrice(), run.config.spacing);
    else if (!run && !B.priv && B.panel === 'bot' && P.GRIDS.includes(B.kind)) { const c = cfg(); if (c.upper > c.lower) lines = T().gridLines(c.lower, c.upper, c.grids, curPrice(), c.spacing); }
    if (!lines.length) return;
    const rows = [...el.querySelectorAll('.bk-r[data-p]')], m = T().bookMarks(rows.map(r => +r.dataset.p), lines, step);
    for (const r of rows) { const s = m[+r.dataset.p]; if (s) { r.classList.add('gl'); if (s === 'sell') r.classList.add('s'); r.title = _t('Grid line: {s}', {s: s === 'sell' ? _t('sell') : s === 'buy' ? _t('buy') : s}); } }
  }

  /* ---------------- panel switching, deep links ---------------- */
  function setPanel(p) {
    B.panel = BOTMODE ? 'bot' : 'order';
    if (B.panel === 'bot') { schedule(true); syncTf(); }
    else { B.pick = 0; dhint(null); }
    render(); drawLines2(); syncUrl();
    if (isPhone()) { const t = $('fsw'); if (t && t.getBoundingClientRect().top < 48) t.scrollIntoView({block: 'start'}); }
  }
  function showBots(id) {
    if (FLOW) { location.href = `/bots/terminal?coin=${encodeURIComponent(S.coin)}&venue=${S.venue}&panel=bots` + (id ? `&bot=${id}` : ''); return; }
    if (!BOTMODE) { location.href = `/bots/terminal?coin=${encodeURIComponent(S.coin)}&venue=${S.venue}` + (id ? `&bot=${id}` : ''); return; }
    S.tab = 'bots'; renderBottom();
    const t = $('p-bottom'); if (isPhone() && t.scrollIntoView) t.scrollIntoView({block: 'start', behavior: 'smooth'});
  }
  function qs() {
    if (!BOTMODE) return '';
    /* the lab (/bots/terminal) names its tested bot `test`: `kind` there means the guided setup (radar/bot_flow.py
       flow_redirect), so a reload or a shared link of the lab stays on the lab */
    let q = `&${FLOW ? 'kind' : 'test'}=${B.view === 'signal' ? 'signal' : B.kind}`;
    if (FLOW) {
      const f = B.flow, from = B.priv && B.priv.coin === S.coin ? B.priv.slug : B.shared && B.shared.kind === B.kind && B.shared.coin === S.coin && B.shared.venue === S.venue ? B.shared.slug : null;
      if (f && f.edit) q += `&edit=${f.edit}`;
      if (from) q += `&from=${encodeURIComponent(from)}`;
    }
    return q;
  }
  function syncUrl() { try { history.replaceState(null, '', `?coin=${encodeURIComponent(S.coin)}&venue=${S.venue}` + qs()); } catch (e) {} }
  function onSelect(changed) {
    if (!changed) return;
    if (B.keepFor !== S.coin + '|' + S.venue && B.shape.grid && B.shape.grid.auto !== false) delete B.shape.grid;   // a /bots pick's own range stays on its market
    else if (B.keepFor !== S.coin + '|' + S.venue && B.shape.grid) { delete B.shape.grid.lower; delete B.shape.grid.upper; B.shape.grid.range = B.shape.grid.range || .08; }
    B.keepFor = null; B.chk = null; B.bt = B.btLast = null; B.pick = 0; B.plan = null;
    if (B.shared && (B.shared.coin !== S.coin || B.shared.venue !== S.venue)) B.shared = null;
    if (B.priv && B.priv.coin !== S.coin) B.priv = null;             /* another exchange for the same coin: the copy moves there */
    if (B.priv) { B.privChk = null; B.bt = null; }
    if (B.panel === 'bot') schedule();
  }
  function onMarket() { if (B.panel === 'bot') { render(); schedule(); } }
  /* a bot's market is shared with hand trades (radar/auto/botshare.py): the server applies the rules and the quote
     carries the warning, so the order form is never blocked here any more */
  function claim(coin, venue) { return null; }
  function useConfig(kind, c) { const f = P.fromConfig(kind, c); B.shape[kind] = f.shape; B.total[kind] = f.total || null; B.preset[kind] = null;
    if (f.shape && f.shape.lower && f.shape.upper) f.shape.range_man = true; }     /* a set range is kept as set (the lab's test too) */

  /* ---------------- a copy of a private setup (the creator hid the settings) ----------------
     The page never has the settings: the copier sets the amount (the margin), their own stop loss (% of the amount) and max
     loss (USDC), and picks the exchange and margin mode as for any bot; the server builds the bot from the creator's
     settings (/api/setups/<slug>/hidden/check and /hidden/backtest, then /api/auto/bots/create with setup). The backtest of
     exactly that bot runs on the server and shows its results only (labelled as a simulation). */
  const privPayload = () => ({amount: B.privIn.amount, venue: S.venue, margin_mode: curMode(), sl_pct: B.privIn.sl, max_loss_usd: B.privIn.max});
  const privKey = () => JSON.stringify(privPayload());
  function privBlocks() {
    const r = B.privChk && B.privChk.key === privKey() ? B.privChk : null, out = acctBlocks(), room = avail();
    // under the copy's minimum: said with its fix also signed out or before the exchange is connected (the account's own
    // lines come after it), as a planned bot's guard does (audit bots-ui-16)
    const low = r && !r.ok && r.min_usd > 0 && B.privIn.amount > 0 && B.privIn.amount < r.min_usd - 1e-9;
    const minB = low ? {text: r.error, min: true, fix: [{label: _t('Use ${0}').replace('{0}', num(r.min_usd)), set: r.min_usd}]} : null;
    if (out.length) return minB ? [minB].concat(out) : out;
    if (!(B.privIn.amount > 0)) out.push({text: _t('Enter an amount')});
    else if (room != null && B.privIn.amount > room + 0.005) out.push({text: _t('Not enough free on {0} (${1} free)').replace('{0}', L(S.venue)).replace('{1}', num(room)), fix: [{label: _t('Deposit'), href: '/app#exchanges'}]});
    else if (!r) out.push({text: _t('Checking…'), wait: true});
    else if (!r.ok) out.push(minB || (r.fix === 'cross' ? {text: r.error, fix: [{label: _t('Use Cross'), act: 'cross'}]} : {text: r.error}));
    return out;
  }
  /* the copy's margin set to Cross (residual audit bots-engine-05: "Choose Cross margin" with no control to do it) */
  function useCross() {
    MM.pick[mmKey(S.venue, S.coin)] = 'cross';
    B.privChk = null; B.bt = null;
    render(); schedule(true);                       // the guided setup re-renders through render() too (flowHook)
  }
  /* the margin mode of a private copy: the same chip and sheet as any bot */
  const privMode = () => openMode(() => { B.privChk = null; B.bt = null; render(); schedule(true); });
  /* a private copy's minimum before anything is typed (and on each exchange picked): the server's check answers it for
     any amount (setups.hidden_min depends on the exchange only), so one check at the setup's own size tells it */
  function privMinProbe() {
    const v = S.venue, slug = B.priv && B.priv.slug;
    if (!slug || (B.privMinAt && B.privMinAt.slug === slug && B.privMinAt.venue === v)) return;
    B.privMinAt = {slug, venue: v, min: null};
    api0(`/api/setups/${encodeURIComponent(slug)}/hidden/check`, {...privPayload(), amount: Math.max(1, Math.round(B.priv.ref || 1000))})
      .then(r => { if (B.privMinAt && B.privMinAt.slug === slug && B.privMinAt.venue === v) { B.privMinAt.min = r && r.min_usd > 0 ? r.min_usd : null; paintPriv(); } })
      .catch(() => { if (B.privMinAt && B.privMinAt.slug === slug && B.privMinAt.venue === v) B.privMinAt = null; });
  }
  /* a private copy's amount set by a fix (its minimum): the copier's own field, then its check and backtest again */
  function setPrivAmount(v) {
    B.privIn.amount = v > 0 ? Math.ceil(v * 100 - 1e-7) / 100 : null; B.bt = null;
    document.querySelectorAll('#bot-pane [data-pk=amount], #bf [data-pk=amount]').forEach(i => { if (i !== document.activeElement) i.value = B.privIn.amount == null ? '' : B.privIn.amount; });
    paintPriv(); flowHook('render'); schedule(true);                 // the guided Review's own line names the amount too
  }
  function privCheck() {
    privMinProbe();
    if (!(B.privIn.amount > 0)) { paintPriv(); renderReview(); return; }
    const want = privKey(), seq = ++B.seq;
    api0(`/api/setups/${encodeURIComponent(B.priv.slug)}/hidden/check`, privPayload())
      .then(r => { if (seq === B.seq && want === privKey()) { B.privChk = {...r, key: want}; paintPriv(); renderReview(); } })
      .catch(e => { if (seq === B.seq) { B.privChk = {ok: false, error: e.message, key: want}; paintPriv(); renderReview(); } });
  }
  const privVal = k => { const r = B.privChk && B.privChk.ok && B.privChk.key === privKey() ? B.privChk : null, a = avail();
    return {avail: a == null ? '–' : num(a) + ' USDC', pos: r ? fmtU(r.max_position_usd) : '–',
            fee: esc(feeTxt()), lev: (r ? r.leverage : B.priv.lev) + 'x'}[k]; };
  function renderPriv(pane) {
    if (!pane) return;
    const keep = document.activeElement && pane.contains(document.activeElement) ? document.activeElement.dataset.pk : null;
    const inp = (k, label, v, unit, t) => `<div class="tb-pr"><label class="k" for="tbp-${k}">${label}${tipI(t)}</label><span class="inp tb-pi"><input id="tbp-${k}" data-pk="${k}" inputmode="decimal" autocomplete="off" value="${v == null ? '' : esc(v)}" placeholder="${esc(_t('Optional'))}"><span class="u">${unit}</span></span></div>`;
    const ro = (label, k) => `<div class="tb-pr"><span class="k">${label}</span><span class="v" data-pv="${k}">${privVal(k)}</span></div>`;
    const left = `<section class="tb-s">${secH(1, _t('Private settings'))}<p class="tb-line">${_t('The creator keeps this bot\'s settings private: its entries, exits and steps are not shown.')}</p>` +
        `<div class="tb-rows">${kvRow(_t('Bot'), esc(kindName(B.priv.kind)))}${ro(_t('Leverage'), 'lev')}` +
        kvRow(_t('Margin'), `<button class="tb-tx" id="tb-mm" type="button">${cross() ? _t('Cross') : _t('Isolated')}${I.chev}</button>`) +
        `${kvRow(_t('Exchange'), esc(L(S.venue)))}</div></section>` +
      `<section class="tb-s">${secH(2, _t('Your limits'))}<div class="tb-rows">` +
        inp('sl', _t('Stop loss'), B.privIn.sl, '%', _t('Closes everything and stops once the bot has lost this share of its amount (closed and open P&L together).')) +
        inp('max', _t('Max loss'), B.privIn.max, 'USDC', _t('Closes everything and stops once the bot has lost this many dollars.')) + '</div></section>';
    const right = `<section class="tb-s">${secH(3, _t('Investment'))}<div class="inp tb-amt"><input data-pk="amount" inputmode="decimal" autocomplete="off" value="${B.privIn.amount == null ? '' : esc(B.privIn.amount)}" placeholder="${esc(_t('Amount'))}" aria-label="${_t('Total investment')}"><span class="u">USDC</span><button class="mx" type="button" id="tb-pmax">${_t('MAX')}</button></div>` +
        `<div class="tb-rows">${ro(`${_t('Available')} ${tip(_t('Margin free on {v} now: what the exchange reports as free, not held by open positions or orders.', {v: L(S.venue)}))}`, 'avail')}${ro(_t('Largest position'), 'pos')}${ro(`${_t('Fees per fill')} ${feeTip()}`, 'fee')}</div><div class="dc" data-bt="pwarn"></div></section>` +
      `<div class="tb-foot"><div class="tb-blk" data-bt="blk"></div>${BP === '3' ? '' : `<button class="go n" id="tb-go" type="button">${_t('Create bot')}</button>`}</div>` +
      `<section class="tb-s tb-bts"><div class="dc" data-bt="bt">${btH()}</div></section>`;
    const kt = NEW ? `<div class="tb-kt">${pickerH()}</div>` : `<div class="tb-g">${pickerH()}</div>`;
    pane.innerHTML = kt + `<div class="hint">${_t('Copied from “{title}”. Set your total, then start.', {title: esc(B.priv.title)})}</div>` +
      `<div class="tb-split"><div class="tb-c1">${left}</div><div class="tb-c2">${right}</div></div>`;
    if (NEW) { gutter(pane); fitStrip(); }
    pane.querySelectorAll('[data-pk]').forEach(el => el.addEventListener('input', () => {
      const v = +el.value.replace(',', '.'); B.privIn[el.dataset.pk] = el.value.trim() && isFinite(v) && v > 0 ? v : null; B.bt = null; paintPriv(); paintBt(); schedule(); }));
    if ($('tb-pmax')) $('tb-pmax').onclick = () => { const a = avail(); if (a > 0) { B.privIn.amount = Math.floor(a * 100) / 100; B.bt = null; renderPriv(pane); schedule(true); } };
    if ($('tb-kind')) $('tb-kind').onclick = openKinds;
    if ($('tb-go')) $('tb-go').onclick = () => openReview();
    if ($('tb-mm')) $('tb-mm').onclick = privMode;
    bindLinks(pane);
    if (keep) { const i = pane.querySelector(`[data-pk="${keep}"]`); if (i) { i.focus(); if (i.value) i.setSelectionRange(i.value.length, i.value.length); } }
    paintPriv(); paintChartNote(); drawLines2();
  }
  function paintPriv() { paintPriv0(); flowHook('paint'); }
  function paintPriv0() {
    document.querySelectorAll('#bot-pane [data-pv]').forEach(e => { e.innerHTML = privVal(e.dataset.pv); });
    const bl = privBlocks(), pr = B.privChk && B.privChk.ok && B.privChk.key === privKey() ? B.privChk : null;
    document.querySelectorAll('[data-bt="blk"]').forEach(e => { e.innerHTML = blocksH(bl); bindLinks(e); });
    document.querySelectorAll('[data-bt="pwarn"]').forEach(e => { e.innerHTML = pr ? (pr.warnings || []).map(w => `<div class="warn">${esc(w)}</div>`).join('') : ''; });
    const g = $('tb-go');
    if (g && S.signedOut) { g.disabled = false; g.textContent = _t('Connect wallet'); }
    else if (g) { g.disabled = bl.length > 0; g.textContent = bl.some(b => b.wait) ? _t('Loading…') : _t('Create bot'); }
    paintStrip();
  }
  function privStrip() {
    const d = B.bt && B.bt.stats ? B.bt.stats : null;
    return [['pv', _t('Settings'), _t('Private'), 3], ['pos', _t('Largest position'), privVal('pos'), 5], ['fee', _t('Fees per fill'), privVal('fee'), 4],
      ['bt', `${_t('Backtest')} <i class="tb-sim">${_t('Simulation')}</i>`, d ? `<span class="${d.return_pct >= 0 ? 'up' : 'dn'}">${C().fmtPct(d.return_pct / 100, 1)}</span>` : '–', 2]];
  }
  function privReviewH() {
    const r = B.privChk && B.privChk.ok && B.privChk.key === privKey() ? B.privChk : null, bl = privBlocks();
    const title = `${_t('Start {coin} {kind} bot on {v}?', {coin: esc(S.coin), kind: kindWord(B.priv.kind), v: esc(L(S.venue))})}`;
    let b = `<div class="kv">${row(_t('Exchange'), esc(L(S.venue)))}${row(_t('Market'), _t('{pair} perpetual', {pair: esc(PAIR())}))}${row(_t('Bot'), `${kindName(B.priv.kind)}<span class="sub">${_t('Private settings')} · ${r ? r.leverage : B.priv.lev}x</span>`)}` +
      (r ? row(_t('Investment'), fmtU(r.budget_usd)) + row(_t('Largest position'), fmtU(r.max_position_usd)) +
           row(_t('Fees'), `${esc(r.venue_label)} ${C().fmtRate((r.maker_pct || 0) / 100)}<span class="sub">${_t('Rivemont {C}', {C: C().fmtRate((r.fee_pct || 0) / 100)})}</span>`) : row(_t('Investment'), fmtU(B.privIn.amount || 0))) + '</div>';
    b += r ? `<div class="tb-sum"><div class="k">${_t('What this bot will do')}</div><ol class="tb-ol">${r.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>` : '';
    b += `<div class="tb-blk">${blocksH(bl)}</div>`;
    b += `<p class="explain">${_t('Pause or stop it any time under Bots.')} ${tip(_t('Non-custodial: the bot trades in your own {v} account. Rivemont\'s key can trade but can\'t withdraw.', {v: L(S.venue)}))}</p>`;
    const go = `<button class="go n" id="sh-go-bot" type="button" ${r && !bl.length ? '' : 'disabled'}>${r || bl.length ? _t('Start bot') : _t('Checking…')}</button>`;
    return `<div class="sh-h"><h3>${title}</h3><button class="xb" data-close type="button" aria-label="${_t('Close')}">${I.x}</button></div>` +
      `<div class="sh-b" id="tb-sheet">${b}</div><div class="sh-f${isPhone() ? ' stick' : ''}"><button class="bt" data-close type="button">${_t('Cancel')}</button>${go}</div>`;
  }
  async function loadShared(slug) {
    B.sharedLoading = slug; B.sharedErr = null;
    try {
      const v = await api0('/api/setups/' + encodeURIComponent(slug));
      if (FLOW && window.BotFlow && BotFlow.state.pend !== 'from') return;      // the setup stopped waiting (it said so): too late
      const c = clone(v.config), venue = c.venue || v.venue, coin = c.coin || v.coin;
      B.kind = v.kind;
      if (v.private_settings) {           /* the creator hid the settings: the copier sets the amount and their own limits */
        B.priv = {slug: slug.split('@')[0], title: v.title, kind: v.kind, coin, lev: v.leverage || 1, ref: v.reference_usd};
        B.privIn = {amount: null, sl: null, max: null}; B.privChk = null; B.bt = B.btLast = null;
        select(coin, venue); setPanel('bot'); return;
      }
      select(coin, venue);
      useConfig(v.kind, c); B.total[v.kind] = null;                  // the customer's own amount: typed, never copied
      B.shared = {slug, title: v.title, ref: v.reference_usd, coin, venue, kind: v.kind};
      setPanel('bot');
    } catch (e) { B.sharedErr = e.message || ' '; if (!FLOW) notice('err', _t('This setup is not available'), e.message); }      // the guided setup says it in the page
    finally { B.sharedLoading = null; flowHook('render'); }
  }
  /* ---------------- the Backtest lab (the Bot terminal in the workspace design): pick a bot type, an amount and a period, then every setting of that type, as the guided setup's
     Customize has them (bot-flow.js BotFlowKit: the same rows, this file's state, bindings and checks), Safe / Balanced /
     Aggressive filling them. The chart draws the bot's lines as they change (drawLines2, previewLines); Run backtest sends
     exactly these settings (the setup's own request, /api/auto/bots/backtest: the same engine, fees and funding included,
     a simulation); Start this bot opens the guided setup (/bots/new) with them (cfg=, as a /bots pick's link). ---------------- */
  const LAB_SKIP = ['signal', 'scaleout'];          // a webhook / a position you hold: set up in /bots/new
  const LAB = {amount: +pref.get('labamt', '') || 1000, days: 30, res: null, busy: false, seq: 0, tab: 'entry', last: '', lastR: '', err: ''};
  const labKinds = () => KINDS.filter(k => !LAB_SKIP.includes(k) && !P.NO_BT.includes(k) && T().BOT_PRESETS && T().BOT_PRESETS[k]);
  const labOn = () => WS && !!$('lab-cfg');
  const WSI = {play: 'M7 4l14 8-14 8z', arrow: 'M4 12h16M15 7l5 5-5 5', layers: 'M3 7l9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4', flask: 'M9 3h6M10 3v7L4 20h16l-6-10V3M8 14h8',
               info: 'M12 11v6M12 7v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', plus: 'M12 4v16M4 12h16', down: 'M6 9l6 6 6-6'};
  const wsi = n => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${WSI[n]}"/></svg>`;
  /* the guided setup with the tested settings (terminal-bots.js init reads cfg=, bot-flow.js opens its Customize) */
  const b64 = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const labHref = d => `/bots/new?coin=${encodeURIComponent(d.coin)}&venue=${encodeURIComponent(d.venue)}&kind=${encodeURIComponent(d.kind)}` +
    (d.amount > 0 ? `&amount=${encodeURIComponent(d.amount)}` : '') + `&cfg=${encodeURIComponent(b64(d.config))}`;
  const kit = () => window.BotFlowKit ? (LAB.kit = LAB.kit || window.BotFlowKit(TBX)) : null;
  const PRESETS = () => [['safe', _t('Safe')], ['balanced', _t('Balanced')], ['aggressive', _t('Aggressive')]];
  /* what keeps the test from running: the settings' own checks (the setup's, without the account's: no wallet is needed) */
  const labBlocks = () => P.planned(B.kind) ? labFieldErrs().concat(setBlocks(true).filter(b => !b.quiet)) : [];
  /* a number field the bot cannot use as typed (past its limit, a fraction where a count goes, a word): named with its
     field and kept from the test, as Customize does (BotFlowKit fieldErrs), never clamped without a word (QA 2026-10-07:
     -1 extra orders ran as 0). Every tab's number fields count, not only the one open */
  function labFieldErrs() {
    const K = kit(); if (!K || !K.fieldErrs || !P.planned(B.kind)) return [];
    const s = shape(), c = cfg(), G = K.groupsNow(), box = document.createElement('div');
    box.innerHTML = ['entry', 'exit', 'risk', 'timing'].map(g => (G[g] || []).map(key => K.rowOf(key, s, c)).join('')).join('');
    const keys = [...new Set([...box.querySelectorAll('input[data-bk][inputmode="decimal"]')].map(i => i.dataset.bk))];
    return K.fieldErrs(keys).map(e => { const i = box.querySelector(`[data-bk="${CSS.escape(e.key)}"]`), r = i && i.closest('.bf-r'), k = r && r.querySelector('.k');
      return {key: e.key, field: e.text, text: (k ? k.textContent + ': ' : '') + e.text}; });
  }
  /* the request: the settings on screen, as the setup sends them (payload, btReq) */
  function labReq() {
    try {
      const bl = labBlocks(); if (bl.length) return {error: bl[0].text};
      /* a grid range the customer did not set is laid around today's price: the test centres it on the price at its
         start instead (the server's backtest.recentred, said under the result), so a 30-day test does not leave it on day one */
      const auto = P.GRIDS.includes(B.kind) && !shape().range_man;
      return {body: {kind: B.kind, config: payload(), days: LAB.days, ...(auto ? {recenter: true} : {})}};
    } catch (e) { return {error: _t('Something went wrong. Try again.')}; }
  }
  /* the same request twice (a second click, a setting put back) shows the kept answer instead of asking the server again
     (its backtests are rate limited: quick repeats were answered "busy"); clicks while one runs, or within a second, wait */
  const LAB_CACHE = new Map();
  async function labRun() {
    const q = labReq();
    if (q.error) { LAB.err = q.error; labLive(); return; }
    if (LAB.busy || Date.now() - (LAB.at0 || 0) < 1000) return;
    const key = JSON.stringify([S.coin, S.venue, q.body]), kept = LAB_CACHE.get(key);
    const done = d => ({...d, kind: B.kind, coin: S.coin, venue: S.venue, amount: total(), days: LAB.days, config: q.body.config, preset: B.preset[B.kind]});
    LAB.err = '';
    if (kept) { LAB.res = done(kept); labPaint(); return; }
    const seq = ++LAB.seq; LAB.at0 = Date.now(); LAB.busy = true; labPaint();
    let d; try { d = await api0('/api/auto/bots/backtest', q.body); } catch (e) { d = {error: e.message}; }
    if (seq !== LAB.seq) return;
    if (!d.error) { LAB_CACHE.set(key, d); if (LAB_CACHE.size > 24) LAB_CACHE.delete(LAB_CACHE.keys().next().value); }
    LAB.busy = false; LAB.res = done(d); labPaint();
  }
  /* the type's settings by Entry / Exit / Risk / Timing: one section at a time under its tab (Entry first), as the
     setup's own sections; every row is the guided setup's (BotFlowKit) */
  /* the leverage and the margin mode sit under the amount (not hidden in
     Risk): the setup's own controls and dialog (per-coin maximum), where the type has them, as the setup decides */
  const labLev = () => { const K = kit(); return !!(K && P.planned(B.kind) && (K.groupsNow().risk || []).includes('leverage') && K.rowOf('leverage', shape(), cfg())); };
  function labSets() {
    const K = kit(); if (!K || !P.planned(B.kind)) return '';
    const s = shape(), c = cfg(), G = K.groupsNow(), top = labLev() ? ['leverage', 'margin'] : [];
    const secs = ['entry', 'exit', 'risk', 'timing'].map(g => [g, (G[g] || []).filter(key => !top.includes(key)).map(key => K.rowOf(key, s, c)).join('')]).filter(x => x[1]);
    if (!secs.length) return '';
    const on = secs.some(x => x[0] === LAB.tab) ? LAB.tab : secs[0][0];
    return `<div class="tab-row lab-tabs" role="tablist" aria-label="${_t('Settings')}">` +
      secs.map(([g]) => `<button type="button" role="tab" data-lab-tab="${g}" class="${g === on ? 'active' : ''}" aria-selected="${g === on}">${K.GNAME()[g]}</button>`).join('') + '</div>' +
      `<div class="lab-rows" role="tabpanel">${secs.find(x => x[0] === on)[1]}</div>`;
  }
  function labConfig() {
    const opt = labKinds().map(k => `<option value="${k}"${k === B.kind ? ' selected' : ''}>${esc(kindName(k))}</option>`).join('');
    const days = [7, 30, 90].map(n => `<option value="${n}"${n === LAB.days ? ' selected' : ''}>${esc(_t('Last {n} days', {n}))}</option>`).join('');
    const t = B.total[B.kind], raw = amtErr() ? B.bad[B.kind] || '' : '', pre = B.preset[B.kind];
    return `<div class="panel-head"><h2>${_t('Test a bot')}</h2><span class="pill">${esc(C().mktName(S.coin))} / ${esc(QT())}</span></div><div class="panel-body">` +
      `<div class="form-group"><label for="lab-kind">${_t('Bot type')}</label><select id="lab-kind">${opt}</select><p class="form-help" id="lab-line">${esc(typeLine(B.kind))}</p></div>` +
      `<div class="form-grid lab-g"><div><label for="lab-amt">${_t('Amount')} · ${esc(QT())}</label><input id="lab-amt" data-inv="1" type="text" inputmode="decimal" autocomplete="off" value="${esc(t == null ? raw : String(t))}" placeholder="0"></div>` +
      `<div><label for="lab-days">${_t('Period')}</label><select id="lab-days">${days}</select></div>` +
      (labLev() ? `<div><label for="tb-lev">${_t('Leverage')}</label>${kit().levC()}</div><div><label for="tb-mm">${_t('Margin')}</label>${kit().mmC()}</div>` +
        `<p class="form-help lab-lvh" data-fv="levline">${esc(kit().levLine())}</p>` : '') + '</div>' +
      `<div class="lab-pre"><span class="lab-k">${_t('Settings')}</span><div class="bf-seg" data-bseg="__pre" role="group" aria-label="${_t('Settings')}">` +
        PRESETS().map(([n, l]) => `<button type="button" data-bpre="${n}" class="${pre === n ? 'on' : ''}" aria-pressed="${pre === n}">${esc(l)}</button>`).join('') + '</div></div>' +
      `<div class="lab-set" id="lab-set">${labSets()}</div>` +
      /* the fees, the first block and Run stay in view under the settings (sticky at the window's bottom edge) */
      `<div class="lab-foot"><div class="summary-line lab-fee"><span>${_t('Fees per fill')}</span><span data-lab="fee">${esc(feeTxt())}</span></div>` +
      `<p class="error" id="lab-err" role="alert" data-lab="err"></p>` +
      `<button class="button primary lab-run" id="lab-run" type="button"${LAB.busy ? ' disabled' : ''}>${wsi('play')}${LAB.busy ? _t('Replaying past prices…') : _t('Run backtest')}</button></div></div>`;
  }
  /* when the test stopped the bot (its stop loss, its range, a liquidation ...): said with the day, never hidden */
  function labStop(s) {
    if (!s.stopped_because) return '';
    let when = '';
    try { when = s.stopped_at ? new Date(s.stopped_at * 1000).toLocaleString(document.documentElement.lang || undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : ''; } catch (e) { when = ''; }
    let flat = '';
    try { flat = s.flat_since ? new Date(s.flat_since * 1000).toLocaleString(document.documentElement.lang || undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : ''; } catch (e) { flat = ''; }
    return `<p class="lab-stop" role="status">${wsi('info')}<span>${esc(when ? _t('Stopped on {date}: {why}', {date: when, why: s.stopped_because}) : _t('It stopped: {why}', {why: s.stopped_because}))}` +
      `${flat ? ' ' + esc(_t('No position was open then: the last one closed on {date}.', {date: flat})) : ''}</span></p>`;
  }
  /* the worst drop: never "−0.0%" (a drop under 0.05% shows two decimals; none at all reads 0.0%) */
  const ddTxt = v => !(v > 0.004) ? '0.0%' : '−' + v.toFixed(v < 0.05 ? 2 : 1) + '%';
  function labResult() {
    const d = LAB.res;
    if (!d) return `<section class="panel lab-empty"><div class="empty-state">${wsi('layers')}<h3>${_t('A result you can inspect')}</h3><p>${_t('Run a test to see the result, the worst drop, the fees and every simulated trade.')}</p></div></section>`;
    if (d.error) return `<section class="panel lab-empty"><div class="empty-state">${wsi('info')}<h3>${_t('This test could not run')}</h3><p>${esc(d.error)}</p></div></section>`;
    const s = d.stats || {}, u = btUsd(d), idle = P.btIdle(s);
    const met = (label, value, foot) => `<div class="metric"><div class="label">${label}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`;
    /* the list: the latest closed trades, its count the test's own (a grid's rows are its positions, flat to flat: its
       cycles are counted above) */
    const all = (d.trades || []).filter(t => t.end), tr = all.slice(-12).reverse(), tot = Math.max(all.length, s.cycles == null && s.rebalances == null ? s.trades || 0 : 0);
    const when = t => { try { return new Date(t * 1000).toLocaleString(document.documentElement.lang || undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}); } catch (e) { return ''; } };
    const pre = PRESETS().find(([n]) => n === d.preset);
    return `<div class="section-title"><h2>${_t('Backtest results')} <span class="pill amber">${_t('Simulation')}</span></h2></div>` +
      `<p class="small muted lab-sub">${esc(kindName(d.kind))} · ${esc(C().mktName(d.coin))} · ${esc(_t('Last {n} days', {n: d.days}))} · ${esc(fmtU(d.amount, 0))} · ${pre ? esc(pre[1]) : _t('Your settings')}</p>` +
      (d.range_start ? `<p class="small muted lab-sub lab-rs">${esc(_t('Range set from the price at the start of the test: {lo} – {hi}', {lo: rp(d.range_start.lower), hi: rp(d.range_start.upper)}))}</p>` : '') +
      labStop(s) +
      '<div class="metrics">' + met(_t('Result'), idle ? C().fmtPct(0, 2) : `<span class="${s.return_pct > 0 ? 'positive' : s.return_pct < 0 ? 'negative' : ''}">${C().fmtPct(s.return_pct / 100, 2)}</span>`, u == null ? '' : sgnU(u) + ' ' + esc(QT())) +
      met(_t('Worst drop'), ddTxt(s.max_drawdown_pct), (s.hold_pct != null ? esc(_t('Buy and hold')) + ' ' + sgnPct(s.hold_pct) : d.hold && d.hold.hold_pct != null ? esc(_t('Just holding')) + ' ' + sgnPct(d.hold.hold_pct) : '')) +
      (s.rebalances != null ? met(_t('Rebalances'), String(s.rebalances), esc(_t('Fills')) + ' ' + (s.fills || 0)) :
      met(s.cycles != null ? _t('Grid cycles') : _t('Trades'), String(s.cycles != null ? s.cycles : s.trades || 0), s.wins != null && s.trades ? esc(_t('{n} won', {n: s.wins})) : '')) +
      met(_t('Fees'), s.fees_usd != null ? esc(fmtU(s.fees_usd, 2)) : '–', s.funding_usd ? esc(_t('Funding')) + ' ' + sgnU(s.funding_usd) : esc(feeTxt())) + '</div>' +
      `<section class="panel"><div class="panel-head"><h2>${_t('Simulated equity')}</h2><span class="small muted">${_t('After fees and funding')}</span></div><div class="panel-body lab-eq">${btCurve(d, 160) || ''}</div></section>` +
      `<div class="lab-start"><p class="small muted">${_t('Opens the bot setup with these settings. Nothing starts until you confirm.')}</p><a class="button primary" id="lab-go" href="${esc(labHref(d))}">${_t('Start this bot')}${wsi('arrow')}</a></div>` +
      (tr.length ? `<section class="panel spacer"><div class="panel-head"><h2>${s.cycles != null ? _t('Simulated positions') : _t('Simulated trades')}</h2><span class="small muted">${tr.length < tot ? esc(_t('Latest {n} of {total}', {n: tr.length, total: tot})) : tot}</span></div><div class="table-wrap"><table><thead><tr><th>${_t('Start')}</th><th>${_t('End')}</th><th>${_t('Orders')}</th><th>${_t('Result')}</th></tr></thead><tbody>` +
        tr.map(t => `<tr><td>${esc(when(t.start))}</td><td>${esc(when(t.end))}</td><td>${t.n}</td><td class="${t.pnl > 0 ? 'positive' : t.pnl < 0 ? 'negative' : ''}">${t.pnl == null ? '–' : sgnU(t.pnl)}</td></tr>`).join('') + `</tbody></table></div></section>` : '') +
      ((d.notes || []).length ? `<p class="form-help lab-notes">${(d.notes || []).map(esc).join(' ')}</p>` : '');
  }
  /* the figures that follow every input without redrawing the fields (focus and caret stay): the read-outs, the
     leverage line, the fees, the first thing keeping the test from running; then the chart's lines */
  function labLive() {
    const c = $('lab-cfg'); if (!c) return;
    const set = (sel, h) => c.querySelectorAll(sel).forEach(e => { if (e.innerHTML !== h) e.innerHTML = h; });
    const K = kit();
    if (P.planned(B.kind)) { const v = vals(); c.querySelectorAll('[data-bv]').forEach(e => { const x = v[e.dataset.bv]; if (x != null && e.innerHTML !== x) e.innerHTML = x; }); wsumMark(c); }
    if (K) set('[data-fv="levline"]', esc(K.levLine()));
    set('[data-lab="fee"]', esc(feeTxt()));
    if ($('lab-ctabs') || chartTabs().tabs.length) labTabs();        // a basket's coins and weights as they are typed
    const bl = labBlocks(), r = B.chk && B.chk.key === chkKey() ? B.chk : null;
    const hrs = B.kind === 'sessgrid' && !C().isHip3(S.coin);         // a market-hours grid on a crypto market: said before Run
    set('[data-lab="err"]', esc(LAB.err || (bl[0] && (amtErr() || (r && !r.ok) || bl[0].min || bl[0].key || hrs) ? bl[0].text : '')));
    const a = $('lab-amt'); if (a) a.classList.toggle('bad', !!amtErr());
    // the fields themselves: red, with the reason under the row's label (as Customize marks them)
    const bad = new Map(bl.filter(b => b.key).map(b => [b.key, b.field]));
    c.querySelectorAll('.lab-rows input[data-bk]').forEach(i => { const t = bad.get(i.dataset.bk), bx = i.closest('.bf-in, .inp'), row = i.closest('.bf-r');
      if (bx) bx.classList.toggle('bad', t != null);
      if (!row) return;
      let m = row.querySelector(`[data-ferr="${CSS.escape(i.dataset.bk)}"]`);
      if (t != null && !m) { m = document.createElement('span'); m.className = 'bf-aerr'; m.dataset.ferr = i.dataset.bk; m.setAttribute('role', 'alert'); row.firstElementChild.appendChild(m); }
      if (m) m.textContent = t || ''; });
  }
  function labPaint() {
    const c = $('lab-cfg'), r = $('lab-res'); if (!c || !r || !C() || !T()) return;
    if (!labKinds().includes(B.kind)) B.kind = labKinds()[0];
    if (B.total[B.kind] == null && !B.bad[B.kind]) B.total[B.kind] = LAB.amount;
    if (P.planned(B.kind)) plan();
    const a = document.activeElement, keep = a && c.contains(a) ? (a.dataset.bk ? '[data-bk="' + CSS.escape(a.dataset.bk) + '"]' : a.id ? '#' + CSS.escape(a.id) : null) : null;
    const raw = a && a.tagName === 'INPUT' ? a.value : null, caret = a && a.selectionStart;
    const h = labConfig();
    if (h !== LAB.last) {
      const rw = c.querySelector('.lab-rows'), sc = rw && rw.dataset.tab === LAB.tab ? rw.scrollTop : 0;
      LAB.last = h; c.innerHTML = h; labBind(c);
      const rw2 = c.querySelector('.lab-rows'); if (rw2) { rw2.dataset.tab = LAB.tab; rw2.scrollTop = sc; }
      const i = keep && c.querySelector(keep);
      if (i) { if (raw != null && i.tagName === 'INPUT' && i.value !== raw) i.value = raw; try { i.focus({preventScroll: true}); if (caret != null && i.setSelectionRange) i.setSelectionRange(caret, caret); } catch (e) {} }
    }
    const rh = labResult(); if (rh !== LAB.lastR) { LAB.lastR = rh; r.innerHTML = rh; }
    labLive();
    labTabs();
  }
  function labBind(c) {
    bindPane(c);            // every setting, the presets (data-bpre), leverage and margin: the setup's own handlers
    // a switch that shows or hides other settings, the second coin: drawn again (the value itself went in through bindPane)
    c.querySelectorAll('.bf-sw input[data-bk], [data-bk="coin_b"]').forEach(i => i.addEventListener('change', () => { render(); schedule(); }));
    c.querySelectorAll('[data-lab-tab]').forEach(b => b.onclick = () => { LAB.tab = b.dataset.labTab; labPaint(); });
    $('lab-kind').onchange = e => { const was = B.kind, k = e.target.value;
      B.kind = k; pref.set('labkind', k); B.chk = null; B.bt = B.btLast = null; LAB.res = null; LAB.err = '';
      if (B.total[k] == null) B.total[k] = B.total[was] != null ? B.total[was] : LAB.amount;
      syncTf(); labPaint(); schedule(true); drawLines2(); syncUrl(); };
    $('lab-amt').addEventListener('input', () => { LAB.err = ''; if (B.total[B.kind] > 0) { LAB.amount = B.total[B.kind]; pref.set('labamt', String(LAB.amount)); } labLive(); });
    $('lab-days').onchange = e => { LAB.days = +e.target.value; };
    $('lab-run').onclick = () => labRun();
  }
  function labInit() {
    const l = $('tm-l'), r = $('tm-r'), cp = $('tm-cp'); if (!l || !r || !cp || $('lab-cfg')) return;
    const t = new URLSearchParams(location.search).get('test'), k = labKinds().includes(t) ? t : pref.get('labkind', ''); B.kind = labKinds().includes(k) ? k : 'grid';
    const cfgEl = document.createElement('section'); cfgEl.className = 'panel lab-cfg'; cfgEl.id = 'lab-cfg';
    const how = document.createElement('section'); how.className = 'panel lab-how';
    const step = (n, a, b) => `<div class="timeline-item"><span class="icon-circle">${n}</span><div><p>${a}</p><small>${b}</small></div></div>`;
    how.innerHTML = `<div class="panel-head"><h2>${_t('How this test works')}</h2>${wsi('flask')}</div><div class="panel-body">` +
      step(1, _t('Real candles from Hyperliquid'), _t('The bot\'s own engine replays the market you picked above.')) +
      step(2, _t('Every fill, every fee'), _t('Exchange and Rivemont fees and funding are counted; a fast move can fill worse.')) +
      step(3, _t('Then set it up'), _t('Open the setup with this type and amount, change any setting, see its backtest again, start it.')) +
      `<p class="form-help">${_t('A simulation of past prices, not a promise of future results.')}</p></div>`;
    r.prepend(cfgEl, how);
    const res = document.createElement('div'); res.className = 'lab-res'; res.id = 'lab-res'; cp.after(res);
    LAB.at = S.coin + '|' + S.venue;
    labPaint();
    // the settings' rows come from bot-flow.js (deferred, after this file): drawn once it is here
    if (!window.BotFlowKit) addEventListener('DOMContentLoaded', () => { LAB.last = ''; labPaint(); schedule(true); drawLines2(); }, {once: true});
    schedule(true);
  }
  /* another market: the old one's prices (a grid's range) mean nothing there; each type starts again from its plan */
  function labMarket() {
    for (const k of Object.keys(B.shape)) delete B.shape[k];
    for (const k of KINDS) if (!B.preset[k]) B.preset[k] = 'balanced';
    LAB.res = null; LAB.err = ''; B.chk = null; labPaint(); schedule(true);
  }
  function init() {
    if (!T()) return;
    document.querySelectorAll('#f-tabs [data-p], #fsw [data-p]').forEach(b => b.onclick = () => setPanel(b.dataset.p));
    const tbl = $('tbl'); if (tbl) tbl.addEventListener('click', e => { const o = e.target.closest('.own[data-bot]'); if (o && o.dataset.bot) { e.stopPropagation(); if (!BOTMODE) return showBots(+o.dataset.bot); showBots(); B.flash = +o.dataset.bot; renderBottom(); } });
    const form = $('form'); if (form) form.addEventListener('click', e => { const a = e.target.closest('a[href*="panel=bots"]'); if (a) { e.preventDefault(); showBots(); } });
    const QS = new URLSearchParams(location.search);
    if (!FLOW && QS.get('test') && !QS.get('kind')) QS.set('kind', QS.get('test'));   // the lab's own link (qs above)
    if (QS.get('kind') === 'neutral') QS.set('kind', 'pair');          // the Market Neutral bot's own name for its link
    if (KINDS.includes(QS.get('kind'))) B.kind = QS.get('kind');
    if (BOTMODE && QS.get('kind') === 'signal') B.view = 'signal';
    if (BOTMODE) { const t = document.querySelector('#f-tabs [data-p=bot]'); if (t) t.textContent = _t('Create a bot'); }
    if (QS.get('cfg') || QS.get('side')) {        // /bots: a backtest pick's settings, or the quiz's direction
      let c = null;
      try { c = QS.get('cfg') ? JSON.parse(decodeURIComponent(escape(atob(QS.get('cfg'))))) : null; } catch (e) { c = null; }
      if (c && typeof c === 'object') { useConfig(B.kind, c); if (QS.get('fresh') === '1') B.total[B.kind] = null; B.keepFor = (QS.get('coin') || S.coin) + '|' + (QS.get('venue') || S.venue); }
      const sd = QS.get('side');
      if (['long', 'short', 'neutral'].includes(sd) && !c) { const base = shape(); if (B.kind === 'grid' || B.kind === 'infinity') base.mode = sd; else if (B.kind === 'indicator') { base.side = sd; applyPreset(B.preset.indicator || 'balanced'); }    // its signal follows the side (a short's is the mirror)
        else if (sd !== 'neutral') base.side = sd; }
    }
    if (QS.get('amount') && +QS.get('amount') > 0) B.total[B.kind] = +QS.get('amount');
    if (BOTMODE && QS.get('panel') === 'bots') S.tab = 'bots';
    if (QS.get('bot')) B.flash = +QS.get('bot');
    if (QS.get('from')) loadShared(QS.get('from'));
    chartToggle(); chartClicks(); initStrip();
    if (WS) labInit();
    if (B.panel === 'bot') schedule(true);
    if (BOTMODE && typeof renderBottom === 'function') renderBottom();     /* the Bots list comes first here */
  }

  window.TB = {render: () => { render(); tabCount(); }, renderTab: el => { renderTab(el); tabCount(); }, tabCount, drawLines: drawLines2, onSelect, onMarket, qs, claim,
               markBook, chartNote, setPanel, showBots, init, stripStats: WS ? undefined : stripStats};    /* the workspace's bar shows the market's figures */
  /* what the guided setup (radar/web/bot-flow.js) builds on: this file's state, plan, checks, backtest and Start */
  const TBX = {B, P, shape, plan, cfg, payload, total, setTotal, amtErr, amtErrText, btIdleText, noBtWhy, rangeExit, applyPreset, presetShape, onSeg, onInput, bindPane, bindLinks, blocks, blocksH,
    privBlocks, privCheck, vals, paintVals, schedule, runBacktest, scheduleBt, btShown, btReady, btKey, previewLines, dragCh, dragged, start, chkKey, avail, feesNow, feeTxt,
    mkPrice, minOrder, maxL, cross, kindName, kindWord, typeName, typeLine, useConfig, edited, liqTxt, riskVals, claimOf, live, bots, stopSheet,
    condsH, coinsH, coinBtn, chartTabs, setChartTab, chartOther, ctabsH, btCurve, rulesH, spH, psH, loadMC, mcKey, rangeByH, setPath, getPath, sideOf, fmtLine, rp, pctTxt, num, tip, segH,
    syncUrl, onSelect, loadPs, hook, exN, BT_REF, liveArbs, IND_LABEL, HARD, capWhy, venueOpts, loadShared, setPrivAmount, privMode, noHeldWhy, tsHolds: P.tsHolds};
  TBX.slBaseLine = slBaseLine;
  if (FLOW) window.TBX = TBX;          /* the Backtest lab (WS) builds on the same object: BotFlowKit(TBX) */
  init();
})();

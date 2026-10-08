/* Rivemont Terminal: pure helpers (no DOM), shared by terminal.html and tests/js/terminal.test.mjs.
   The order preview mirrors radar/auto/terminal.py plan(); the server's quote is what the confirmation sheet shows. */
(function (root) {
  /* translated words (radar/i18n.py runtime); in node (tests) the English itself */
  const _t = (root && root._t) || ((k, v) => v ? String(k).replace(/\{(\w+)\}/g, (m, x) => x in v && v[x] != null ? v[x] : m) : k);
  /* the exchanges offered for trading (the page's RV_TRADE_VENUES, radar/auto/strategies.trade_venues); every one in node */
  const OFFER = root && Array.isArray(root.RV_TRADE_VENUES) ? root.RV_TRADE_VENUES : null;
  const VENUES = ['hyperliquid', 'lighter', 'aster', 'grvt', 'nado', 'paradex', 'pacifica', 'hibachi', 'dydx', 'orderly', 'extended'].filter(v => !OFFER || OFFER.includes(v));
  const LABEL = {hyperliquid: 'Hyperliquid', lighter: 'Lighter', aster: 'Aster', grvt: 'GRVT', nado: 'Nado', paradex: 'Paradex',
                 pacifica: 'Pacifica', hibachi: 'Hibachi', dydx: 'dYdX', orderly: 'Orderly', extended: 'Extended'};
  const CROSS_ONLY = ['hibachi', 'dydx', 'extended'];
  /* the currency each exchange quotes its perpetuals in (and settles margin in) */
  const QUOTE = {hyperliquid: 'USDC', lighter: 'USDC', pacifica: 'USDC', orderly: 'USDC', paradex: 'USD', dydx: 'USD', extended: 'USD',
                 aster: 'USDT', grvt: 'USDT', hibachi: 'USDT', nado: 'USDT0'};
  const quoteOf = v => QUOTE[v] || 'USD';
  /* Hyperliquid's builder dexs (HIP-3, radar/auto/hip3.py): a market named "xyz:TSLA" is TSLA on the dex "xyz", which the
     page shows by its own name (trade.xyz: DEX_LABEL, filled from /api/auto/terminal/tickers "dexs") */
  const DEX_LABEL = {xyz: 'trade.xyz', flx: 'Felix', vntl: 'Ventuals', hyna: 'HyENA', km: 'Kinetiq', mkts: 'Kinetiq', cash: 'dreamcash',
    para: 'Paragon', io: 'EntropyIO'};
  const H3 = /^[a-z][a-z0-9]{0,7}:[A-Z0-9]{1,15}$/, h3seen = new Map();      /* asked for every coin in every list: kept */
  const isHip3 = c => { let v = h3seen.get(c); if (v === undefined) { v = H3.test(String(c || '')); if (h3seen.size < 20000) h3seen.set(c, v); } return v; };
  const mktName = c => isHip3(c) ? String(c).split(':')[1] : String(c || '');
  const mktDex = c => isHip3(c) ? String(c).split(':')[0] : '';
  const dexLabel = d => d ? DEX_LABEL[d] || d : '';
  function setDexLabels(list) { for (const d of list || []) if (d && d.name) DEX_LABEL[d.name] = d.label || d.name; }
  /* the picker's search: the market's own name, its dex (xyz, trade.xyz) or the whole name (xyz:TSLA) */
  const mktMatch = (c, q) => { const w = String(q || '').trim().toUpperCase(); if (!w) return true;
    return mktName(c).includes(w) || String(c).toUpperCase().includes(w) || (isHip3(c) && dexLabel(mktDex(c)).toUpperCase().includes(w)); };
  /* how well a market matches the typed word: 0 its exact ticker (PURR before PURRDAT), 1 a ticker starting with it, 2 the rest */
  const mktRank = (c, q) => { const w = String(q || '').trim().toUpperCase(); if (!w) return 0; const n = mktName(c).toUpperCase();
    return n === w || String(c).toUpperCase() === w ? 0 : n.startsWith(w) ? 1 : 2; };
  /* a market as the exchange lists it: BTC/USDC on Hyperliquid, BTC/USDT on Aster, TSLA/USDC on trade.xyz (Hyperliquid) */
  /* a builder-dex market names its dex (xyz:SNDK and io:SNDK are two markets): TSLA/USDC · xyz */
  const pairLabel = (coin, v) => mktName(coin) + '/' + quoteOf(v) + (isHip3(coin) ? ' · ' + mktDex(coin) : '');
  /* chart timeframe -> KLineChart period */
  function tfPeriod(tf) {
    const m = /^(\d+)([mhdw])$/.exec(tf || '');
    if (!m) return null;
    return {span: +m[1], type: {m: 'minute', h: 'hour', d: 'day', w: 'week'}[m[2]]};
  }
  /* the margin modes the customer can pick on an exchange before the account is read (radar/auto/terminal.py VENUE_MODES;
     the first is the fallback when the exchange's own setting for the coin is not known) */
  const MODES = {hyperliquid: ['cross', 'isolated'], lighter: ['isolated', 'cross'], aster: ['isolated', 'cross'],
                 orderly: ['isolated', 'cross'], dydx: ['cross'], hibachi: ['cross'], extended: ['cross']};
  const marginModes = v => MODES[v] || (CROSS_ONLY.includes(v) ? ['cross'] : ['isolated']);

  /* decimals that show a price to about 5 significant digits (2 at least for prices above 1) */
  function priceDecimals(px) {
    if (!px || !isFinite(px)) return 2;
    const a = Math.abs(px);
    if (a >= 10000) return 1;
    if (a >= 1) return Math.max(2, 5 - Math.floor(Math.log10(a)) - 1);
    return Math.min(12, 4 - Math.floor(Math.log10(a)));   // PEPE at 0.0000042866 needs 10 (its tick is 1e-10)
  }
  /* one Intl.NumberFormat per (min, max) decimals: building one costs far more than formatting with it (the book
     formats ~150 numbers per tick) */
  const NFC = {};
  function nfmt(min, max) {
    const key = min + '|' + max;
    return NFC[key] || (NFC[key] = new Intl.NumberFormat('en-US', {minimumFractionDigits: min, maximumFractionDigits: max}));
  }
  /* on screen a negative number carries the true minus sign U+2212 (as wide as "+" in tabular figures); never in an
     input's value or anything read back */
  const MINUS = '\u2212';
  const neg = s => s.charAt(0) === '-' ? MINUS + s.slice(1) : s;
  function fmtPrice(px, d) {
    if (px == null || !isFinite(px)) return '–';
    const k = d ?? priceDecimals(px);
    return neg(nfmt(k, k).format(Number(px)));
  }
  /* a long run of zeros folded as on DEX screeners: 0.0000042866 -> 0.0₅42866 (the subscript counts the zeros after
     the point); for narrow columns (the book) and the chart axis */
  const SUBD = '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089';
  function foldZeros(s, min) {
    const m = /^([\u2212-]?\d*)\.(0+)([1-9]\d*)$/.exec(String(s));
    if (!m || m[2].length < (min || 4)) return String(s);
    return m[1] + '.0' + [...String(m[2].length)].map(d => SUBD[+d]).join('') + m[3];
  }
  function sizeDecimals(px) {            /* coin sizes: 0 to 6 decimals, more for pricier coins (BTC 5, ETH 4, SOL 3) */
    if (!px || !isFinite(px)) return 4;
    return Math.max(0, Math.min(6, Math.ceil(Math.log10(px))));
  }
  function fmtSize(sz, px, fixed) {  /* fixed: every row of a column shows the same decimals */
    if (sz == null || !isFinite(sz)) return '–';
    const k = sizeDecimals(px);
    return neg(nfmt(fixed ? k : 0, k).format(Number(sz)));
  }
  function fmtUsd(x, d) {
    if (x == null || !isFinite(x)) return '–';
    const k = d ?? (Math.abs(x) < 1000 ? 2 : 0);
    return (x < 0 ? MINUS + '$' : '$') + nfmt(k, k).format(Math.abs(x));
  }
  function fmtCompact(x) {
    if (x == null || !isFinite(x)) return '–';
    const a = Math.abs(x);
    const s = x < 0 ? MINUS : '';
    return a >= 1e9 ? s + '$' + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? s + '$' + (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? s + '$' + (a / 1e3).toFixed(0) + 'K' : fmtUsd(x, 0);
  }
  /* a book amount in a narrow column, exchange-app style: 4.623K, 24.62K, 209.2K, 1.234M */
  function fmtAmt(x) {
    if (x == null || !isFinite(x)) return '–';
    const a = Math.abs(x), k = (v, u) => { const b = Math.abs(v); return v.toFixed(b >= 100 ? 1 : b >= 10 ? 2 : 3) + u; };
    return neg(a >= 1e9 ? k(x / 1e9, 'B') : a >= 1e6 ? k(x / 1e6, 'M') : a >= 1e3 ? k(x / 1e3, 'K') : x.toFixed(a >= 100 ? 1 : 2));
  }
  /* the order book's Total column: K / M from a thousand, else 3 decimals (no five-decimal sums), but under 1 as many of
     the lot's decimals as the figure needs, so a 0.0001 BTC level on a 0.00001 lot never reads 0.000 (0.9 stays 0.900).
     k: the decimals of a whole side's sub-1 totals (bookTotalDec), so their points line up in the right-aligned column */
  function subOneDec(x, d) {
    let k = Math.min(3, d);
    const v = +(+x).toFixed(d); while (k < d && +v.toFixed(k) !== v) k++;
    return k;
  }
  function bookTotal(x, p, k) {
    if (x >= 1000) return fmtAmt(x);
    const d = sizeDecimals(p);
    return fmtPrice(x, x < 1 ? (k != null ? k : subOneDec(x, d)) : Math.min(3, d));
  }
  /* one side of the book's sub-1 decimals: the most any of its totals under 1 needs (at least 3, at most the lot's) */
  function bookTotalDec(totals, p) {
    const d = sizeDecimals(p); let k = Math.min(3, d);
    for (const x of totals || []) if (x < 1) k = Math.max(k, subOneDec(x, d));
    return k;
  }
  function fmtPct(x, d = 2) { return x == null || !isFinite(x) ? '–' : (x >= 0 ? '+' : '') + neg((x * 100).toFixed(d)) + '%'; }
  /* a fee rate as a short percentage: 0.00045 -> "0.045%" */
  function fmtRate(r) { return r == null || !isFinite(r) ? '–' : neg((+(r * 100).toFixed(4)).toString()) + '%'; }

  /* about where an isolated position is liquidated (radar/auto/terminal.py liq_estimate); mm: the exchange's own
     maintenance margin rate where it publishes it (the market's mm_rate: Lighter, dYdX), else half the initial margin at
     the maximum leverage */
  function liqEstimate(isBuy, px, lev, maxLev, cross, mm) {
    if (cross || !px || !lev) return null;
    const move = 1 / lev - (mm > 0 ? mm : 1 / (2 * (maxLev || 20)));
    if (move <= 0) return null;
    return isBuy ? px * (1 - move) : px * (1 + move);
  }

  /* coins in an order: usd = order value, coin, margin = the USD put up (order by cost: leverage multiplies it) */
  function qtyOf(size, unit, px, lev) {
    return unit === 'coin' ? size : unit === 'margin' ? size * lev / px : size / px;
  }

  /* a size floored to the exchange's size step (the market's lot), as the exchange takes it (terminal.py floor_lot) */
  function floorLot(q, lot) {
    if (!(lot > 0) || !(q > 0)) return q;
    const d = Math.max(0, Math.min(12, Math.ceil(-Math.log10(lot) - 1e-9)));
    return +(Math.floor(q / lot + 1e-9) * lot).toFixed(d);
  }

  /* every market from /api/markets/lite (rows [coin, venue index, mark, rate_1h, volume_usd, open_interest_usd]):
     {by: {coin: {venue: market}}, vol: {coin: 24h volume on every exchange}}. The scanner's marks are per coin already,
     also on a coin an exchange lists only in thousands (radar/venues.py _per), so they are never scaled here again.
     units(venue, coin): coins per unit of the exchange's market (1000 for 1000PEPE); such a market is left out on the
     `unlisted` exchanges (Hyperliquid, Lighter: the Terminal does not trade them per coin there yet) */
  function liteMarkets(d, units, unlisted, venues) {
    const by = {}, vol = {}, vs = (d && d.venues) || [], ok = venues || VENUES;
    for (const r of (d && d.rows) || []) {
      const m = {coin: r[0], venue: vs[r[1]], mark: r[2], rate_1h: r[3], volume_usd: r[4], open_interest_usd: r[5]};
      if (!ok.includes(m.venue)) continue;
      if (units && units(m.venue, m.coin) !== 1 && (unlisted || []).includes(m.venue)) continue;
      (by[m.coin] = by[m.coin] || {})[m.venue] = m;
      vol[m.coin] = (vol[m.coin] || 0) + (m.volume_usd || 0);
    }
    return {by, vol};
  }
  /* an exchange's thousand-coin market name as its positions report it -> [the coin's own name, coins per unit]:
     kPEPE -> ['PEPE', 1000], 1000PEPE -> ['PEPE', 1000], 1000000MOG -> ['MOG', 1e6]; any other -> [name, 1]
     (radar/auto/terminal.py in_thousands, the same rule) */
  function kName(c) {
    const s = String(c || ''), m = /^(?:k([A-Z][A-Z0-9]{0,13})|(1000000|1000)([A-Z][A-Z0-9]{0,13}))$/.exec(s);
    return !m ? [s, 1] : m[1] ? [m[1], 1000] : [m[3], +m[2]];
  }
  /* a record kept per coin (a position TP/SL, a smart order: prices per PEPE, sizes in PEPE) in the units of a
     Positions row that reports it in thousands (kPEPE: prices per 1,000, sizes in thousands) */
  function inUnits(o, unit) {
    if (!o || !(unit > 1)) return o;
    /* 12 significant figures: 0.0000045 x 1000 is 0.0045, never 0.0045000000000000005 (the TP/SL sheet shows it as typed) */
    const p = x => x == null || x === '' ? x : +(+x * unit).toPrecision(12), q = x => x == null || x === '' ? x : +(+x / unit).toPrecision(12), out = {...o};
    for (const k of ['tp', 'sl', 'sl_px', 'best', 'start_px', 'avg_px', 'entry_px', 'price', 'trigger_px']) if (k in out) out[k] = p(out[k]);
    for (const k of ['size', 'filled']) if (k in out) out[k] = q(out[k]);
    if (Array.isArray(o.tps)) out.tps = o.tps.map(t => t && typeof t === 'object' ? {...t, px: p(t.px)} : t);
    if (Array.isArray(o.rungs)) out.rungs = o.rungs.map(r => r && typeof r === 'object' ? {...r, px: p(r.px)} : r);
    return out;
  }

  /* what the form describes: coins, notional, margin, fees, cost and liquidation. f.lot: the market's size step (the
     coins the exchange receives); f.imf: an exchange with no leverage per coin (dYdX) holds notional x imf as margin;
     f.mm: the exchange's own maintenance rate */
  function preview(f) {
    const px = f.type === 'limit' ? +f.price : +f.ref;
    const size = +f.size;
    if (!(px > 0) || !(size > 0)) return null;
    const lev = Math.max(1, Math.round(+f.leverage || 1));
    const qty = floorLot(qtyOf(size, f.unit, px, lev), f.lot), notional = qty * px;
    if (!(qty > 0)) return null;
    const fees = f.fees || {maker: 0, taker: 0, rivemont: 0};
    const exRate = (f.maker ?? f.type === 'limit') ? fees.maker : fees.taker;   /* maker: false for an IOC or marketable limit */
    const isBuy = f.side === 'long', cross = f.cross ?? CROSS_ONLY.includes(f.venue);   /* f.cross: the account's own mode (Aster Multi-Assets) */
    const margin = f.reduce ? null : f.imf > 0 ? notional * f.imf : notional / lev, exchangeFee = notional * exRate, rvRate = freeDayRate(fees, notional).rate, rivemontFee = notional * rvRate;
    return {qty, notional, px, lev, margin, exchangeFee, exRate, rivemontFee, rivemontRate: rvRate,
            cost: margin == null ? null : margin + exchangeFee + rivemontFee,
            liq: f.reduce ? null : liqEstimate(isBuy, px, lev, f.maxLev, cross, f.mm),
            liqLong: f.reduce ? null : liqEstimate(true, px, lev, f.maxLev, cross, f.mm),
            liqShort: f.reduce ? null : liqEstimate(false, px, lev, f.maxLev, cross, f.mm)};
  }

  /* the largest order the free balance allows, in the form's unit: margin plus fees fit in 98% of what is free */
  function maxSize(o) {
    const {avail, lev, px, unit, feeRate} = o;
    if (!(avail > 0) || !(px > 0)) return 0;
    const l = Math.max(1, lev || 1), fr = feeRate || 0;
    const notional = avail * 0.98 / (1 / l + fr);
    return unit === 'coin' ? notional / px : unit === 'margin' ? notional / l : notional;
  }
  /* size <-> percent of the maximum (the slider and the % buttons), rounded for the input */
  function sizeFromPct(pct, max, unit, px) {
    const v = Math.max(0, Math.min(100, pct)) / 100 * max;
    if (!(v > 0)) return '';
    return unit === 'coin' ? String(+v.toFixed(sizeDecimals(px))) : v.toFixed(2);
  }
  /* the Close tab at 100%: the whole position, exactly. The field shows it in the form's unit (coins: the position's
     own size, never rounded to the form's decimals; value: at the price used), and the order goes in coins for the
     position's exact size, so a coin whose lot is finer than the form's decimals leaves no dust and never overshoots.
     all: the "unit|size|position size" the 100% control put in the field: anything typed after it, or a position that
     grew or shrank since (a fill, another tab), sends the field's figure as shown, never a size the form did not show */
  function closeAll(posSize, unit, px) {
    const s = +posSize;
    if (!(s > 0)) return '';
    return unit === 'coin' ? String(s) : px > 0 ? (s * px).toFixed(2) : '';
  }
  function orderSize(o) {
    const {close, all, unit, size, posSize} = o;
    if (close && all && +posSize > 0 && all === unit + '|' + size + '|' + posSize) return {size: +posSize, size_unit: 'coin'};
    return {size: +size, size_unit: unit};
  }
  function pctFromSize(size, max) {
    const s = +size;
    if (!(s > 0) || !(max > 0)) return 0;
    return Math.max(0, Math.min(100, s / max * 100));
  }

  /* leverage presets: 1 / 2 / 3 / 5 / 10 / 20x up to the exchange's maximum (a lower maximum is offered itself) */
  function levPresets(maxLev) {
    const m = Math.max(1, Math.floor(maxLev || 1));
    const p = [1, 2, 3, 5, 10, 20].filter(x => x <= m);
    return m < 20 && !p.includes(m) ? p.concat([m]) : p;
  }
  function levTicks(maxLev) {
    // as the usual leverage slider: 1x, then even round steps (5x, 10x, 25x ...) up to the maximum, at most five after 1x
    const m = Math.max(1, Math.floor(maxLev || 1));
    const step = [1, 2, 5, 10, 25, 50, 100].find(s => m / s <= 5) || Math.ceil(m / 5);
    const out = [1];
    for (let x = step; x < m; x += step) if (x > 1) out.push(x);
    if (out.length > 1 && m - out[out.length - 1] < step / 2) out.pop();     // the maximum never sits right next to a step
    if (m > 1) out.push(m);
    return out;
  }

  /* BBO prices: counterparty n = the opposite side's n-th level (fills at once), queue n = the same side's n-th level
     (waits in the book). Fewer levels than n: the deepest one there is. */
  function bboPrice(book, mode, isBuy) {
    if (!book || !mode) return null;
    const m = /^([cq])(\d+)$/.exec(mode);
    if (!m) return null;
    const n = +m[2], opposite = m[1] === 'c';
    const rows = (isBuy ? opposite : !opposite) ? book.asks : book.bids;
    if (!rows || !rows.length) return null;
    return rows[Math.min(n, rows.length) - 1][0];
  }
  const BBO = {c1: _t('Counterparty 1'), c5: _t('Counterparty 5'), q1: _t('Queue 1'), q5: _t('Queue 5')};
  /* a BBO limit order's price when it goes (Confirm, as its menu says), not when Long / Short was tapped: the book's
     level for that side then; the price it had when the book has no such level */
  function bboAtSend(book, mode, side, price) {
    const p = bboPrice(book, mode, side === 'long');
    return p > 0 ? p : price;
  }

  /* the order book grouped to a coarser price step: bids round down, asks round up, sizes summed */
  function groupBook(rows, step, isBid) {
    if (!step) return rows || [];
    const agg = new Map();
    for (const [p, s] of rows || []) {
      const k = +((isBid ? Math.floor(p / step + 1e-9) : Math.ceil(p / step - 1e-9)) * step).toFixed(10);
      agg.set(k, (agg.get(k) || 0) + s);
    }
    return [...agg.entries()].sort((a, b) => isBid ? b[0] - a[0] : a[0] - b[0]);
  }
  /* price steps offered for grouping: the book's own tick and 10x, 100x of it */
  function tickSteps(px) {
    const d = priceDecimals(px), base = Math.pow(10, -d);
    return [base, base * 10, base * 100].map(x => +x.toPrecision(1));
  }

  /* the order book with running totals, for depth bars: rows best first */
  function depth(bids, asks, n) {
    const run = rows => { let t = 0; return (rows || []).slice(0, n).map(([p, s]) => { t += s; return {p, s, t}; }); };
    const b = run(bids), a = run(asks);
    const max = Math.max(1e-12, ...b.map(x => x.t), ...a.map(x => x.t));
    const bb = b[0] && b[0].p, aa = a[0] && a[0].p;
    return {bids: b, asks: a, max, spread: bb && aa ? aa - bb : null, mid: bb && aa ? (aa + bb) / 2 : null,
            spreadPct: bb && aa ? (aa - bb) / ((aa + bb) / 2) : null};
  }
  /* buyers' share of the resting size on both sides (the B / S bar under the book) */
  function buyShare(bids, asks) {
    const s = rows => (rows || []).reduce((t, r) => t + (r[1] || 0), 0);
    const b = s(bids), a = s(asks);
    return b + a > 0 ? b / (b + a) : null;
  }

  /* seconds to the next hourly funding payment, as MM:SS */
  function fundingCountdown(nowSec) {
    const left = (3600 - Math.floor(nowSec) % 3600) % 3600;          // HH:MM:SS (00:00:00 at the hour)
    return ['00', String(Math.floor(left / 60)).padStart(2, '0'), String(left % 60).padStart(2, '0')].join(':');
  }

  /* 24-hour change, high and low from hourly candles [t, o, h, l, c, v?] */
  function dayStats(rows, nowSec) {
    const r = (rows || []).filter(x => x[0] > nowSec - 86400);
    if (!r.length) return null;
    return {change: r[r.length - 1][4] / r[0][1] - 1, high: Math.max(...r.map(x => x[2])), low: Math.min(...r.map(x => x[3])),
            volume: r.every(x => x.length > 5) ? r.reduce((t, x) => t + x[5] * x[4], 0) : null};
  }

  /* Funding Arbitrage pairs a customer can enter: both legs on exchanges carry may use for them, liquid, worth it */
  function pairsFor(opps, venues, minVolume = 5e6) {
    const ok = new Set(venues || []);
    return (opps || []).filter(o => ok.has(o.short_venue) && ok.has(o.long_venue) && o.net_apr > 0 && (o.min_volume_usd || 0) >= minVolume);
  }
  /* one plain line on why a pair pays */
  function pairWhy(o) {
    const s = LABEL[o.short_venue] || o.short_venue, l = LABEL[o.long_venue] || o.long_venue;
    const d3 = o.spread_apr_3d, per = o.persistence_3d;
    return _t('Funding on {s} runs {v}% a year above {l}', {s, v: (o.spread_apr_now * 100).toFixed(1), l}) +
      (d3 != null ? '; ' + _t('3-day average {v}%', {v: (d3 * 100).toFixed(1)}) : '') + (per != null ? ', ' + _t('in our favour {v}% of the time', {v: Math.round(per * 100)}) : '') + '.';
  }

  /* every connected exchange's balance from /api/auto/me: [{venue, equity, free}]. free is what a new hand trade may use:
     the money model's withdrawable (radar/auto/money.py: not kept by a strategy, not held by positions), the same figure
     the server checks orders against (api.term_ctx) and the app's Wallet shows */
  function accounts(me) {
    if (!me) return [];
    if (me.money && Array.isArray(me.money.venues))
      return me.money.venues.filter(x => x.balance != null && isFinite(x.balance))
        .map(x => ({venue: x.venue, equity: +x.balance, free: x.withdrawable != null && isFinite(x.withdrawable) ? +x.withdrawable : null}));
    const out = [];
    const add = (venue, a, eq, free) => { if (eq != null && isFinite(eq)) out.push({venue, equity: +eq, free: free != null && isFinite(free) ? +free : null}); };
    if (me.hl_account) add('hyperliquid', me.hl_account, me.hl_account.account_usd, me.hl_account.free_usd);
    if (me.lt_usd != null) add('lighter', null, me.lt_usd, null);
    for (const v of VENUES.slice(2)) {
      const a = me[v + '_account'];
      if (a && !a.blocked) add(v, a, a.account_usd, a.free_usd);
    }
    return out;
  }
  function totals(me) {
    const a = accounts(me);
    return {equity: a.reduce((s, x) => s + x.equity, 0), free: a.reduce((s, x) => s + (x.free ?? x.equity), 0), n: a.length};
  }

  /* chart timeframes: the row, and more in the menu (built on the server from finer bars) */
  const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const TFS_MORE = ['30m', '2h', '12h', '1w'];
  const tfLabel = t => t.replace('h', 'H').replace('d', 'D').replace('w', 'W');

  /* an order's take profit / stop loss, from the server's fields (radar/auto/terminal.py: protection = waiting_fill,
     pending, on, failed or not_needed; tp_status / sl_status per trigger; prot_error; prot_next = the next try, unix s).
     -> {text, cls: '' | 'up' | 'dn' | 'wait', title, attention: the customer should know (not on yet after a fill, or given up)} */
  function protState(o, hhmm) {
    const t = hhmm || (x => new Date(x * 1000).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'}));
    const kinds = ['tp', 'sl'].filter(k => o && o[k]);
    if (!o || !kinds.length || o.reduce_only) return {text: '–', cls: '', title: '', attention: false};
    const name = k => k === 'tp' ? 'TP' : 'SL', both = kinds.map(name).join(' + ');
    const on = kinds.filter(k => o[k + '_status'] === 'open'), off = kinds.filter(k => o[k + '_status'] !== 'open');
    const err = o.prot_error ? String(o.prot_error) : '';
    switch (o.protection) {
      case 'on': return {text: _t('{kinds} on', {kinds: both}), cls: 'up', title: _t('On the exchange, for the size that filled'), attention: false};
      case 'waiting_fill': return {text: _t('{kinds} after fill', {kinds: both}), cls: '', title: _t('Placed on the exchange as soon as this order fills'), attention: false};
      case 'pending': {
        const when = o.prot_next ? _t('retry {time}', {time: t(o.prot_next)}) : _t('placing');
        return {text: (on.length ? _t('{kinds} on', {kinds: on.map(name).join(' + ')}) + ' · ' + off.map(name).join(' + ') + ' ' : both + ' ') + when, cls: 'wait',
                title: (err ? _t('Refused: {error}', {error: err}) + '. ' : '') + _t('Rivemont keeps trying, spaced out, and tells you if it gives up.'), attention: true}; }
      case 'failed': return {text: on.length ? _t('{kinds} on', {kinds: on.map(name).join(' + ')}) + ' · ' + _t('{kinds} not placed', {kinds: off.map(name).join(' + ')}) : _t('{kinds} not placed', {kinds: both}), cls: 'dn',
                             title: (err ? _t('Refused: {error}', {error: err}) + '. ' : '') + _t('Rivemont stopped trying: set it yourself.'), attention: true};
      case 'not_needed': return {text: _t('{kinds} not needed', {kinds: both}), cls: '', title: err || _t('Nothing filled, so there was nothing to protect'), attention: false};
      case 'watched': return {text: _t('{kinds} watched', {kinds: both}), cls: 'up', title: _t('This exchange has no trigger orders switched on in Rivemont: Rivemont watches the price and closes with a market order'), attention: false};
      case 'moved': return {text: both + ' → ' + _t('position'), cls: '', title: _t('Replaced by the take profit / stop loss set on the position'), attention: false};
      default: return {text: both, cls: '', title: '', attention: false};
    }
  }
  /* an order's status in words; 'placing' = sent, the exchange has not confirmed it yet (it can still be cancelled) */
  const ORDER_STATUS = {filled: _t('Filled'), open: _t('Open [status]'), placing: _t('Sending'), canceled: _t('Canceled'), error: _t('Refused'), waiting: _t('Watching'),
                        active: _t('Active'), done: _t('Done')};
  /* a cancel sent that the exchange has not confirmed yet (Lighter confirms a block later): never shown as cancelled
     before the exchange says so; the server reads it again on each refresh */
  const cancelling = o => !!(o && o.cancel_sent && (o.status === 'open' || o.status === 'placing'));
  const orderStatus = o => cancelling(o) ? _t('Cancelling') : ORDER_STATUS[o && o.status] || (o && o.status) || '–';
  const TYPE_LABEL = {limit: _t('Limit [order]'), market: _t('Market [order]'), stop_market: _t('Stop market'), stop_limit: _t('Stop limit'), tpsl: 'TP/SL', smart: _t('Smart'),
                      twap: 'TWAP', pov: 'POV', iceberg: _t('Iceberg'), scaled: _t('Scaled Order'), margin: _t('Margin'), trailing: _t('Trailing stop')};
  const typeLabel = t => TYPE_LABEL[t] || t || '–';
  const TIF_LABEL = {gtc: 'GTC', ioc: 'IOC', post: _t('Post only')};

  /* ---- chart indicators (KLineChart built-ins): on the price (main) or in a pane below (sub), with their settings ---- */
  const IND = {
    MA: {pane: 'main', label: 'MA', title: _t('Moving average'), params: [7, 25, 99], names: [_t('Period 1'), _t('Period 2'), _t('Period 3')]},
    EMA: {pane: 'main', label: 'EMA', title: _t('Exponential moving average'), params: [12, 26], names: [_t('Period 1'), _t('Period 2')]},
    BOLL: {pane: 'main', label: 'BOLL', title: _t('Bollinger bands'), params: [20, 2], names: [_t('Period'), _t('Std. dev.')]},
    VOL: {pane: 'sub', label: 'VOL', title: _t('Volume'), params: [], names: []},
    RSI: {pane: 'sub', label: 'RSI', title: _t('Relative strength index'), params: [14], names: [_t('Period')]},
    MACD: {pane: 'sub', label: 'MACD', title: 'MACD', params: [12, 26, 9], names: [_t('Fast'), _t('Slow'), _t('Signal')]},
    // the rest of the usual exchange list, drawn by the chart library itself (its default periods)
    SAR: {pane: 'main', label: 'SAR', title: _t('Parabolic stop and reverse'), params: [2, 2, 20], names: [_t('Start'), _t('Step'), _t('Maximum')]},
    KDJ: {pane: 'sub', label: 'KDJ', title: _t('Stochastic'), params: [9, 3, 3], names: [_t('Period'), 'K', 'D']},
    OBV: {pane: 'sub', label: 'OBV', title: _t('On-balance volume'), params: [30], names: [_t('Period')]},
    CCI: {pane: 'sub', label: 'CCI', title: _t('Commodity channel index'), params: [20], names: [_t('Period')]},
    WR: {pane: 'sub', label: 'WR', title: _t('Williams %R'), params: [6, 10, 14], names: [_t('Period 1'), _t('Period 2'), _t('Period 3')]},
    DMI: {pane: 'sub', label: 'DMI', title: _t('Directional movement'), params: [14, 6], names: [_t('Period'), _t('Smoothing')]}};
  const IND_ORDER = ['MA', 'EMA', 'BOLL', 'SAR', 'VOL', 'RSI', 'MACD', 'KDJ', 'OBV', 'CCI', 'WR', 'DMI'];
  function indDefaults() { return {on: ['VOL'], params: Object.fromEntries(IND_ORDER.map(n => [n, IND[n].params.slice()]))}; }
  /* a parameter list made safe: whole periods 1 to 500 (BOLL's deviation 0.5 to 5), the defaults for anything else */
  function indParams(name, raw) {
    const d = IND[name]; if (!d) return null;
    const src = Array.isArray(raw) ? raw : [];
    return d.params.map((def, i) => {
      const v = +src[i];
      if (name === 'BOLL' && i === 1) return isFinite(v) && v >= 0.5 && v <= 5 ? Math.round(v * 10) / 10 : def;
      return isFinite(v) && v >= 1 && v <= 500 ? Math.round(v) : def;
    });
  }
  /* saved settings (localStorage, JSON) -> {on, params}; anything unknown or broken falls back to the defaults */
  function parseInd(json) {
    let s = null;
    try { s = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { s = null; }
    const d = indDefaults();
    if (!s || typeof s !== 'object') return d;
    const on = Array.isArray(s.on) ? IND_ORDER.filter(n => s.on.includes(n)) : d.on;
    const params = Object.fromEntries(IND_ORDER.map(n => [n, indParams(n, s.params && s.params[n])]));
    return {on, params};
  }
  const indLabel = (name, params) => IND[name] ? IND[name].label + (params && params.length ? ' ' + params.join(', ') : '') : name;

  /* ---- what an order costs if it fills: exchange fee, Rivemont's fee and the spread + slippage through the book ---- */
  /* the book walked for qty coins (radar/auto/terminal.py est_slippage): {avgPx, usd, rate, enough} or null */
  function walkBook(book, isBuy, qty) {
    if (!book || !(qty > 0)) return null;
    const bids = book.bids || [], asks = book.asks || [];
    if (!bids.length || !asks.length) return null;
    const mid = (bids[0][0] + asks[0][0]) / 2;
    let left = qty, cost = 0;
    for (const [p, s] of (isBuy ? asks : bids)) { const t = Math.min(left, s); cost += t * p; left -= t; if (left <= 1e-12) break; }
    const done = qty - Math.max(left, 0);
    if (done <= 0) return null;
    const avg = cost / done, usd = Math.max(0, (avg - mid) * done * (isBuy ? 1 : -1));
    return {avgPx: avg, usd, rate: mid ? usd / (mid * done) : 0, enough: left <= 1e-12};
  }
  /* {exchange, rivemont, slippage, total} in USD for an order of `notional` (slip: walkBook's usd, or null) */
  function allInFee(notional, exRate, rivRate, feeFree, slip) {
    if (!(notional > 0)) return null;
    const exchange = notional * (exRate || 0), rivemont = feeFree ? 0 : notional * (rivRate || 0), slippage = slip == null ? null : slip;
    return {exchange, rivemont, slippage, total: exchange + rivemont + (slippage || 0)};
  }
  /* Rivemont's rate on an order of `notional` given an exchange's fee (the venue's `fee` from /api/auto/terminal): on a
     Points fee-free day (free_left set: the day's cap of waived fees not used up yet) the order is fee-free only when its
     fee at the normal rate (`paid`) fits in what is left; past that it pays the normal fee (as the server decides it). */
  function freeDayRate(fee, notional) {
    const f = fee || {};
    if (f.free_left == null) return {rate: f.rivemont || 0, free: false, day: false};
    const free = !(notional > 0) || notional * (f.paid || 0) <= f.free_left + 1e-9;
    return {rate: free ? 0 : (f.paid || 0), free, day: true};
  }
  /* this order's cost on each connected exchange, side by side (the figures only, in the server's
     order, never ranked or recommended). rows: /api/auto/terminal/costs venues; byVenue: the funding board's market per
     exchange (rate_1h). Adds funding for one hour at this size: + received, - paid (a long pays a positive rate). */
  function costRows(rows, byVenue, isBuy, notional) {
    return (rows || []).map(r => {
      const m = (byVenue || {})[r.venue], rate = m && m.rate_1h != null ? m.rate_1h : null;
      const fund = rate == null || !(notional > 0) ? null : -notional * rate * (isBuy ? 1 : -1);
      return {...r, fundingRate: rate, fundingUsd: fund};
    });
  }
  /* ---- take profit / stop loss on a position ---- */
  /* estimated P&L if the level is reached: (level - entry) x size, a short the other way */
  function tpslPnl(entry, level, size, isLong) {
    if (!(entry > 0) || !(level > 0) || !(size > 0)) return null;
    return (level - entry) * size * (isLong ? 1 : -1);
  }
  /* why a TP / SL level is refused before it is sent (radar/auto/terminal.py tpsl_plan): null when it is fine */
  function tpslWhy(kind, level, ref, isLong) {
    if (level == null || level === '') return null;
    const v = +level;
    if (!(v > 0)) return _t('Enter a price above 0');
    if (!(ref > 0)) return null;
    const above = (kind === 'tp') === isLong;
    if (above && v <= ref) return kind === 'tp' ? _t('Take profit on a long goes above the price now') : _t('Stop loss on a short goes above the price now');
    if (!above && v >= ref) return kind === 'tp' ? _t('Take profit on a short goes below the price now') : _t('Stop loss on a long goes below the price now');
    return null;
  }
  /* a level from a percentage move (TP / SL presets): +pct in the position's favour for a TP, against it for a SL */
  function levelFromPct(ref, pct, kind, isLong) {
    if (!(ref > 0)) return null;
    const up = (kind === 'tp') === isLong;
    return ref * (1 + (up ? 1 : -1) * Math.abs(pct) / 100);
  }

  /* ---- history: the date filter and the CSV export ---- */
  /* the history request for a range: a preset ('1', '7', '30', '90' days) or 'custom' with from / to ('YYYY-MM-DD', local
     days, both included). null: a custom range not complete or backwards */
  function histRange(range, from, to) {
    if (range !== 'custom') return {days: Math.max(1, +range || 30)};
    const day = (s, end) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null;
      const d = new Date(+m[1], +m[2] - 1, +m[3], end ? 23 : 0, end ? 59 : 0, end ? 59 : 0); return Math.floor(d.getTime() / 1000); };
    const a = day(from), b = day(to, true);
    return a && b && b > a ? {start: a, end: b} : null;
  }
  /* rows as CSV (RFC 4180: quotes doubled, a field with a comma, quote or line break quoted), CRLF lines, a BOM first so
     spreadsheet apps read UTF-8. cols: [[header, row => value]] */
  function csvOf(cols, rows) {
    const cell = v => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '﻿' + [cols.map(c => cell(c[0])).join(','), ...rows.map(r => cols.map(c => cell(c[1](r))).join(','))].join('\r\n') + '\r\n';
  }
  /* a time for a CSV cell: 'YYYY-MM-DD HH:MM:SS' in UTC */
  const csvTime = t => t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) : '';

  /* ---- TP / SL by price, ROE % or P&L: o = {entry, isLong, kind: 'tp' | 'sl', mpc: margin per coin (a
     position: its margin / size; an order: entry / leverage), qty: the coins it closes}. A take profit moves in the
     position's favour, a stop loss against it, whatever sign is typed. -> the trigger price, or null */
  function tpslLevel(unit, v, o) {
    if (v === '' || v == null || !isFinite(+v)) return null;
    if (unit !== 'roe' && unit !== 'pnl') return +v > 0 ? +v : null;
    const x = Math.abs(+v), sgn = (o.kind === 'tp') === !!o.isLong ? 1 : -1;
    if (!(x > 0) || !(o.entry > 0)) return null;
    const d = unit === 'roe' ? (o.mpc > 0 ? x / 100 * o.mpc : null) : (o.qty > 0 ? x / o.qty : null);
    if (d == null) return null;
    const y = o.entry + sgn * d;
    return y > 0 ? y : null;
  }
  /* what a level means for that position: {pnl (USD, for qty), roe (a fraction of its margin)} */
  function tpslFigures(level, o) {
    if (!(level > 0) || !(o.entry > 0)) return null;
    const d = (level - o.entry) * (o.isLong ? 1 : -1);
    return {pnl: o.qty > 0 ? d * o.qty : null, roe: o.mpc > 0 ? d / o.mpc : null};
  }
  /* the level shown back in a unit (the TP/SL editor switches units without losing what was typed) */
  function tpslValue(unit, level, o) {
    if (!(level > 0)) return null;
    if (unit !== 'roe' && unit !== 'pnl') return level;
    const f = tpslFigures(level, o);
    if (!f) return null;
    const v = unit === 'roe' ? (f.roe == null ? null : f.roe * 100) : f.pnl;
    return v == null ? null : Math.abs(v);
  }

  /* ---- an open position's margin and liquidation (radar/auto/terminal.py: removable, isolated_liq, cross_liq) ---- */
  /* maintenance: the exchange's own rate where it publishes it (mm), else half the initial margin at the maximum leverage */
  const mmRate = (maxLev, mm) => mm > 0 ? +mm : 0.5 / (+maxLev || 20);
  /* isolated (true), cross (false), or the exchange did not say (null) */
  function posIsolated(p) {
    if (!p) return null;
    if (typeof p.isolated === 'boolean') return p.isolated;
    return p.margin_mode === 'isolated' ? true : p.margin_mode === 'cross' ? false : null;
  }
  /* the position's margin: the exchange's own figure, else its value over its leverage */
  function posMargin(p) {
    if (!p) return null;
    if (p.margin_usd != null && isFinite(p.margin_usd)) return +p.margin_usd;
    const l = +p.leverage;
    return l > 0 && p.value_usd != null ? p.value_usd / l : null;
  }
  /* about how much margin an isolated position can give back: what it holds above the initial margin of its leverage,
     less an open loss (rounded down to the cent) */
  function marginRoom(p, maxLev) {
    if (!p || p.margin_usd == null || !isFinite(p.margin_usd)) return null;
    const lev = +p.leverage || +maxLev || 0, keep = lev ? (+p.value_usd || 0) / lev : 0, loss = Math.max(0, -(+p.pnl || 0));
    return Math.max(0, Math.floor((+p.margin_usd - keep - loss) * 100 + 1e-6) / 100);
  }
  function isoLiq(isLong, size, entry, margin, mm) {
    if (!(size > 0) || !(entry > 0) || margin == null) return null;
    const x = isLong ? (size * entry - margin) / (size * (1 - mm)) : (size * entry + margin) / (size * (1 + mm));
    return x > 0 ? x : null;
  }
  /* where an isolated position is liquidated after amt more margin (amt < 0: removed): the exchange's figure moved by
     amt / (size x (1 -/+ maintenance)), or computed from the margin when the exchange gives none */
  function liqAfterMargin(p, amt, maxLev, mmKnown) {
    const mm = mmRate(maxLev, mmKnown), s = +p.size, long = p.side === 'long';
    if (!(s > 0)) return null;
    if (p.liq_px > 0) { const x = long ? p.liq_px - amt / (s * (1 - mm)) : p.liq_px + amt / (s * (1 + mm)); return x > 0 ? x : null; }
    const m = posMargin(p);
    return m == null ? null : isoLiq(long, s, +p.entry_px, m + amt, mm);
  }
  /* about where a cross position of `size` coins is liquidated, every other position held where it is: equity plus this
     position's move meets the maintenance margin of all (otherMm: the others', USD). null: the account covers any price */
  function crossLiq(isLong, size, mark, equity, otherMm, mm) {
    if (!(size > 0) || !(mark > 0) || !(equity > 0)) return null;
    const x = isLong ? (size * mark + otherMm - equity) / (size * (1 - mm)) : (equity + size * mark - otherMm) / (size * (1 + mm));
    return x > 0 ? x : null;
  }
  /* the cross estimate for one coin on one exchange's account (positions: that account's, from /api/auto/me). size and
     side: the position after an order (a new order passes its own), mark: the price now; isolated positions' margin is
     not the cross account's, cross ones' maintenance counts. maxLevOf(position) -> the market's maximum leverage */
  function crossLiqFor(o) {
    const {venue, coin, isLong, size, mark, equity, positions, maxLev, maxLevOf, mm} = o, ml = maxLevOf || (() => 20);
    let eq = +equity || 0, other = 0;
    for (const q of positions || []) {
      if (q.venue !== venue || q.coin === coin) continue;
      if (posIsolated(q) === true) eq -= posMargin(q) || 0;
      else other += (+q.value_usd || 0) * mmRate(ml(q));
    }
    return crossLiq(isLong, +size, +mark, eq, other, mmRate(maxLev, mm));     /* mm: this market's own rate, where known */
  }

  /* ---- price alerts: an alert rings once the price is at or past its level on the side it was set for ---- */
  function alertHit(a, px) {
    if (!a || a.fired || !(px > 0)) return false;
    return a.dir === 'above' ? px >= a.price : px <= a.price;
  }

  /* ---- funding for this coin on every exchange that lists it, for the strip next to the chart: the busiest exchange
     first (by volume), the selected one marked; an exchange that publishes no rate is left out ---- */
  function fundingStrip(byVenue, current) {
    return Object.entries(byVenue || {}).filter(([, m]) => m && m.rate_1h != null)
      .sort((a, b) => (b[1].volume_usd || 0) - (a[1].volume_usd || 0))
      .map(([venue, m]) => ({venue, rate: m.rate_1h, on: venue === current}));
  }

  /* ---- keyboard shortcuts (the '?' sheet lists these; the page handles them) ---- */
  const SHORTCUTS = [
    ['B', _t('Open long / buy (confirm first)')], ['S', _t('Open short / sell (confirm first)')], ['L', _t('Limit order')], ['M', _t('Market order')],
    ['T', _t('Conditional')], ['O', _t('Open side')], ['C', _t('Close side')], ['/', _t('Search a market')],      /* one exchange: no E */
    ['1 – 6', _t('Timeframe 1m, 5m, 15m, 1H, 4H, 1D')], ['I', _t('Indicators')], ['F', _t('Chart full screen')], ['A', _t('Price alert')], ['P', _t('Positions')], ['H', _t('Order history')],
    ['Esc', _t('Close a sheet or menu, stop drawing')], ['Ctrl / ⌘', _t('Hold while drawing: magnet to open, high, low, close')],
    ['Shift', _t('Hold while drawing a line: horizontal, vertical or 45°')], ['Alt + H', _t('Horizontal line at the cursor')],
    ['Ctrl / ⌘ + Z', _t('Undo the last drawing change')], ['Delete', _t('Delete the selected drawing')], ['?', _t('This list')]];
  /* the action a key press means, or null (typing in a field, or a key with a modifier, means nothing) */
  function keyAction(key, typing, mod) {
    if (typing || mod) return null;
    const k = String(key || '');
    const map = {b: 'buy', s: 'sell', l: 'limit', m: 'market', t: 'stop', o: 'open', c: 'close', '/': 'search', i: 'indicators',
                 a: 'alert', p: 'positions', h: 'history', f: 'fullscreen', '?': 'help'};
    if (/^[1-6]$/.test(k)) return 'tf' + k;
    return map[k.toLowerCase()] || null;
  }

  /* ---- the layout (the order panel's ⋯ Settings: Layout, desktop): where Rivemont's own panels sit, never anyone's look.
     A preset is a starting point (the order of the three top columns, chart c / order book b / order panel f, and whether
     the market bar runs across the full width); the trader can then drag the lines between the panels (the book's and
     the order panel's widths, the positions' visible height), swap panels by dragging a panel's title bar (the three top
     columns among themselves; positions and the account between them), and hide the book or the account. One versioned
     object per browser (rv_term_layout); the page's <head> applies it before the first paint with the same rules (its
     copy is checked against these in tests/js/terminal-layout.test.mjs). Version 1 ({p: an old preset id, side,
     wide}) becomes the same arrangement silently. ---- */
  const LAYOUTS = [
    {id: 'std', name: _t('Standard'), o: 'cbf', bar: false, line: _t('Chart, order book, then the order panel')},
    {id: 'bookl', name: _t('Book left'), o: 'bcf', bar: false, line: _t("Order book on the chart's left")},
    {id: 'forml', name: _t('Order panel left'), o: 'fcb', bar: false, line: _t('Order panel first, then the chart and the book')},
    {id: 'top', name: _t('Market bar on top'), o: 'cbf', bar: true, line: _t('Market bar across the top, order panel below it')}];
  const LAYOUT_OLD = {classic: 'std', binance: 'bookl', mexc: 'forml', hl: 'top'};       // version 1's ids
  /* the limits (px): the book's and the order panel's widths, the positions' visible height under the top panels (the
     stylesheet also keeps the chart at least 400px wide whatever the window) */
  const LAY_MIN = {wb: 220, wf: 280, bv: 40}, LAY_MAX = {wb: 440, wf: 420, bv: 1200};
  /* the most the side panels can really take at a window width vw, as the stylesheet clamps them (terminal.html
     --form-w / --book-w): the order panel leaves the positions table 720px, the book leaves the chart 400px (402: the
     two hairlines) beside an order panel of wf; never under the minimums */
  function layRoom(vw, wf) {
    const f = Math.max(LAY_MIN.wf, Math.min(LAY_MAX.wf, vw - 720));
    return {wf: f, wb: Math.max(LAY_MIN.wb, Math.min(LAY_MAX.wb, vw - Math.min(wf == null ? f : wf, f) - 402))};
  }
  /* a dragged vertical line between panels x and y (key "cb", "bf" ...; px: how far right) at window width vw: the panel
     beside the chart changes, or both when the book and the order panel are neighbours. w0: the widths {c, b, f} when the
     drag began. Each panel stays inside what the stylesheet lets it take (layRoom), so a line never moves the other
     line instead (a 1000px window: the order panel cannot grow past 280px) */
  function layDrag(s, key, px, w0, vw) {
    const [x, y] = key, K = {b: 'wb', f: 'wf'}, mx = layRoom(vw, w0.f);
    const room = Math.max(0, w0.c - 400);              // the chart never narrower than 400px (the stylesheet holds it too)
    if (x === 'c') { const w = Math.max(Math.min(LAY_MIN[K[y]], w0[y]), Math.min(mx[K[y]], w0[y] - px, w0[y] + room)); return laySize(s, K[y], w); }
    if (y === 'c') { const w = Math.max(Math.min(LAY_MIN[K[x]], w0[x]), Math.min(mx[K[x]], w0[x] + px, w0[x] + room)); return laySize(s, K[x], w); }
    // neighbours: what one gains the other gives; the order panel's room is the window's, the book's its own maximum
    const hi = {wf: mx.wf, wb: LAY_MAX.wb};
    const d = Math.max(Math.min(0, LAY_MIN[K[x]] - w0[x]), Math.min(0, w0[y] - hi[K[y]]), Math.min(px, Math.max(0, hi[K[x]] - w0[x]), Math.max(0, w0[y] - LAY_MIN[K[y]])));
    return laySize(laySize(s, K[x], w0[x] + d), K[y], w0[y] - d);
  }
  const LAY_KEYS = ['p', 'o', 'bar', 'a', 'hb', 'ha', 'wb', 'wf', 'bv'];
  const layEnd = o => o[0] === 'f' ? 'l' : 'r';                                  // the account under the order panel's end
  const layFormEnd = o => o[0] === 'f' ? 'l' : o[2] === 'f' ? 'r' : null;
  const layNum = (x, k) => x == null || x === '' || typeof x === 'boolean' || !isFinite(+x) ? null : Math.round(Math.min(LAY_MAX[k], Math.max(LAY_MIN[k], +x)));
  function layDefault(id) {
    const p = LAYOUTS.find(l => l.id === id) || LAYOUTS[0];
    return {v: 2, p: p.id, o: p.o, bar: p.bar, a: layEnd(p.o), hb: false, ha: false, wb: null, wf: null, bv: null};
  }
  /* the order panel moved to one end, the other two keeping their order; the account follows it when it was under it */
  function laySide(s, side) {
    const rest = s.o.replace('f', ''), o = side === 'l' ? 'f' + rest : rest + 'f', fe = layFormEnd(s.o);
    return {...s, o, a: !fe || s.a === fe ? side : s.a};
  }
  /* a saved layout (JSON text or an object, either version) made safe: anything unknown or broken falls back to the
     preset's own value, widths and the height into their limits */
  function termLayout(raw) {
    let o = raw;
    if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch (e) { o = null; } }
    if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
    if (o.v !== 2) {
      const d = layDefault(typeof o.p === 'string' && Object.prototype.hasOwnProperty.call(LAYOUT_OLD, o.p) ? LAYOUT_OLD[o.p] : o.p), wide = typeof o.wide === 'boolean' ? o.wide : o.p === 'mexc';
      const s = (o.side === 'l' || o.side === 'r') && o.side !== layEnd(d.o) ? laySide(d, o.side) : d;
      return wide ? {...s, wb: 248, wf: 280} : s;
    }
    const d = layDefault(o.p), ord = typeof o.o === 'string' && o.o.length === 3 && [...'cbf'].every(c => o.o.includes(c)) ? o.o : d.o;
    return {v: 2, p: d.p, o: ord, bar: typeof o.bar === 'boolean' ? o.bar : d.bar, a: o.a === 'l' || o.a === 'r' ? o.a : layEnd(ord),
            hb: o.hb === true, ha: o.ha === true, wb: layNum(o.wb, 'wb'), wf: layNum(o.wf, 'wf'), bv: layNum(o.bv, 'bv')};
  }
  /* has the trader changed the preset (then picking another preset asks first)? */
  const layCustom = raw => { const s = termLayout(raw), d = layDefault(s.p); return LAY_KEYS.some(k => s[k] !== d[k]); };
  /* swap two panels (c, b, f: the top columns; p, a: positions and the account); anything else changes nothing */
  function laySwap(raw, x, y) {
    const s = termLayout(raw);
    if (x !== y && 'cbf'.includes(x) && 'cbf'.includes(y) && x && y) {
      const o = [...s.o], i = o.indexOf(x), j = o.indexOf(y); o[i] = y; o[j] = x;
      const no = o.join(''), fe = layFormEnd(s.o), ne = layFormEnd(no);
      return {...s, o: no, a: fe && ne && s.a === fe ? ne : s.a};
    }
    if (x !== y && 'pa'.includes(x) && 'pa'.includes(y) && x && y && !s.ha) return {...s, a: s.a === 'l' ? 'r' : 'l'};
    return s;
  }
  /* one width or the height, into its limits (null: the preset's own) */
  const laySize = (raw, k, px) => ({...termLayout(raw), [k]: layNum(px, k)});
  /* what the stylesheet places the panels by: attributes and custom properties on <html> (null: removed). Each top panel
     has its grid track (the chart the rest, the book and the order panel their widths); the account sits under the
     panel at its end, except under the chart, where it gets a track of its own at the order panel's width (the positions
     table keeps its room) */
  function layPlan(raw) {
    const s = termLayout(raw), vis = s.hb ? s.o.replace('b', '') : s.o, n = vis.length, fi = vis.indexOf('f');
    const bar = s.bar || (fi > 0 && fi < n - 1), W = {c: 'minmax(0, 1fr)', b: 'var(--book-w)', f: 'var(--form-w)'};
    const sl = !s.ha && s.a === 'l' && vis[0] === 'c', sr = !s.ha && s.a === 'r' && vis[n - 1] === 'c', cols = [], at = {};
    for (const k of vis) {
      const i = cols.length + 1;
      if (k === 'c' && sl) cols.push(W.f, W.c); else if (k === 'c' && sr) cols.push(W.c, W.f); else cols.push(W[k]);
      at[k] = [i, cols.length + 1];
    }
    const N = cols.length + 1, sp = (x, y) => x + ' / ' + y, F = at.f, px = v => v == null ? null : v + 'px';
    const ac = s.a === 'l' ? [1, sl ? 2 : at[vis[0]][1]] : [sr ? N - 1 : at[vis[n - 1]][0], N];
    return {attrs: {'data-tl': s.p, 'data-tbar': bar ? '1' : null, 'data-thb': s.hb ? '1' : null, 'data-tha': s.ha ? '1' : null},
            vars: {'--tl-cols': cols.join(' '), '--tl-c': sp(at.c[0], at.c[1]), '--tl-b': at.b ? sp(at.b[0], at.b[1]) : '1', '--tl-f': sp(F[0], F[1]),
                   '--tl-top': bar ? sp(1, N) : F[0] === 1 ? sp(F[1], N) : sp(1, F[0]),
                   '--tl-bot': s.ha ? sp(1, N) : s.a === 'l' ? sp(ac[1], N) : sp(1, ac[0]), '--tl-ac': sp(ac[0], ac[1]),
                   '--ub': px(s.wb), '--uf': px(s.wf), '--bv': px(s.bv)}};
  }

  /* ---------------- bots in the Terminal (radar/web/terminal-bots.js; settings = radar/auto/bots.py config keys) ---------------- */
  /* Every bot type, in the order the picker shows them (radar/auto/bots.py KIND_INFO holds the same list and catalog()
     serves it to other pages; tests/test_bot_kinds.py checks both agree): id, name, icon (BOT_ICON), group, one line. */
  const BOT_CATALOG = [
    {id: 'grid', name: _t('Grid'), icon: 'grid', group: 'grid', line: _t('Buys below the price and sells above it. Fees and losses can exceed grid gains.')},
    {id: 'rgrid', name: _t('Reverse grid'), icon: 'rgrid', group: 'grid', line: _t('A short grid for falling markets: sells first, buys back lower.')},
    {id: 'infinity', name: _t('Infinity grid'), icon: 'infinity', group: 'grid', line: _t('A grid that moves its range with the price when the price leaves it.')},
    {id: 'dca', name: 'DCA', icon: 'ladder', group: 'accumulate', line: _t('Buys a little now and more if the price dips, then sells everything at your take profit.')},
    {id: 'martingale', name: _t('Martingale'), icon: 'martingale', group: 'accumulate', risk: 'high', line: _t('Buys more each time the price falls, up to your limit; exits on a small bounce.')},
    {id: 'recurring', name: _t('Recurring buy'), icon: 'calendar', group: 'accumulate', line: _t('Buys a set amount every hour, day or week, at the time you pick.')},
    {id: 'rebalance', name: _t('Rebalancing'), icon: 'pie', group: 'accumulate', line: _t('Holds several coins at target weights and trades back to them.')},
    {id: 'indicator', name: _t('Indicator'), icon: 'signal', group: 'strategy', line: _t('Waits for a chart signal you pick, then trades with a take profit and stop loss.')},
    {id: 'breakout', name: _t('Breakout'), icon: 'breakout', group: 'strategy', line: _t('Enters when candles close beyond the recent high or low.')},
    {id: 'meanrev', name: _t('Mean reversion'), icon: 'wave', group: 'strategy', line: _t('Buys the lower Bollinger band and sells the upper one.')},
    {id: 'pair', name: _t('Market neutral'), icon: 'pair', group: 'strategy', line: _t('Long one coin, short a related one, sized by beta; trades their spread when it stretches.')},
    {id: 'trailstop', name: _t('Trailing stop'), icon: 'trailstop', group: 'position', line: _t('Follows a position with a stop that trails the best price.')},
    {id: 'scalp', name: _t('Scalping ladder'), icon: 'pingpong', group: 'grid', line: _t('Maker orders close around the price that move with it.')},
    {id: 'sar', name: _t('Stop and reverse'), icon: 'swap', group: 'strategy', risk: 'high', line: _t('Always in the market: flips long or short on each trend signal.')},
    {id: 'ladder', name: _t('Dip ladder'), icon: 'net', group: 'strategy', line: _t('Limit orders waiting under the recent low for sharp wicks.')},
    {id: 'funding', name: _t('Funding harvest'), icon: 'percent', group: 'strategy', line: _t('Holds the side that receives funding while it pays enough.')},
    {id: 'chase', name: _t('Trailing entry'), icon: 'trail', group: 'position', line: _t('Enters after a rebound from the low, or chases the best price with a limit order.')},
    {id: 'scaleout', name: _t('Take-profit ladder'), icon: 'stairs', group: 'position', line: _t('Closes a position you hold in parts, at several profit targets.')},
    {id: 'custom', name: _t('Custom rules'), icon: 'rules', group: 'custom', line: _t('If these conditions are true, then place these orders: your own bot.')},
    {id: 'volgrid', name: _t('Volatility grid'), icon: 'pulse', group: 'grid', line: _t('A grid whose step follows the ATR; it pauses new buys when volatility jumps.')},
    {id: 'sessgrid', name: _t('Market-hours grid'), icon: 'clock', group: 'grid', line: _t('A grid for stocks and commodities that follows the market\'s hours and weekends.')},
    {id: 'twap', name: 'TWAP', icon: 'slices', group: 'accumulate', line: _t('Buys or sells a total amount in small slices over the time you choose.')},
    {id: 'liqguard', name: _t('Liquidation guard'), icon: 'shield', group: 'position', line: _t('Watches a position you hold and adds margin, cuts it or alerts you near liquidation.')},
    {id: 'fundflip', name: _t('Funding flip'), icon: 'flip', group: 'strategy', line: _t('Takes the side that gets paid once funding stays past your level for hours.')},
  ];
  const BOT_KINDS = BOT_CATALOG.map(k => k.id);
  const BOT_NAME = Object.fromEntries(BOT_CATALOG.map(k => [k.id, k.name]));
  const BOT_LINE = Object.fromEntries(BOT_CATALOG.map(k => [k.id, k.line]));
  const BOT_GROUP = {grid: _t('Grid bots'), accumulate: _t('Accumulate'), strategy: _t('Strategies'), position: _t('Position tools'), custom: _t('Build your own')};
  /* the market each type suits, for the picker's filter (radar/auto/bots.py MARKETS / KIND_MARKETS: the one place, the
     reasons are there; tests/test_bots_hub.py checks this copy agrees). signal = Signal bot */
  const BOT_MARKET = {sideways: _t('Sideways'), up: _t('Uptrend'), down: _t('Downtrend'), hedged: _t('Hedged & passive')};
  const BOT_MARKETS = {grid: ['sideways'], rgrid: ['down', 'sideways'], infinity: ['up'], dca: ['up', 'sideways'], martingale: ['sideways'], recurring: ['up'],
    rebalance: ['hedged'], indicator: ['up', 'down'], breakout: ['up', 'down'], meanrev: ['sideways'], pair: ['hedged'], trailstop: ['up', 'down'],
    scalp: ['sideways'], sar: ['up', 'down'], ladder: ['sideways'], funding: ['sideways'], chase: ['up', 'down'], scaleout: ['up', 'down'],
    custom: ['sideways', 'up', 'down'], signal: ['sideways', 'up', 'down'], volgrid: ['sideways'], sessgrid: ['sideways'], twap: ['up', 'down'], liqguard: ['up', 'down'], fundflip: ['sideways']};
  const GRID_KINDS = ['grid', 'rgrid', 'infinity', 'scalp', 'volgrid', 'sessgrid'];          // the grid engine (bots.engine)
  /* the grids that lay their own range around the price (no range you draw): the scalping ladder, the volatility grid
     (ATR) and the market-hours grid (the session's step) */
  const SELF_RANGE = ['scalp', 'volgrid', 'sessgrid'];
  const isGrid = k => GRID_KINDS.includes(k);
  /* 24px line icons (stroke = currentColor) for the picker; 'sig' is the Signal bot's ('arb': the retired Funding Arbitrage's, for its running rows) */
  const BOT_ICON = {
    arb: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>', sig: '<path d="M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0"/><circle cx="12" cy="12" r="1.3"/><path d="M12 13v7"/>',
    grid: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/><path d="M8 4v16M16 4v16" opacity=".45"/>',
    rgrid: '<path d="M4 6h16M4 12h16M4 18h16" opacity=".45"/><path d="M5 5l5 5 4-2 5 9"/>',
    infinity: '<path d="M12 12c-2-3-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1 6-4s4-4 6-4a4 4 0 0 1 0 8c-2 0-4-1-6-4z"/>',
    ladder: '<path d="M5 5h4v4h4v4h4v4h3"/><circle cx="7" cy="5" r="1.2"/><circle cx="11" cy="9" r="1.2"/><circle cx="15" cy="13" r="1.2"/>',
    martingale: '<path d="M4 6l4 3 4 1 4 3 4 5"/><path d="M6 20h2M10 20h3M15 20h5" /><path d="M7 20v-2M11.5 20v-4M17.5 20v-7" opacity=".5"/>',
    signal: '<path d="M3 16l5-6 4 4 5-8 4 5"/><circle cx="17" cy="6" r="1.6"/>', calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M9 14h2v2H9z"/>',
    trail: '<path d="M3 7c4 0 5 10 9 10s5-6 9-6"/><path d="M17 8l4 3-4 3"/>', stairs: '<path d="M4 19h4v-4h4v-4h4V7h4"/><path d="M18 4l2 3-3 1"/>',
    trailstop: '<path d="M3 17l5-5 4 3 8-9"/><path d="M3 20l5-5 4 3 8-9" stroke-dasharray="2 2" opacity=".6"/>',
    breakout: '<path d="M3 15h10M3 9h10" opacity=".5"/><path d="M4 12l4-2 4 2 4-7 4 1"/>',
    wave: '<path d="M3 8c3-3 6-3 9 0s6 3 9 0M3 16c3-3 6-3 9 0s6 3 9 0" opacity=".5"/><path d="M3 12c3-4 6 4 9 0s6 4 9 0"/>',
    pair: '<path d="M3 16l5-5 4 3 8-8"/><path d="M3 8l5 5 4-3 8 8" opacity=".55"/>',
    swap: '<path d="M7 4v14l-3-3M17 20V6l3 3"/>', pingpong: '<path d="M4 9h16M4 15h16" opacity=".5"/><path d="M5 15l3-6 3 6 3-6 3 6 3-6"/>',
    net: '<path d="M4 6h16" opacity=".5"/><path d="M6 10h12M8 14h8M10 18h4"/>', percent: '<path d="M6 18L18 6"/><circle cx="7.5" cy="7.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>',
    pie: '<circle cx="12" cy="12" r="8"/><path d="M12 4v8l6 5"/>', rules: '<path d="M5 6h6M5 12h4M5 18h6"/><path d="M14 6l3 3-3 3M14 15h6"/>',
    more: '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
    pulse: '<path d="M4 6h16M4 18h16" opacity=".45"/><path d="M3 12h4l2-4 3 8 2-5 2 1h5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/><path d="M2 12h2M20 12h2" opacity=".45"/>',
    slices: '<path d="M4 20h16" opacity=".5"/><path d="M6 17v-3M10 17v-5M14 17v-4M18 17v-6"/>', shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    flip: '<path d="M4 12h16" opacity=".5"/><path d="M5 9c2-4 5-4 7 0s5 4 7 0"/><path d="M5 15c2 4 5 4 7 0" opacity=".55"/>'};
  const botIcon = id => `<svg class="i btk-i" viewBox="0 0 24 24" aria-hidden="true">${BOT_ICON[id] || BOT_ICON.more}</svg>`;
  /* Rule sets the Custom rules bot starts from (an action's `pct` is its share of the largest position) */
  const RULE_PRESETS = {
    safe: {timeframe: '1h', rules: [{logic: 'and', if: [{ind: 'rsi', period: 14, op: 'below', value: 30}, {ind: 'position', op: 'flat'}], then: [{do: 'buy', pct: 50, type: 'market'}], cooldown_min: 0, max_runs: 0},
                                    {logic: 'and', if: [{ind: 'rsi', period: 14, op: 'above', value: 70}, {ind: 'position', op: 'long'}], then: [{do: 'close', pct: 100}], cooldown_min: 0, max_runs: 0}]},
    balanced: {timeframe: '1h', rules: [{logic: 'and', if: [{ind: 'ma_cross', ma: 'ema', fast: 9, slow: 21, op: 'crosses_above'}], then: [{do: 'target', side: 'long', pct: 100}], cooldown_min: 0, max_runs: 0},
                                        {logic: 'and', if: [{ind: 'ma_cross', ma: 'ema', fast: 9, slow: 21, op: 'crosses_below'}, {ind: 'position', op: 'long'}], then: [{do: 'close', pct: 100}], cooldown_min: 0, max_runs: 0}]},
    aggressive: {timeframe: '15m', rules: [{logic: 'and', if: [{ind: 'supertrend', period: 10, mult: 3, op: 'turns_up'}], then: [{do: 'target', side: 'long', pct: 100}], cooldown_min: 0, max_runs: 0},
                                           {logic: 'and', if: [{ind: 'supertrend', period: 10, mult: 3, op: 'turns_down'}], then: [{do: 'target', side: 'short', pct: 100}], cooldown_min: 0, max_runs: 0}]}};
  /* Safe / Balanced / Aggressive, the same as the app's builder (app.html PRESETS); a grid's range is ±range around the
     price. Amounts come from the total investment (BotPlan.derive), so presets hold only the shape. */
  const BOT_PRESETS = {
    dca: {safe: {side: 'long', base_usd: 40, so_count: 5, so_step_pct: 1.3, step_scale: 1.3, so_mult: 1.2, tp_pct: 1.5, sl_pct: 15, leverage: 1, repeat: true, start: null},
      balanced: {side: 'long', base_usd: 50, so_count: 5, so_step_pct: 1, step_scale: 1.2, so_mult: 1.4, tp_pct: 1.2, sl_pct: 12, leverage: 1, repeat: true, start: null},
      aggressive: {side: 'long', base_usd: 50, so_count: 6, so_step_pct: 0.8, step_scale: 1, so_mult: 1.6, tp_pct: 0.8, sl_pct: null, leverage: 3, repeat: true, start: null}},
    grid: {safe: {mode: 'neutral', range: .12, grids: 12, total_usd: 300, leverage: 1, stop_outside: true},
      balanced: {mode: 'neutral', range: .06, grids: 20, total_usd: 400, leverage: 2, stop_outside: true},
      aggressive: {mode: 'long', range: .03, grids: 14, total_usd: 500, leverage: 5, stop_outside: true}},
    indicator: {safe: {side: 'long', timeframe: '4h', conditions: [{ind: 'rsi', period: 14, op: 'below', value: 30}], size_usd: 100, entry: {mode: 'all'}, tp_pct: 4, sl_pct: 3, leverage: 1, exit_opposite: false},
      balanced: {side: 'long', timeframe: '1h', conditions: [{ind: 'ma_cross', ma: 'ema', fast: 9, slow: 21, op: 'crosses_above'}], size_usd: 150, entry: {mode: 'split', by: 'price', parts: 3, step_pct: 1}, tp_pct: 3, sl_pct: 4, leverage: 2, exit_opposite: true},
      aggressive: {side: 'long', timeframe: '15m', conditions: [{ind: 'bb', period: 20, std: 2, op: 'touches_lower'}], size_usd: 100, entry: {mode: 'dca', so_count: 3, so_step_pct: 1.5, so_mult: 1.5}, tp_pct: 1.5, sl_pct: 6, leverage: 5, exit_opposite: false}},
    rgrid: {safe: {mode: 'short', range: .12, grids: 12, leverage: 1, stop_outside: true},
      balanced: {mode: 'short', range: .06, grids: 20, leverage: 2, stop_outside: true},
      aggressive: {mode: 'short', range: .03, grids: 14, leverage: 3, stop_outside: true}},
    infinity: {safe: {mode: 'long', range: .12, grids: 12, leverage: 1, trail_up: true, trail_down: false, stop_outside: true},
      balanced: {mode: 'neutral', range: .06, grids: 20, leverage: 2, trail_up: true, trail_down: true, stop_outside: false},
      aggressive: {mode: 'neutral', range: .03, grids: 14, leverage: 3, trail_up: true, trail_down: true, stop_outside: false}},
    martingale: {safe: {side: 'long', add_on: 'loss', mult: 1.5, step_pct: 2.5, max_adds: 3, tp_pct: 1.5, sl_pct: 20, leverage: 1, repeat: true},
      balanced: {side: 'long', add_on: 'loss', mult: 2, step_pct: 2, max_adds: 4, tp_pct: 1.2, sl_pct: 18, leverage: 1, repeat: true},
      aggressive: {side: 'long', add_on: 'loss', mult: 2, step_pct: 1.5, max_adds: 5, tp_pct: 0.8, sl_pct: 12, leverage: 2, repeat: true}},
    recurring: {safe: {side: 'long', every: 'week', at_hour: 9, weekday: 0, times: 12, leverage: 1},
      balanced: {side: 'long', every: 'day', at_hour: 9, weekday: 0, times: 30, leverage: 1},
      aggressive: {side: 'long', every: 'hour', at_hour: 9, weekday: 0, times: 48, tp_pct: 5, leverage: 1}},
    rebalance: {safe: {side: 'long', mode: 'interval', every_h: 168, drift_pct: 5, order_type: 'taker', leverage: 1},
      balanced: {side: 'long', mode: 'threshold', every_h: 24, drift_pct: 5, order_type: 'taker', leverage: 1},
      aggressive: {side: 'long', mode: 'threshold', every_h: 24, drift_pct: 2, order_type: 'maker', leverage: 2}},
    breakout: {safe: {side: 'long', timeframe: '1d', lookback: 20, confirm: 1, buffer_pct: 0.5, retest_pct: 0, expire: 3, tp_pct: 12, sl_pct: 6, leverage: 1},
      balanced: {side: 'both', timeframe: '4h', lookback: 20, confirm: 1, buffer_pct: 0.2, retest_pct: 0, expire: 3, tp_pct: 5, sl_pct: 2.5, trail_pct: 2, leverage: 2},
      aggressive: {side: 'both', timeframe: '1h', lookback: 30, confirm: 1, buffer_pct: 0, retest_pct: 0, expire: 3, tp_pct: 2, sl_pct: 1, leverage: 3}},
    meanrev: {safe: {side: 'long', timeframe: '4h', period: 20, std: 2.5, exit: 'mid', sl_pct: 4, leverage: 1},
      balanced: {side: 'long', timeframe: '4h', period: 20, std: 2, exit: 'mid', sl_pct: 4, leverage: 1},
      aggressive: {side: 'both', timeframe: '4h', period: 20, std: 2, exit: 'mid', sl_pct: 2.5, leverage: 2}},
    pair: {safe: {hedge: 'beta', mode: 'revert', timeframe: '4h', window: 60, entry_z: 2.5, levels: 1, exit_z: 0.5, stop_z: 4, sl_pct: 5, max_hold_h: 168, leverage: 1, repeat: true},
      balanced: {hedge: 'beta', mode: 'revert', timeframe: '1h', window: 100, entry_z: 2, levels: 1, exit_z: 0.5, stop_z: 3.5, sl_pct: 6, max_hold_h: 72, leverage: 2, repeat: true},
      aggressive: {hedge: 'beta', mode: 'revert', timeframe: '15m', window: 96, entry_z: 1.5, levels: 1, exit_z: 0.25, stop_z: 3, sl_pct: 5, max_hold_h: 24, leverage: 3, repeat: true}},
    // Protect a position I hold is the default purpose; leverage applies when it opens one
    trailstop: {safe: {side: 'long', entry: 'attach', by: 'pct', trail_pct: 5, leverage: 1},
      balanced: {side: 'long', entry: 'attach', by: 'pct', trail_pct: 3, activation_pct: 2, sl_pct: 5, leverage: 2},
      aggressive: {side: 'long', entry: 'attach', by: 'atr', timeframe: '1h', atr_period: 14, atr_mult: 2.5, sl_pct: 4, leverage: 3}},
    chase: {safe: {side: 'long', mode: 'trail', callback_pct: 2, tp_pct: 6, sl_pct: 5, leverage: 1},
      balanced: {side: 'long', mode: 'trail', callback_pct: 1, tp_pct: 4, sl_pct: 4, leverage: 2},
      aggressive: {side: 'long', mode: 'chase', max_chase_pct: 1, tp_pct: 3, sl_pct: 3, leverage: 3}},
    scaleout: {safe: {side: 'long', levels: 2, first_pct: 3, step_pct: 3, leverage: 1},
      balanced: {side: 'long', levels: 3, first_pct: 2, step_pct: 2, sl_pct: 10, leverage: 1},
      aggressive: {side: 'long', levels: 5, first_pct: 1, step_pct: 1, trail_pct: 2, leverage: 1}},
    sar: {safe: {timeframe: '4h', signal: 'supertrend', period: 10, mult: 3, fast: 9, slow: 21, ma: 'ema', signal_len: 9, sl_pct: 6, leverage: 1},
      balanced: {timeframe: '1h', signal: 'supertrend', period: 10, mult: 3, fast: 9, slow: 21, ma: 'ema', signal_len: 9, leverage: 2},
      aggressive: {timeframe: '15m', signal: 'ma_cross', period: 10, mult: 3, fast: 9, slow: 21, ma: 'ema', signal_len: 9, leverage: 3}},
    scalp: {safe: {spread_pct: 0.5, levels: 3, recenter: true, sl_pct: 10, leverage: 1},
      balanced: {spread_pct: 0.3, levels: 5, recenter: true, sl_pct: 8, leverage: 2},
      aggressive: {spread_pct: 0.15, levels: 8, recenter: true, sl_pct: 5, leverage: 5}},
    ladder: {safe: {side: 'long', timeframe: '4h', lookback: 42, offset_pct: 2, count: 3, step_pct: 3, refresh: 12, tp_pct: 4, sl_pct: 8, leverage: 1},
      balanced: {side: 'long', timeframe: '1h', lookback: 48, offset_pct: 1, count: 4, step_pct: 2, refresh: 24, tp_pct: 3, sl_pct: 6, leverage: 1},
      aggressive: {side: 'long', timeframe: '15m', lookback: 96, offset_pct: 0.5, count: 5, step_pct: 1, refresh: 48, tp_pct: 2, sl_pct: 4, leverage: 3}},
    funding: {safe: {side: 'short', min_rate: 0.005, exit_rate: 0.001, sl_pct: 8, leverage: 1},
      balanced: {side: 'both', min_rate: 0.003, exit_rate: 0.0005, sl_pct: 6, leverage: 1},
      aggressive: {side: 'both', min_rate: 0.002, exit_rate: 0, sl_pct: 4, leverage: 3}},
    custom: {safe: {...RULE_PRESETS.safe, sl_pct: 5, leverage: 1}, balanced: {...RULE_PRESETS.balanced, sl_pct: 4, leverage: 2},
      aggressive: {...RULE_PRESETS.aggressive, sl_pct: 3, leverage: 3}},
    /* radar/auto/bot_adaptive.py DEFAULTS: lines about 3x the round trip's fees apart on a BTC-like coin */
    volgrid: {safe: {mode: 'neutral', timeframe: '4h', atr_period: 14, step_atr: 1, grids: 10, spike_pause: true, spike_mult: 1.5, sl_pct: 15, leverage: 1},
      balanced: {mode: 'neutral', timeframe: '4h', atr_period: 14, step_atr: 0.75, grids: 12, spike_pause: true, spike_mult: 1.5, sl_pct: 12, leverage: 2},
      aggressive: {mode: 'neutral', timeframe: '1h', atr_period: 14, step_atr: 1, grids: 16, spike_pause: true, spike_mult: 2, sl_pct: 10, leverage: 3}},
    sessgrid: {safe: {mode: 'neutral', step_open_pct: 1, off_hours: 'pause', step_off_pct: 2, grids: 8, weekend_flat: true, flat_min: 30, gap_guard: true, gap_wait_min: 60, gap_pct: 2, sl_pct: 15, leverage: 1},
      balanced: {mode: 'neutral', step_open_pct: 0.8, off_hours: 'pause', step_off_pct: 2, grids: 10, weekend_flat: false, flat_min: 30, gap_guard: true, gap_wait_min: 30, gap_pct: 2, sl_pct: 12, leverage: 2},
      aggressive: {mode: 'neutral', step_open_pct: 0.6, off_hours: 'wide', step_off_pct: 1.5, grids: 14, weekend_flat: false, flat_min: 30, gap_guard: true, gap_wait_min: 15, gap_pct: 3, sl_pct: 10, leverage: 3}},
    twap: {safe: {side: 'long', mode: 'accumulate', duration_min: 240, slices: 24, randomize: true, max_spread_pct: 0.2, leverage: 1},
      balanced: {side: 'long', mode: 'accumulate', duration_min: 60, slices: 12, randomize: true, leverage: 1},
      aggressive: {side: 'long', mode: 'accumulate', duration_min: 30, slices: 10, randomize: true, leverage: 2}},
    liqguard: {safe: {side: 'long', action: 'margin_reduce', trigger_pct: 15, margin_usd: 50, reduce_pct: 25, max_day: 3, cooldown_min: 10, leverage: 1},
      balanced: {side: 'long', action: 'margin_reduce', trigger_pct: 10, margin_usd: 50, reduce_pct: 25, max_day: 3, cooldown_min: 10, leverage: 1},
      aggressive: {side: 'long', action: 'reduce', trigger_pct: 5, reduce_pct: 50, max_day: 5, cooldown_min: 5, leverage: 1}},
    fundflip: {safe: {side: 'short', min_rate: 0.01, hours: 6, exit_rate: 0, sl_pct: 5, leverage: 1},
      balanced: {side: 'both', min_rate: 0.006, hours: 4, exit_rate: 0, sl_pct: 5, leverage: 1},
      aggressive: {side: 'both', min_rate: 0.004, hours: 2, exit_rate: 0, sl_pct: 4, leverage: 3}}};
  const COND_DEF = {rsi: {ind: 'rsi', period: 14, op: 'below', value: 30}, price_ma: {ind: 'price_ma', ma: 'ema', period: 50, op: 'crosses_above'},
    ma_cross: {ind: 'ma_cross', ma: 'ema', fast: 9, slow: 21, op: 'crosses_above'}, bb: {ind: 'bb', period: 20, std: 2, op: 'touches_lower'},
    macd: {ind: 'macd', fast: 12, slow: 26, signal: 9, op: 'crosses_above'}, supertrend: {ind: 'supertrend', period: 10, mult: 3, op: 'turns_up'},
    price: {ind: 'price', op: 'above', value: null}, change: {ind: 'change', op: 'down', pct: 3, candles: 4},
    breakout: {ind: 'breakout', op: 'above_high', period: 20}, bb_mid: {ind: 'bb_mid', period: 20, std: 2, op: 'crosses_above'},
    position: {ind: 'position', op: 'flat'}, pnl: {ind: 'pnl', op: 'above', pct: 3}, time: {ind: 'time', from_h: 9, to_h: 17},
    weekday: {ind: 'weekday', days: [0, 1, 2, 3, 4]}, funding: {ind: 'funding', op: 'above', rate: 0.005}, always: {ind: 'always'}};
  /* the conditions an indicator bot can use, and the extra ones a rules bot can (its position, time, funding) */
  const IND_CONDS = ['rsi', 'ma_cross', 'price_ma', 'bb', 'macd', 'supertrend', 'price', 'change', 'breakout', 'bb_mid'];
  const RULE_CONDS = IND_CONDS.concat(['position', 'pnl', 'time', 'weekday', 'funding', 'always']);
  const ACTION_DEF = {buy: {do: 'buy', pct: 50, type: 'market', offset_pct: 0.5, expire: 3}, sell: {do: 'sell', pct: 50, type: 'market', offset_pct: 0.5, expire: 3},
    close: {do: 'close', pct: 100}, target: {do: 'target', side: 'long', pct: 100},
    ladder: {do: 'ladder', side: 'long', anchor: 'low', lookback: 24, count: 3, step_pct: 1, offset_pct: 0.5, pct: 20, expire: 24}, cancel: {do: 'cancel'}};
  const ENTRY_DEF = {all: {mode: 'all'}, split: {mode: 'split', by: 'price', parts: 3, step_pct: 1}, dca: {mode: 'dca', so_count: 3, so_step_pct: 2, so_mult: 1.5},
    martingale: {mode: 'martingale', so_count: 3, so_step_pct: 2, so_mult: 2, max_total_usd: 1500}};
  const BOT_TFS = ['5m', '15m', '1h', '4h', '1d'];
  const DEFAULT_BASKET = coin => { const c = [coin || 'BTC'].concat(['BTC', 'ETH', 'SOL'].filter(x => x !== coin)).slice(0, 3);
    return [{coin: c[0], weight: 50}, {coin: c[1], weight: 30}, {coin: c[2], weight: 20}]; };
  /* the pair bot's second coin by default: the market leader, or the runner-up when the first coin is the leader */
  const pairOf = coin => coin === 'BTC' ? 'ETH' : 'BTC';
  /* The builder's Advanced part for every type the schema covers, in groups (Entry / Exit / Risk / Schedule): short
     labels, the reason in the (i) tip. f = {g: group, k: the setting (a dot path in the shape), t: num | seg | sel | ck |
     coin | venue | coins | rules, l: label, u: unit, tip, ph: what an empty field means, opts: [[value, label, cap?]],
     cap: the exchange capability it needs (bot_venues.caps), show: shape => shown}. The DCA, grid and indicator bots
     (and the grid-engine types) keep their own fields in terminal-bots.js. */
  const S_ = (g, k, t, l, x) => ({g, k, t, l, ...(x || {})});
  const TP = S_('exit', 'tp_pct', 'num', 'TP', {u: '%', ph: _t('None'), tip: _t('Take profit: closes everything this far from the average entry.')});
  const SL = S_('risk', 'sl_pct', 'num', 'SL', {u: '%', ph: _t('None'), tip: _t('Stop loss: closes everything this far against the average entry.')});
  const SLR = {...SL, ph: '', tip: _t('Required: closes everything this far against the average entry.')};
  const TRAIL = S_('risk', 'trail_pct', 'num', _t('Trailing'), {u: '%', ph: _t('Off'), tip: _t('A stop that follows the best price this far behind it. Rivemont watches it once a minute.')});
  const OTYPE = S_('entry', 'order_type', 'seg', _t('Orders'), {opts: [['taker', _t('Market [order]')], ['maker', _t('Maker'), 'post_only']], tip: _t('Market fills at once; maker waits at the best price and pays the lower fee.')});
  const TF = S_('entry', 'timeframe', 'seg', _t('Chart'), {opts: BOT_TFS.map(t => [t, t])});
  const REPEAT = S_('schedule', 'repeat', 'ck', _t('Start again after an exit'));
  /* the adaptive grids' direction and their exits as a share of the investment (radar/auto/bots.py grid_exit) */
  const GMODE = S_('entry', 'mode', 'seg', _t('Direction'), {opts: [['neutral', _t('Neutral')], ['long', _t('Long')], ['short', _t('Short')]], tip: _t('Neutral starts with no position; Long starts holding coins to sell higher; Short starts short to buy back lower.')});
  const GTP = S_('exit', 'tp_pct', 'num', 'TP', {u: '%', ph: _t('None'), tip: _t('Closes everything and stops once the grid has made this share of the investment.')});
  const GSL = S_('risk', 'sl_pct', 'num', 'SL', {u: '%', ph: _t('None'), tip: _t('Closes everything and stops once the grid has lost this share of the investment.')});
  const BOT_SCHEMA = {
    martingale: [S_('entry', 'add_on', 'seg', _t('Add'), {opts: [['loss', _t('On dips')], ['profit', _t('On gains')]], tip: _t('On dips: buys more as the price goes against you (classic martingale). On gains: adds as it moves your way.')}),
      S_('entry', 'step_pct', 'num', _t('Every'), {u: '%', tip: _t('How far the price moves before each add.')}),
      S_('entry', 'mult', 'num', _t('Size ×'), {tip: _t('Each add is this many times the one before.')}),
      S_('risk', 'max_adds', 'num', _t('Most adds'), {tip: _t('Required: it never adds more times than this.')}),
      {...TP, ph: '', tip: _t('Required on dips: closes everything this far in your favour from the average entry.')}, SLR, REPEAT],
    recurring: [S_('schedule', 'every', 'seg', _t('Every'), {opts: [['hour', _t('Hour')], ['day', _t('Day')], ['week', _t('Week')]]}),
      S_('schedule', 'at_hour', 'num', _t('At'), {u: 'UTC', show: s => s.every !== 'hour', tip: _t('The hour of the day, 0 to 23, in UTC.')}),
      S_('schedule', 'weekday', 'sel', _t('Day'), {show: s => s.every === 'week', opts: [[0, _t('Monday')], [1, _t('Tuesday')], [2, _t('Wednesday')], [3, _t('Thursday')], [4, _t('Friday')], [5, _t('Saturday')], [6, _t('Sunday')]]}),
      S_('schedule', 'times', 'num', _t('Times'), {tip: _t('How many buys; the total is split between them.')}), TP, SL],
    rebalance: [S_('entry', 'coins', 'coins', _t('Coins')),
      S_('schedule', 'mode', 'seg', _t('Rebalance'), {opts: [['threshold', _t('On drift')], ['interval', _t('On time')]]}),
      S_('schedule', 'drift_pct', 'num', _t('Drift'), {u: _t('pp'), show: s => s.mode !== 'interval', tip: _t('Trades back once a coin is this many percentage points (pp) from its weight: at 5 pp a 20% coin is traded back at 15% or 25%.')}),
      S_('schedule', 'every_h', 'num', _t('Every'), {u: 'h', show: s => s.mode === 'interval'}), OTYPE,
      S_('exit', 'tp_pct', 'num', 'TP', {u: '%', ph: _t('None'), tip: _t('Closes every coin once the basket has made this share of the amount.')}),
      S_('risk', 'sl_pct', 'num', 'SL', {u: '%', ph: _t('None'), tip: _t('Closes every coin once the basket has lost this share of the amount.')})],
    breakout: [TF, S_('entry', 'lookback', 'num', _t('Look back'), {u: _t('candles'), tip: _t('The high and low of this many candles are the range to break.')}),
      S_('entry', 'confirm', 'num', _t('Confirm'), {u: _t('candles'), tip: _t('How many candles in a row must close beyond the range. More: fewer false breakouts, later entries.')}),
      S_('entry', 'buffer_pct', 'num', _t('Beyond by'), {u: '%', ph: '0', tip: _t('The close must be at least this far past the high or low.')}),
      S_('entry', 'retest_pct', 'num', _t('Pullback'), {u: '%', ph: '0', tip: _t('0 enters at once; more waits with a limit order for a pullback this deep.')}),
      S_('entry', 'expire', 'num', _t('Wait'), {u: _t('candles'), show: s => +s.retest_pct > 0}), TP, SLR, TRAIL],
    meanrev: [TF, S_('entry', 'period', 'num', _t('Period')), S_('entry', 'std', 'num', _t('Width'), {tip: _t('Standard deviations from the middle line.')}),
      S_('exit', 'exit', 'seg', _t('Exit at'), {opts: [['mid', _t('Middle')], ['band', _t('Other band')]], tip: _t('Middle: a quicker, smaller exit. Other band: waits for the full swing.')}), TP, SLR],
    pair: [S_('entry', 'coin_b', 'coin', _t('Pair with'), {tip: _t('The second coin: it trades the opposite side, sized by the hedge.')}),
      S_('entry', 'venue_b', 'venue', _t('On'), {show: () => VENUES.length > 1, tip: _t('Where the second coin trades: the same exchange by default.')}),
      S_('entry', 'hedge', 'seg', _t('Hedge'), {opts: [['beta', _t('Beta')], ['fixed', _t('Fixed')], ['equal', _t('Equal')]], tip: _t('Beta: sizes the legs by the OLS hedge ratio so their price moves cancel out (market neutral). Fixed: a ratio you set. Equal: the same amount on each leg.')}),
      S_('entry', 'beta', 'num', _t('Ratio'), {show: s => s.hedge === 'fixed', tip: _t('The second leg is this many times the first, from 0.1 to 10.')}),
      S_('entry', 'mode', 'seg', _t('Bet'), {opts: [['revert', _t('Gap closes')], ['trend', _t('Gap widens')]], tip: _t('Gap closes: shorts the coin that ran ahead, buys the one that lagged. Gap widens: the other way round.')}),
      TF, S_('entry', 'window', 'num', _t('Look back'), {u: _t('candles'), tip: _t('Beta and the z-score of the spread are measured over this many candles.')}),
      S_('entry', 'entry_z', 'num', _t('Enter at z'), {tip: _t('How stretched the spread must be, in standard deviations.')}),
      S_('entry', 'levels', 'num', _t('Entry levels'), {ph: '1', tip: _t('1 enters with the whole amount. More: a share at each level, one step further out (for example z 2, 2.5 and 3), every level hedged the same way; the exit and the stops apply to the whole position.')}),
      S_('entry', 'level_step_z', 'num', _t('Level step'), {u: 'z', ph: '0.5', show: s => +s.levels > 1, tip: _t('How much further out each next level is, in z.')}),
      S_('entry', 'level_weights', 'seg', _t('Split'), {opts: [['equal', _t('Equal')], ['more', '1 : 2 : 3']], show: s => +s.levels > 1, tip: _t('Equal parts, or 1 : 2 : 3 so the levels further out add more.')}),
      S_('entry', 'max_half_life', 'num', _t('Max half-life'), {u: _t('candles'), ph: _t('Any'), tip: _t('Enters only while a gap in the spread halves within this many candles.')}),
      S_('exit', 'exit_z', 'num', _t('Exit at z'), {tip: _t('It closes both legs when the spread comes back this close to its average.')}),
      S_('risk', 'stop_z', 'num', _t('Stop at z'), {ph: _t('None'), show: s => s.mode !== 'trend', tip: _t('If the gap keeps widening to this z, the pair may have broken apart: it closes and stops.')}),
      S_('risk', 'sl_pct', 'num', 'SL', {u: '%', ph: _t('None'), tip: _t('Closes both legs and stops once they have lost this share of their amount together.')}),
      S_('risk', 'max_loss_usd', 'num', _t('Max loss'), {u: 'USD', ph: _t('None'), tip: _t('Closes both legs and stops once the bot has lost this much in all, fees included.')}),
      S_('exit', 'tp_pct', 'num', 'TP', {u: '%', ph: _t('None'), tip: _t('Closes both legs once they have made this share of their amount together.')}),
      S_('exit', 'max_hold_h', 'num', _t('Close after'), {u: 'h', ph: _t('Never'), tip: _t('A time limit for each trade.')}), REPEAT],
    trailstop: [S_('entry', 'entry', 'seg', _t('Position'), {opts: [['attach', _t('One I hold')], ['new', _t('Open now [entry]')]], tip: _t('Open now: buys (or shorts) the amount and trails it. One I hold: follows your open position; it sets no money aside.')}),
      S_('risk', 'by', 'seg', _t('Trail by'), {opts: [['pct', '%'], ['atr', 'ATR']], tip: _t('A fixed % behind the best price, or a multiple of the ATR (it widens when the market moves more).')}),
      S_('risk', 'trail_pct', 'num', _t('Distance'), {u: '%', show: s => s.by !== 'atr'}),
      S_('risk', 'timeframe', 'seg', _t('Chart'), {opts: BOT_TFS.map(t => [t, t]), show: s => s.by === 'atr'}),
      S_('risk', 'atr_period', 'num', 'ATR', {show: s => s.by === 'atr'}), S_('risk', 'atr_mult', 'num', _t('Mult.'), {show: s => s.by === 'atr'}),
      S_('risk', 'activation_pct', 'num', _t('Start at'), {u: '%', ph: _t('Now'), tip: _t('The trail starts once the position is this far in profit; the stop loss holds until then.')}),
      S_('risk', 'sl_pct', 'num', 'SL', {u: '%', ph: _t('None'), tip: _t('The stop until the trail starts.')}), TP],
    chase: [S_('entry', 'mode', 'seg', _t('Entry'), {opts: [['trail', _t('Rebound')], ['chase', _t('Chase'), 'post_only']]}),
      S_('entry', 'activation_px', 'num', _t('Activation'), {ph: _t('Now'), show: s => s.mode !== 'chase', tip: _t('It starts following the price once it reaches this.')}),
      S_('entry', 'callback_pct', 'num', _t('Rebound'), {u: '%', show: s => s.mode !== 'chase', tip: _t('Buys once the price rises this far from its lowest point (the mirror for a short).')}),
      S_('entry', 'max_chase_pct', 'num', _t('Max chase'), {u: '%', show: s => s.mode === 'chase', tip: _t('It gives up when the price runs this far from the start.')}), TP, SL, TRAIL, REPEAT],
    scaleout: [S_('exit', 'levels', 'num', _t('Targets'), {tip: _t('Equal parts of your position, one per target.')}),
      S_('exit', 'first_pct', 'num', _t('First'), {u: '%', tip: _t('The first target, from your entry price.')}),
      S_('exit', 'step_pct', 'num', _t('Every'), {u: '%'}), SL, TRAIL],
    /* the averages' type (EMA or SMA) only for the averages cross, the signal line's length only for MACD; a bot saved before either choice runs EMA and 9, as the server defaults them (bot_rules.compile_preset) */
    sar: [TF, S_('entry', 'signal', 'sel', _t('Signal'), {opts: [['supertrend', 'Supertrend'], ['ma_cross', _t('Averages cross')], ['macd', 'MACD']]}),
      S_('entry', 'period', 'num', 'ATR', {show: s => s.signal === 'supertrend'}), S_('entry', 'mult', 'num', _t('Mult.'), {show: s => s.signal === 'supertrend'}),
      S_('entry', 'ma', 'seg', _t('Average'), {opts: [['ema', 'EMA'], ['sma', 'SMA']], show: s => s.signal === 'ma_cross',
        tip: _t('EMA leans on the latest candles and turns sooner; SMA weighs every candle the same: calmer, later.')}),
      S_('entry', 'fast', 'num', _t('Fast'), {show: s => s.signal !== 'supertrend'}), S_('entry', 'slow', 'num', _t('Slow'), {show: s => s.signal !== 'supertrend'}),
      S_('entry', 'signal_len', 'num', _t('Signal line'), {ph: '9', show: s => s.signal === 'macd',
        tip: _t('Candles the MACD signal line averages. Shorter: earlier flips, more false ones.')}), SL, TRAIL],
    scalp: [S_('entry', 'spread_pct', 'num', _t('Gap'), {u: '%', tip: _t('Distance between two orders. Keep it above twice the fees.')}),
      S_('entry', 'levels', 'num', _t('Each side'), {tip: _t('Orders below and above the price.')}),
      S_('entry', 'recenter', 'ck', _t('Follow the price'), {tip: _t('When the price leaves the ladder, it closes and starts again around the new price.')}),
      S_('risk', 'sl_pct', 'num', 'SL', {u: '%', ph: _t('None'), tip: _t('Closes everything once it has lost this share of the investment.')})],
    /* a long ladder buys under the recent low, a short one sells over the recent high (bot_rules.describe): each field
       says the side's own words */
    ladder: [TF, S_('entry', 'lookback', 'num', _t('Look back'), {u: _t('candles'), show: s => s.side !== 'short', tip: _t('Candles the recent low is read from.')}),
      S_('entry', 'lookback', 'num', _t('Look back'), {u: _t('candles'), show: s => s.side === 'short', tip: _t('Candles the recent high is read from.')}),
      S_('entry', 'offset_pct', 'num', _t('Below low'), {u: '%', show: s => s.side !== 'short', tip: _t('How far under the recent low the first order waits.')}),
      S_('entry', 'offset_pct', 'num', _t('Above high'), {u: '%', show: s => s.side === 'short', tip: _t('How far over the recent high the first order waits.')}),
      S_('entry', 'count', 'num', _t('Orders'), {show: s => s.side !== 'short', tip: _t('How many limit orders wait under the low.')}),
      S_('entry', 'count', 'num', _t('Orders'), {show: s => s.side === 'short', tip: _t('How many limit orders wait over the high.')}),
      S_('entry', 'step_pct', 'num', _t('Every'), {u: '%'}),
      S_('schedule', 'refresh', 'num', _t('Refresh'), {u: _t('candles'), show: s => s.side !== 'short', tip: _t('While nothing fills, it moves the orders to the new low this often.')}),
      S_('schedule', 'refresh', 'num', _t('Refresh'), {u: _t('candles'), show: s => s.side === 'short', tip: _t('While nothing fills, it moves the orders to the new high this often.')}), TP, SLR],
    funding: [S_('entry', 'min_rate', 'num', _t('Enter at'), {u: '%/h', tip: _t('Opens when funding pays the side this much per hour.')}),
      S_('exit', 'exit_rate', 'num', _t('Exit under'), {u: '%/h'}), TP, SLR],
    custom: [TF, S_('entry', 'rules', 'rules', _t('Rules')), TP, SL, TRAIL],
    volgrid: [GMODE, S_('entry', 'timeframe', 'seg', _t('Chart'), {opts: BOT_TFS.map(t => [t, t]), tip: _t('The candles the ATR is measured on. A longer chart gives steadier, wider lines.')}),
      S_('entry', 'step_atr', 'num', _t('Step'), {u: '× ATR', tip: _t('The gap between two lines, in ATRs: the grid widens when the market moves more and tightens when it calms.')}),
      S_('entry', 'grids', 'num', _t('Lines'), {tip: _t('How many orders: the range is this many steps, centred on the price.')}),
      S_('entry', 'atr_period', 'num', 'ATR', {u: _t('candles'), tip: _t('Candles the ATR is averaged over. Fewer react faster.')}),
      S_('risk', 'spike_pause', 'ck', _t('Pause on a volatility spike'), {tip: _t('Opens no new grid positions while the ATR jumps far above its average; orders that close positions stay.')}),
      S_('risk', 'spike_mult', 'num', _t('Spike at'), {u: '×', show: s => s.spike_pause !== false, tip: _t('A spike is the ATR above this many times its average of the last 48 candles.')}),
      GTP, GSL],
    sessgrid: [GMODE, S_('entry', 'step_open_pct', 'num', _t('Step, market open'), {u: '%', tip: _t('The gap between two lines while the stock or futures market is open and the price is deep.')}),
      S_('entry', 'grids', 'num', _t('Lines'), {tip: _t('How many orders: the range is this many steps, centred on the price.')}),
      S_('schedule', 'off_hours', 'seg', _t('Out of hours'), {opts: [['pause', _t('Pause new entries')], ['wide', _t('Wider steps')]], tip: _t('Pause: no new positions, long or short, out of hours and on weekends; orders that close positions stay. Wider steps: the grid closes and is laid again wider. With Close before the weekend on, the weekend itself is flat.')}),
      S_('schedule', 'step_off_pct', 'num', _t('Step, out of hours'), {u: '%', show: s => s.off_hours === 'wide', tip: _t('The gap between two lines out of hours and on weekends, when the price is thin and can jump. It must be wider than the open-market step.')}),
      S_('schedule', 'weekend_flat', 'ck', _t('Close before the weekend'), {tip: _t('Closes everything before the external price stops for the weekend and starts again when the market reopens.')}),
      S_('schedule', 'flat_min', 'num', _t('Close'), {u: _t('min before'), show: s => !!s.weekend_flat, tip: _t('How many minutes before the weekend it closes.')}),
      S_('risk', 'gap_guard', 'ck', _t('Gap guard'), {tip: _t('After the weekend it waits before opening new positions, and starts the grid again if the price gapped.')}),
      S_('risk', 'gap_wait_min', 'num', _t('Wait after the open'), {u: 'min', show: s => s.gap_guard !== false, tip: _t('Minutes with no new positions after the market reopens.')}),
      S_('risk', 'gap_pct', 'num', _t('Restart at a gap of'), {u: '%', show: s => s.gap_guard !== false, tip: _t('If the price opened this far from the last close, the grid starts again around the new price.')}),
      GTP, GSL],
    twap: [S_('entry', 'mode', 'seg', _t('Goal'), {opts: [['accumulate', _t('Build [position]')], ['unwind', _t('Close one I hold')]], tip: _t('Build: buys (or shorts) the amount in slices. Close one I hold: closes your open position in reduce-only slices; it sets no money aside.')}),
      S_('schedule', 'duration_min', 'num', _t('Run time'), {u: _t('min'), tip: _t('How long the slices are spread over, from 5 minutes to a week.')}),
      S_('schedule', 'slices', 'num', _t('Slices'), {tip: _t('How many orders the total is split into: at most one a minute.')}),
      S_('schedule', 'randomize', 'ck', _t('Vary time and size'), {tip: _t('Moves each slice a little in time and size, so the orders are harder to spot. The total stays the same.')}),
      S_('exit', 'close_pct', 'num', _t('Close'), {u: '%', show: s => s.mode === 'unwind', tip: _t('The share of your position it closes.')}),
      S_('entry', 'limit_px', 'num', _t('Price limit'), {ph: _t('None'), tip: _t('A buy never pays above it and a sell never sells below it; past it, the bot waits.')}),
      S_('entry', 'max_spread_pct', 'num', _t('Max spread'), {u: '%', ph: _t('None'), tip: _t('It waits while the gap between the best bid and ask is wider than this.')}),
      {...SL, show: s => s.mode !== 'unwind', tip: _t('While it buys: closes everything this far against the average entry.')}],
    liqguard: [S_('risk', 'trigger_pct', 'num', _t('Act at'), {u: '%', tip: _t('It acts when the mark price is this close to the liquidation price.')}),
      S_('risk', 'action', 'seg', _t('Then'), {opts: [['margin_reduce', _t('Both')], ['margin', _t('Margin')], ['reduce', _t('Cut')], ['alert', _t('Alert')]], tip: _t('Add margin: from your free balance, isolated positions only. Cut: closes a share with a reduce-only order. Alert: tells you and trades nothing.')}),
      S_('risk', 'margin_usd', 'num', _t('Add'), {u: 'USD', show: s => s.action === 'margin' || s.action === 'margin_reduce', tip: _t('Margin added each time.')}),
      S_('risk', 'max_margin_day_usd', 'num', _t('Most a day'), {u: 'USD', ph: _t('Add × actions'), show: s => s.action === 'margin' || s.action === 'margin_reduce', tip: _t('It never adds more margin than this in one day (UTC).')}),
      S_('risk', 'reduce_pct', 'num', _t('Cut'), {u: '%', show: s => s.action === 'reduce' || s.action === 'margin_reduce', tip: _t('The share of the position closed each time.')}),
      S_('schedule', 'max_day', 'num', _t('Actions a day'), {tip: _t('At most this many actions in one day (UTC).')}),
      S_('schedule', 'cooldown_min', 'num', _t('Wait'), {u: _t('min'), tip: _t('Minutes between two actions, so the next check reads the new liquidation price first.')})],
    fundflip: [S_('entry', 'min_rate', 'num', _t('Enter at'), {u: '%/h', tip: _t('Opens when funding pays the side this much per hour.')}),
      S_('entry', 'hours', 'num', _t('For'), {u: 'h', tip: _t('How many hourly readings in a row funding must stay past the level.')}),
      S_('exit', 'exit_rate', 'num', _t('Exit under'), {u: '%/h', tip: _t('0 closes when funding flips and stops paying the side.')}), TP, SLR]};
  const BOT_GROUPS = [['entry', _t('Entry')], ['exit', _t('Exit')], ['risk', _t('Risk')], ['schedule', _t('Schedule')]];
  /* the sides a type offers: long / short, both too, or none (it decides itself, or the type fixes it) */
  const BOT_SIDES = {breakout: ['long', 'short', 'both'], meanrev: ['long', 'short', 'both'], funding: ['short', 'long', 'both'], sar: [], custom: [], scalp: [],
    rgrid: [], pair: [], volgrid: [], sessgrid: [], fundflip: ['short', 'long', 'both']};
  const clone = o => JSON.parse(JSON.stringify(o));
  /* a price rounded to about 4 significant digits (grid ranges read like 3,265 or 0.6120, not 3,264.87) */
  function niceRound(v) { if (!(v > 0)) return v; const d = Math.pow(10, Math.floor(Math.log10(v)) - 3); return +(Math.round(v / d) * d).toPrecision(12); }
  /* a preset's settings for this market: the grid's range around the price, leverage capped at the market's maximum */
  function botPreset(kind, name, px, maxLev) {
    const c = clone(BOT_PRESETS[kind][name]);
    if (isGrid(kind) && c.range) { const r = c.range; delete c.range; c.lower = px ? niceRound(px * (1 - r)) : null; c.upper = px ? niceRound(px * (1 + r)) : null; c._range = r; }
    if (maxLev && c.leverage > maxLev) c.leverage = maxLev;
    return c;
  }
  /* ---------------- market-based presets ----------------
     radar/auto/bot_presets.py is the same math on the server (tests/test_bot_presets.py checks both agree).
     Percentages scaled by the coin's volatility: the standard deviation of its 4h returns over 30 days (180 closed 4h
     candles) over a BTC-like 0.75% is the volatility ratio vr (0.5-4); every percentage is BTC's default times vr.
     Grids: a range centred on the price, ±12% / ±6% / ±3% (Safe / Balanced / Aggressive) times vr, clamped to 4-40 /
     2-25 / 1-15%; an even number of lines (as many above the price as below), each earning at least 3x the round trip's
     fees (maker + Rivemont on both fills) even at the top, capped per preset. Advanced may take the low-high of the last
     N candles of the preset's chart instead (range_by 'swing'; price ± 3 ATR(14) when there is no clear swing).
     DCA: the usual price deviation, step scale, volume scale, max safety orders and take profit; martingale: step and
     take profit; dip ladder: offset, step, take profit and stop; each BTC's default times vr, never under 3 round trips.
     Breakout / mean reversion / indicator: stop and target from the ATR of the bot's own chart. Pure and deterministic.
     byTf: {tf: [[t, o, h, l, c], ...]} closed candles. -> {set: settings to merge into the preset, basis: {what, tf, n, k,
     v, h}} or null when the candles are not there (the fixed preset stays). */
  const PRESET_TF = {safe: '1d', balanced: '4h', aggressive: '1h'};
  const LIQUID = ['BTC', 'ETH', 'SOL'];
  const SWING_N = 30, SWING_N_MAX = 250, ATR_N = 14;
  const MAX_GRIDS_P = {safe: 12, balanced: 24, aggressive: 48};
  const VOL_TF = '4h', VOL_N = 180, REF_VOL = 0.75, VR_LO = 0.5, VR_HI = 4;
  const GRID_HALF = {safe: 12, balanced: 6, aggressive: 3};
  const GRID_HALF_CLAMP = {safe: [4, 40], balanced: [2, 25], aggressive: [1, 15]};
  const DCA_BASE = {safe: {so_step_pct: 1.3, step_scale: 1.3, tp_pct: 1.5}, balanced: {so_step_pct: 1.0, step_scale: 1.2, tp_pct: 1.2},
    aggressive: {so_step_pct: 0.8, step_scale: 1.0, tp_pct: 0.8}};
  const MART_BASE = {safe: {step_pct: 2.5, tp_pct: 1.5}, balanced: {step_pct: 2.0, tp_pct: 1.2}, aggressive: {step_pct: 1.5, tp_pct: 0.8}};
  const LADDER_BASE = {safe: {offset_pct: 2, step_pct: 3, tp_pct: 4, sl_pct: 8}, balanced: {offset_pct: 1, step_pct: 2, tp_pct: 3, sl_pct: 6},
    aggressive: {offset_pct: 0.5, step_pct: 1, tp_pct: 2, sl_pct: 4}};
  const STOP_K = {safe: [2.0, 1.5], balanced: [1.5, 1.0], aggressive: [1.2, 0.8]};      // [take profit, stop] x ATR %
  /* breakout: stop 2 ATR, target 4 ATR (1 ATR was inside the noise: stopped out most of the time in backtests,
     2026-09-30); mean reversion: stop 3 ATR (2 for Aggressive) */
  const BRK_K = [2, 4], MR_K = {safe: 3, balanced: 3, aggressive: 2};
  const VOL_KINDS = ['grid', 'rgrid', 'infinity', 'dca', 'martingale', 'ladder'];
  const r2 = x => Math.floor(x * 100 + 0.5) / 100;
  function presetTf(name, coin) { return name === 'aggressive' && LIQUID.includes(coin) ? '15m' : PRESET_TF[name]; }
  /* Wilder's ATR on the last candle (radar/auto/indicators.py atr) */
  function atrLast(rows, n) {
    n = n || ATR_N;
    if (!rows || rows.length < n + 1) return null;
    const tr = rows.map((c, i) => i === 0 ? c[2] - c[3] : Math.max(c[2] - c[3], Math.abs(c[2] - rows[i - 1][4]), Math.abs(c[3] - rows[i - 1][4])));
    let v = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
    for (let i = n; i < tr.length; i++) v = (v * (n - 1) + tr[i]) / n;
    return v;
  }
  /* the swing's candle count from Advanced (10 to 250) */
  function swingN(n) { n = Math.trunc(+n); return !isFinite(n) || !n ? SWING_N : Math.min(SWING_N_MAX, Math.max(10, n)); }
  /* the grid's range from a chart: the swing of the last n candles, or an ATR band around the price */
  function swingRange(rows, px, n) {
    const a = atrLast(rows), w = (rows || []).slice(-(n || SWING_N));
    if (!a || !(px > 0) || w.length < 10) return null;
    const lo = Math.min(...w.map(c => c[3])), hi = Math.max(...w.map(c => c[2]));
    if (lo < px && px < hi && hi - lo >= 2 * a) return {lower: lo, upper: hi, mode: 'swing', atr: a};
    return {lower: px - 3 * a, upper: px + 3 * a, mode: 'atr', atr: a};
  }
  const costOf = fees => { const f = fees || {}; return Math.max(0.0005, 2 * ((+f.maker || 0) + (+f.rivemont || 0))); };
  /* an even number of evenly spaced lines, each gap at least 3 round trips at the top of the range, capped per preset */
  function gridCount(lower, upper, name, fees) {
    let g = Math.floor((upper - lower) / (upper * 3 * costOf(fees)));
    g = Math.max(2, Math.min(MAX_GRIDS_P[name], g));
    return g - g % 2;
  }
  /* the standard deviation (%) of the last 180 candle-to-candle returns (plain returns and sums: the server's number) */
  function volPct(rows) {
    const c = (rows || []).slice(-(VOL_N + 1)).map(r => r[4]).filter(x => x > 0);
    if (c.length < 31) return null;
    const ret = [];
    for (let i = 1; i < c.length; i++) ret.push(c[i] / c[i - 1] - 1);
    const n = ret.length;
    let m = 0; for (const x of ret) m += x; m /= n;
    let q = 0; for (const x of ret) q += (x - m) * (x - m);
    return Math.sqrt(q / (n - 1)) * 100;
  }
  const volRatio = v => Math.min(VR_HI, Math.max(VR_LO, v / REF_VOL));
  const gridHalf = (name, vr) => r2(Math.min(GRID_HALF_CLAMP[name][1], Math.max(GRID_HALF_CLAMP[name][0], GRID_HALF[name] * vr)));
  const floorPct = fees => 3 * costOf(fees) * 100;
  function marketPreset(kind, name, byTf, ctx) {
    const px = ctx && ctx.px, coin = ctx && ctx.coin, fees = ctx && ctx.fees, P = BOT_PRESETS[kind] && BOT_PRESETS[kind][name];
    if (!P || !(px > 0) || !byTf) return null;
    const atrPct = tf => { const a = atrLast(byTf[tf]); return a ? a / px * 100 : null; };
    const fl = floorPct(fees), grid = isGrid(kind) && !SELF_RANGE.includes(kind);
    if (grid && ctx.range_by === 'swing') {
      const tf = presetTf(name, coin), n = swingN(ctx.range_n), r = swingRange(byTf[tf], px, n);
      if (!r) return null;
      const lower = niceRound(r.lower), upper = niceRound(r.upper);
      if (!(lower > 0) || !(upper > lower)) return null;
      return {set: {lower, upper, grids: gridCount(lower, upper, name, fees)},
              basis: {what: r.mode === 'swing' ? 'swing' : 'atr', tf, n, k: 3}};
    }
    if (VOL_KINDS.includes(kind)) {
      const v = volPct(byTf[VOL_TF]);
      if (!v) return null;
      const vr = volRatio(v), basis = {what: 'vol', tf: VOL_TF, days: 30, v: r2(v)};
      if (grid) {
        const h = gridHalf(name, vr), lower = niceRound(px * (1 - h / 100)), upper = niceRound(px * (1 + h / 100));
        if (!(lower > 0) || !(upper > lower)) return null;
        return {set: {lower, upper, grids: gridCount(lower, upper, name, fees)}, basis: {...basis, h}};
      }
      basis.what = 'vol_steps';
      if (kind === 'dca') {
        const b = DCA_BASE[name], step = r2(Math.max(b.so_step_pct * vr, fl)), tp = r2(Math.max(b.tp_pct * vr, fl));
        const set = {so_step_pct: step, step_scale: b.step_scale, tp_pct: tp};
        let reach = 0, g = 1;
        for (let j = 0; j < P.so_count; j++) { reach = reach + step * g; g = g * b.step_scale; }
        if (P.sl_pct) set.sl_pct = r2(Math.max(P.sl_pct, reach + step));      // the stop beyond the last safety order
        return {set, basis};
      }
      if (kind === 'martingale') {
        const b = MART_BASE[name], step = r2(Math.max(b.step_pct * vr, fl)), tp = r2(Math.max(b.tp_pct * vr, fl));
        const set = {step_pct: step, tp_pct: tp};
        if (P.sl_pct) set.sl_pct = r2(Math.max(P.sl_pct, step * (P.max_adds + 1)));
        return {set, basis};
      }
      const b = LADDER_BASE[name], step = r2(b.step_pct * vr);
      return {set: {offset_pct: r2(b.offset_pct * vr), step_pct: step, tp_pct: r2(Math.max(b.tp_pct * vr, fl)),
                    sl_pct: r2(Math.max(b.sl_pct * vr, step * P.count))}, basis};
    }
    if (kind === 'breakout' || kind === 'meanrev') {
      const tf = P.timeframe, v = atrPct(tf);
      if (!v) return null;
      const set = kind === 'breakout' ? {sl_pct: r2(Math.max(BRK_K[0] * v, fl)), tp_pct: r2(Math.max(BRK_K[1] * v, fl))}
        : {sl_pct: r2(Math.max(MR_K[name] * v, fl))};
      return {set, basis: {what: 'atr_stops', tf, v: r2(v)}};
    }
    if (kind === 'indicator') {
      const tf = (ctx && ctx.tf) || P.timeframe, v = atrPct(tf);
      if (!v) return null;
      const [kt, ks] = STOP_K[name];
      // the stop sits beyond the preset's last planned entry (split parts, extra orders), or those entries could never fill
      const e = P.entry || {}, reach = e.mode === 'split' && e.by !== 'candles' ? (+e.step_pct || 0) * ((+e.parts || 1) - 1)
        : e.mode === 'dca' || e.mode === 'martingale' ? (+e.so_step_pct || 0) * (+e.so_count || 0) : 0;
      return {set: {tp_pct: r2(Math.max(v * kt, fl)), sl_pct: r2(Math.max(v * ks, fl) + reach)}, basis: {what: 'atr_stops', tf, v: r2(v)}};
    }
    return null;
  }
  /* the charts a preset reads (what to fetch) */
  function presetCharts(kind, name, coin, ctx) {
    if (isGrid(kind) && !SELF_RANGE.includes(kind) && ctx && ctx.range_by === 'swing') return [presetTf(name, coin)];
    if (VOL_KINDS.includes(kind)) return [VOL_TF];
    if (kind === 'breakout' || kind === 'meanrev') return [BOT_PRESETS[kind][name].timeframe];
    if (kind === 'indicator') return [(ctx && ctx.tf) || BOT_PRESETS[kind][name].timeframe];
    return [];
  }
  /* the quiet line under the presets that says what the numbers came from */
  function basisText(b) {
    if (!b) return '';
    if (b.what === 'swing') return _t('Range: low–high of the last {n} {tf} candles', {n: b.n, tf: b.tf});
    if (b.what === 'atr') return _t('Range: price ± {k} ATR ({tf}), no clear swing', {k: b.k, tf: b.tf});
    if (b.what === 'atr_steps') return _t('Steps and take profit from the {tf} ATR ({v}%)', {tf: b.tf, v: b.v});
    if (b.what === 'vol') return _t('Range: price ± {h}% · 30-day volatility {v}% per {tf}', {h: b.h, v: b.v, tf: b.tf});
    if (b.what === 'vol_steps') return _t('Steps scaled to the 30-day volatility ({v}% per {tf})', {v: b.v, tf: b.tf});
    return _t('Stop and target from the {tf} ATR ({v}%)', {tf: b.tf, v: b.v});
  }
  /* the indicator bot: first the indicator, then Safe / Balanced / Aggressive tune its settings and chart */
  const IND_STRATS = ['rsi', 'ma_cross', 'price_ma', 'bb', 'macd', 'supertrend'];
  const IND_PRESETS = {
    rsi: {safe: ['4h', {ind: 'rsi', period: 14, op: 'below', value: 25}], balanced: ['1h', {ind: 'rsi', period: 14, op: 'below', value: 30}],
      aggressive: ['15m', {ind: 'rsi', period: 14, op: 'below', value: 35}]},
    ma_cross: {safe: ['1d', {ind: 'ma_cross', ma: 'ema', fast: 50, slow: 200, op: 'crosses_above'}], balanced: ['4h', {ind: 'ma_cross', ma: 'ema', fast: 20, slow: 50, op: 'crosses_above'}],
      aggressive: ['1h', {ind: 'ma_cross', ma: 'ema', fast: 9, slow: 21, op: 'crosses_above'}]},
    price_ma: {safe: ['1d', {ind: 'price_ma', ma: 'ema', period: 200, op: 'crosses_above'}], balanced: ['4h', {ind: 'price_ma', ma: 'ema', period: 50, op: 'crosses_above'}],
      aggressive: ['1h', {ind: 'price_ma', ma: 'ema', period: 20, op: 'crosses_above'}]},
    bb: {safe: ['4h', {ind: 'bb', period: 20, std: 2.5, op: 'touches_lower'}], balanced: ['1h', {ind: 'bb', period: 20, std: 2, op: 'touches_lower'}],
      aggressive: ['15m', {ind: 'bb', period: 20, std: 2, op: 'touches_lower'}]},
    macd: {safe: ['1d', {ind: 'macd', fast: 12, slow: 26, signal: 9, op: 'crosses_above'}], balanced: ['4h', {ind: 'macd', fast: 12, slow: 26, signal: 9, op: 'crosses_above'}],
      aggressive: ['1h', {ind: 'macd', fast: 8, slow: 21, signal: 5, op: 'crosses_above'}]},
    supertrend: {safe: ['1d', {ind: 'supertrend', period: 10, mult: 3, op: 'turns_up'}], balanced: ['4h', {ind: 'supertrend', period: 10, mult: 3, op: 'turns_up'}],
      aggressive: ['1h', {ind: 'supertrend', period: 7, mult: 2, op: 'turns_up'}]}};
  /* a condition's mirror, as the engine takes it for the short side of a Both bot and for "close on the opposite signal"
     (radar/auto/indicators.py OPPOSITE_OP / opposite: every operator, RSI X mirrored to 100 - X) */
  const MIRROR_OP = {below: 'above', above: 'below', crosses_above: 'crosses_below', crosses_below: 'crosses_above', touches_lower: 'touches_upper',
    touches_upper: 'touches_lower', above_zero: 'below_zero', below_zero: 'above_zero', turns_up: 'turns_down', turns_down: 'turns_up', is_up: 'is_down',
    is_down: 'is_up', up: 'down', down: 'up', above_high: 'below_low', below_low: 'above_high'};
  function mirrorCond(c) {
    if (!c) return c;
    const o = {...c, op: MIRROR_OP[c.op] || c.op};
    if (c.ind === 'rsi' && c.value != null && c.value !== '' && isFinite(+c.value)) o.value = +(100 - +c.value).toFixed(4);
    return o;
  }
  /* the entry signal for a side: the preset's (long, and neutral: the engine mirrors it), mirrored for a short */
  function indSignal(strat, name, side) {
    const [tf, c0] = IND_PRESETS[strat][name], c = clone(c0);
    return {timeframe: tf, conditions: [side === 'short' ? mirrorCond(c) : c]};
  }
  /* profit per grid line after the maker fee and Rivemont's fee on both fills, in % (radar/auto/bots.py grid_profit_pct) */
  function gridProfit(cfg, fees) {
    if (!cfg || !(cfg.upper > cfg.lower) || !(cfg.grids >= 1)) return null;
    const f = fees || {maker: 0, rivemont: 0}, cost = 2 * ((f.maker || 0) + (f.rivemont || 0));
    if (cfg.spacing === 'geometric') { const g = (Math.pow(cfg.upper / cfg.lower, 1 / cfg.grids) - 1 - cost) * 100; return {max: g, min: g}; }
    const gap = (cfg.upper - cfg.lower) / cfg.grids;
    return {max: (gap / cfg.lower - cost) * 100, min: (gap / (cfg.upper - gap) - cost) * 100};
  }
  /* the grid's price lines (bots.grid_levels): evenly spaced, or each the same % above the one below (geometric) */
  function gridLevels(lower, upper, grids, spacing) {
    if (!(upper > lower) || !(grids >= 1)) return [];
    if (spacing === 'geometric') { const r = Math.pow(upper / lower, 1 / grids); return Array.from({length: grids}, (_, i) => lower * Math.pow(r, i)).concat([upper]); }
    const step = (upper - lower) / grids;
    return Array.from({length: grids}, (_, i) => lower + step * i).concat([upper]);
  }
  /* the grid's lines as the bot plans them at the start (bots.grid_levels + grid_plan): buys below the price, sells above,
     the line nearest the price left empty */
  function gridLines(lower, upper, grids, mid, spacing) {
    const lv = gridLevels(lower, upper, grids, spacing);
    if (!lv.length) return [];
    const ref = Math.min(Math.max(mid || lower, lower), upper);
    let empty = 0; lv.forEach((p, i) => { if (Math.abs(p - ref) < Math.abs(lv[empty] - ref)) empty = i; });
    return lv.map((px, i) => ({px, side: i === empty ? 'empty' : i < empty ? 'buy' : 'sell'}));
  }
  const pctTxt = x => (+(+x).toFixed(4)).toString() + '%';
  const DAYS = [_t('Mon'), _t('Tue'), _t('Wed'), _t('Thu'), _t('Fri'), _t('Sat'), _t('Sun')];
  /* a condition in a few words: short for tables and cards (EMA 9/21 cross ↑), long in plain words for the form */
  function condText(c, long) {
    if (!c) return '';
    const up = /above|up/.test(c.op || ''), ma = String(c.ma || '').toUpperCase(), dir = up ? '↑' : '↓';
    if (c.ind === 'rsi') return long ? (c.op === 'below' ? _t('RSI {period} below {value}', {period: c.period, value: c.value}) : _t('RSI {period} above {value}', {period: c.period, value: c.value})) : `RSI ${c.period} ${c.op === 'below' ? '<' : '>'} ${c.value}`;
    if (c.ind === 'price_ma') return long ? (up ? _t('Price crosses above {ma} {period}', {ma, period: c.period}) : _t('Price crosses below {ma} {period}', {ma, period: c.period})) : _t('Price × {ma} {period} {dir}', {ma, period: c.period, dir});
    if (c.ind === 'ma_cross') return long ? (up ? _t('{a} crosses above {b}', {a: `${ma} ${c.fast}`, b: `${ma} ${c.slow}`}) : _t('{a} crosses below {b}', {a: `${ma} ${c.fast}`, b: `${ma} ${c.slow}`})) : _t('{ma} {fast}/{slow} cross {dir}', {ma, fast: c.fast, slow: c.slow, dir});
    if (c.ind === 'bb') return long ? (c.op === 'touches_lower' ? _t('Price touches the lower Bollinger Band ({period}, {std})', {period: c.period, std: c.std}) : _t('Price touches the upper Bollinger Band ({period}, {std})', {period: c.period, std: c.std})) : `BOLL ${c.period},${c.std} ${c.op === 'touches_lower' ? _t('lower') : _t('upper')}`;
    if (c.ind === 'macd' && long) return {crosses_above: _t('MACD {fast}/{slow}/{signal} crosses above its signal line', c), crosses_below: _t('MACD {fast}/{slow}/{signal} crosses below its signal line', c),
      above_zero: _t('MACD {fast}/{slow}/{signal} above 0', c), below_zero: _t('MACD {fast}/{slow}/{signal} below 0', c)}[c.op] || `MACD ${c.fast}/${c.slow}/${c.signal}`;
    if (c.ind === 'supertrend' && long) return {turns_up: _t('Supertrend ({period}, {mult}) turns up', c), turns_down: _t('Supertrend ({period}, {mult}) turns down', c),
      is_up: _t('Supertrend ({period}, {mult}) is up', c), is_down: _t('Supertrend ({period}, {mult}) is down', c)}[c.op] || `Supertrend ${c.period}, ${c.mult}`;
    if (c.ind === 'macd') return `MACD ${c.fast}/${c.slow}/${c.signal} ${{crosses_above: '× ↑', crosses_below: '× ↓', above_zero: '> 0', below_zero: '< 0'}[c.op] || ''}`;
    if (c.ind === 'supertrend') return `ST ${c.period},${c.mult} ${{turns_up: '↗', turns_down: '↘', is_up: '↑', is_down: '↓'}[c.op] || ''}`;
    if (c.ind === 'price') return `${_t('Price')} ${c.op === 'above' ? '>' : '<'} ${c.value == null ? '…' : fmtPrice(+c.value)}`;
    if (c.ind === 'change') return `${_t('Price')} ${c.op === 'up' ? '+' : '−'}${c.pct}% / ${c.candles}`;
    if (c.ind === 'breakout') return c.op === 'above_high' ? _t('Breaks {n} high', {n: c.period}) : _t('Breaks {n} low', {n: c.period});
    if (c.ind === 'bb_mid') return `BOLL ${c.period} ${_t('mid')} ${dir}`;
    if (c.ind === 'position') return {flat: _t('No position'), long: _t('Is long'), short: _t('Is short'), open: _t('Has a position')}[c.op];
    if (c.ind === 'pnl') return `${_t('P&L')} ${c.op === 'above' ? '≥' : '≤'} ${c.pct}%`;
    if (c.ind === 'time') return `${String(c.from_h).padStart(2, '0')}–${String(c.to_h).padStart(2, '0')} UTC`;
    if (c.ind === 'weekday') return (c.days || []).map(d => DAYS[d]).join(' ');
    if (c.ind === 'funding') return `${_t('Funding')} ${c.op === 'above' ? '>' : '<'} ${c.rate}%/h`;
    if (c.ind === 'always') return _t('Every candle');
    return c.ind;
  }
  /* an indicator bot's entry signal in a few words: its first condition (+n more); a Both bot names both sides, the
     long signal and its mirror for the short (the engine trades both: radar/auto/bot_rules.py neutral) */
  function sigLine(c) {
    const list = (c && c.conditions) || [], n = list.length, more = n > 1 ? ` +${n - 1}` : '';
    if (c && c.side === 'neutral' && list[0]) return _t('Long {a} · short {b}', {a: condText(list[0]) + more, b: condText(mirrorCond(list[0])) + more});
    return `${condText(list[0])}${more}`;
  }
  /* a Stop-and-reverse bot's signal in a few words, with the averages' type and the MACD signal line it runs (a bot saved
     before those choices: EMA and 9, as the server runs it) */
  function sarSig(c) {
    c = c || {};
    if (c.signal === 'ma_cross') return `${(c.ma === 'sma' ? 'SMA' : 'EMA')} ${c.fast || 9}/${c.slow || 21}`;
    if (c.signal === 'macd') return `MACD ${c.fast || 12}/${c.slow || 26}/${c.signal_len || 9}`;
    return c.signal === 'supertrend' || !c.signal ? `Supertrend ${c.period || 10}/${c.mult || 3}` : '';
  }
  const EVERY = () => ({hour: _t('Hourly'), day: _t('Daily'), week: _t('Weekly')});
  /* one short line per bot for tables and cards */
  function botRule(kind, c) {
    if (!c) return '';
    if (c.private) return _t('Private settings');          /* a copy of a private setup: the creator's settings are never sent */
    const rp = v => v >= 1000 ? nfmt(0, 0).format(Math.round(v)) : fmtPrice(v), p = c.preset || {};
    if (kind === 'volgrid') return `${c.step_atr}× ATR ${c.timeframe} · ${c.grids}${c.spike_mult ? ' · ' + _t('spike pause') : ''}`;
    if (kind === 'sessgrid') return `${pctTxt(c.step_open_pct)} / ${c.off_hours === 'wide' ? pctTxt(c.step_off_pct) : _t('paused')} · ${c.grids}${c.weekend_flat ? ' · ' + _t('flat weekends') : ''}`;
    if (isGrid(kind)) return `${rp(c.lower)}–${rp(c.upper)} · ${c.grids}${c.spacing === 'geometric' ? ' · ' + _t('geo') : ''}${kind === 'infinity' ? ' · ∞' : ''}`;
    if (kind === 'dca') return (c.so_count ? `${c.so_count} × ${pctTxt(c.so_step_pct)}` : _t('No extra orders')) + ` · TP ${pctTxt(c.tp_pct)}`;
    if (kind === 'indicator') return `${c.timeframe} ${sigLine(c)}`;
    if (kind === 'martingale') return `${c.max_adds} × ${pctTxt(c.step_pct)} · ×${c.mult} · TP ${pctTxt(c.tp_pct || 0)}`;
    if (kind === 'trailstop') return `${c.by === 'atr' ? `${c.atr_mult}× ATR` : pctTxt(c.trail_pct)}${c.entry === 'attach' ? ' · ' + _t('your position') : ''}`;
    if (kind === 'pair') return `${c.coin}/${c.coin_b} · z ±${c.entry_z}`;
    if (kind === 'chase') return c.mode === 'chase' ? _t('Chase ≤ {v}%', {v: c.max_chase_pct}) : _t('Rebound {v}%', {v: c.callback_pct});
    if (kind === 'scaleout') return _t('{n} targets from +{v}%', {n: c.levels, v: c.first_pct});
    if (kind === 'recurring') return `${EVERY()[p.every] || ''} · ${p.times}×`;
    if (kind === 'breakout') return `${c.timeframe} · ${_t('{n} candles', {n: p.lookback})}`;
    if (kind === 'meanrev') return `${c.timeframe} · BOLL ${p.period},${p.std}`;
    if (kind === 'sar') return `${c.timeframe} · ${sarSig(p)}`;
    if (kind === 'ladder') return `${p.count} × ${pctTxt(p.step_pct)} · ${c.timeframe}`;
    if (kind === 'funding') return `≥ ${p.min_rate}%/h`;
    if (kind === 'rebalance') return (c.coins || []).map(x => `${x.coin} ${x.weight}%`).join(' · ');
    if (kind === 'custom') return _t('{n} rules · {tf}', {n: (c.rules || []).length, tf: c.timeframe});
    if (kind === 'twap') return `${c.slices} × · ${c.duration_min} ${_t('min')}${c.mode === 'unwind' ? ' · ' + _t('your position') : ''}`;
    if (kind === 'liqguard') return _t('Acts at {v}%', {v: c.trigger_pct}) + ' · ' + _t('your position');
    if (kind === 'fundflip') return `≥ ${p.min_rate}%/h · ${p.hours}h`;
    return '';
  }
  /* a preset card's key numbers for this market */
  function presetFacts(kind, c, fees) {
    if (kind === 'grid') { const g = gridProfit(c, fees);
      return `±${Math.round((c._range || 0) * 100)}% · ${_t('{grids} grids', {grids: c.grids})} · ${g ? _t('{v}%/line', {v: (g.min >= 0 ? '+' : '') + g.min.toFixed(2)}) : '–'} · ${c.leverage}x`; }
    if (kind === 'dca') return `${c.so_count} × ${pctTxt(c.so_step_pct)} · ×${c.so_mult} · TP ${pctTxt(c.tp_pct)} · ${c.leverage}x`;
    if (kind === 'indicator') return `${sigLine(c)} · ${c.timeframe} · TP ${pctTxt(c.tp_pct)} / SL ${pctTxt(c.sl_pct)} · ${c.leverage}x`;
    return presetLine(kind, c);
  }
  /* the one short line a preset shows (every type) */
  function presetLine(kind, c) {
    const lv = (c.leverage || 1) + 'x', tp = c.tp_pct ? 'TP ' + pctTxt(c.tp_pct) : null, sl = c.sl_pct ? 'SL ' + pctTxt(c.sl_pct) : null;
    const range = () => `±${Math.round((c.range || c._range || 0) * 100)}%`;
    const parts = {
      grid: () => [range(), _t('{grids} grids', {grids: c.grids})],
      rgrid: () => [range(), _t('{grids} grids', {grids: c.grids})],
      infinity: () => [range(), _t('{grids} grids', {grids: c.grids}), c.trail_down ? '↕' : '↑'],
      dca: () => [`${c.so_count} × ${pctTxt(c.so_step_pct)}`, tp],
      indicator: () => [c.timeframe, tp, sl],
      martingale: () => [`${c.max_adds} × ${pctTxt(c.step_pct)}`, `×${c.mult}`, tp],
      trailstop: () => [c.by === 'atr' ? `${c.atr_mult}× ATR` : pctTxt(c.trail_pct), c.activation_pct ? '+' + pctTxt(c.activation_pct) : null],
      pair: () => [c.timeframe, `z ±${c.entry_z}`, sl],
      chase: () => [c.mode === 'chase' ? _t('Chase') : _t('Rebound') + ' ' + pctTxt(c.callback_pct), sl],
      scaleout: () => [_t('{n} targets', {n: c.levels}), '+' + pctTxt(c.first_pct)],
      breakout: () => [c.timeframe, _t('{n} candles', {n: c.lookback})],
      meanrev: () => [c.timeframe, `BOLL ${c.period},${c.std}`],
      sar: () => [c.timeframe, sarSig(c)],
      scalp: () => [pctTxt(c.spread_pct), _t('{n}/side', {n: c.levels})],
      ladder: () => [c.timeframe, `${c.count} × ${pctTxt(c.step_pct)}`],
      funding: () => [`≥ ${c.min_rate}%/h`, sl],
      recurring: () => [EVERY()[c.every], `${c.times}×`],
      rebalance: () => [c.mode === 'interval' ? _t('Every {h}h', {h: c.every_h}) : _t('Drift {v} pp', {v: c.drift_pct})],
      custom: () => [c.timeframe, _t('{n} rules', {n: (c.rules || []).length})],
      volgrid: () => [c.timeframe, `${c.step_atr}× ATR`, _t('{grids} grids', {grids: c.grids})],
      sessgrid: () => [pctTxt(c.step_open_pct), c.off_hours === 'wide' ? pctTxt(c.step_off_pct) : _t('paused'), _t('{grids} grids', {grids: c.grids})],
      twap: () => [`${c.slices} ×`, `${c.duration_min} ${_t('min')}`],
      liqguard: () => [_t('Acts at {v}%', {v: c.trigger_pct}), {margin_reduce: _t('Margin, else cut'), margin: _t('Add margin'), reduce: _t('Cut'), alert: _t('Alert')}[c.action]],
      fundflip: () => [`≥ ${c.min_rate}%/h`, `${c.hours}h`, sl]}[kind];
    return (parts ? parts() : []).filter(x => x).concat([lv]).join(' · ');
  }
  /* the side a bot holds, for funding: its side; a long or short grid that side; a neutral grid, a basket, a pair or
     rules none */
  const botSide = (kind, c) => isGrid(kind) ? (c.mode === 'neutral' ? null : c.mode) : kind === 'pair' ? null
    : c.side === 'long' || c.side === 'short' ? c.side : null;
  /* The chart overlay a new bot type draws before it starts, from its plan (terminal-bots.js previewLines draws them):
     {lines: [{px, tone: up | dn | acc | dim, dash, label}], handles: [{which, px, tone, title}], band: [lo, hi] | null,
     boll: [period, std] | null, note: a line for the chart's corner}. `rows`: the chart's closed candles on the bot's
     timeframe ([t, o, h, l, c]), for the breakout range. */
  function botOverlay(kind, c, orders, px, rows) {
    const out = {lines: [], handles: [], band: null, boll: null, note: null};
    if (!px || !c) return out;
    const long = c.side !== 'short', sgn = long ? 1 : -1;
    const at = (pct, s) => px * (1 + (s == null ? sgn : s) * pct / 100);
    if (kind === 'martingale') {
      (orders || []).forEach((o, i) => { if (o.px > 0) out.lines.push({px: o.px, tone: i ? (long ? 'up' : 'dn') : 'acc', dash: [4, 3], label: i ? _t('Add {n}', {n: i}) : _t('First')}); });
      if (c.tp_pct) out.handles.push({which: 'tp', px: at(c.tp_pct), tone: 'up', title: _t('TP {v}{tp_pct}%{v2}', {v: long ? '+' : '−', tp_pct: c.tp_pct, v2: ' ' + _t('(moves with the average)')})});
      if (c.sl_pct) out.handles.push({which: 'sl', px: at(c.sl_pct, -sgn), tone: 'dn', title: _t('SL {v}{sl_pct}%{v2}', {v: long ? '−' : '+', sl_pct: c.sl_pct, v2: ' ' + _t('from the entry')})});
      return out;
    }
    if (kind === 'trailstop') {
      out.lines.push({px, tone: 'acc', dash: [4, 3], label: c.entry === 'attach' ? _t('Your position') : _t('Entry')});
      if (c.activation_pct) out.lines.push({px: at(c.activation_pct), tone: 'dim', dash: [1, 3], label: _t('Trailing starts')});
      const stop = c.activation_pct || c.by === 'atr' ? (c.sl_pct ? at(c.sl_pct, -sgn) : null) : at(c.trail_pct, -sgn);
      if (stop) out.handles.push({which: 'sl', px: stop, tone: 'dn', title: c.activation_pct || c.by === 'atr' ? _t('Stop until the trail starts') : _t('Trailing stop · follows the best price')});
      if (c.tp_pct) out.handles.push({which: 'tp', px: at(c.tp_pct), tone: 'up', title: _t('TP {v}{tp_pct}%{v2}', {v: long ? '+' : '−', tp_pct: c.tp_pct, v2: ' ' + _t('from the entry')})});
      return out;
    }
    if (kind === 'breakout') {
      const n = +c.lookback || 20, w = (rows || []).slice(-n);
      if (w.length >= 2) {
        const buf = (+c.buffer_pct || 0) / 100, hi = Math.max(...w.map(r => r[2])) * (1 + buf), lo = Math.min(...w.map(r => r[3])) * (1 - buf);
        if (c.side !== 'short') out.lines.push({px: hi, tone: 'up', dash: [4, 3], label: _t('Breakout above')});
        if (c.side !== 'long') out.lines.push({px: lo, tone: 'dn', dash: [4, 3], label: _t('Breakout below')});
        out.band = [lo, hi];
      }
      return out;
    }
    if (kind === 'meanrev') { out.boll = [+c.period || 20, +c.std || 2]; return out; }
    if (kind === 'recurring') {
      out.lines.push({px, tone: 'acc', dash: [4, 3], label: _t('Buys {n} times', {n: c.times})});
      if (c.tp_pct) out.handles.push({which: 'tp', px: at(c.tp_pct), tone: 'up', title: _t('TP {v}{tp_pct}%{v2}', {v: long ? '+' : '−', tp_pct: c.tp_pct, v2: ' ' + _t('(moves with the average)')})});
      return out;
    }
    if (kind === 'pair') { out.note = _t('{a}/{b} ratio · enters at z ±{z}', {a: c.coin || '', b: c.coin_b || '', z: c.entry_z}); return out; }
    if (kind === 'twap') {
      out.lines.push({px, tone: 'acc', dash: [4, 3], label: c.mode === 'unwind' ? _t('Your position') : _t('{n} slices', {n: c.slices})});
      if (+c.limit_px > 0) out.lines.push({px: +c.limit_px, tone: 'dim', dash: [1, 3], label: _t('Price limit')});
      if (c.sl_pct && c.mode !== 'unwind') out.handles.push({which: 'sl', px: at(c.sl_pct, -sgn), tone: 'dn', title: _t('SL {v}{sl_pct}%{v2}', {v: long ? '−' : '+', sl_pct: c.sl_pct, v2: ' ' + _t('from the entry')})});
      return out;
    }
    if (kind === 'liqguard') { out.note = _t('Acts within {v}% of your liquidation price', {v: c.trigger_pct}); return out; }
    if (kind === 'rebalance') { out.note = (c.coins || []).map(x => `${x.coin} ${x.weight}%`).join(' · '); return out; }
    (orders || []).forEach((o, i) => { if (o.px > 0) out.lines.push({px: o.px, tone: i ? (long ? 'up' : 'dn') : 'acc', dash: [4, 3], label: null}); });
    if (c.tp_pct && kind !== 'scaleout') out.handles.push({which: 'tp', px: at(c.tp_pct), tone: 'up', title: _t('TP {v}{tp_pct}%{v2}', {v: long ? '+' : '−', tp_pct: c.tp_pct, v2: ' ' + _t('from the entry')})});
    if (c.sl_pct) out.handles.push({which: 'sl', px: at(c.sl_pct, -sgn), tone: 'dn', title: _t('SL {v}{sl_pct}%{v2}', {v: long ? '−' : '+', sl_pct: c.sl_pct, v2: ' ' + _t('from the entry')})});
    return out;
  }
  /* The venue whose funding pays this side most right now (from the funding board: markets[coin][venue].rate_1h, what a
     long pays per hour; a short receives it). Only where the coin is listed and, when `ok` is given, on those exchanges.
     -> {venue, rate (what this side earns per hour, > 0 = receives), here (the same for `current`)} or null. */
  function fundingPick(markets, coin, side, current, ok) {
    const by = (markets || {})[coin] || {};
    if (!side) return null;
    const earn = v => { const r = (by[v] || {}).rate_1h; return r == null || !isFinite(r) ? null : side === 'long' ? -r : r; };
    const vs = Object.keys(by).filter(v => earn(v) != null && (!ok || ok.includes(v)));
    if (!vs.length) return null;
    const best = vs.reduce((a, v) => earn(v) > earn(a) ? v : a, vs[0]);
    return {venue: best, rate: earn(best), here: earn(current)};
  }
  /* a dragged chart line -> the setting it stands for (DCA: take profit, stop loss and the last extra order set tp_pct,
     sl_pct and so_step_pct from the first price; grid handles set lower / upper), rounded for the form */
  function dragSetting(kind, which, c, first, px) {
    if (!(px > 0) || !(first > 0)) return null;
    const long = (c.side || 'long') === 'long', r2 = x => Math.max(0.01, Math.round(x * 100) / 100);
    if (which === 'lower' || which === 'upper' || /_px$/.test(which)) return {[which]: niceRound(px)};   // a price setting: the price itself
    // a distance from the entry dragged past the entry: refused (the line goes back), never its mirror on the other side
    // (a long's take profit dropped under the first price read as a take profit that far above it)
    const up = {tp: 1, activation: 1, sl: -1, last: -1}[which];
    if (up && (long ? up : -up) * (px - first) < 0) return null;
    if (which === 'activation') return {activation_pct: r2(Math.abs(px / first - 1) * 100)};          // a trailing stop's start, from the entry
    if (which === 'tp') return {tp_pct: r2(Math.abs(px / first - 1) * 100)};
    if (which === 'sl') return {sl_pct: r2(Math.abs(px / first - 1) * 100)};
    if (which === 'last' && c.so_count) {             // the first gap, so the last order lands here with the step scale
      const sc = +c.step_scale > 0 ? +c.step_scale : 1;
      let w = 0, g = 1;
      for (let j = 0; j < c.so_count; j++) { w += g; g *= sc; }
      return {so_step_pct: r2(Math.abs(px / first - 1) * 100 / w)};
    }
    return null;
  }
  /* A new bot's margin that fits on an exchange, from the money model (radar/auto/money.py, me.money.venues[]): what the
     exchange reports as free now (withdrawable), as a CEX checks a bot's investment against the available balance
     (api.room_check). Nothing is kept for another strategy and no share is held back. null when the balance is unknown. */
  function botRoom(x) {
    if (!x || x.balance == null || x.withdrawable == null) return null;
    return Math.max(0, x.withdrawable);
  }
  /* the Amount sheet's numbers (app.html botBudgetSheet): the new margin after adding or taking off `delta`, and whether
     it can be saved: never below what the open orders and position use; under the per-customer limit (when there is
     one); an increase must fit in botRoom of its exchange (x = me.money's row for it), else the deposit that makes it fit */
  function budgetChange(o) {
    const d = Math.max(0, Math.round((+o.delta || 0) * 100) / 100), after = Math.round((o.add ? o.now + d : o.now - d) * 100) / 100;
    if (!d) return {after: o.now, d, block: true};
    if (!o.add) {
      if (after <= 0) return {after, d, block: true, why: _t('That is all of its margin or more. To end it, stop the bot instead.'), stop: true};
      if (after < (o.inUse || 0)) return {after, d, block: true, why: `${_t('Its open orders and position use {inUse} and stay as they are, so the margin can\'t go below that now. Lower it once they have closed, or stop the bot.', {inUse: fmtUsd(o.inUse, 0)})}`, stop: true};
      return {after, d, block: false};
    }
    if (o.limit && (o.others || 0) + after > o.limit + 1e-6) return {after, d, block: true, why: `${_t('Rivemont uses at most {limit} per customer, all your bots and copies together.', {limit: fmtUsd(o.limit, 0)})}`};
    const room = botRoom(o.money);
    const short = room == null ? 0 : Math.max(0, d - room);
    return {after, d, block: short >= 0.5, deposit: short >= 0.5 ? Math.ceil(short) : 0};     // the server refuses it too
  }
  /* which of the book's `rows` (prices shown `step` apart) hold a bot line: the nearest row within half a step.
     -> {price: 'buy' | 'sell'} */
  function bookMarks(rows, lines, step) {
    const out = {}, half = (step || 0) / 2 + 1e-9;
    for (const l of lines || []) {
      if (l.side === 'empty') continue;
      let best = null;
      for (const p of rows || []) if (Math.abs(l.px - p) <= half && (best == null || Math.abs(l.px - p) < Math.abs(l.px - best))) best = p;
      if (best != null) out[best] = l.side;
    }
    return out;
  }


  /* ---------------- smart orders (radar/auto/smart.py): entry, 1-10 take profits, trailing, stop, breakeven ---------------- */
  /* n shares that add up to 100 (whole %, the last one takes the rest): 3 -> [33, 33, 34] */
  const SMART_MAX_TPS = 10;               // smart.MAX_TPS (10, was 5)
  function smartShares(n) {
    n = Math.max(1, Math.min(SMART_MAX_TPS, n | 0));
    const a = Array.from({length: n}, () => Math.floor(100 / n));
    a[n - 1] = 100 - a.slice(0, -1).reduce((s, x) => s + x, 0);
    return a;
  }
  /* the ladder's rung prices, as bots.ladder: rung k sits k steps further from the first price (below for a long) */
  function smartLadder(side, first, parts, stepPct) {
    if (!(first > 0) || !(parts >= 1)) return [];
    const s = side === 'long' ? -1 : 1;
    return Array.from({length: parts}, (_, k) => first * (1 + s * (stepPct || 0) / 100 * k));
  }
  /* how many exits the take profit side has: the rows, plus the trailing rest when TP1 closes a share first */
  /* trigger orders the exits keep on the exchange at most (smart.exit_legs): one per take profit row that closes a
     share, plus the one stop (stop loss, trailing stop, breakeven, or the trailing take profit's level) */
  function smartLegs(tps, o) { return (tps || []).filter(t => !(t.pct !== '' && t.pct != null && +t.pct <= 0)).length + (o && (o.sl || o.trailSl || o.trailTp || o.be) ? 1 : 0); }
  function smartTargets(tps, trail) { return trail ? 1 + (tps && tps[0] && +tps[0].pct > 0 ? 1 : 0) : (tps || []).length; }
  /* the stop that applies now: the stop loss (moved by breakeven / trailing) or the trailing take profit's level,
     whichever is closer to the price (smart.stop_level) -> {px, why} or null */
  function smartStop(o) {
    const long = o.side === 'long', c = [];
    if (o.sl_px) c.push({px: +o.sl_px, why: o.sl_why || 'stop loss'});
    if (o.trail_on && o.best && o.trail_tp_pct) { const d = o.trail_tp_pct / 100; c.push({px: long ? o.best * (1 - d) : o.best * (1 + d), why: 'trailing take profit'}); }
    if (!c.length) return null;
    return c.reduce((a, b) => (long ? b.px > a.px : b.px < a.px) ? b : a);
  }
  const WHY = {'stop loss': 'SL', breakeven: _t('SL breakeven'), 'trailing stop': _t('Trailing SL'), 'trailing take profit': _t('Trailing TP')};
  /* the lines a smart order (a record, or the plan being typed) draws on the chart: [{id, price, tone, label}] */
  function smartLines(o) {
    if (!o) return [];
    const long = o.side === 'long', out = [], rungs = o.rungs || [], n = rungs.length, done = o.tp_done || [];
    if (o.phase === 'waiting' && o.start_px) out.push({id: 'start', price: +o.start_px, tone: 'acc', label: _t('Start {dir} {price}', {dir: o.start_dir === 'up' ? '≥' : '≤', price: fmtPrice(o.start_px)})});
    rungs.forEach((r, i) => { if (r.px && ['pending', 'open', 'placing'].includes(r.status || 'pending'))
      out.push({id: 'e' + i, price: +r.px, tone: long ? 'up' : 'dn', label: n > 1 ? _t('Entry {i}/{n}', {i: i + 1, n}) : _t('Entry')}); });
    (o.tps || []).forEach((t, i) => { if (done[i] == null && t.px && !(o.trail_on && i === 0))
      out.push({id: 'tp' + i, price: +t.px, tone: 'up', label: o.trail_tp_pct ? `TP1${+t.pct ? ' ' + +t.pct + '%' : ''} · ` + _t('then trail {v}%', {v: +o.trail_tp_pct}) : `TP${i + 1} ${+t.pct}%`}); });
    const s = smartStop(o.sl_px !== undefined || o.trail_on ? o : {...o, sl_px: o.sl, sl_why: 'stop loss'});
    if (s) out.push({id: 'stop', price: s.px, tone: 'dn', label: WHY[s.why] || _t('Stop [order]')});
    return out;
  }
  /* "TP1 2,100 · TP2 2,200 · SL 1,900" for a table cell; hit targets are left out */
  function smartExits(o) {
    const done = o.tp_done || [], out = [];
    (o.tps || []).forEach((t, i) => { if (done[i] == null) out.push(`TP${i + 1} ${fmtPrice(t.px)}`); });
    if (o.trail_on) out.push(_t('trailing {v}%', {v: +o.trail_tp_pct}));
    const s = smartStop(o);
    if (s) out.push(`${WHY[s.why] || 'SL'} ${fmtPrice(s.px)}`);
    return out.join(' · ') || '–';
  }
  /* the form's smart order as the server takes it (TerminalSmartIn), from the order form's fields */
  function smartBody(f, side, price) {
    const sm = f.smart, num = x => x === '' || x == null || !isFinite(+x) ? null : +x;
    const ladder = sm.mode === 'ladder';
    const tps = sm.tps.filter(t => num(t.px)).map(t => ({px: +t.px, pct: num(t.pct) == null ? null : +t.pct}));
    return {side, entry: {mode: ladder ? 'ladder' : 'single', type: ladder ? 'limit' : f.type === 'limit' ? 'limit' : 'market', price: ladder || f.type === 'limit' ? price : null,
              parts: ladder ? num(sm.parts) : null, step_pct: ladder ? num(sm.step) : null},
            start_px: num(sm.start), expires_h: num(sm.exp), tps: sm.trailTp ? tps.slice(0, 1) : tps, trail_tp_pct: sm.trailTp ? num(sm.trailTpPct) : null,
            sl: num(sm.sl), trail_sl_pct: sm.trailSl ? num(sm.trailSlPct) : null, breakeven: !!sm.be};
  }
  /* the plan being typed, for the chart (smartLines) */
  function smartPlan(body, ref) {
    const first = body.entry.price || ref;
    const rungs = body.entry.mode === 'ladder' ? smartLadder(body.side, first, body.entry.parts || 0, body.entry.step_pct || 0).map(px => ({px})) : [{px: body.entry.price || null}];
    return {side: body.side, rungs, tps: body.tps, sl: body.sl, trail_tp_pct: body.trail_tp_pct, start_px: body.start_px, phase: body.start_px ? 'waiting' : 'entering',
            start_dir: body.start_px && ref ? (body.start_px > ref ? 'up' : 'down') : null};
  }

  const api = {SMART_MAX_TPS, smartShares, smartLegs, smartLadder, smartTargets, smartStop, smartLines, smartExits, smartBody, smartPlan, BOT_KINDS, BOT_NAME, BOT_LINE, BOT_PRESETS, COND_DEF, ENTRY_DEF, BOT_TFS,
               BOT_CATALOG, BOT_GROUP, BOT_MARKET, BOT_MARKETS, BOT_ICON, botIcon, marketPreset, basisText, atrLast, swingRange, swingN, gridCount, volPct, presetCharts, presetTf, IND_STRATS, IND_PRESETS, indSignal, BOT_SCHEMA, BOT_GROUPS, BOT_SIDES, IND_CONDS, RULE_CONDS, ACTION_DEF, DEFAULT_BASKET, pairOf, GRID_KINDS, isGrid, gridLevels, presetLine, botOverlay,
               niceRound, botPreset, gridProfit, gridLines, condText, botRule, MIRROR_OP, mirrorCond, sigLine, sarSig,
               presetFacts, botSide, fundingPick, dragSetting, botRoom, budgetChange, bookMarks,
               protState, orderStatus, cancelling, typeLabel, TYPE_LABEL, TIF_LABEL, IND, IND_ORDER, indDefaults, indParams, parseInd, indLabel,
               walkBook, allInFee, freeDayRate, costRows, histRange, csvOf, csvTime, tpslPnl, tpslWhy, levelFromPct, tpslLevel, tpslFigures, tpslValue, mmRate, posIsolated, posMargin,
               marginRoom, isoLiq, liqAfterMargin, crossLiq, crossLiqFor, alertHit, fundingStrip, SHORTCUTS, keyAction, LAYOUTS, LAY_MIN, LAY_MAX, layRoom, layDrag, termLayout, layDefault,
               laySide, layCustom, laySwap, laySize, layPlan, VENUES, LABEL, CROSS_ONLY, QUOTE, quoteOf, pairLabel, tfPeriod, TFS, TFS_MORE, BBO, marginModes,
               isHip3, mktName, mktDex, dexLabel, setDexLabels, mktMatch, mktRank, DEX_LABEL, tfLabel, priceDecimals, fmtPrice, foldZeros, sizeDecimals, fmtSize, fmtUsd, fmtCompact, fmtAmt, bookTotal,
               bookTotalDec, fmtPct, fmtRate, liqEstimate, qtyOf, preview, maxSize, sizeFromPct, closeAll, orderSize, pctFromSize, levPresets, levTicks, bboPrice, bboAtSend, groupBook,
               tickSteps, depth, buyShare, fundingCountdown, dayStats, pairsFor, pairWhy, accounts, totals, floorLot, liteMarkets, kName, inUnits};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TerminalCore = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Rivemont chart adapter: the ONLY file that talks to the chart library (KLineChart 10, Apache-2.0, loaded by the page
   from its pinned CDN URL). Everything else (terminal.html) uses the small interface below, so swapping to TradingView
   or Lightweight Charts later means rewriting this one file.

     const ch = RvChart.init(el, {theme, timezone, locale, fmtPrice, askText, onDrawingsChange, onToolEnd})
     ch.setMarket(symbol, venue, pricePrecision, volumePrecision)      ch.setTimeframe('1h')
     ch.setFeed({history(from, to, tf) -> bars, subscribe(onBar) -> unsubscribe, loaded()})   ch.reload()
     ch.setTheme(tokens)
     ch.indicators.add(name, params) / remove(name) / clear() / list()      the viewer's own indicators
     ch.indicators.preview([{name, params}])     shown on top while a form needs them (a bot's conditions); [] ends it
     ch.tools.select(tool) / cancel() / clear() / removeSelected() / selected() / count() / setLock(on)
     ch.tools.setMagnet('off' | 'weak' | 'strong') / magnet()      snaps drawn points to the candles' open, high, low, close;
       holding Ctrl (Cmd on a Mac) is a strong magnet while it is held (opts.onMagnetHeld(held) tells the page)
     ch.tools.undo() -> bool      the last drawing change (add, move, delete, clear) taken back
     ch.tools.hlineAtCursor() -> bool     a horizontal line at the crosshair's price (Alt+H)
     ch.tools.serialize() -> [...] / restore([...])
     Holding Shift while drawing (or dragging an end of) a trend line or ray keeps it horizontal, vertical or at 45 degrees.
     ch.lines.upsert(id, {price, kind, label, color, tone, draggable, onMove, onMoving, onY, style: 'order' | 'handle'})
       (tone: the label's text colour; by default the line's own when it is the up or down colour, else the text colour)
       (onY(y, paneHeight): called each time the line is drawn, for an HTML tag that rides on it)
     ch.lines.remove(id) / removeKind(kind) / ids(kind)
     ch.lines.bundle(id, {lines: [{price, color, dash, size, label, right, tick}], band: [lo, hi], bandColor} | null)
     ch.keepInView(who, lo, hi)       the price scale always reaches lo..hi of every `who` (0, 0 ends that one)
     ch.priceAt(clientX, clientY)     the price under a point of the page (or null)
     ch.resize() / ch.destroy()
     opts.plain: a preview's chart (no title or O / H / L / C legend until hovered, no high / low marks)

   A bar is {t (ms), o, h, l, c, v}. Tools: trend, ray, hline, vline, channel, fib, rect, measure, text. Theme tokens:
   {text, strong, dim, grid, up, dn, line, line2, acc, accSoft, accLine, ink, panel2, upS, dnS, bg, series: [colours]}.
   Quiet by design (the same family as the bot setup): the price lines are thin, their
   labels small tags on the chart's own background with a hairline (the figure coloured only where it means up or down),
   the last price a monochrome tag (the bot setup's "now"), its line a faint grey, indicator lines in the low-saturation series colours,
   volume bars faint, horizontal grid lines only. */
(function (root) {
  'use strict';
  const K = () => root.klinecharts || null;
  const FAM = 'Inter, system-ui, sans-serif';
  const TOOL = {trend: 'segment', ray: 'rayLine', hline: 'horizontalStraightLine', vline: 'verticalStraightLine',
                channel: 'parallelStraightLine', fib: 'fibonacciLine', rect: 'rvRect', measure: 'rvMeasure', text: 'rvText'};
  const FROM_LIB = Object.fromEntries(Object.entries(TOOL).map(([k, v]) => [v, k]));
  const MAIN = ['MA', 'EMA', 'SMA', 'BOLL', 'SAR'];                 // drawn on the price; the others in a pane below
  const PANE_H = {VOL: 72};
  const MAG = {off: 'normal', weak: 'weak_magnet', strong: 'strong_magnet'};
  const SHIFTED = new Set(['trend', 'ray']);                  // Shift keeps these at 0, 45 or 90 degrees
  const period = tf => { const m = /^(\d+)([mhdw])$/.exec(tf || ''); return m ? {span: +m[1], type: {m: 'minute', h: 'hour', d: 'day', w: 'week'}[m[2]]} : null; };

  /* ---- drawing helpers, pure (tests/js/chart-draw.test.mjs) ---- */
  // the magnet setting as kept by the page ('1' from before the weak / strong choice is the weak one)
  const magnetOf = v => v === 'strong' ? 'strong' : v === true || v === '1' || v === 'weak' || v === 'on' ? 'weak' : 'off';
  // the library's overlay mode: Ctrl held is a strong magnet whatever the setting
  const modeOf = (setting, held) => held ? MAG.strong : MAG[magnetOf(setting)];
  /* where the library's magnet puts a price v over a bar {open, high, low, close} (its own rule, so the crosshair can
     show the point before the click): 'strong_magnet' takes the nearest of the bar's prices (above the high: the high,
     below the low: the low); 'weak_magnet' the same inside the bar, outside only within sens (a price distance) */
  function snapValue(v, bar, mode, sens) {
    if (!bar || mode === 'normal' || !isFinite(v)) return v;
    const top = Math.max(bar.open, bar.close), bot = Math.min(bar.open, bar.close), weak = mode === 'weak_magnet';
    if (v > bar.high) return !weak || v - bar.high <= (sens || 0) ? bar.high : v;
    if (v < bar.low) return !weak || bar.low - v <= (sens || 0) ? bar.low : v;
    if (v > top) return v - top < bar.high - v ? top : bar.high;
    if (v < bot) return v - bar.low < bot - v ? bar.low : bot;
    return top - v < v - bot ? top : bot;
  }
  /* Shift: point b (pixels) moved to the nearest of horizontal, vertical or 45 degrees from a */
  function constrain(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, ax = Math.abs(dx), ay = Math.abs(dy), t = Math.tan(Math.PI / 8);
    if (ay <= ax * t) return {x: b.x, y: a.y, dir: 'h'};
    if (ax <= ay * t) return {x: a.x, y: b.y, dir: 'v'};
    return {x: b.x, y: a.y + (dy < 0 ? -ax : ax), dir: 'd'};
  }
  /* undo: the drawings as they were before each change (JSON), the newest last */
  function history(limit) {
    let past = [], now = '[]';
    return {
      reset(state) { past = []; now = state; },
      record(state) { if (state === now) return false; past.push(now); if (past.length > (limit || 50)) past.shift(); now = state; return true; },
      undo() { if (!past.length) return null; now = past.pop(); return now; },
      size: () => past.length
    };
  }

  const SERIES = ['#7880ff', '#d4a45c', '#b48ec8', '#62b0b4', '#f0506e'];      // a caller without the theme's series colours
  const hexA = (c, a) => /^#[0-9a-f]{6}$/i.test(c || '') ? c + a : c;       // a #rrggbb colour at an alpha (two hex digits)
  /* a price line's label: a small tag on the chart's background with a hairline, its text in `col` */
  const tagStyle = (k, col) => ({style: 'stroke_fill', color: col, backgroundColor: k.bg || k.panel2 || 'transparent', borderColor: k.line2 || k.line, borderSize: 1,
    borderRadius: 4, size: 11, weight: 500, family: FAM, paddingLeft: 6, paddingRight: 6, paddingTop: 3, paddingBottom: 3});
  /* the label's text colour: the given tone, else the line's own when it means up or down, else the text colour */
  const toneOf = (k, e) => e.tone || (e.color && (e.color === k.up || e.color === k.dn) ? e.color : k.strong || '#fff');
  function styles(k) {
    const axis = {axisLine: {color: k.line2}, tickLine: {color: k.line2}, tickText: {color: k.text, family: FAM, size: 12}};
    const cross = {line: {color: k.line2, style: 'dashed'}, text: {color: k.strong, family: FAM, size: 12, backgroundColor: k.panel2, borderColor: k.line2}};
    // candles: the theme's candle colours (cup/cdn) when it gives them, both directions filled (no hollow rising candles)
    const cu = k.cup || k.up, cd = k.cdn || k.dn;
    const bar = {upColor: cu, downColor: cd, noChangeColor: k.text, upBorderColor: cu, downBorderColor: cd, noChangeBorderColor: k.text,
                 upWickColor: cu, downWickColor: cd, noChangeWickColor: k.text};
    return {
      // RV_CHART_QUIET (an arbitrage pane's chart, radar/web/arb-desk.js): fewer lines, horizontal only and fainter
      grid: root.RV_CHART_QUIET ? {horizontal: {color: k.grid, style: 'dashed', dashedValue: [2, 6]}, vertical: {show: false}}
                                : {horizontal: {color: k.grid}, vertical: {show: false}},
      candle: {bar, priceMark: {high: {color: k.text, textFamily: FAM}, low: {color: k.text, textFamily: FAM},
                 // the last price: a monochrome tag and a faint dotted line (the bot setup's "now"); the figure's direction is in the bar and the book
                 last: k.bg ? {upColor: k.text, downColor: k.text, noChangeColor: k.text, line: {style: 'dashed', dashedValue: [2, 3], size: 1},
                               text: {family: FAM, size: 12, weight: 500, color: k.bg, borderRadius: 4}}
                            : {upColor: k.up, downColor: k.dn, noChangeColor: k.text, line: {style: 'dashed', size: 1}, text: {family: FAM, size: 12, color: k.ink}}},
               tooltip: {title: {color: k.strong, family: FAM, size: 12, template: '{ticker}'}, legend: {color: k.text, family: FAM, size: 12,
                 template: [{title: 'O ', value: '{open}'}, {title: 'H ', value: '{high}'}, {title: 'L ', value: '{low}'}, {title: 'C ', value: '{close}'}]}}},
      indicator: {ohlc: {upColor: hexA(cu, '40'), downColor: hexA(cd, '40'), noChangeColor: k.text},
                  bars: [{upColor: hexA(cu, '40'), downColor: hexA(cd, '40'), noChangeColor: k.text, borderColor: 'transparent'}],
                  lines: (k.series && k.series.length ? k.series : SERIES).map(color => ({style: 'solid', smooth: false, size: 1, dashedValue: [2, 2], color})),
                  lastValueMark: {show: false}, tooltip: {title: {color: k.dim || k.text, family: FAM, size: 12, showName: true, showParams: true}, legend: {color: k.dim || k.text, family: FAM, size: 12}}},
      xAxis: axis, yAxis: axis, separator: {color: k.line2, activeBackgroundColor: k.accSoft},
      crosshair: {horizontal: cross, vertical: cross},
      overlay: {point: {color: k.acc, borderColor: k.accLine, activeColor: k.acc, activeBorderColor: k.accLine, radius: 4, activeRadius: 5},
                line: {color: k.acc, size: 1}, rect: {style: 'stroke_fill', color: k.accSoft, borderColor: k.acc, borderSize: 1},
                polygon: {color: k.accSoft, borderColor: k.acc}, circle: {color: k.accSoft, borderColor: k.acc},
                text: {color: k.ink, family: FAM, size: 12, backgroundColor: k.acc, borderColor: k.acc, borderRadius: 3, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2}}};
  }

  /* the custom figures, registered once: rectangle, price range, text, and the horizontal lines the Terminal draws
     (fixed: entry, liquidation, alerts; draggable: orders, TP / SL). They read the chart they belong to from extendData
     or the global registry below. */
  const charts = new Set();
  let registered = false;
  function register() {
    const L = K();
    if (registered || !L) return;
    registered = true;
    const box = (a, b) => ({x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)});
    const owner = o => { for (const c of charts) if (c._owns(o.id)) return c; return charts.values().next().value || null; };
    L.registerOverlay({name: 'rvRect', totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
      createPointFigures: ({coordinates}) => coordinates.length < 2 ? [] : [{type: 'rect', attrs: box(coordinates[0], coordinates[1]), styles: {style: 'stroke_fill'}}]});
    L.registerOverlay({name: 'rvMeasure', totalStep: 3, needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
      createPointFigures: ({coordinates, overlay}) => {
        if (coordinates.length < 2) return [];
        const c = owner(overlay); if (!c) return [];
        const [a, b] = coordinates, [p, q] = overlay.points, k = c._tokens;
        if (p.value == null || q.value == null) return [];
        const d = q.value - p.value, up = d >= 0, pct = p.value ? d / p.value : 0, step = c._step;
        const bars = step ? Math.round(Math.abs((q.timestamp || 0) - (p.timestamp || 0)) / step) : 0;
        const cx = (a.x + b.x) / 2, col = up ? k.up : k.dn;
        return [{type: 'rect', attrs: box(a, b), styles: {style: 'fill', color: up ? k.upS : k.dnS}},
          {type: 'line', attrs: {coordinates: [{x: cx, y: a.y}, {x: cx, y: b.y}]}, styles: {color: col}},
          {type: 'text', attrs: {x: cx, y: b.y + (up ? -6 : 6), text: `${up ? '+' : '−'}${c._fmt(Math.abs(d))} (${up ? '+' : '−'}${Math.abs(pct * 100).toFixed(2)}%) · ${bars} bars`, align: 'center', baseline: up ? 'bottom' : 'top'},
           styles: {color: k.ink, backgroundColor: col, borderColor: col}}];
      }});
    L.registerOverlay({name: 'rvText', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
      createPointFigures: ({coordinates, overlay}) => coordinates.length ? [{type: 'text', attrs: {x: coordinates[0].x, y: coordinates[0].y, text: String(overlay.extendData || 'Text'), align: 'left', baseline: 'middle'}}] : []});
    // the labels at the right edge never sit on each other: close lines get their labels stacked (the line stays at its price)
    const line = drag => ({coordinates, bounding, overlay, yAxis}) => {
      if (!coordinates.length) return [];
      const c = owner(overlay), y = coordinates[0].y, e = overlay.extendData || {}, ink = c ? c._tokens.ink : '#fff';
      const ly = c && c._labelY ? c._labelY(overlay.id, y, yAxis) : y;
      if (e.onY) try { e.onY(y, bounding.height); } catch (err) {}      // the page's own tag on this line (a position's P&L and actions) follows it
      const k = c ? c._tokens : {}, tag = k.bg ? tagStyle(k, toneOf(k, e)) : {color: ink, backgroundColor: e.color, borderColor: e.color};
      if (!drag) return [{type: 'line', attrs: {coordinates: [{x: 0, y}, {x: bounding.width, y}]}, styles: {style: 'dashed', color: k.bg ? hexA(e.color, 'b3') : e.color, dashedValue: [4, 3], size: 1}, ignoreEvent: true}].concat(e.title ?
        [{type: 'text', attrs: {x: bounding.width - 8, y: ly, text: e.title, align: 'right', baseline: 'middle'}, styles: tag, ignoreEvent: true}] : []);
      return [{type: 'line', attrs: {coordinates: [{x: 0, y}, {x: bounding.width, y}]}, styles: {style: 'solid', color: k.bg ? hexA(e.color, 'b3') : e.color, size: 1}},
        {type: 'rect', attrs: {x: 0, y: y - 6, width: bounding.width, height: 12}, styles: {style: 'fill', color: 'rgba(0,0,0,0)'}},
        {type: 'text', attrs: {x: bounding.width - 8, y: ly, text: e.title + '  ⇅', align: 'right', baseline: 'middle'}, styles: tag}];
    };
    L.registerOverlay({name: 'rvHandle', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true,
      createPointFigures: ({coordinates, bounding, overlay}) => {
        if (!coordinates.length) return [];
        const c = owner(overlay), y = coordinates[0].y, e = overlay.extendData || {}, ink = c ? c._tokens.ink : '#fff', k = c ? c._tokens : {};
        return [{type: 'rect', attrs: {x: 0, y: y - 12, width: bounding.width, height: 24}, styles: {style: 'fill', color: 'rgba(0,0,0,0)'}},
                {type: 'line', attrs: {coordinates: [{x: 0, y}, {x: bounding.width, y}]}, styles: {style: 'dashed', dashedValue: [6, 4], color: e.color, size: 1.5}},
                // a handle whose label would sit on another's keeps its line alone (no empty tag)
                ...(e.title ? [{type: 'text', attrs: {x: 8, y, text: e.title, align: 'left', baseline: 'middle'}, styles: k.bg ? tagStyle(k, toneOf(k, e)) : {color: ink, backgroundColor: e.color, borderColor: e.color}}] : [])];
      }});
    L.registerOverlay({name: 'rvBundle', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
      createPointFigures: ({bounding, overlay, yAxis}) => {
        const c = owner(overlay), e = overlay.extendData || {}, out = [], W = bounding.width, H = bounding.height, ink = c ? c._tokens.ink : '#fff';
        if (!yAxis) return out;
        const y = v => yAxis.convertToPixel(v);
        if (e.band) { const a = y(e.band[0]), b = y(e.band[1]); out.push({type: 'rect', attrs: {x: 0, y: Math.min(a, b), width: W, height: Math.abs(a - b)}, styles: {style: 'fill', color: e.bandColor}, ignoreEvent: true}); }
        // label rows already used on each side (the draggable handles' own labels first): a closer line keeps its line, not its label
        const taken = {l: c && c._handleYs ? c._handleYs(yAxis) : [], r: []};
        for (const l of e.lines || []) {
          const yy = y(l.price); if (!(yy >= -1 && yy <= H + 1)) continue;
          out.push({type: 'line', attrs: {coordinates: [{x: 0, y: yy}, {x: W, y: yy}]}, styles: {style: l.dash ? 'dashed' : 'solid', dashedValue: l.dash || [4, 3], color: l.color, size: l.size || 1}, ignoreEvent: true});
          if (l.tick) out.push({type: 'rect', attrs: {x: W - 12, y: yy - 2, width: 12, height: 4}, styles: {style: 'fill', color: l.tick}, ignoreEvent: true});
          const side = l.right ? taken.r : taken.l, free = l.label && !side.some(t => Math.abs(t - yy) < 18);
          if (free) side.push(yy);
          const k = c ? c._tokens : {};
          if (free) out.push({type: 'text', attrs: {x: l.right ? W - 16 : 8, y: yy, text: l.label, align: l.right ? 'right' : 'left', baseline: 'middle'},
            styles: k.bg ? tagStyle(k, toneOf(k, l)) : {color: ink, backgroundColor: l.color, borderColor: l.color}, ignoreEvent: true});
        }
        return out;
      }});
    // volume: one legend ("Vol 53.29") in its own pane, bars in the up / down colours (the library's VOL repeats its name)
    L.registerIndicator({name: 'rvVol', shortName: 'Vol', series: 'volume', precision: 2, calcParams: [], shouldFormatBigNumber: true, minValue: 0,
      figures: [{key: 'volume', title: '', type: 'bar', baseValue: 0,
        styles: (a) => { const data = a && a.current ? a : a && a.data, cur = data && data.current, d = cur && (cur.indicatorData || cur), k = cur && cur.kLineData, c = charts.values().next().value, t = (c && c._tokens) || {};
          const up = k ? k.close >= k.open : !!(d && d.up);
          return {color: up ? (t.cup || t.up || '#2ebd85') + '38' : (t.cdn || t.dn || '#f0506e') + '38'}; }}],      /* neutral where the theme's candles are (Obsidian) */
      calc: list => list.map(k => ({volume: k.volume, up: k.close >= k.open}))});
    // keeps planned lines in view: the candle pane's price scale always reaches lo..hi (no figures, no legend)
    L.registerIndicator({name: 'rvRange', shortName: '', series: 'price', precision: 2, calcParams: [], figures: [], calc: () => [],
      createTooltipDataSource: () => ({name: '', calcParamsText: '', legends: [], features: [], values: [], icons: []})});
    L.registerOverlay({name: 'rvLevel', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true, createPointFigures: line(false)});
    L.registerOverlay({name: 'rvDrag', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true, createPointFigures: line(true)});
    /* the time axis: a label that would run past either edge of the pane is left out, never drawn cut ("1 12:00" for
       "10-01 12:00" after a small drag); the library's own ticks otherwise */
    let mc = null;
    const tw = t => { try { mc = mc || document.createElement('canvas').getContext('2d'); mc.font = `12px ${FAM}`; return mc.measureText(t).width; } catch (e) { return t.length * 7; } };
    if (L.registerXAxis) L.registerXAxis({name: 'rvTime', createTicks: ({bounding, defaultTicks}) => (defaultTicks || []).filter(k => {
      const h = tw(String(k.text == null ? '' : k.text)) / 2; return !bounding || !(bounding.width > 0) || (k.coord - h >= 0 && k.coord + h <= bounding.width); })});
  }

  // the library folds 0.0000042892 as the literal text 0.0{5}42892; the Terminal shows it as DEX screeners do, 0.0₅42892
  const SUBD = '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089';
  function foldSub(v) {
    const m = /^(-?\d*)\.(0+)([1-9]\d*)$/.exec(String(v));
    return m && m[2].length >= 4 ? m[1] + '.0' + [...String(m[2].length)].map(d => SUBD[+d]).join('') + m[3] : String(v);
  }

  function init(el, opts) {
    const L = K();
    if (!L || !el) return null;
    register();
    const o = opts || {};
    // o.numFormat: the price axis and tags in the page's number style and decimals, as its headline (the coin page:
    // 84.761,0 in German, 0.000004288 unfolded)
    // o.formatter: the library's own formatter (a page's date words, radar/web/bot-flow.js)
    const kc = L.init(el, {styles: styles(o.theme || {}), locale: o.locale || 'en-US', timezone: o.timezone || 'UTC', ...(o.formatter ? {formatter: o.formatter} : {}),
      ...(o.numFormat ? {thousandsSeparator: {sign: '', format: o.numFormat}, decimalFold: {threshold: 99}}
                     : {decimalFold: {threshold: 4, format: foldSub}})});
    if (!kc) return null;
    // the library gives its chart a positive tabindex (1), which jumps it ahead of the skip link and the page's own
    // order: the chart stays reachable by keyboard, in document order
    el.querySelectorAll('[tabindex="1"]').forEach(n => n.setAttribute('tabindex', '0'));
    try { if (kc.overrideXAxis) kc.overrideXAxis({name: 'rvTime', scrollZoomEnabled: true}); } catch (e) {}
    let feed = null, tf = null, lastTs = null, magnet = 'off', lock = false, drawing = null, selected = null, restoring = false, dragging = null;
    let held = false, shift = false, pressing = false, cursor = null;      // Ctrl / Cmd and Shift held, a drawing's point dragged, the mouse
    const lines = new Map();                  // id -> {spec, oid, drag}
    const toK = b => ({timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v == null ? 0 : b.v});
    const ch = {
      _tokens: o.theme || {}, _step: 0, _fmt: o.fmtPrice || (x => String(x)),
      _owns: id => typeof id === 'string' && (id.startsWith('rvl_') ? lines.has(id.slice(4)) : id.startsWith('rvb_') ? bundles.has(id.slice(4)) : !!kc.getOverlays({id}).length)
    };
    const hist = history(50);
    const changed = () => {
      if (restoring) return;
      setTimeout(() => { hist.record(JSON.stringify(ch.tools.serialize())); if (o.onDrawingsChange) o.onDrawingsChange(); }, 0);
    };

    kc.setDataLoader({
      getBars: ({type, callback}) => {
        if (type !== 'init' || !feed) { callback([], false); return; }
        Promise.resolve(feed.history(null, null, tf)).then(rows => {
          rows = rows || [];
          ch._step = rows.length > 1 ? rows[1].t - rows[0].t : 0;
          lastTs = rows.length ? rows[rows.length - 1].t : null;
          callback(rows.map(toK), false);
          ch._n = rows.length; fitArea();
          setTimeout(() => { for (const id of lines.keys()) paint(id); for (const id of bundles.keys()) paintBundle(id); if (feed && feed.loaded) feed.loaded(); fitLegend(); }, 0);
        }).catch(() => callback([], false));
      },
      subscribeBar: ({callback}) => { if (feed && feed.subscribe) ch._unsub = feed.subscribe(b => { lastTs = Math.max(lastTs || 0, b.t); callback(toK(b)); }); },
      unsubscribeBar: () => { if (typeof ch._unsub === 'function') ch._unsub(); ch._unsub = null; }});

    ch.setMarket = (symbol, venue, pricePrecision, volumePrecision) =>
      kc.setSymbol({ticker: venue ? `${symbol} · ${venue}` : symbol, pricePrecision, volumePrecision: volumePrecision == null ? 4 : volumePrecision});
    ch.setTimeframe = t => { tf = t; const per = period(t), old = kc.getPeriod(); if (per && (!old || old.span !== per.span || old.type !== per.type)) kc.setPeriod(per); };
    ch.setFeed = f => { feed = f; };
    /* the space right of the newest candle, in px (a phone: a small gap, not the library's 80px, ~35% of a 390px chart) */
    ch.rightGap = px => { try { kc.setOffsetRightDistance(px); } catch (e) {} };
    ch.reload = () => { lastTs = null; kc.resetData(); };
    ch.empty = () => { lastTs = null; feed = null; kc.resetData(); };
    ch.setTheme = t => { ch._tokens = t || {}; kc.setStyles(styles(ch._tokens)); areaStyle(); for (const id of lines.keys()) paint(id); for (const id of bundles.keys()) paintBundle(id); };
    /* opts.area: a price line with a soft fill instead of candles (a coin's price page), in opts.area's colour
       token ('up' / 'dn' / 'acc'); ch.setArea(token) recolours it (the line turns red on a falling day) */
    let area = o.area || null;
    function areaStyle() {
      if (!area) return;
      const c = ch._tokens[area] || ch._tokens.acc || '#7880ff', a = x => /^#[0-9a-f]{6}$/i.test(c) ? c + x : c;
      kc.setStyles({candle: {type: 'area', area: {lineSize: 1.6, lineColor: c, smooth: false, value: 'close',
        backgroundColor: [{offset: 0, color: a('00')}, {offset: 1, color: a('33')}]}, priceMark: {high: {show: false}, low: {show: false}},
        tooltip: {showRule: 'none'}}, ...(root.RvHover ? {crosshair: {show: false}} : {})});
      ch._areaCol = c;
    }
    ch.setArea = tok => { area = tok; areaStyle(); };
    /* the price line's hover readout (/app/chart-hover.js, area mode only, never the Terminal's candles): its dashed
       line, dot and label replace the library's crosshair; the line always shows its whole range, so no drag-scroll or
       zoom, and a vertical swipe on a phone scrolls the page (a sideways drag scrubs) */
    if (area && root.RvHover) {
      try { kc.setScrollEnabled(false); kc.setZoomEnabled(false); } catch (e) {}
      const inner = el.firstElementChild; if (inner) inner.style.touchAction = 'pan-y';
      // the library takes every touch drag for itself (it cancels the page's scroll): its touches stop here
      for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) el.addEventListener(n, e => e.stopPropagation(), {capture: true, passive: true});
      root.RvHover.attach(el, {
        pts: () => (kc.getDataList() || []).map(k => [k.timestamp, k.close]),
        xy: i => { const k = (kc.getDataList() || [])[i]; return k ? kc.convertToPixel({dataIndex: i, value: k.close}, {paneId: 'candle_pane', absolute: true}) : {}; },
        box: () => { const b = kc.getSize('candle_pane', 'main'); return b && b.width ? {l: b.left || 0, t: b.top || 0, w: b.width, h: b.height} : null; },
        fmt: v => ch._fmt(v) + (o.hoverUnit ? ' ' + o.hoverUnit : ''), get color() { return ch._areaCol; }, label: o.hoverLabel || ''});
    }
    // the price line shows its whole range across the width (the price axis takes ~72px)
    function fitArea() { if (area && ch._n > 1 && kc.setBarSpace) try { kc.setOffsetRightDistance(8); kc.setBarSpace(Math.max(1, (el.clientWidth - 92) / ch._n)); kc.scrollToRealTime(); } catch (e) {} }
    ch.resize = () => { kc.resize(); fitArea(); };
    areaStyle();
    /* opts.plain: a preview's candles (the guided bot setup, radar/web/bot-flow.js): no market name or O / H / L / C over
       the candles until the pointer is on them, no high / low marks; drag, zoom and the crosshair as on the Terminal */
    const plainStyle = () => { if (o.plain) kc.setStyles({candle: {tooltip: {showRule: 'follow_cross', title: {show: false}}, priceMark: {high: {show: false}, low: {show: false}}}}); };
    plainStyle();
    /* the price scale's figures give way to the last-price tag (a figure under it read as a second, cut price): a tick
       whose figure would touch the tag is left out: half the tag (11px type, 3px padding: ~9px), half a figure (12px
       type: 6px) and a ~5px gap, so 20px from the last close (the scale is linear: its coordinate from two ticks) */
    try {
      kc.overrideYAxis({paneId: 'candle_pane', createTicks: ({defaultTicks}) => {
        try {
          const list = kc.getDataList() || [], last = list.length ? list[list.length - 1].close : null, t = defaultTicks || [];
          if (!(last > 0) || t.length < 2 || t[0].value === t[t.length - 1].value) return t;
          const a = t[0], z = t[t.length - 1], y = a.coord + (last - a.value) * (z.coord - a.coord) / (z.value - a.value);
          return t.filter(x => Math.abs(x.coord - y) > 20);
        } catch (e) { return defaultTicks; }
      }});
    } catch (e) {}
    if (o.plain) try { kc.setOffsetRightDistance(24); } catch (e) {}       // the newest candle near the price scale, as the preview showed it
    /* the O / H / L / C legend stays on one line under the market's name (a second line runs into the high mark): a
       narrow chart packs the four figures closer, and one too narrow even for that leaves out C (the last-price mark on
       the price scale shows it); a short chart keeps the highest candle (its high mark, a line at the top of a range)
       below the legend lines instead of under them (the scale's top gap, 20% of the height, grows to the legend's height) */
    let legendKey = '12-4-8-8', gapTop = 0.2;
    function fitLegend() {
      if (area) return;
      let w = 0, h = 0, list = [];
      try { const b = kc.getSize('candle_pane', 'main'); w = (b && b.width) || 0; h = (b && b.height) || 0; list = kc.getDataList() || []; } catch (e) { return; }
      const cv = el.querySelector('canvas'), cx = cv && cv.getContext('2d');     // the chart's own canvas: it measures with the page's tabular figures
      if (!w || !list.length || !cx) return;
      // legend lines: the name, O H L C, and each MA / EMA / BOLL legend (its name and ~100px per figure, wrapped)
      const figs = n => n === 'BOLL' ? 3 : n === 'SMA' ? 1 : ((shown.get(n) || []).length || (n === 'MA' ? 4 : 3));
      const rows = 2 + [...shown.keys()].filter(n => MAIN.includes(n)).reduce((a, n) => a + Math.ceil((90 + figs(n) * 100) / Math.max(1, w - 8)), 0);
      // the scale adds gap x the price range on top (and 0.1 below), so a gap of px pixels is px * 1.1 / (h - px)
      const px = Math.min(6 + rows * 20 + 20, h * 0.4), gap = h * 0.2 / 1.3 >= px ? 0.2 : +(px * 1.1 / (h - px)).toFixed(3);
      if (gap !== gapTop) { gapTop = gap; try { kc.overrideYAxis({paneId: 'candle_pane', gap: {top: gap}}); } catch (e) {} }
      const p = ((kc.getSymbol && kc.getSymbol()) || {}).pricePrecision, dp = p == null ? 2 : p;
      let hi = 0; for (let i = Math.max(0, list.length - 500); i < list.length; i++) hi = Math.max(hi, list[i].high || 0);
      // the four figures always (QA round 3: a phone dropped C): the gaps first, then a smaller type (12, 11, 10 px), and
      // only a chart too narrow even for that leaves out C (the last-price mark on the price scale shows it)
      const f0 = cx.font, txt = hi.toLocaleString('en-US', {minimumFractionDigits: dp, maximumFractionDigits: dp}), room = w - 8;   // the tooltip's 4px offsets on both sides
      const widths = {};
      for (const fs of [12, 11, 10]) { cx.font = `normal ${fs}px ${FAM}`; const val = cx.measureText(txt).width; widths[fs] = ['O ', 'H ', 'L ', 'C '].map(x => cx.measureText(x).width + val + 1); }
      cx.font = f0;
      const fits = (fs, n, ml, mr) => widths[fs].slice(0, n).reduce((a, x) => a + ml + x + mr, 0) <= room;
      let pick = null;
      for (const [fs, ml, mr] of [[12, 8, 8], [12, 8, 4], [12, 8, 0], [12, 4, 0], [11, 4, 0], [10, 4, 0], [10, 2, 0]]) if (fits(fs, 4, ml, mr)) { pick = [fs, 4, ml, mr]; break; }
      if (!pick) pick = [10, 3, 2, 0];
      const key = pick.join('-');
      if (key === legendKey) return;
      legendKey = key;
      const t = [{title: 'O ', value: '{open}'}, {title: 'H ', value: '{high}'}, {title: 'L ', value: '{low}'}, {title: 'C ', value: '{close}'}];
      kc.setStyles({candle: {tooltip: {legend: {size: pick[0], marginLeft: pick[2], marginRight: pick[3], template: t.slice(0, pick[1])}}}});
    }
    ch._fitLegend = fitLegend;
    const setTheme0 = ch.setTheme;
    ch.setTheme = t => { setTheme0(t); plainStyle(); legendKey = ''; fitLegend(); };      // the theme's styles bring the full legend back
    const ro = root.ResizeObserver ? new root.ResizeObserver(() => fitLegend()) : null; if (ro) ro.observe(el);
    ch.destroy = () => { charts.delete(ch); unlisten(); if (ro) ro.disconnect(); L.dispose(el); };

    /* indicators: MA / EMA / BOLL on the price, the rest (VOL, RSI, MACD) in their own pane below */
    const own = new Map(), prev = new Map(), shown = new Map();      // name -> params: the viewer's, a form's preview, drawn
    function show() {
      const want = new Map([...own, ...prev]);                 // a preview's settings win while it is on
      for (const [n, ps] of shown) if (!want.has(n) || JSON.stringify(want.get(n)) !== JSON.stringify(ps)) {
        kc.removeIndicator({paneId: MAIN.includes(n) ? 'candle_pane' : 'rv_' + n, name: n === 'VOL' ? 'rvVol' : n}); shown.delete(n); }
      for (const [n, ps] of want) {
        if (shown.has(n)) continue;
        if (MAIN.includes(n)) kc.createIndicator({name: n, calcParams: ps || undefined, paneId: 'candle_pane'}, true);
        else {
          kc.createIndicator({name: n === 'VOL' ? 'rvVol' : n, calcParams: n === 'VOL' ? [] : (ps || undefined), paneId: 'rv_' + n, ...(n === 'RSI' ? {precision: 2} : {})}, false);
          kc.setPaneOptions({id: 'rv_' + n, height: PANE_H[n] || (prev.has(n) && !own.has(n) ? 72 : 88), minHeight: 48});
          // the volume bars stop under their legend ("Vol 53.29" never sits on a bar): the pane's scale keeps ~20px on top
          if (n === 'VOL') try { kc.overrideYAxis({paneId: 'rv_VOL', gap: {top: 0.4, bottom: 0}}); } catch (e) {}
        }
        shown.set(n, ps);
      }
      fitLegend();
    }
    ch.indicators = {
      add(name, params) { own.set(name, params || null); show(); },
      remove(name) { own.delete(name); show(); },
      clear() { own.clear(); show(); },
      list: () => [...own.keys()],
      preview(list) { prev.clear(); for (const x of list || []) prev.set(x.name, x.params || null); show(); }
    };
    let range = '';
    const ranges = new Map();                 // who -> [lo, hi]: the scale reaches all of them
    ch.keepInView = (who, lo, hi) => {
      if (lo > 0 && hi > 0) ranges.set(who, [lo, hi]); else ranges.delete(who);
      const all = [...ranges.values()];
      lo = all.length ? Math.min(...all.map(r => r[0])) : 0; hi = all.length ? Math.max(...all.map(r => r[1])) : 0;
      const key = lo && hi ? `${lo}|${hi}` : '';
      if (key === range) return;
      try {
        if (range) kc.removeIndicator({paneId: 'candle_pane', name: 'rvRange'});
        if (key) kc.createIndicator({name: 'rvRange', paneId: 'candle_pane', minValue: lo, maxValue: hi}, true);
        range = key;
      } catch (e) { range = ''; }
    };
    ch.priceAt = (x, y) => {
      const r = el.getBoundingClientRect(), p = kc.convertFromPixel([{x: x - r.left, y: y - r.top}], {paneId: 'candle_pane'});
      const v = p && p[0] && p[0].value;
      return v > 0 ? v : null;
    };

    /* drawing tools: one at a time; kept per market by the page (serialize / restore) */
    const events = () => ({
      onDrawEnd: e => { const x = e.overlay; drawing = null;
        /* the Text tool: its words come from the page (askText: a string, or a promise of one from an inline field placed at
           the point drawn, {x, y} in the chart's pixels); none: the drawing goes */
        const done = t => {
          if (x.name === 'rvText') { if (!t) { setTimeout(() => { kc.removeOverlay({id: x.id}); changed(); }, 0); if (o.onToolEnd) o.onToolEnd(); return; } kc.overrideOverlay({id: x.id, extendData: t}); }
          if (lock) kc.overrideOverlay({id: x.id, lock: true});
          if (o.onToolEnd) o.onToolEnd();
          changed(); };
        if (x.name === 'rvText' && o.askText) {
          let at = null; try { const px = kc.convertToPixel((x.points || []).slice(0, 1), {paneId: 'candle_pane'}); at = px && px[0] && isFinite(px[0].x) ? {x: px[0].x, y: px[0].y} : null; } catch (err) { at = null; }
          const t = o.askText(at);
          if (t && typeof t.then === 'function') { t.then(done, () => done(null)); return; }
          return done(t);
        }
        done(null); },
      onPressedMoveStart: () => { pressing = true; },
      onPressedMoveEnd: () => { pressing = false; changed(); },
      onSelected: e => { selected = e.overlay.id; },
      onDeselected: () => { selected = null; },
      onRightClick: e => { kc.removeOverlay({id: e.overlay.id}); selected = null; changed(); if (e.preventDefault) e.preventDefault(); },
      onRemoved: () => changed()});
    const mode = () => modeOf(magnet, held);
    /* Shift on a trend line or ray: the moving end goes to horizontal, vertical or 45 degrees from the other end */
    const PANE = {paneId: 'candle_pane'};
    function square(points, i) {
      const a = points[1 - i], b = points[i];
      if (!shift || !a || !b || a.value == null || b.value == null || a.dataIndex == null || b.dataIndex == null) return;
      const px = kc.convertToPixel([{dataIndex: a.dataIndex, value: a.value}, {dataIndex: b.dataIndex, value: b.value}], PANE);
      if (!px || !px[1] || px[0].y == null || px[1].y == null) return;
      const c = constrain(px[0], px[1]);
      if (c.dir === 'h') b.value = a.value;
      else if (c.dir === 'v') { b.dataIndex = a.dataIndex; b.timestamp = a.timestamp; }
      else { const p = kc.convertFromPixel([{x: px[1].x, y: c.y}], PANE); if (p && p[0] && p[0].value != null) b.value = p[0].value; }
    }
    const shiftable = tool => SHIFTED.has(tool) ? {
      performEventMoveForDrawing: e => { if (e.performPointIndex === 1) square(e.points, 1); },
      performEventPressedMove: e => { if (e.performPointIndex === 0 || e.performPointIndex === 1) square(e.points, e.performPointIndex); }} : {};
    const setMode = () => { try { kc.overrideOverlay({groupId: 'draw', mode: mode()}); if (drawing) kc.overrideOverlay({id: drawing, mode: mode()}); } catch (e) {} };

    /* the magnet crosshair: on the candles, with the magnet on (or Ctrl held), the crosshair and its price label sit on
       the bar's close; while a point is being placed or dragged, on the price that point will snap to */
    const store = kc.getChartStore ? kc.getChartStore() : null;
    let rawCross = null;
    const snapCross = t => {
      if (!t || t.paneId !== 'candle_pane' || t.x == null || t.y == null || area || (magnet === 'off' && !held)) return t;
      try {
        const idx = store.coordinateToDataIndex(t.x), bar = store.getDataByDataIndex(idx);
        if (!bar) return t;
        const at = kc.convertFromPixel([{x: t.x, y: t.y}, {x: t.x, y: t.y + 8}], PANE), v = at && at[0] && at[0].value;
        if (v == null) return t;
        const per = at[1].value - v;                        // price per 8 px (a linear scale)
        if (!per) return t;
        const target = drawing || pressing ? snapValue(v, bar, mode(), Math.abs(per)) : bar.close;
        return {...t, y: t.y + (target - v) * 8 / per};     // not rounded to a pixel: the price label reads the exact price
      } catch (e) { return t; }
    };
    if (store && typeof store.setCrosshair === 'function') {
      const orig = store.setCrosshair.bind(store);
      store.setCrosshair = (t, opts) => { if (t && t.paneId) rawCross = {x: t.x, y: t.y, paneId: t.paneId}; else if (!t) rawCross = null; return orig(snapCross(t), opts); };
    }
    const recross = () => { if (store && rawCross) try { store.setCrosshair({...rawCross}, {forceInvalidate: true}); } catch (e) {} };

    /* Ctrl (Cmd on a Mac) held: a strong magnet until it is let go; Shift held: square lines. Read from the keys and
       from every mouse event over the chart (a key pressed while the page had no focus still counts) */
    const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    const hold = h => { h = !!h; if (h === held) return; held = h; setMode(); recross(); if (o.onMagnetHeld) o.onMagnetHeld(held); };
    const onMouse = e => { shift = e.shiftKey; hold(MAC ? e.metaKey : e.ctrlKey); cursor = e.type === 'mouseleave' ? null : {x: e.clientX, y: e.clientY}; };
    const onKeys = e => {
      if (e.key === 'Shift') shift = e.type === 'keydown';
      if (e.key === (MAC ? 'Meta' : 'Control')) hold(e.type === 'keydown');
    };
    const onBlur = () => { shift = false; hold(false); };
    const win = typeof window !== 'undefined' ? window : null;
    for (const t of ['mousemove', 'mousedown', 'mouseup', 'mouseleave']) el.addEventListener(t, onMouse, true);
    if (win) { win.addEventListener('keydown', onKeys, true); win.addEventListener('keyup', onKeys, true); win.addEventListener('blur', onBlur); }
    function unlisten() {
      for (const t of ['mousemove', 'mousedown', 'mouseup', 'mouseleave']) el.removeEventListener(t, onMouse, true);
      if (win) { win.removeEventListener('keydown', onKeys, true); win.removeEventListener('keyup', onKeys, true); win.removeEventListener('blur', onBlur); }
    }
    function put(list) {
      for (const d of Array.isArray(list) ? list : []) {
        // this adapter's format ({tool, points: [{t, price}], text}); drawings saved before it ({name, points: [{timestamp, value}]}) too
        const tool = d && (d.tool || FROM_LIB[d.name]);
        if (!tool || !TOOL[tool] || !Array.isArray(d.points)) continue;
        const points = d.points.map(p => ({timestamp: p.t ?? p.timestamp, value: p.price ?? p.value}));
        kc.createOverlay({name: TOOL[tool], groupId: 'draw', points, extendData: d.text ?? d.extendData ?? null, lock, mode: mode(), ...events(), ...shiftable(tool)});
      }
    }
    ch.tools = {
      select(tool) {
        ch.tools.cancel();
        if (!TOOL[tool]) return false;
        drawing = kc.createOverlay({name: TOOL[tool], groupId: 'draw', mode: mode(), ...events(), ...shiftable(tool)});
        return true;
      },
      cancel() { if (drawing) { const d = drawing; drawing = null; restoring = true; kc.removeOverlay({id: d}); restoring = false; } },
      active: () => !!drawing,
      clear() { kc.removeOverlay({groupId: 'draw'}); selected = null; changed(); },
      selected: () => selected,
      removeSelected() { if (!selected) return false; kc.removeOverlay({id: selected}); selected = null; changed(); return true; },
      count: () => kc.getOverlays({groupId: 'draw'}).filter(x => x.id !== drawing).length,
      setMagnet(m) { magnet = magnetOf(m); setMode(); recross(); },
      magnet: () => magnet,
      held: () => held,
      undo() {
        const prev = hist.undo();
        if (prev == null) return false;
        ch.tools.cancel();
        restoring = true; kc.removeOverlay({groupId: 'draw'}); put(JSON.parse(prev)); restoring = false;
        selected = null;
        if (o.onDrawingsChange) setTimeout(o.onDrawingsChange, 0);
        return true;
      },
      canUndo: () => hist.size() > 0,
      hlineAtCursor() {
        if (!cursor || lastTs == null || area) return false;
        const r = el.getBoundingClientRect(), cr = store && store.getCrosshair ? store.getCrosshair() : null;
        const y = cr && cr.paneId === 'candle_pane' && cr.y != null ? cr.y : cursor.y - r.top;
        const p = kc.convertFromPixel([{x: cursor.x - r.left, y}], PANE), v = p && p[0] && p[0].value;
        if (!(v > 0)) return false;
        kc.createOverlay({name: TOOL.hline, groupId: 'draw', points: [{timestamp: lastTs, value: v}], lock, mode: mode(), ...events()});
        changed();
        return true;
      },
      setLock(on) { lock = !!on; kc.overrideOverlay({groupId: 'draw', lock}); },
      serialize: () => kc.getOverlays({groupId: 'draw'}).filter(x => x.currentStep === -1 && x.points && x.points.length && FROM_LIB[x.name])
        .map(x => ({tool: FROM_LIB[x.name], points: x.points.map(p => ({t: p.timestamp, price: p.value})), text: x.extendData ?? null})),
      restore(list) {
        restoring = true;
        kc.removeOverlay({groupId: 'draw'});
        put(list);
        restoring = false;
        hist.reset(JSON.stringify(ch.tools.serialize()));         // undo goes back no further than what was loaded
      }
    };

    /* horizontal lines: order lines, TP / SL, entry, liquidation, alerts, plan levels. A draggable one calls onMove(price)
       when dropped somewhere new; the page re-upserts it (or not) and the line follows. */
    function paint(id) {
      const l = lines.get(id); if (!l) return;
      const s = l.spec, oid = 'rvl_' + id, pts = lastTs == null ? null : [{timestamp: lastTs, value: s.price}];
      if (!pts) return;
      if (dragging === oid) return;
      const drag = !!s.draggable, name = !drag ? 'rvLevel' : s.style === 'handle' ? 'rvHandle' : 'rvDrag', ext = {color: s.color, tone: s.tone || null, title: s.label || '', onY: s.onY || null};
      if (l.painted && l.name === name) { kc.overrideOverlay({id: oid, points: pts, extendData: ext, lock: !drag}); return; }
      if (l.painted) kc.removeOverlay({id: oid});
      kc.createOverlay({id: oid, name, groupId: 'lines', lock: !drag, points: pts, extendData: ext,
        onPressedMoveStart: () => { dragging = oid; },
        onPressedMoving: e => { const cur = lines.get(id), v = e.overlay.points[0] && e.overlay.points[0].value; if (cur && cur.spec.onMoving && v > 0) cur.spec.onMoving(v); },
        onPressedMoveEnd: e => {
          dragging = null;
          const cur = lines.get(id), v = e.overlay.points[0] && e.overlay.points[0].value;
          if (cur && cur.spec.onMove && v > 0 && Math.abs(v / cur.spec.price - 1) > 1e-6) cur.spec.onMove(v);
          else paint(id);
        }});
      l.painted = true; l.name = name;
    }
    const LABEL_H = 20;                       // a label's height with its padding: closer lines stack their labels
    ch._labelY = (oid, y, yAxis) => {
      if (!yAxis || dragging === oid) return y;
      const ys = [];
      for (const [id, l] of lines) if (l.painted && l.spec.label && l.spec.style !== 'handle' && 'rvl_' + id !== dragging) {
        const v = yAxis.convertToPixel(l.spec.price); if (isFinite(v)) ys.push({oid: 'rvl_' + id, y: v});
      }
      ys.sort((a, b) => a.y - b.y || (a.oid < b.oid ? -1 : 1));
      for (let i = 1; i < ys.length; i++) if (ys[i].y < ys[i - 1].y + LABEL_H) ys[i].y = ys[i - 1].y + LABEL_H;
      const hit = ys.find(r => r.oid === oid);
      return hit ? hit.y : y;
    };
    ch._handleYs = yAxis => { const ys = [];
      for (const [, l] of lines) if (l.painted && l.spec.label && l.spec.style === 'handle') { const v = yAxis.convertToPixel(l.spec.price); if (isFinite(v)) ys.push(v); }
      return ys; };
    const bundles = new Map();                // id -> spec
    function paintBundle(id) {
      const s = bundles.get(id), oid = 'rvb_' + id;
      kc.removeOverlay({id: oid});
      if (!s || lastTs == null) return;
      const first = (s.band || [])[0] || ((s.lines || [])[0] || {}).price;
      if (!first) return;
      kc.createOverlay({id: oid, name: 'rvBundle', groupId: 'bundles', lock: true, points: [{timestamp: lastTs, value: first}],
        extendData: {lines: s.lines || [], band: s.band || null, bandColor: s.bandColor}});
    }
    ch.lines = {
      upsert(id, spec) { const l = lines.get(id) || {}; l.spec = {...spec}; lines.set(id, l); paint(id); },
      remove(id) { const l = lines.get(id); if (!l) return; if (l.painted) kc.removeOverlay({id: 'rvl_' + id}); lines.delete(id); },
      removeKind(kind) { for (const [id, l] of [...lines]) if (!kind || l.spec.kind === kind) ch.lines.remove(id); },
      ids: kind => [...lines].filter(([, l]) => !kind || l.spec.kind === kind).map(([id]) => id),
      get: id => (lines.get(id) || {}).spec || null,
      bundle(id, spec) { if (spec) bundles.set(id, spec); else bundles.delete(id); paintBundle(id); }
    };
    ch.raw = kc;                              // the library's chart, for a page's own tuning (its range, its axis)
    charts.add(ch);
    return ch;
  }

  root.RvChart = {init, available: () => !!K(), TOOLS: Object.keys(TOOL), period, _pure: {snapValue, constrain, history, magnetOf, modeOf}};
})(typeof window !== 'undefined' ? window : globalThis);

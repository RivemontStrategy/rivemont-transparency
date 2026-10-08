/* Rivemont wallet: the ONE way the app talks to an EVM wallet. Every signature (Hyperliquid approvals, Lighter, Orderly,
   Paradex, dYdX, Nado, Aster, GRVT, sign-in), every transaction (deposits) and every network switch goes through here.

   Wallets it finds and connects:
   - injected wallets, found with EIP-6963 (Rabby, MetaMask, Coinbase, OKX... each announces itself), else window.ethereum
     (a wallet app's own browser, older extensions);
   - WalletConnect v2 from any browser (a QR code on a computer, the wallet app opened by a link on a phone), when the
     server has a WalletConnect project id (WALLETCONNECT_PROJECT_ID, sent in /api/auto/info). Without one it is hidden
     and a phone browser with no wallet gets links that open Rivemont inside the wallet app's browser instead.
   A "Connect wallet" picker lists injected wallets first; the choice is remembered in this browser (rv_wallet). With one
   way only (a wallet app's own browser, one extension and no WalletConnect) there is no picker: exactly as before.
   Errors come back in plain words, and a cancel is always code 4001 (whatever the wallet or WalletConnect called it).

   create() holds the logic and takes its window, storage, WalletConnect loader and picker as options, so
   tests/js/wallet.test.mjs drives it with mock EIP-1193 providers; domUI() is the picker on the page. */
(function (root) {
  const _t = (root && root._t) || ((k, v) => v ? String(k).replace(/\{(\w+)\}/g, (m, x) => x in v && v[x] != null ? v[x] : m) : k);
  // served by Rivemont itself, pinned (audit sec-06): no code from a CDN runs next to the login key in this origin.
  // The WalletConnect library is one self-contained bundle of the npm release (its build line opens the file).
  const WC_VERSION = '2.25.0';
  const WC_URL = `/app/vendor/walletconnect-ethereum-provider-${WC_VERSION}.min.js`;
  const QR_URL = '/app/vendor/qrcode-generator-1.4.4.js';
  // every network a Rivemont flow may ask the wallet for: Arbitrum (Hyperliquid, Lighter, Orderly, dYdX deposits),
  // Ethereum (dYdX, Paradex sign-in), BNB Chain (Aster), Ink (Nado), GRVT, and their testnets
  const CHAINS = [42161, 1, 56, 57073, 325, 421614, 11155111, 97, 763373, 326];
  const RPC = {42161: 'https://arb1.arbitrum.io/rpc', 421614: 'https://sepolia-rollup.arbitrum.io/rpc', 1: 'https://ethereum-rpc.publicnode.com',
    11155111: 'https://ethereum-sepolia-rpc.publicnode.com', 56: 'https://bsc-dataseed.binance.org', 97: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    57073: 'https://rpc-gel.inkonchain.com', 763373: 'https://rpc-gel-sepolia.inkonchain.com'};
  const enc = encodeURIComponent;
  const bare = h => String(h).replace(/^https?:\/\//, '');
  // phone wallets: wc = open the app with a WalletConnect link; open = open this page inside the app's own browser;
  // app = open the app (to approve a request); get = where to install it. Links as the wallets document them.
  const APPS = [
    {id: 'rabby', name: 'Rabby', rdns: 'io.rabby', color: '#7084FF', wc: u => 'rabby://wc?uri=' + enc(u),   // WalletConnect registry: native rabby:// (a bare wc: link opened nothing on Android)
     open: null, app: 'rabby://', get: 'https://rabby.io'},
    {id: 'metamask', name: 'MetaMask', rdns: 'io.metamask', color: '#F6851B', wc: u => 'https://metamask.app.link/wc?uri=' + enc(u),
     open: h => 'https://metamask.app.link/dapp/' + bare(h), app: 'https://metamask.app.link/', get: 'https://metamask.io/download'},
    {id: 'trust', name: 'Trust Wallet', rdns: 'com.trustwallet.app', color: '#0500FF', wc: u => 'trust://wc?uri=' + enc(u),
     open: h => 'https://link.trustwallet.com/open_url?coin_id=60&url=' + enc(h), app: 'trust://', get: 'https://trustwallet.com/download'},
    {id: 'okx', name: 'OKX Wallet', rdns: 'com.okex.wallet', color: '#111111', wc: (u, android) => android ? u : 'okex://main/wc?uri=' + enc(u),
     open: h => 'okx://wallet/dapp/url?dappUrl=' + enc(h), app: 'okex://main', get: 'https://www.okx.com/download'},
    {id: 'coinbase', name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet', color: '#0052FF', wc: u => u,
     open: h => 'https://go.cb-w.com/dapp?cb_url=' + enc(h), app: 'cbwallet://', get: 'https://www.coinbase.com/wallet/downloads'}];
  const ORDER = ['io.rabby', 'io.metamask', 'com.coinbase.wallet', 'com.okex.wallet', 'com.trustwallet.app'];

  const mkErr = (code, message, cause) => { const e = new Error(message); e.code = code; if (cause) e.cause = cause; return e; };
  const msgOf = e => String((e && (e.message || (e.data && e.data.message) || e.reason)) || e || '');
  function isCancel(e) {
    if (!e) return false;
    if (e.code === 4001 || e.code === 5000 || e.code === 'ACTION_REJECTED') return true;      // EIP-1193, WalletConnect, ethers
    return /user (rejected|denied|cancel+ed|disapproved)|rejected by (the )?user|request (was )?rejected|user cancel/i.test(msgOf(e));
  }
  // an error from any wallet -> one the app can show as it is (and still test e.code === 4001 for a cancel)
  function explain(e) {
    if (isCancel(e)) return e && e.code === 4001 && e.message ? e : mkErr(4001, _t('You cancelled in your wallet.'), e);
    const m = msgOf(e), c = e && e.code;
    if (c === -32002 || /already pending|request.*pending/i.test(m))
      return mkErr(-32002, _t('Your wallet already has a request waiting. Open your wallet, finish or reject it, then try again.'), e);
    if (c === 4100) return mkErr(4100, _t('Your wallet has not allowed this site yet. Unlock your wallet, connect again, then try again.'), e);
    if (c === 4900 || c === 4901) return mkErr(c, _t('Your wallet is not connected to this network. Check the network in your wallet, then try again.'), e);
    if (/no matching key|session.*(not found|expired|deleted|disconnected)|missing or invalid.*topic|pairing.*expired/i.test(m))
      return mkErr('RV_SESSION', _t('The link to your phone wallet has ended. Connect your wallet again.'), e);
    if (/timed? ?out|request expired/i.test(m)) return mkErr('RV_TIMEOUT', _t('Your wallet did not answer in time. Open your wallet app and try again.'), e);
    if (e instanceof Error) return e;
    return mkErr(c || -32603, m || _t('Your wallet could not do this. Try again.'), e);
  }
  function guessName(p) {
    if (!p) return _t('Browser wallet');
    return p.isRabby ? 'Rabby' : p.isOkxWallet || p.isOKExWallet ? 'OKX Wallet' : p.isCoinbaseWallet ? 'Coinbase Wallet' : p.isTrust || p.isTrustWallet ? 'Trust Wallet'
      : p.isMetaMask ? 'MetaMask' : _t('Browser wallet');
  }
  function storageOf(win) {
    return {get: k => { try { return win.localStorage.getItem(k); } catch (e) { return null; } },
            set: (k, v) => { try { v == null ? win.localStorage.removeItem(k) : win.localStorage.setItem(k, v); } catch (e) {} }};
  }
  function mobileOf(win) {
    const n = win.navigator || {}, ua = n.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    try { return win.matchMedia('(pointer: coarse)').matches && !win.matchMedia('(pointer: fine)').matches; } catch (e) { return false; }
  }

  function create(o) {
    o = o || {};
    const win = o.win || root, store = o.storage || storageOf(win);
    const loadWC = o.loadWC || (() => import(WC_URL));
    const mobile = () => o.mobile != null ? !!o.mobile : mobileOf(win);
    const android = () => /Android/i.test(((win.navigator || {}).userAgent) || '');
    let ui = o.ui || null;
    const cfg = {projectId: '', name: 'Rivemont', url: '', icon: ''};
    const found = [];                 // EIP-6963 announcements: {id, name, icon, rdns, provider}
    let cur = null;                   // the wallet in use: {kind: 'injected' | 'wc', id, name, icon, provider}
    let wcInit = null, wcProv = null;
    const subs = {accountsChanged: [], chainChanged: [], disconnect: [], connect: []};
    const fire = (ev, x) => (subs[ev] || []).slice().forEach(f => { try { f(x); } catch (e) {} });
    const onAcc = a => fire('accountsChanged', a), onChain = c => fire('chainChanged', c);
    const onDisc = x => { if (cur && cur.kind === 'wc') { cur = null; if (store.get('rv_wallet') === 'wc') store.set('rv_wallet', null); } fire('disconnect', x); };

    function announce(ev) {
      const d = ev && ev.detail;
      if (!d || !d.info || !d.provider) return;
      const id = 'inj:' + (d.info.rdns || d.info.uuid || d.info.name);
      if (found.some(x => x.id === id)) return;
      found.push({id, name: d.info.name || guessName(d.provider), icon: d.info.icon || '', rdns: d.info.rdns || '', provider: d.provider});
      found.sort((a, b) => (ORDER.indexOf(a.rdns) + 1 || 99) - (ORDER.indexOf(b.rdns) + 1 || 99));
    }
    function requestAnnouncements() { try { win.dispatchEvent(new win.Event('eip6963:requestProvider')); } catch (e) {} }
    if (win.addEventListener) { win.addEventListener('eip6963:announceProvider', announce); requestAnnouncements(); }

    // injected wallets: the EIP-6963 ones, else window.ethereum (a wallet app's own browser announces itself or sets it)
    function injected() {
      requestAnnouncements();
      if (found.length) return found.slice();
      const e = win.ethereum;
      return e && typeof e.request === 'function' ? [{id: 'inj', name: guessName(e), icon: '', rdns: '', provider: e}] : [];
    }
    const wcOn = () => /^[0-9a-f]{32}$/i.test(cfg.projectId || '');

    function use(w) {
      if (cur && cur.provider && cur.provider !== w.provider && cur.provider.removeListener) {
        const p = cur.provider; try { p.removeListener('accountsChanged', onAcc); p.removeListener('chainChanged', onChain); p.removeListener('disconnect', onDisc); } catch (e) {}
      }
      if (!cur || cur.provider !== w.provider) {
        const p = w.provider;
        if (p && p.on) try { p.on('accountsChanged', onAcc); p.on('chainChanged', onChain); p.on('disconnect', onDisc); } catch (e) {}
      }
      cur = w;
    }

    // ---- WalletConnect ----
    async function wcProvider() {
      if (wcProv) return wcProv;
      if (!wcInit) {
        const origin = cfg.url || (win.location && win.location.origin) || 'https://rivemont.xyz';
        wcInit = (async () => {
          const m = await loadWC();
          const EP = m.EthereumProvider || (m.default && m.default.EthereumProvider) || m.default;
          const p = await EP.init({projectId: cfg.projectId, showQrModal: false, optionalChains: CHAINS, rpcMap: RPC,
            metadata: {name: cfg.name, description: _t('Trade, bots, copy trading and vaults on DEXs, from your own wallet.'), url: origin,
                       icons: [cfg.icon || origin + '/brand/icon-192.png']}});
          wcProv = p; return p;
        })();
        wcInit.catch(() => { wcInit = null; });
      }
      return wcInit;
    }
    const wcLive = p => !!(p && p.session && p.accounts && p.accounts.length);
    const peerName = p => (p && p.session && p.session.peer && p.session.peer.metadata && p.session.peer.metadata.name) || 'WalletConnect';
    const useWC = p => { use({kind: 'wc', id: 'wc', name: peerName(p), icon: '', provider: p}); store.set('rv_wallet', 'wc'); return p.accounts.slice(); };
    function wcPair(onUri) {                    // a new WalletConnect session: the link (QR or deep link) -> the wallet approves
      let stop = null;
      const run = (async () => {
        const p = await wcProvider();
        if (wcLive(p)) return p;
        const h = u => onUri(u);
        p.on('display_uri', h);
        try { await p.connect({optionalChains: CHAINS, rpcMap: RPC}); } finally { try { p.removeListener('display_uri', h); } catch (e) {} }
        if (!wcLive(p)) throw mkErr('RV_SESSION', _t('Your wallet did not connect. Try again.'));
        return p;
      })();
      stop = () => { try { if (wcProv && wcProv.signer && wcProv.signer.abortPairingAttempt) wcProv.signer.abortPairingAttempt(); } catch (e) {} };
      return {run, stop};
    }

    // ---- connect: the remembered wallet, the only one there is, or the picker ----
    let connecting = null;
    async function connect(opt) {
      opt = opt || {};
      if (!opt.force && cur) {
        if (cur.kind === 'wc' && wcLive(cur.provider)) return cur.provider.accounts.slice();
        if (cur.kind === 'injected') return raw(cur.provider, 'eth_requestAccounts', []);
      }
      if (connecting) return connecting;
      connecting = (async () => {
        const inj = injected(), wc = wcOn(), saved = opt.force ? null : store.get('rv_wallet');
        if (saved === 'wc' && wc) {                           // a phone wallet linked before: its session is kept by WalletConnect
          try { const p = await wcProvider(); if (wcLive(p)) return useWC(p); } catch (e) {}
        }
        const keep = saved && saved !== 'wc' ? inj.find(x => x.id === saved) || (saved === 'inj' && inj.length === 1 ? inj[0] : null) : null;
        if (keep) return useInjected(keep);
        if (!opt.force && inj.length === 1 && !wc) return useInjected(inj[0]);
        if (!opt.force && inj.length === 1 && mobile()) return useInjected(inj[0]);      // inside a wallet app's own browser
        return pick(inj, wc);
      })();
      try { return await connecting; } finally { connecting = null; }
    }
    async function useInjected(w) {
      const a = await raw(w.provider, 'eth_requestAccounts', []);
      use({kind: 'injected', id: w.id, name: w.name, icon: w.icon, provider: w.provider});
      store.set('rv_wallet', w.id);
      return a;
    }
    async function pick(inj, wc) {
      if (!ui) ui = o.ui || domUI(win);
      const mob = mobile(), href = (win.location && win.location.href) || '';
      const h = ui.open({injected: inj, wc, mobile: mob, android: android(), apps: APPS, href});
      let pairing = null, done = false;
      const startPair = () => {
        if (pairing) return pairing;
        pairing = wcPair(u => h.uri(u));
        pairing.run.catch(e => { pairing = null; if (!done && !isCancel(e)) { h.uri(''); h.error(explain(e).message); } });
        return pairing;
      };
      if (wc && mob) startPair();                  // a phone: the link must be ready before the tap that opens the wallet
      try {
        for (;;) {
          const next = h.next();
          const choice = await (pairing ? Promise.race([next, pairing.run.then(() => 'wc:linked', () => new Promise(() => {}))]) : next);
          if (choice == null) { if (pairing) pairing.stop(); throw mkErr(4001, _t('No wallet connected.')); }
          if (choice === 'wc:linked') { const p = await pairing.run; return useWC(p); }
          if (choice === 'wc' && mob) { h.error(''); startPair(); continue; }      // a phone: new links in the list
          if (choice === 'wc') {
            h.view('qr'); const pr = startPair();
            const r = await Promise.race([pr.run.then(p => ({p}), e => ({e})), h.next().then(c => ({c}))]);
            if (r.p) return useWC(r.p);
            if (r.e) { h.view('list'); h.error(explain(r.e).message); continue; }
            if (r.c == null) { pr.stop(); throw mkErr(4001, _t('No wallet connected.')); }
            if (r.c === 'back') { h.view('list'); continue; }
            continue;
          }
          if (choice.startsWith('app:')) { store.set('rv_wallet_app', choice.slice(4)); continue; }   // the tap opened that app
          const w = inj.find(x => x.id === choice);
          if (w) { h.busy(w.name); try { return await useInjected(w); } catch (e) { const x = explain(e); if (x.code === 4001) { h.view('list'); h.error(_t('You cancelled in {name}.', {name: w.name})); continue; } throw x; } }
        }
      } finally { done = true; h.close(); }
    }

    // ---- requests ----
    async function raw(p, method, params) {
      try { return await p.request({method, params: params || []}); } catch (e) { throw explain(e); }
    }
    const SIGN = ['personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData', 'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'];
    async function request(method, params) {
      if (method === 'eth_requestAccounts') return connect();
      if (!cur) await connect();
      const p = cur.provider;
      if (cur.kind !== 'wc' || !SIGN.includes(method) || method === 'wallet_switchEthereumChain') return raw(p, method, params);
      // WalletConnect: the request waits in the phone wallet; say so, with a way to open the app on a phone
      if (!ui) ui = o.ui || domUI(win);
      const app = APPS.find(a => a.id === store.get('rv_wallet_app')) || null;
      const h = ui.wait({name: cur.name, mobile: mobile(), link: app && app.app, method});
      try { return await Promise.race([raw(p, method, params), h.closed.then(() => { throw mkErr(4001, _t('You closed the request. Check your wallet app: nothing is sent until you approve there.')); })]); }
      catch (e) { if (e && e.code === 'RV_SESSION') await disconnect(); throw e; }
      finally { h.close(); }
    }
    const personalSign = (message, account) => request('personal_sign', [message, account]);
    const signTypedData = (account, data) => request('eth_signTypedData_v4', [account, typeof data === 'string' ? data : JSON.stringify(data)]);
    const sendTransaction = tx => request('eth_sendTransaction', [tx]);
    const chainId = () => request('eth_chainId', []);
    // switch network; 4902 (unknown network) adds it when `add` is given. strict: any other failure -> "Switch your wallet
    // to <name>" (a transaction must not go out on the wrong network); else only a cancel stops the flow (a signature's
    // domain names its chain; wallets that can't switch still sign).
    async function switchChain(hex, add, opt) {
      opt = opt || {};
      try { await request('wallet_switchEthereumChain', [{chainId: hex}]); }
      catch (e) {
        const unknown = e && (e.code === 4902 || (e.cause && e.cause.code === 4902) || /unrecognized chain|unknown chain|chain.*not (been )?added/i.test(msgOf(e)));
        if (unknown && add) return void await request('wallet_addEthereumChain', [add]);
        if (opt.strict) throw mkErr('RV_CHAIN', opt.name ? _t('Switch your wallet to the {v} network, then try again.', {v: opt.name}) : _t('Switch your wallet to the right network, then try again.'), e);
        if (e && e.code === 4001) throw e;
      }
    }
    async function disconnect() {
      const was = cur; cur = null; store.set('rv_wallet', null);
      if (was && was.kind === 'wc' && was.provider && was.provider.disconnect) { try { await was.provider.disconnect(); } catch (e) {} }
    }
    function on(ev, fn) { (subs[ev] = subs[ev] || []).push(fn); return () => { subs[ev] = subs[ev].filter(f => f !== fn); }; }
    async function account() {                  // the account in use now, without asking the wallet (null if none)
      if (!cur) return null;
      try { const a = cur.kind === 'wc' ? cur.provider.accounts : await cur.provider.request({method: 'eth_accounts', params: []}); return (a && a[0]) || null; } catch (e) { return null; }
    }
    // after a reload: pick the remembered wallet back up quietly (no picker, no wallet pop-up)
    async function restore() {
      const saved = store.get('rv_wallet');
      if (!saved) return null;
      if (saved === 'wc') { if (!wcOn()) return null; try { const p = await wcProvider(); if (wcLive(p)) { useWC(p); return current(); } } catch (e) {} return null; }
      const w = injected().find(x => x.id === saved) || (saved === 'inj' ? injected()[0] : null);
      if (!w) return null;
      try { const a = await w.provider.request({method: 'eth_accounts', params: []}); if (a && a.length) { use({kind: 'injected', id: w.id, name: w.name, icon: w.icon, provider: w.provider}); return current(); } } catch (e) {}
      return null;
    }
    const current = () => cur && {kind: cur.kind, id: cur.id, name: cur.name, icon: cur.icon};
    function configure(c) { Object.assign(cfg, c || {}); return api; }
    const options = () => ({injected: injected().map(x => ({id: x.id, name: x.name})), walletconnect: wcOn(), mobile: mobile()});
    const api = {configure, connect, request, personalSign, signTypedData, sendTransaction, chainId, switchChain, disconnect, on, account,
                 restore, current, options, isCancel, explain};
    return api;
  }

  /* ---------------- the picker on the page ---------------- */
  const CSS = `
.rvw { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: var(--rv-scrim, rgba(0,0,0,.6)); padding: 16px; animation: rvwIn .15s ease-out; }
@keyframes rvwIn { from { opacity: 0; } }
.rvw-box { background: var(--rv-panel, #181a20); color: var(--rv-text, #eaecef); border: 1px solid var(--rv-card-line, transparent); border-radius: var(--rv-r-lg, 12px); width: min(424px, 100%);
  max-height: calc(100vh - 32px); overflow-y: auto; padding: 32px; box-shadow: var(--rv-pop, 0 8px 32px rgba(0,0,0,.5)); font: var(--rv-fs-body)/1.5 var(--rv-font); }
.rvw-hd { display: flex; align-items: center; gap: 8px; min-height: 32px; }
.rvw-hd h3 { margin: 0; font-size: var(--rv-fs-page); line-height: 32px; font-weight: 600; flex: 1; }
.rvw-logo { display: block; width: 32px; height: 32px; margin: 0 0 24px; }
.rvw-ib { width: 32px; height: 32px; border-radius: var(--rv-r-sm); border: 0; background: transparent; color: var(--rv-muted, #999); display: grid; place-items: center; cursor: pointer; padding: 0; flex: none; }
.rvw-ib:hover { background: var(--rv-btn2, #2b3139); color: var(--rv-text, #eaecef); } .rvw-ib svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; }
.rvw-hd .rvw-ib.bk { margin-left: -8px; }
.rvw-lead { margin: 4px 0 0; font-size: var(--rv-fs-body); color: var(--rv-muted, #999); line-height: 1.5; }
.rvw-sec { margin: 24px 0 8px; font-size: var(--rv-fs-xs); color: var(--rv-dim, #929aa5); }
.rvw-list { display: grid; gap: 8px; }
.rvw-w { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 12px; width: 100%; padding: 8px 16px; min-height: 56px; border-radius: var(--rv-r-sm, 8px);
  border: 1px solid var(--rv-line2, #2b3139); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; text-decoration: none; box-sizing: border-box; }
.rvw-w:hover { border-color: var(--rv-faint, #474d57); background: var(--rv-panel2, #1e2329); }
.rvw-w[aria-disabled=true] { opacity: .55; pointer-events: none; }
.rvw-ic { width: 28px; height: 28px; border-radius: var(--rv-r-sm); display: grid; place-items: center; overflow: hidden; font-weight: 500; font-size: var(--rv-fs-lg); color: #fff; }
.rvw-ic img { width: 100%; height: 100%; object-fit: cover; display: block; } .rvw-ic svg { width: 18px; height: 18px; }
.rvw-t { display: grid; min-width: 0; } .rvw-t b { font-weight: 500; font-size: var(--rv-fs-body); } .rvw-t small { color: var(--rv-muted, #999); font-size: var(--rv-fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rvw-tag { font-size: var(--rv-fs-xs); padding: 2px 8px; border-radius: var(--rv-r-sm); background: var(--rv-pos-soft, rgba(80,200,120,.12)); color: var(--rv-pos, #5c9); white-space: nowrap; }
.rvw-tag.mut { background: var(--rv-sunk, #111); color: var(--rv-muted, #999); }
.rvw-qr { margin-top: 16px; display: grid; place-items: center; }
.rvw-qr .q { width: 232px; height: 232px; padding: 12px; box-sizing: border-box; border-radius: var(--rv-r-lg); background: #fff; display: grid; place-items: center; }
.rvw-qr .q svg { width: 208px; height: 208px; display: block; } .rvw-qr .q .sp { width: 24px; height: 24px; border: 2px solid #bbb; border-top-color: transparent; border-radius: 999px; animation: rvwSp 1s linear infinite; }
@keyframes rvwSp { to { transform: rotate(360deg); } }
.rvw-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.rvw-b { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 8px 12px; border-radius: var(--rv-r-sm, 8px); border: 0; background: var(--rv-btn2, #2b3139);
  color: var(--rv-text, #eee); font: inherit; font-size: var(--rv-fs-body); cursor: pointer; text-decoration: none; box-sizing: border-box; }
.rvw-b:hover { background: var(--rv-btn2-hover, #363c45); } .rvw-b.pri { background: var(--rv-primary, #eaecef); color: var(--rv-primary-ink, #0b0e11); }
.rvw-acts .rvw-b { flex: 1 1 0; min-width: 0; }
.rvw-st { margin: 12px 0 0; font-size: var(--rv-fs-xs); color: var(--rv-muted, #999); text-align: center; }
.rvw-err { margin: 12px 0 0; font-size: var(--rv-fs-xs); color: var(--rv-neg, #e77); }
.rvw-links { display: flex; flex-wrap: wrap; gap: 8px; }
.rvw-foot { margin: 16px 0 0; font-size: var(--rv-fs-xs); color: var(--rv-dim, #777); line-height: 1.5; }
@media (max-width: 520px) { .rvw { place-items: end center; padding: 0; } .rvw-box { width: 100%; max-width: 560px; border-radius: 12px 12px 0 0; padding: 24px 16px calc(24px + env(safe-area-inset-bottom)); max-height: 92vh; } .rvw-logo { margin-bottom: 16px; } }
`;
  const ICONS = {
    wc: '<svg viewBox="0 0 24 24"><path fill="#fff" d="M6.1 8.6c3.3-3.2 8.5-3.2 11.8 0l.4.4c.2.2.2.4 0 .6l-1.3 1.3c-.1.1-.2.1-.3 0l-.5-.5c-2.3-2.2-6-2.2-8.3 0l-.6.5c-.1.1-.2.1-.3 0L5.7 9.6c-.2-.2-.2-.4 0-.6l.4-.4zm14.6 2.7 1.2 1.2c.2.2.2.4 0 .6l-5.3 5.2c-.2.2-.4.2-.6 0l-3.8-3.7h-.1l-3.8 3.7c-.2.2-.4.2-.6 0L2.1 13.1c-.2-.2-.2-.4 0-.6l1.2-1.2c.2-.2.4-.2.6 0l3.8 3.7h.1l3.8-3.7c.2-.2.4-.2.6 0l3.8 3.7h.1l3.8-3.7c.3-.2.5-.2.8 0z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>', back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    go: '<svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:var(--rv-dim,#777);fill:none;stroke-width:2"><path d="M9 5l7 7-7 7"/></svg>',
    phone: '<svg viewBox="0 0 24 24" style="stroke:#fff;fill:none;stroke-width:2"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/></svg>'};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const safeIcon = s => /^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(s || '') || /^https:\/\//i.test(s || '') ? s : '';
  const tile = (w, color) => safeIcon(w.icon) ? `<span class="rvw-ic"><img alt="" src="${esc(w.icon)}"></span>`
    : `<span class="rvw-ic" style="background:${color || '#3a3a40'}">${esc((w.name || '?').trim()[0].toUpperCase())}</span>`;

  function domUI(win) {
    const doc = win.document;
    let qrLib = null;
    const loadQR = () => qrLib || (qrLib = new Promise((ok, no) => {
      if (win.qrcode) return ok(win.qrcode);
      const s = doc.createElement('script'); s.src = QR_URL; s.async = true;
      s.onload = () => win.qrcode ? ok(win.qrcode) : no(new Error(_t('QR code unavailable')));
      s.onerror = () => { qrLib = null; no(new Error(_t('QR code unavailable'))); };
      doc.head.appendChild(s);
    }));
    function css() { if (!doc.getElementById('rvw-css')) { const s = doc.createElement('style'); s.id = 'rvw-css'; s.textContent = CSS; doc.head.appendChild(s); } }
    function shell(label) {
      css();
      doc.querySelectorAll('.rvw').forEach(e => e.remove());
      const el = doc.createElement('div'); el.className = 'rvw'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', label);
      el.innerHTML = '<div class="rvw-box" id="rvw-box"></div>';
      doc.body.appendChild(el);
      return el;
    }
    const hd = (title, back) => `<div class="rvw-hd">${back ? `<button class="rvw-ib bk" data-a="back" aria-label="${_t('Back')}">${ICONS.back}</button>` : ''}<h3>${esc(title)}</h3><button class="rvw-ib" data-a="close" aria-label="${_t('Close')}">${ICONS.x}</button></div>`;

    // the picker: open() -> {next(): Promise<choice>, view(name), uri(u), error(t), busy(name), close()}
    function open(s) {
      const el = shell(_t('Connect wallet')), box = el.querySelector('.rvw-box');
      let view = 'list', uri = '', err = '', busy = '', waiters = [];
      const push = c => { const w = waiters; waiters = []; w.forEach(f => f(c)); if (!w.length) queued.push(c); };
      const queued = [];
      const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(ok => waiters.push(ok));
      const href = s.href;
      function listView() {
        const inj = s.injected, mob = s.mobile;
        let h = '<img class="rvw-logo" src="/brand/mark.svg" alt="Rivemont">' + hd(inj.length || s.wc ? _t('Connect wallet') : mob ? _t('Open in your wallet app') : _t('No wallet in this browser'));
        if (!inj.length && !s.wc) {
          h += mob ? `<p class="rvw-lead">${_t('This browser has no wallet. Open Rivemont inside your wallet app\'s own browser, then connect there.')}</p>`
                   : `<p class="rvw-lead">${_t('Add a wallet extension to this browser (Rabby or MetaMask), then reload this page. Or open rivemont.xyz/app in your wallet app on your phone.')}</p>`;
          h += '<div class="rvw-sec">' + (mob ? _t('Open Rivemont in') : _t('Get a wallet')) + '</div><div class="rvw-list">';
          for (const a of s.apps) {
            if (mob && a.open) h += `<a class="rvw-w" data-app="${a.id}" href="${esc(a.open(href))}" rel="noopener">${tile(a, a.color)}<span class="rvw-t"><b>${esc(a.name)}</b><small>${_t('Opens this page in {name}', {name: esc(a.name)})}</small></span>${ICONS.go}</a>`;
            else if (mob) h += `<button class="rvw-w" data-a="copy">${tile(a, a.color)}<span class="rvw-t"><b>${esc(a.name)}</b><small>${_t('Paste the link in {name}\'s browser', {name: esc(a.name)})}</small></span><span class="rvw-tag mut">${_t('Copy link')}</span></button>`;
            else if (a.id === 'rabby' || a.id === 'metamask') h += `<a class="rvw-w" href="${esc(a.get)}" target="_blank" rel="noopener">${tile(a, a.color)}<span class="rvw-t"><b>${esc(a.name)}</b><small>${_t('Browser extension')}</small></span>${ICONS.go}</a>`;
          }
          h += '</div>';
        } else {
          if (mob && s.wc && !inj.length) h += `<p class="rvw-lead">${_t('Pick your wallet app. It opens, you approve, then come back here.')}</p>`;
          if (inj.length) {
            h += `<div class="rvw-sec">${mob ? _t('In this app') : _t('In this browser')}</div><div class="rvw-list">` + inj.map(w =>
              `<button class="rvw-w" data-w="${esc(w.id)}">${tile(w, (s.apps.find(a => a.rdns === w.rdns) || {}).color)}<span class="rvw-t"><b>${esc(w.name)}</b><small>${busy === w.name ? _t('Confirm in {name}…', {name: esc(w.name)}) : mob ? _t('Built into this browser') : _t('Browser extension')}</small></span><span class="rvw-tag">${_t('Detected')}</span></button>`).join('') + '</div>';
          }
          if (s.wc && !mob) {
            h += `<div class="rvw-sec">${inj.length ? _t('Other wallets') : _t('Phone wallet')}</div><div class="rvw-list"><button class="rvw-w" data-w="wc"><span class="rvw-ic" style="background:#3B99FC">${ICONS.wc}</span>` +
                 `<span class="rvw-t"><b>WalletConnect</b><small>${_t('Scan a QR code with your phone wallet')}</small></span>${ICONS.go}</button></div>`;
          }
          if (s.wc && mob) {
            h += `<div class="rvw-sec">${inj.length ? _t('Other wallet apps') : _t('Wallet apps')}</div><div class="rvw-list">`;
            for (const a of s.apps.filter(a => !inj.some(w => w.rdns === a.rdns))) {     // not twice: a detected wallet is above
              const l = uri ? a.wc(uri, s.android) : '';
              h += `<a class="rvw-w" data-app="${a.id}" ${l ? `href="${esc(l)}"` : 'aria-disabled="true"'} rel="noopener">${tile(a, a.color)}<span class="rvw-t"><b>${esc(a.name)}</b><small>${uri ? _t('Opens {name} to approve', {name: esc(a.name)}) : _t('Preparing the link…')}</small></span>${ICONS.go}</a>`;
            }
            h += `<a class="rvw-w" data-app="other" ${uri ? `href="${esc(uri)}"` : 'aria-disabled="true"'} rel="noopener"><span class="rvw-ic" style="background:#3B99FC">${ICONS.wc}</span><span class="rvw-t"><b>${_t('Other wallet')}</b><small>${_t('Any WalletConnect wallet on this device')}</small></span>${ICONS.go}</a></div>`;
            const opens = s.apps.filter(a => a.open);
            if (!inj.length) h += `<div class="rvw-sec">${_t('Or open Rivemont inside the app')}</div><div class="rvw-links">` +
              opens.map(a => `<a class="rvw-b" data-app="${a.id}" href="${esc(a.open(href))}" rel="noopener">${esc(a.name)}</a>`).join('') + `<button class="rvw-b" data-a="copy">${_t('Copy link')}</button></div>`;
          }
        }
        if (err) h += `<p class="rvw-err" role="alert">${esc(err)}</p>` + (s.wc && mob && !uri ? ('<div class="rvw-acts"><button class="rvw-b" data-w="wc">' + _t('Try again') + '</button></div>') : '');
        h += `<p class="rvw-foot">${_t('Connecting only shares your address. Nothing is signed or sent until you approve it in your wallet.')}</p>`;
        return h;
      }
      function qrView() {
        return hd(_t('Scan with your phone'), true) +
          `<p class="rvw-lead">${_t('Open Rabby, MetaMask, Trust, OKX or Coinbase Wallet on your phone, tap Scan, and point it at this code.')}</p>` +
          `<div class="rvw-qr"><div class="q" id="rvw-q" aria-label="${_t('WalletConnect QR code')}">${qrSvg || '<span class="sp"></span>'}</div></div>` +
          `<div class="rvw-acts"><button class="rvw-b" data-a="copy" ${uri ? '' : 'disabled'}>${_t('Copy link')}</button></div>` +
          (err ? `<p class="rvw-err" role="alert">${esc(err)}</p>` : `<p class="rvw-st" role="status">${uri ? _t('Waiting for your phone…') : _t('Preparing a secure link…')}</p>`);
      }
      let qrSvg = '';
      function draw() { box.innerHTML = view === 'qr' ? qrView() : listView(); const f = box.querySelector('[data-w], a.rvw-w[href], [data-a=close]'); if (f && doc.activeElement === doc.body) try { f.focus({preventScroll: true}); } catch (e) {} }
      async function makeQR() {
        if (!uri) return;
        try { const q = await loadQR(); const g = q(0, 'M'); g.addData(uri); g.make(); qrSvg = g.createSvgTag({cellSize: 4, margin: 0, scalable: true}); }
        catch (e) { err = _t('The QR code didn\'t load. Use Copy link and paste it in your wallet app.'); }
        if (view === 'qr') draw();
      }
      async function copy() {
        const t = view === 'qr' ? uri : href;          // the QR's link for a wallet app; else this page, to open in one
        try { await win.navigator.clipboard.writeText(t); err = ''; flash(_t('Link copied')); } catch (e) { err = _t('Copy did not work here. Link: {link}', {link: t}); draw(); }
      }
      function flash(t) { const st = box.querySelector('.rvw-st') || box.querySelector('.rvw-foot'); if (st) { const o = st.textContent; st.textContent = t; setTimeout(() => { if (st.isConnected) st.textContent = o; }, 1600); } }
      el.addEventListener('click', e => {
        if (e.target === el) return push(null);
        const b = e.target.closest('[data-a], [data-w], [data-app]'); if (!b) return;
        if (b.dataset.a === 'close') return push(null);
        if (b.dataset.a === 'back') return push('back');
        if (b.dataset.a === 'copy') return copy();
        if (b.dataset.w) { err = ''; return push(b.dataset.w); }
        if (b.dataset.app) push('app:' + b.dataset.app);           // the link itself opens the app
      });
      const key = e => { if (e.key === 'Escape') push(null); };
      doc.addEventListener('keydown', key);
      draw();
      return {
        next, view(v) { view = v; if (v === 'list') busy = ''; draw(); },
        uri(u) { uri = u || ''; qrSvg = ''; draw(); makeQR(); },
        error(t) { err = t || ''; busy = ''; draw(); },
        busy(name) { busy = name; err = ''; draw(); },
        close() { doc.removeEventListener('keydown', key); el.remove(); }};
    }
    // a WalletConnect request waiting in the phone wallet
    function wait(s) {
      const el = shell(_t('Confirm in your wallet')), box = el.querySelector('.rvw-box');
      let done, closed = new Promise(ok => { done = ok; });
      const what = /sendTransaction/.test(s.method) ? _t('the transaction') : /addEthereumChain/.test(s.method) ? _t('the network') : _t('the signature');
      box.innerHTML = hd(_t('Confirm in your wallet')) +
        `<p class="rvw-lead">${s.mobile ? `${_t('Open {name} and approve {what}, then come back here.', {name: esc(s.name), what})}` : `${_t('Open {name} on your phone and approve {what}.', {name: esc(s.name), what})}`}</p>` +
        (s.mobile && s.link ? `<div class="rvw-acts"><a class="rvw-b pri" href="${esc(s.link)}" rel="noopener">${_t('Open {name}', {name: esc(s.name)})}</a></div>` : '') +
        `<p class="rvw-st" role="status">${_t('Waiting for your wallet…')}</p>`;
      el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-a=close]')) { done(); el.remove(); } });
      return {closed, close() { el.remove(); }};
    }
    return {open, wait};
  }

  const api = {create, isCancel, explain, domUI, APPS, CHAINS, WC_URL, QR_URL};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RVWallet = api;
})(typeof window !== 'undefined' ? window : globalThis);

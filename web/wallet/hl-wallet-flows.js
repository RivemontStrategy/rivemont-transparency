/* Rivemont app: the Hyperliquid wallet flows, as they run in the browser.

   EXCERPTS of the live app's scripts (app-core.js and app-money.js), copied unchanged except for comments, so the
   signing flows can be read and tested on their own. They run inside the app, which provides `me` (the signed-in
   account: address, agent_address), `info` (server settings: mode, builder, max_fee_rate), `key` (the account's login
   key), `api` / `api0` (POST to the server), `WALLET` (web/wallet/wallet.js), `_t` (translation), and small UI helpers
   ($, say, toast, notice, load, render, ...). The tests in tests/js cut the blocks between the <name> markers out of
   this file and run them with those names mocked.

   In every flow the server prepares the exact action and its EIP-712 typed data, and THIS code checks that action
   again before the wallet is asked to sign: right type, right network and chain id, a fresh nonce, the destination is
   the connected wallet itself (withdrawals, USDC moves), and for approvals the right agent, the configured builder
   address and a fee rate of at most 0.1%. Anything else is refused and nothing is signed. */

/* ======== Sign in with the wallet (from app-core.js: the Log in page) ========
   The server issues an EIP-4361 message naming this site and the wallet (signing/signin.py); the wallet signs it with
   personal_sign; the server recovers the signer and checks the exact text (signing/routes_excerpt.py login_checked). */
V.welcome.bind = () => {
  const msg = (t, kind) => { $('m-hello').textContent = t || ''; $('m-hello').className = 'msg' + (kind ? ' ' + kind : ''); };
  $('agree').onchange = () => { if ($('agree').checked) msg(''); };
  $('b-wallet').onclick = async () => {
    if (!$('agree').checked) { msg(_t('Tick the box below to accept the terms first.'), 'err'); $('agree').focus(); return; }
    const b = $('b-wallet'); b.disabled = true; msg('');
    if (window.rvEv) window.rvEv('wallet_connect_attempt', {from: 'app'});    // radar/analytics.py (success / fail: the server)
    try {
      const [acct] = await WALLET.connect();
      // the message names this site and the wallet (EIP-4361): the wallet shows whose sign-in it is
      let chain = null; try { chain = await WALLET.chainId(); } catch (e) {}
      const {message} = await api0('/api/auto/login/start', {address: acct, chain_id: chain});
      msg(_t('Sign the message in your wallet. It should name {host}.', {host: String(message).split(' wants you')[0] || location.hostname}));
      const signature = await WALLET.personalSign(message, acct);
      const r = await api0('/api/auto/login', {message, signature, terms: true, invite: $('invite') ? $('invite').value.trim() : ''});
      key = r.key; keyStore.set(key); await load();
      if (!me) throw new Error(loadErr || _t('Could not open your account. Try again.'));
      toast(r.created ? _t('Welcome to Rivemont. Your account is ready.') : _t('Signed in')); afterSignIn();
    } catch (e) {
      msg(e && e.code === 4001 ? _t('You cancelled in your wallet. Nothing happened.') : (e && e.message) || String(e), 'err');
      if (window.rvEv && !(e && e.status)) window.rvEv('wallet_connect_fail', {from: 'app', reason: e && e.code === 4001 ? 'cancelled' : 'wallet_error'});
      // private beta (AUTO_INVITE_CODE set): the code box shows only when the server asks a new wallet for it
      if (e && e.status === 403 && $('invbox')) { $('invbox').hidden = false; $('invite').focus(); }
    }
    if ($('b-wallet')) $('b-wallet').disabled = false;
  };
};

/* ======== The withdraw guard (from app-core.js): the same rule as withdraw/balance_guard.py ======== */
/*<guard>*/
/* Nothing is kept for a strategy (Rivemont is an exchange front end): a withdrawal may take what the
   exchange itself reports as free, and a strategy set above the money on its exchanges says so. Pure functions of the
   money model (me.money, radar/auto/money.py); the "what if" of a withdrawal is worked out exactly as
   money.withdraw_check does it (tests/js/guard.test.mjs runs both on the same models). */
const GUARD = (() => {
  const EPS = 0.005;
  const venue = (m, v) => ((m && m.venues) || []).find(x => x.venue === v) || null;
  // withdrawing `amount` from V (`fee`: what the exchange takes on top): null when the exchange lets it leave (or reports
  // no free figure: it decides itself), else {free, most}: its free figure and the most that can leave now
  function withdraw(m, v, amount, fee = 0) {
    const x = venue(m, v); if (!x || !(amount > 0) || x.exchange_free == null || !x.live) return null;
    const ex = Math.max(0, x.exchange_free);
    if (amount + fee <= ex + EPS) return null;
    return {free: Math.round(ex * 100) / 100, most: Math.max(0, Math.floor((ex - fee) * 100 + 1e-6) / 100)};
  }
  // strategies whose amount is above the money on their exchanges: [{...strategy, have, to, ok}] (none while a balance is unknown)
  function short(m) {
    return ((m && m.strategies) || []).filter(s => s.shortfall != null && s.shortfall >= 1)
      .map(s => ({...s, have: s.on_exchanges, to: s.fix_to, ok: s.fix_ok, inUse: s.in_use || 0, venue: s.venues[0]}));
  }
  return {withdraw, short};
})();
/*</guard>*/

/* ======== Hyperliquid withdrawals (from app-money.js) ======== */
/*<hlwd>*/
/* Hyperliquid's withdrawal fee: Hyperliquid takes $1 out of the amount signed. "Fee from the amount"
   (the default): you withdraw X and receive X - $1. "Receive the full amount": you receive X and the wallet signs X + $1.
   Pure, in cents; the server's hl.withdraw_amounts is the same rule (tests/js/hl-withdraw.test.mjs). */
const HLWD = (() => {
  const FEE = 1, MIN = 2;                                            // hl.WITHDRAW_FEE_USD, hl.WITHDRAW_MIN_USD
  const cents = v => Math.floor(Math.round((+v || 0) * 1e6) / 1e4);
  // typed amount -> {gross: signed, receive: arrives, fee}; nothing typed: zeros
  function amounts(a, full) {
    const n = Math.max(0, cents(a)); if (!n) return {gross: 0, receive: 0, fee: FEE};
    const g = full ? n + FEE * 100 : n;
    return {gross: g / 100, receive: Math.max(0, g - FEE * 100) / 100, fee: FEE};
  }
  const min = full => full ? MIN - FEE : MIN;                        // the least that can be typed
  const max = (avail, full) => Math.max(0, cents(avail) - (full ? FEE * 100 : 0)) / 100;   // MAX: withdrawable (- $1)
  return {amounts, min, max, FEE};
})();
/*</hlwd>*/
// the withdrawals Rivemont builds, one per exchange: the Withdraw sheet and a Transfer's first step both call these.
// The signed withdrawal handed to the server: a refusal (4xx) means nothing was sent; any other failure (the network, a
// 5xx) may come after the exchange took it, so it is 'pending' and never "not sent" (audit money-06)
async function wdSubmit(path, body) {
  try { return await api0(path, body); }
  catch (e) { if (e && typeof e === 'object' && !(e.status >= 400 && e.status < 500)) e.code = 'pending'; throw e; }
}
const wdUnsure = venue => _t('Your wallet signed it, but Rivemont did not hear back from {venue}. Check your {venue} balance in a few minutes before withdrawing again.', {venue});
async function wdHLCore(a, full = false) {   // Hyperliquid -> the connected wallet on Arbitrum (full: a arrives, $1 on top)
  const [acct] = await WALLET.connect();
  if (!acct || acct.toLowerCase() !== (me.address || '').toLowerCase()) throw new Error(`${_t('Switch your wallet to {address}, the account connected here, then try again.', {address: short(me.address)})}`);
  const p = await api0('/api/auto/withdraw', {key, usd: a, receive_full: !!full, chain_id: await WALLET.chainId()});
  // the wallet signs exactly the cents the summary showed (the gross: what leaves Hyperliquid), to this same wallet
  // (audit money-01: it once signed a cent less)
  const d = HLWD.amounts(a, full), x = p.action || {}, m = (p.typed_data && p.typed_data.message) || {}, me0 = String(me.address || '').toLowerCase();
  if (x.type !== 'withdraw3' || String(x.destination).toLowerCase() !== me0 || Math.round(+x.amount * 100) !== Math.round(d.gross * 100) ||
    (p.receive_usd != null && Math.round(+p.receive_usd * 100) !== Math.round(d.receive * 100)) ||
    String(m.destination).toLowerCase() !== me0 || String(m.amount) !== String(x.amount))
    throw new Error(_t('Rivemont refused to ask your wallet for this (not this amount to your own wallet). Nothing was signed.'));
  const signature = await WALLET.signTypedData(acct, p.typed_data);
  await wdSubmit('/api/auto/withdraw', {key, action: p.action, signature});
  return {amount_usd: a};
}
/* ---- Hyperliquid's market groups (HIP-3 builder dexs: trade.xyz and others; radar/auto/hip3.py). A classic account keeps
   each group's USDC apart: an order there can use only what sits in that group, and only the main balance can be
   withdrawn. One wallet signature (Hyperliquid's sendAsset, built by our server, to this same account only, checked here
   again before the wallet sees it) moves USDC between them. Unified accounts share one balance: nothing to move. ---- */
let hdx = null, hdxFrom = 'main', hdxTo = null, hdxAmt = '';
const hdxKey = x => x.name || 'main';
async function hlDexLoad() {
  if (!$('hl-dx') || !key || DEMO) return;
  try { hdx = await api0('/api/auto/hl/dexs', {key}); } catch (e) { hdx = {err: e.message || String(e)}; }
  hdx.at = Date.now();
  hlDexShow();
}
function hdxCheck(p, from, to, a) {        // a move of this amount between these two groups of this same account, in USDC only
  const x = (p && p.action) || {}, m = (p && p.typed_data && p.typed_data.message) || {}, me0 = String(me.address || '').toLowerCase();
  const ok = x.type === 'sendAsset' && String(x.destination).toLowerCase() === me0 && x.sourceDex === from && x.destinationDex === to &&
    String(x.token || '').startsWith('USDC:') && x.fromSubAccount === '' && Math.round(+x.amount * 100) === Math.round(a * 100) &&
    String(m.destination).toLowerCase() === me0 && m.sourceDex === from && m.destinationDex === to && String(m.amount) === String(x.amount) && m.token === x.token;
  if (!ok) throw new Error(_t('Rivemont refused to ask your wallet for this (not a move inside your own account). Nothing was signed.'));
}
async function hlDexMove(from, to, btn) {
  const a = floorCents($('hdx-a').value);
  if (!to || !(a >= (hdx.min_usd || 1)) || a > from.free_usd + 0.005) return;
  btn.disabled = true; btn.classList.add('busy');
  try {
    const [acct] = await WALLET.connect();
    if (!acct || acct.toLowerCase() !== (me.address || '').toLowerCase()) throw new Error(`${_t('Switch your wallet to {address}, the account connected here, then try again.', {address: short(me.address)})}`);
    const p = await api0('/api/auto/hl/dex-move', {key, usd: a, chain_id: await WALLET.chainId(), from_dex: from.name, to_dex: to.name});
    hdxCheck(p, from.name, to.name, a);
    const signature = await WALLET.signTypedData(acct, p.typed_data);
    await api0('/api/auto/hl/dex-move', {key, action: p.action, signature});
    hdxAmt = ''; if ($('hdx-a')) $('hdx-a').value = '';
    toast(_t('Moved {amount} from {from} to {to}', {amount: usd(a), from: from.label, to: to.label}));
    await hlDexLoad(); refreshAfterMove(10000);
  } catch (e) { notice('err', _t('Not moved'), e && (e.code === 4001 || /user rejected/i.test(e.message || '')) ? _t('You cancelled in your wallet. Nothing was sent.') : (e.message || String(e))); }
  finally { if ($('b-hdx')) { btn.classList.remove('busy'); $('hdx-a').dispatchEvent(new Event('input')); } }
}

/* ======== Hyperliquid approvals: the trade-only API wallet and the builder fee (from app-money.js) ======== */
/*<approve>*/
// Refuse a mismatched approval before asking the wallet to sign. This checks a prepare response, not a compromised page.
function checkHLApproval(p, kind, chainId, account) {
  const refuse = () => { throw new Error(_t('The approval details do not match this request. Nothing was signed. Reload and try again.')); };
  const address = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x) && !/^0x0{40}$/i.test(x);
  const sameAddress = (a, b) => address(a) && address(b) && a.toLowerCase() === b.toLowerCase();
  const exactKeys = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join(',') === keys.slice().sort().join(',');
  const fields = kind === 'approveAgent' ? [
    {name: 'hyperliquidChain', type: 'string'}, {name: 'agentAddress', type: 'address'},
    {name: 'agentName', type: 'string'}, {name: 'nonce', type: 'uint64'}
  ] : kind === 'approveBuilderFee' ? [
    {name: 'hyperliquidChain', type: 'string'}, {name: 'maxFeeRate', type: 'string'},
    {name: 'builder', type: 'address'}, {name: 'nonce', type: 'uint64'}
  ] : null;
  if (!fields || !address(account) || !/^0x[0-9a-f]+$/i.test(String(chainId))) refuse();
  const a = p && p.action, td = p && p.typed_data;
  const primary = kind === 'approveAgent' ? 'HyperliquidTransaction:ApproveAgent' : 'HyperliquidTransaction:ApproveBuilderFee';
  const names = fields.map(f => f.name);
  if (!exactKeys(a, ['type', 'signatureChainId', ...names]) || a.type !== kind ||
      String(a.signatureChainId).toLowerCase() !== String(chainId).toLowerCase() ||
      a.hyperliquidChain !== (info.mode === 'live' ? 'Mainnet' : 'Testnet') ||
      !Number.isSafeInteger(a.nonce) || Math.abs(Date.now() - a.nonce) > 10 * 60 * 1000) refuse();
  if (kind === 'approveAgent') {
    if (!sameAddress(a.agentAddress, me && me.agent_address) || a.agentName !== 'rivemont') refuse();
  } else {
    const rate = String(a.maxFeeRate);
    if (!sameAddress(account, me && me.address) || !sameAddress(a.builder, info.builder) ||
        rate !== info.max_fee_rate || !/^(?:0|0\.\d+)%$/.test(rate) || Number(rate.slice(0, -1)) > 0.1) refuse();
  }
  if (!exactKeys(td, ['domain', 'types', 'primaryType', 'message']) || td.primaryType !== primary ||
      !exactKeys(td.message, names) || names.some(n => td.message[n] !== a[n]) ||
      !exactKeys(td.domain, ['name', 'version', 'chainId', 'verifyingContract']) ||
      td.domain.name !== 'HyperliquidSignTransaction' || td.domain.version !== '1' ||
      !Number.isSafeInteger(td.domain.chainId) || td.domain.chainId !== Number(chainId) ||
      String(td.domain.verifyingContract).toLowerCase() !== '0x' + '0'.repeat(40) ||
      !exactKeys(td.types, [primary, 'EIP712Domain']) ||
      JSON.stringify(td.types[primary]) !== JSON.stringify(fields) ||
      JSON.stringify(td.types.EIP712Domain) !== JSON.stringify([
        {name: 'name', type: 'string'}, {name: 'version', type: 'string'},
        {name: 'chainId', type: 'uint256'}, {name: 'verifyingContract', type: 'address'}
      ])) refuse();
}

async function approve(kind, btn) {
  say('m-hl', ''); btn.disabled = true;
  try {
    const [account] = await WALLET.connect();
    const chainId = await WALLET.chainId();
    const p = await api('/api/auto/prepare', {key, kind, chain_id: chainId});
    if (kind === 'approveAgent' && !(me && me.agent_address)) me = await api('/api/auto/me', {key});
    checkHLApproval(p, kind, chainId, account);
    const signature = await WALLET.signTypedData(account, p.typed_data);
    me = await api('/api/auto/submit', {key, kind, action: p.action, signature});
    toast(kind === 'approveAgent' ? _t('API wallet approved') + (me.notice ? '. ' + me.notice : '') : _t('Fee approved')); await load(); render();
  } catch (e) { say('m-hl', e.message || String(e), 'err'); btn.disabled = false; }
}

/*</approve>*/

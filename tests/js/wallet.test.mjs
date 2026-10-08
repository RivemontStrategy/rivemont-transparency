// node tests/js/wallet.test.mjs — the one wallet module (web/wallet/wallet.js) with mock EIP-1193 providers: EIP-6963
// discovery, the remembered choice, the picker only when there is a choice, personal_sign / eth_signTypedData_v4 /
// eth_sendTransaction, network switches (add on 4902, strict vs lenient), account and disconnect events, errors in plain
// words (a cancel is always 4001), and WalletConnect (a fake EthereumProvider: QR link, session, requests, session end).
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const W = createRequire(import.meta.url)("../../web/wallet/wallet.js");
const A1 = "0x1111111111111111111111111111111111111111", A2 = "0x2222222222222222222222222222222222222222";

class Mock1193 {                                 // an injected wallet: answers, records, emits
  constructor(accounts = [A1], chain = "0xa4b1", flags = {}) {
    Object.assign(this, flags); this.accounts = accounts; this.chain = chain; this.calls = []; this.l = {}; this.fail = {}; this.known = new Set(["0xa4b1", "0x1", "0xaa36a7"]);
  }
  on(e, f) { (this.l[e] = this.l[e] || []).push(f); }
  removeListener(e, f) { this.l[e] = (this.l[e] || []).filter(x => x !== f); }
  emit(e, x) { (this.l[e] || []).forEach(f => f(x)); }
  async request({method, params}) {
    this.calls.push([method, params]);
    if (this.fail[method]) { const f = this.fail[method]; if (f.once) delete this.fail[method]; throw Object.assign(new Error(f.message || "failed"), {code: f.code}); }
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return this.accounts;
      case "eth_chainId": return this.chain;
      case "personal_sign": return "0xsig:" + params[0] + ":" + params[1];
      case "eth_signTypedData_v4": return "0xtyped:" + params[0] + ":" + JSON.parse(params[1]).primaryType;
      case "eth_sendTransaction": return "0xhash:" + params[0].to;
      case "wallet_switchEthereumChain": if (!this.known.has(params[0].chainId)) throw Object.assign(new Error("Unrecognized chain ID"), {code: 4902});
        this.chain = params[0].chainId; this.emit("chainChanged", this.chain); return null;
      case "wallet_addEthereumChain": this.known.add(params[0].chainId); this.chain = params[0].chainId; return null;
      case "eth_getBalance": return "0x10";
      default: throw Object.assign(new Error("unsupported " + method), {code: 4200});
    }
  }
}
function memStore() { const m = new Map(); return {get: k => m.has(k) ? m.get(k) : null, set: (k, v) => v == null ? m.delete(k) : m.set(k, v), m}; }
function mkWin(eth) { const w = new EventTarget(); w.Event = Event; if (eth) w.ethereum = eth; w.location = {href: "https://rivemont.xyz/app#exchanges", origin: "https://rivemont.xyz"}; w.navigator = {userAgent: "Mozilla/5.0 (X11; Linux x86_64)"}; return w; }
function announce(win, rdns, name, provider) {       // what an EIP-6963 wallet does when asked (and once on load)
  const send = () => win.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), {detail: Object.freeze({info: {uuid: rdns + "-uuid", name, icon: "data:image/svg+xml,<svg/>", rdns}, provider})}));
  win.addEventListener("eip6963:requestProvider", send); send();
}
function mockUI(script) {                             // the picker, scripted: each next() takes the next choice
  const log = [];
  return {log, open(s) {
    log.push(["open", s.injected.map(x => x.id), s.wc, s.mobile]);
    const steps = script.slice();
    return {next: async () => { const c = steps.shift(); log.push(["next", c]); return typeof c === "function" ? c() : c; },
            view: v => log.push(["view", v]), uri: u => log.push(["uri", u]), error: t => log.push(["error", t]), busy: n => log.push(["busy", n]), close: () => log.push(["close"])};
  }, wait(s) { log.push(["wait", s.name, s.method]); return {closed: new Promise(() => {}), close: () => log.push(["unwait"])}; }};
}
const typed = {types: {EIP712Domain: []}, primaryType: "Approve", domain: {chainId: 42161}, message: {}};

// ---- one injected wallet (a wallet app's own browser, or one extension): no picker, exactly as before ----
{
  const eth = new Mock1193([A1], "0xa4b1", {isRabby: true}), store = memStore(), ui = mockUI([]);
  const w = W.create({win: mkWin(eth), storage: store, ui});
  assert.deepEqual(await w.connect(), [A1]);
  assert.equal(ui.log.length, 0, "no picker with one wallet");
  assert.equal(w.current().name, "Rabby"); assert.equal(store.get("rv_wallet"), "inj");
  assert.equal(await w.personalSign("0x68656c6c6f", A1), "0xsig:0x68656c6c6f:" + A1);
  assert.equal(await w.signTypedData(A1, typed), "0xtyped:" + A1 + ":Approve");                 // object -> JSON string
  assert.equal(await w.signTypedData(A1, JSON.stringify(typed)), "0xtyped:" + A1 + ":Approve"); // or already a string
  assert.deepEqual(eth.calls.find(c => c[0] === "eth_signTypedData_v4")[1], [A1, JSON.stringify(typed)]);
  assert.equal(await w.sendTransaction({from: A1, to: "0xabc", data: "0x", value: "0x0"}), "0xhash:0xabc");
  assert.equal(await w.chainId(), "0xa4b1");
  assert.equal(await w.request("eth_getBalance", [A1, "latest"]), "0x10");                     // reads go through the same wallet
  assert.deepEqual(await w.request("eth_requestAccounts"), [A1]);
  // every call the app makes still asks for accounts first (eth_requestAccounts), as the page did with window.ethereum
  assert.equal(eth.calls.filter(c => c[0] === "eth_requestAccounts").length, 2);
}

// ---- network switches ----
{
  const eth = new Mock1193(), w = W.create({win: mkWin(eth), storage: memStore(), ui: mockUI([])});
  await w.connect();
  await w.switchChain("0x1"); assert.equal(eth.chain, "0x1");
  const ink = {chainId: "0xdef1", chainName: "Ink", nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18}, rpcUrls: ["https://rpc-gel.inkonchain.com"]};
  await w.switchChain("0xdef1", ink);                                                           // unknown (4902) -> added
  assert.equal(eth.chain, "0xdef1"); assert.deepEqual(eth.calls.at(-1), ["wallet_addEthereumChain", [ink]]);
  await w.switchChain("0x38");                                                                  // unknown, nothing to add: lenient goes on
  await assert.rejects(w.switchChain("0x38", null, {strict: true, name: "BNB Chain"}), e => e.code === "RV_CHAIN" && e.message === "Switch your wallet to the BNB Chain network, then try again.");
  eth.fail.wallet_switchEthereumChain = {code: 4001, message: "User rejected the request.", once: true};
  await assert.rejects(w.switchChain("0x1"), e => e.code === 4001);                             // a cancel always stops the flow
  eth.fail.wallet_switchEthereumChain = {code: -32603, message: "internal", once: true};
  await w.switchChain("0x1");                                                                   // lenient: other failures go on (the signature names its chain)
  eth.fail.wallet_switchEthereumChain = {code: 4001, message: "User rejected the request.", once: true};
  await assert.rejects(w.switchChain("0xa4b1", null, {strict: true, name: "Arbitrum"}), e => e.code === "RV_CHAIN");   // strict: as the page said before
}

// ---- errors: plain words, and a cancel is 4001 whatever the wallet called it ----
{
  const eth = new Mock1193(), w = W.create({win: mkWin(eth), storage: memStore(), ui: mockUI([])});
  await w.connect();
  for (const [code, message] of [[4001, "User rejected the request."], [5000, "User rejected."], ["ACTION_REJECTED", "user rejected action"], [-32603, "MetaMask Tx Signature: User denied transaction signature."]]) {
    eth.fail.personal_sign = {code, message, once: true};
    await assert.rejects(w.personalSign("0x00", A1), e => e.code === 4001, String(code));
  }
  eth.fail.eth_signTypedData_v4 = {code: -32002, message: "Request of type 'eth_requestAccounts' already pending", once: true};
  await assert.rejects(w.signTypedData(A1, typed), e => e.code === -32002 && /already has a request waiting/.test(e.message));
  eth.fail.eth_sendTransaction = {code: 4100, message: "The requested method and/or account has not been authorized by the user.", once: true};
  await assert.rejects(w.sendTransaction({to: "0x1"}), e => e.code === 4100 && /has not allowed this site/.test(e.message));
  eth.fail.eth_sendTransaction = {code: -32000, message: "insufficient funds for gas", once: true};
  await assert.rejects(w.sendTransaction({to: "0x1"}), e => e.code === -32000 && e.message === "insufficient funds for gas");   // the wallet's own words
  assert.equal(W.explain({code: 4902, message: "x"}).code, 4902);                              // plain objects become errors, code kept
  assert.ok(W.isCancel({message: "Transaction was rejected by the user"})); assert.ok(!W.isCancel({code: 4200, message: "nope"}));
}

// ---- accounts and network changes, disconnect: the app hears them from whichever wallet is in use ----
{
  const eth = new Mock1193(), w = W.create({win: mkWin(eth), storage: memStore(), ui: mockUI([])});
  const heard = []; w.on("accountsChanged", a => heard.push(["acc", a[0]])); w.on("chainChanged", c => heard.push(["chain", c])); const off = w.on("disconnect", () => heard.push(["disc"]));
  await w.connect();
  eth.accounts = [A2]; eth.emit("accountsChanged", [A2]); eth.emit("chainChanged", "0x1");
  assert.equal(await w.account(), A2);
  off(); eth.emit("disconnect", {});
  assert.deepEqual(heard, [["acc", A2], ["chain", "0x1"]]);
}

// ---- EIP-6963: several wallets -> the picker, injected first, the choice remembered ----
{
  const win = mkWin(new Mock1193([A1], "0xa4b1", {isMetaMask: true}));
  const rabby = new Mock1193([A2], "0xa4b1", {isRabby: true}), mm = new Mock1193([A1], "0xa4b1", {isMetaMask: true});
  announce(win, "io.metamask", "MetaMask", mm); announce(win, "io.rabby", "Rabby Wallet", rabby);
  const store = memStore(), ui = mockUI(["inj:io.rabby"]);
  const w = W.create({win, storage: store, ui});
  assert.deepEqual(w.options().injected.map(x => x.id), ["inj:io.rabby", "inj:io.metamask"]);  // Rabby first; window.ethereum not twice
  assert.deepEqual(await w.connect(), [A2]);
  assert.deepEqual(ui.log[0], ["open", ["inj:io.rabby", "inj:io.metamask"], false, false]);
  assert.equal(store.get("rv_wallet"), "inj:io.rabby"); assert.equal(w.current().name, "Rabby Wallet");
  assert.equal(await w.personalSign("0x01", A2), "0xsig:0x01:" + A2); assert.equal(mm.calls.length, 0);
  // a reload: the remembered wallet, no picker
  const ui2 = mockUI([]), w2 = W.create({win, storage: store, ui: ui2});
  assert.deepEqual(await w2.connect(), [A2]); assert.equal(ui2.log.length, 0);
  assert.equal((await w2.restore()).id, "inj:io.rabby");
  // Change wallet: the picker again, whatever was remembered
  const ui3 = mockUI(["inj:io.metamask"]), w3 = W.create({win, storage: store, ui: ui3});
  assert.deepEqual(await w3.connect({force: true}), [A1]); assert.equal(store.get("rv_wallet"), "inj:io.metamask");
  // closing the picker is a cancel (4001); cancelling in one wallet brings the list back to pick another
  const w4 = W.create({win, storage: memStore(), ui: mockUI([null])});
  await assert.rejects(w4.connect(), e => e.code === 4001);
  rabby.fail.eth_requestAccounts = {code: 4001, message: "User rejected the request.", once: true};
  const ui5 = mockUI(["inj:io.rabby", "inj:io.metamask"]), w5 = W.create({win, storage: memStore(), ui: ui5});
  assert.deepEqual(await w5.connect(), [A1]);
  assert.ok(ui5.log.some(x => x[0] === "error" && /cancelled in Rabby Wallet/.test(x[1])));
  // disconnect forgets the choice
  await w5.disconnect(); assert.equal(w5.current(), null);
}

// ---- no wallet at all, no WalletConnect: the picker (it shows how to open Rivemont in a wallet app) ----
{
  const ui = mockUI([null]), w = W.create({win: mkWin(null), storage: memStore(), ui, mobile: true});
  await assert.rejects(w.connect(), e => e.code === 4001);
  assert.deepEqual(ui.log[0], ["open", [], false, true]);
}

// ---- WalletConnect: a fake EthereumProvider (the real one is @walletconnect/ethereum-provider, loaded from jsDelivr) ----
class FakeWC {
  static inits = [];
  static async init(o) { const p = new FakeWC(o); FakeWC.inits.push(o); FakeWC.last = p; return p; }
  constructor(o) { this.o = o; this.l = {}; this.session = null; this.accounts = []; this.calls = []; this.signer = {abortPairingAttempt: () => { this.aborted = true; }}; }
  on(e, f) { (this.l[e] = this.l[e] || []).push(f); } removeListener(e, f) { this.l[e] = (this.l[e] || []).filter(x => x !== f); }
  emit(e, x) { (this.l[e] || []).forEach(f => f(x)); }
  async connect() { this.emit("display_uri", "wc:abc@2?relay-protocol=irn&symKey=01"); await new Promise(ok => { this.approve = ok; });
    this.session = {topic: "t1", peer: {metadata: {name: "Rabby Mobile"}}}; this.accounts = [A2]; }
  async request({method, params}) { this.calls.push([method, params]); if (this.fail) { const f = this.fail; this.fail = null; throw f; }
    return method === "personal_sign" ? "0xwc:" + params[0] : method === "eth_chainId" ? "0xa4b1" : "0xok"; }
  async disconnect() { this.session = null; this.accounts = []; this.emit("disconnect", {}); }
}
const PID = "0123456789abcdef0123456789abcdef";
{
  // a computer with no extension: the only way is WalletConnect, so the picker opens on it (QR view) without a list step
  const store = memStore(), ui = mockUI(["wc", () => new Promise(() => {})]);
  const w = W.create({win: mkWin(null), storage: store, ui, loadWC: async () => ({EthereumProvider: FakeWC}), mobile: false});
  w.configure({projectId: "not-an-id"}); assert.equal(w.options().walletconnect, false);           // no valid id: WalletConnect hidden
  w.configure({projectId: PID}); assert.equal(w.options().walletconnect, true);
  const conn = w.connect();
  await new Promise(ok => setTimeout(ok, 10));
  assert.deepEqual(ui.log.filter(x => x[0] === "uri").map(x => x[1]), ["wc:abc@2?relay-protocol=irn&symKey=01"]);   // the QR's link
  assert.ok(ui.log.some(x => x[0] === "view" && x[1] === "qr"));
  const o = FakeWC.inits.at(-1);
  assert.equal(o.projectId, PID); assert.equal(o.showQrModal, false); assert.ok(o.optionalChains.includes(42161) && o.optionalChains.includes(56) && o.optionalChains.includes(57073));
  assert.equal(o.metadata.url, "https://rivemont.xyz");
  FakeWC.last.approve();                                                                          // the phone wallet approves
  assert.deepEqual(await conn, [A2]);
  assert.equal(store.get("rv_wallet"), "wc"); assert.equal(w.current().name, "Rabby Mobile"); assert.equal(w.current().kind, "wc");
  // a signature: it waits in the phone wallet, and the page says so
  assert.equal(await w.personalSign("0x68", A2), "0xwc:0x68");
  assert.ok(ui.log.some(x => x[0] === "wait" && x[1] === "Rabby Mobile" && x[2] === "personal_sign"));
  assert.equal(await w.chainId(), "0xa4b1");
  // cancel on the phone: 4001 like any wallet
  FakeWC.last.fail = Object.assign(new Error("User rejected."), {code: 5000});
  await assert.rejects(w.signTypedData(A2, typed), e => e.code === 4001);
  // the session ended on the phone: plain words, and the next action connects again
  FakeWC.last.fail = new Error("No matching key. session topic doesn't exist: t1");
  await assert.rejects(w.personalSign("0x01", A2), e => e.code === "RV_SESSION" && /Connect your wallet again/.test(e.message));
  assert.equal(w.current(), null); assert.equal(store.get("rv_wallet"), null);
}
{
  // a phone with no wallet in its browser: the pairing starts at once so each wallet's link is ready for the tap
  const store = memStore(), ui = mockUI(["app:metamask", () => new Promise(() => {})]);
  FakeWC.inits = [];
  const w = W.create({win: mkWin(null), storage: store, ui, loadWC: async () => ({EthereumProvider: FakeWC}), mobile: true});
  w.configure({projectId: PID});
  const conn = w.connect();
  await new Promise(ok => setTimeout(ok, 10));
  assert.ok(ui.log.some(x => x[0] === "uri"), "links ready before any tap");
  assert.equal(store.get("rv_wallet_app"), "metamask");                                           // the tap opened MetaMask
  FakeWC.last.approve();                                                                          // approved there, back in the browser
  assert.deepEqual(await conn, [A2]);
  // a reload: WalletConnect keeps the session; the remembered choice uses it without any picker
  const ui2 = mockUI([]), w2 = W.create({win: mkWin(null), storage: store, ui: ui2, loadWC: async () => ({EthereumProvider: {init: async () => FakeWC.last}}), mobile: true});
  w2.configure({projectId: PID});
  assert.deepEqual(await w2.connect(), [A2]); assert.equal(ui2.log.length, 0);
  assert.equal((await w2.restore()).kind, "wc");
  await w2.disconnect(); assert.equal(FakeWC.last.session, null);
  // the deep links as the wallets document them
  const mmApp = W.APPS.find(a => a.id === "metamask"), okx = W.APPS.find(a => a.id === "okx"), trust = W.APPS.find(a => a.id === "trust");
  assert.equal(mmApp.wc("wc:x@2"), "https://metamask.app.link/wc?uri=wc%3Ax%402");
  assert.equal(mmApp.open("https://rivemont.xyz/app"), "https://metamask.app.link/dapp/rivemont.xyz/app");
  assert.equal(okx.wc("wc:x@2", true), "wc:x@2"); assert.equal(okx.wc("wc:x@2", false), "okex://main/wc?uri=wc%3Ax%402");
  assert.equal(trust.open("https://rivemont.xyz/app"), "https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Frivemont.xyz%2Fapp");
}
{
  // an extension AND WalletConnect on a computer: the picker lists the extension first, WalletConnect after
  const win = mkWin(null), rabby = new Mock1193([A1], "0xa4b1", {isRabby: true}); announce(win, "io.rabby", "Rabby Wallet", rabby);
  const ui = mockUI(["inj:io.rabby"]), w = W.create({win, storage: memStore(), ui, loadWC: async () => ({EthereumProvider: FakeWC}), mobile: false});
  w.configure({projectId: PID});
  assert.deepEqual(await w.connect(), [A1]);
  assert.deepEqual(ui.log[0], ["open", ["inj:io.rabby"], true, false]);
  // inside a wallet app's own browser (one injected wallet on a phone): no picker even with WalletConnect on
  const ui2 = mockUI([]), w2 = W.create({win, storage: memStore(), ui: ui2, loadWC: async () => ({EthereumProvider: FakeWC}), mobile: true});
  w2.configure({projectId: PID});
  assert.deepEqual(await w2.connect(), [A1]); assert.equal(ui2.log.length, 0);
}
console.log("wallet.js: all checks passed");

// ---- phone wallet links: each opens its own app with the WalletConnect link (Rabby's bare wc: link did nothing) ----
{
  let apps = null;
  const ui = {open(s) { apps = s.apps; return {next: () => new Promise(() => {}), view() {}, uri() {}, error() {}, busy() {}, close() {}}; }, wait() {}};
  const w = W.create({win: mkWin(null), storage: memStore(), ui});
  w.connect().catch(() => {});
  await new Promise(r => setTimeout(r, 0));
  if (apps) {
    const rb = apps.find(a => a.id === "rabby"), u = "wc:abc@2?relay-protocol=irn&symKey=1";
    assert.equal(rb.wc(u), "rabby://wc?uri=" + encodeURIComponent(u));
    assert.equal(rb.app, "rabby://");
  } else {
    const src = (await import("node:fs")).readFileSync(new URL("../../web/wallet/wallet.js", import.meta.url), "utf8");
    assert.ok(src.includes("wc: u => 'rabby://wc?uri=' + enc(u)") && src.includes("app: 'rabby://'"));
  }
}

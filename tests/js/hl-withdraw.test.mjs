// node tests/js/hl-withdraw.test.mjs — the Hyperliquid withdraw sheet's fee choice: "Fee from the
// amount" (default: withdraw X, receive X - $1) or "Receive the full amount" (receive X, the wallet signs X + $1).
// The pure math (between /*<hlwd>*/ markers) must give what withdraw/hl_withdraw.py withdraw_amounts gives, and with the page's
// guard (/*<guard>*/) MAX and the refusal say the most that can be received.
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../../web/wallet/hl-wallet-flows.js", import.meta.url), "utf8");
const cut = n => src.slice(src.indexOf(`/*<${n}>*/`), src.indexOf(`/*</${n}>*/`));
const dir = mkdtempSync(join(tmpdir(), "hlwd-"));
writeFileSync(join(dir, "m.mjs"), cut("hlwd") + "\n" + cut("guard") + "\nexport default {HLWD, GUARD};\n");
const {HLWD, GUARD} = (await import(join(dir, "m.mjs"))).default;

// gross / net
assert.deepEqual(HLWD.amounts(50, false), {gross: 50, receive: 49, fee: 1});
assert.deepEqual(HLWD.amounts(50, true), {gross: 51, receive: 50, fee: 1});
assert.deepEqual(HLWD.amounts(8.04, true), {gross: 9.04, receive: 8.04, fee: 1});    // cents kept (audit money-01)
assert.deepEqual(HLWD.amounts(2.999, false), {gross: 2.99, receive: 1.99, fee: 1});  // floored, never rounded up
assert.deepEqual(HLWD.amounts('', true), {gross: 0, receive: 0, fee: 1});            // nothing typed
// minimums: $2 signed either way
assert.equal(HLWD.min(false), 2); assert.equal(HLWD.min(true), 1);
// MAX: withdrawable, or withdrawable - $1 when receiving the full amount
assert.equal(HLWD.max(396.03, false), 396.03); assert.equal(HLWD.max(396.03, true), 395.03);
assert.equal(HLWD.max(0.5, true), 0); assert.equal(HLWD.max(1024.1, true), 1023.1);

// insufficient balance: the guard with the $1 on top says the most that can be received
const m = {venues: [{venue: "hyperliquid", balance: 300, exchange_free: 300, live: true, withdrawable: 300, running: []}], strategies: []};
assert.equal(GUARD.withdraw(m, "hyperliquid", 299, 1), null);                     // receive 299: sign 300, fits
let g = GUARD.withdraw(m, "hyperliquid", 300, 1);                                 // receive 300: needs 301
assert.ok(g && g.free === 300 && g.most === 299);
assert.equal(GUARD.withdraw(m, "hyperliquid", 300, 0), null);                     // fee from the amount: 300 fits
assert.equal(g.most, HLWD.max(300, true));                                        // Use max == MAX in this mode

// the same numbers as the server's hl.withdraw_amounts, for many amounts in both modes
const cases = [];
for (let n = 100; n <= 1000000; n += 7919) for (const full of [false, true]) if (full || n >= 200) cases.push([n / 100, full]);
const py = `import json,sys\nfrom withdraw import hl_withdraw as hl\nprint(json.dumps([[hl.withdraw_amounts(a, f)["gross_usd"], hl.withdraw_amounts(a, f)["receive_usd"]] for a, f in json.load(sys.stdin)]))`;
let srv = null;
try { srv = JSON.parse(execFileSync("python3", ["-c", py], {input: JSON.stringify(cases), cwd: new URL("../../", import.meta.url).pathname, encoding: "utf8"})); }
catch (e) { console.log("server comparison skipped:", e.message.split("\n")[0]); }
if (srv) cases.forEach(([a, full], i) => { const d = HLWD.amounts(a, full); assert.deepEqual([d.gross, d.receive], srv[i], `${a} ${full}`); });

// the wallet is asked to sign the gross the summary shows, never the typed amount when the fee comes on top
const core = src.slice(src.indexOf("async function wdHLCore"), src.indexOf("/* ---- Hyperliquid's market groups"));
assert.ok(/receive_full: !!full/.test(core) && /Math\.round\(\+x\.amount \* 100\) !== Math\.round\(d\.gross \* 100\)/.test(core));
assert.ok(/destination\)\.toLowerCase\(\) !== me0/.test(core), "own wallet only");
console.log("hl-withdraw ok", srv ? cases.length + " server cases" : "");

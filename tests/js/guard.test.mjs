// node tests/js/guard.test.mjs [cases.json] — the page's withdraw guard and amount notice (web/wallet/hl-wallet-flows.js,
// between the guard markers), which read the server's money model (me.money).
// Nothing is kept for a strategy (Rivemont is an exchange front end): a withdrawal may take what the exchange itself
// reports as free, and a strategy set above the money on its exchanges says so.
// With a cases file (written by tests/test_withdraw.py from withdraw/balance_guard.py withdraw_check), every case must
// give exactly the server's answer: one rule, in the page and on the server.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = readFileSync(new URL("../../web/wallet/hl-wallet-flows.js", import.meta.url), "utf8");
const block = html.slice(html.indexOf("/*<guard>*/"), html.indexOf("/*</guard>*/"));
assert.ok(block.length > 1000, "guard block found");
const dir = mkdtempSync(join(tmpdir(), "g-"));
writeFileSync(join(dir, "g.mjs"), block + "\nexport default GUARD;\n");
const G = (await import(join(dir, "g.mjs"))).default;

// a model the way money.build shapes it (only the fields the guard reads)
const venue = (v, balance, free, live = true) => ({venue: v, balance, exchange_free: free, live, withdrawable: free, running: []});
let m = {venues: [venue("hyperliquid", 628.35, 628.35), venue("lighter", 612.4, null), venue("aster", 400, 250)], strategies: []};
assert.equal(G.withdraw(m, "hyperliquid", 600), null);                  // all of it is free: fine, whatever bots run
assert.equal(G.withdraw(m, "hyperliquid", 0), null);                    // nothing typed: nothing to say
assert.equal(G.withdraw(m, "lighter", 5000), null);                     // no free figure: Lighter decides itself
let g = G.withdraw(m, "aster", 300);                                    // $250 free: the rest holds positions
assert.ok(g && g.free === 250 && g.most === 250);
g = G.withdraw(m, "aster", 250, 1);                                     // the fee comes on top
assert.ok(g && g.most === 249);
assert.equal(G.withdraw({venues: [venue("aster", 400, 100, false)], strategies: []}, "aster", 300), null);  // stale: no guess

// the notice: the server's shortfall, and the amount that matches what is there
const sh = G.short({venues: [], strategies: [{kind: "carry", id: "funding", name: "Rivemont Auto", amount: 400, venues: ["hyperliquid", "lighter"],
  on_exchanges: 201, shortfall: 199, fix_to: 201, fix_ok: true, min: 200, in_use: 0},
  {kind: "copy", id: "copy", name: "Copy a trader", amount: 500, venues: ["hyperliquid"], on_exchanges: null, shortfall: null, fix_to: null, fix_ok: false}]});
assert.equal(sh.length, 1);                                             // an unknown balance: no notice
assert.ok(sh[0].to === 201 && sh[0].ok && sh[0].have === 201 && sh[0].venue === "hyperliquid");

// the server's own answers (money.withdraw_check) on the models money.build made
if (process.argv[2]) {
  const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const pick = r => r && {free: r.free, most: r.most};
  for (const c of cases) assert.deepEqual(pick(G.withdraw(c.model, c.venue, c.amount, c.fee)), pick(c.expect), JSON.stringify([c.name, c.venue, c.amount]));
  for (const c of cases) assert.deepEqual(G.short(c.model).map(x => [x.kind, x.to, x.ok]),
    c.model.strategies.filter(s => s.shortfall != null && s.shortfall >= 1).map(s => [s.kind, s.fix_to, s.fix_ok]));
  console.log(`guard matches the server on ${cases.length} cases`);
}
console.log("guard ok");

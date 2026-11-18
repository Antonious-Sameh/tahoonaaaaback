/**
 * Dependency-free check of the debt-transfer ACCOUNTING RULES (no MongoDB, no
 * npm packages needed):  node scripts/test-debt-transfer-model.js
 *
 * It re-states, in plain JS, the signed-balance convention used by
 * personBalance.service.js / personService.js / reports.service.js and the
 * validation rules of customerDebtTransfer.service.js, then checks the owner's
 * 13 scenarios plus a randomized property test (net position is invariant,
 * no party is double counted, rules reject exactly what they should).
 *
 * IT IS A MODEL, not the real code: it proves the sign convention and the
 * report bucketing are coherent. The real aggregation pipelines are verified by
 * scripts/test-debt-transfer.js against a real MongoDB replica set.
 */
let passed = 0; let failed = 0;
const check = (n, c, x = '') => { if (c) { passed += 1; } else { failed += 1; console.log(`  ✗ ${n} ${x}`); } };
const r2 = (x) => Math.round(x * 100) / 100;

// raw: customer = "they owe us"; supplier = "we owe them".  owes = what the party owes the SHOP.
const owesSign = { customer: 1, supplier: -1 };
class Ledger {
  constructor() { this.parties = []; this.transfers = []; this.keys = new Set(); }
  add(kind, name, owes = 0) { const p = { id: this.parties.length, kind, name, base: owesSign[kind] * owes }; this.parties.push(p); return p; }
  raw(p) { // transferSign === owesSign
    let t = 0;
    for (const x of this.transfers) { if (x.to === p.id) t += x.amount; if (x.from === p.id) t -= x.amount; }
    return r2(p.base + owesSign[p.kind] * t);
  }
  owes(p) { return r2(owesSign[p.kind] * this.raw(p)); }
  // mirrors createCustomerDebtTransfer's rules
  transfer(from, to, amount, key) {
    if (key && this.keys.has(key)) return { ok: true, dup: true };
    if (from.id === to.id) return { ok: false, why: 'same' };
    const a = r2(Number(amount));
    if (!Number.isFinite(a) || a <= 0) return { ok: false, why: 'amount' };
    const fo = this.owes(from);
    if (fo <= 0) return { ok: false, why: 'nodebt' };
    if (a > fo) return { ok: false, why: 'exceeds' };
    if (to.kind === 'customer' && this.owes(to) < 0) return { ok: false, why: 'targetcredit' };
    this.transfers.push({ from: from.id, to: to.id, amount: a });
    if (key) this.keys.add(key);
    return { ok: true };
  }
  // mirrors getPersonBalanceReport's floor + buckets
  report(kind) {
    let outstanding = 0; let credit = 0;
    for (const p of this.parties.filter((x) => x.kind === kind)) {
      const raw = this.raw(p);
      // customer: raw>0 => they owe us ; supplier: raw>0 => we owe them (remaining), raw<0 => creditOwed
      if (raw > 0) outstanding += raw; else credit += -raw;
    }
    return { outstanding: r2(outstanding), credit: r2(credit) };
  }
  net() { // what the shop is owed minus what it owes, everyone
    const c = this.report('customer'); const s = this.report('supplier');
    return r2(c.outstanding - c.credit + s.credit - s.outstanding);
  }
}
const mk = (cs = [], ss = []) => { const L = new Ledger(); return { L, c: cs.map(([n, o]) => L.add('customer', n, o)), s: ss.map(([n, o]) => L.add('supplier', n, o)) }; };
const sup = (weOwe) => -weOwe; // supplier "owes the shop" figure when the shop owes it weOwe

// 1. customer 3000 -> supplier 0
{ const { L, c: [a], s: [s] } = mk([['a', 3000]], [['s', 0]]); const n = L.net();
  check('1 ok', L.transfer(a, s, 3000).ok); check('1 customer 0', L.owes(a) === 0); check('1 supplier owes shop 3000', L.owes(s) === 3000);
  check('1 supplier report: credit 3000, outstanding 0', L.report('supplier').credit === 3000 && L.report('supplier').outstanding === 0);
  check('1 customers report outstanding 0', L.report('customer').outstanding === 0); check('1 net unchanged', L.net() === n); }
// 2. customer 3000 -> supplier that owes shop 1000
{ const { L, c: [a], s: [s] } = mk([['a', 3000]], [['s', 1000]]); const n = L.net();
  L.transfer(a, s, 3000); check('2 supplier owes 4000', L.owes(s) === 4000 && L.report('supplier').credit === 4000); check('2 net unchanged', L.net() === n); }
// 3. customer 3000 -> supplier the shop owes 1000 (netting)
{ const { L, c: [a], s: [s] } = mk([['a', 3000]], [['s', sup(1000)]]); const n = L.net();
  check('3 before: shop owes 1000', L.report('supplier').outstanding === 1000);
  L.transfer(a, s, 3000); check('3 nets: supplier owes shop 2000', L.owes(s) === 2000 && L.report('supplier').credit === 2000 && L.report('supplier').outstanding === 0);
  check('3 net unchanged', L.net() === n); }
// 4. supplier owes shop 3000 -> customer
{ const { L, c: [b], s: [s] } = mk([['b', 0]], [['s', 3000]]); const n = L.net();
  check('4 ok', L.transfer(s, b, 3000).ok); check('4 supplier 0, customer owes 3000', L.owes(s) === 0 && L.owes(b) === 3000 && L.report('customer').outstanding === 3000); check('4 net', L.net() === n); }
// 5. supplier owes 3000 -> supplier the shop... "عليه 500 للمحل"
{ const { L, s: [x, y] } = mk([], [['x', 3000], ['y', 500]]); const n = L.net();
  L.transfer(x, y, 3000); check('5 dest owes 3500', L.owes(y) === 3500 && L.owes(x) === 0); check('5 net', L.net() === n); }
// 6. supplier owes 3000 -> supplier the shop owes 800
{ const { L, s: [x, y] } = mk([], [['x', 3000], ['y', sup(800)]]); const n = L.net();
  L.transfer(x, y, 3000); check('6 dest: -800 + 3000 = they owe 2200', L.owes(y) === 2200 && L.report('supplier').outstanding === 0 && L.report('supplier').credit === 2200); check('6 net', L.net() === n); }
// 7. partial, 8. successive
{ const { L, c: [a, b], s: [s] } = mk([['a', 3000], ['b', 0]], [['s', sup(5000)]]); const n = L.net();
  L.transfer(a, s, 1000); check('7 partial: a 2000, shop owes s 4000', L.owes(a) === 2000 && L.report('supplier').outstanding === 4000);
  L.transfer(a, b, 500); L.transfer(b, s, 200); L.transfer(a, s, 1500);
  check('8 successive: a 0, b 300, s owes 5000-1000-200-1500=2300 (shop owes)', L.owes(a) === 0 && L.owes(b) === 300 && L.raw(s) === 2300, `${L.owes(a)} ${L.owes(b)} ${L.raw(s)}`); check('8 net', L.net() === n); }
// 9. more than available; 10. zero/negative/garbage; 11. duplicate; same party; no-debt source; customer target with credit
{ const { L, c: [a, b], s: [s] } = mk([['a', 1000], ['b', 0]], [['s', sup(100)]]);
  check('9 exceeds rejected', L.transfer(a, s, 1000.01).why === 'exceeds');
  for (const bad of [0, -5, NaN, 'abc', undefined, null, Infinity]) check(`10 rejects ${String(bad)}`, !L.transfer(a, b, bad).ok);
  check('10 same party rejected', L.transfer(a, a, 10).why === 'same' && L.transfer(s, s, 10).why === 'same');
  check('10 source with no debt rejected (supplier the shop owes)', L.transfer(s, a, 1).why === 'nodebt');
  check('11 first with key ok', L.transfer(a, b, 100, 'k1').ok); check('11 duplicate key is a no-op', L.transfer(a, b, 100, 'k1').dup === true && L.owes(a) === 900 && L.owes(b) === 100);
  L.transfers.push({ from: s.id, to: b.id, amount: 0 }); // no-op marker
}
// 12. two concurrent full-debt transfers == second must be rejected once the first committed
{ const { L, c: [a, b, c] } = mk([['a', 1000], ['b', 0], ['c', 0]]); const r1 = L.transfer(a, b, 1000); const r2_ = L.transfer(a, c, 1000);
  check('12 only one of two full transfers succeeds', r1.ok && !r2_.ok && L.owes(b) + L.owes(c) === 1000); }
// 13. failure => full rollback (model: a transfer that throws leaves no record)
{ const { L, c: [a], s: [s] } = mk([['a', 500]], [['s', 0]]); const before = JSON.stringify(L.transfers); L.transfer(a, s, 9999); check('13 rejected transfer leaves no record', JSON.stringify(L.transfers) === before && L.owes(a) === 500); }

// property test
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let run = 0; run < 300; run += 1) {
  const L = new Ledger(); const ps = [];
  for (let i = 0; i < 6; i += 1) { const kind = rnd() < 0.5 ? 'customer' : 'supplier'; ps.push(L.add(kind, `p${i}`, kind === 'customer' ? Math.floor(rnd() * 2000) : Math.floor((rnd() - 0.5) * 4000))); }
  const n0 = L.net();
  for (let k = 0; k < 40; k += 1) {
    const f = ps[Math.floor(rnd() * 6)]; const t = ps[Math.floor(rnd() * 6)];
    const amt = r2(rnd() * 1500); const res = L.transfer(f, t, amt);
    if (res.ok) check('prop: source never negative after', L.owes(f) >= 0);
  }
  check('prop: net position invariant', L.net() === n0, `${run}`);
  const c = L.report('customer'); const s = L.report('supplier');
  const owedToShop = r2(ps.filter((p) => L.owes(p) > 0).reduce((x, p) => x + L.owes(p), 0));
  const shopOwes = r2(ps.filter((p) => L.owes(p) < 0).reduce((x, p) => x - L.owes(p), 0));
  check('prop: report buckets cover every party exactly once', r2(c.outstanding + s.credit) === owedToShop && r2(c.credit + s.outstanding) === shopOwes, `${run}`);
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

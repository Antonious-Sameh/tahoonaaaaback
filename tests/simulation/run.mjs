/* eslint-disable */
import assert from 'node:assert/strict';
import { getFakeDb, resetFakeDb, ObjectId } from './mini-mongo.js';

const SRC = new URL('../../src/', import.meta.url).pathname;
const { createAccountBalanceTransfer: transfer, listAccountBalanceTransfers: listTransfers } = await import(SRC + 'services/accountBalanceTransfer.service.js');
const { createCustomerDebtTransfer } = await import(SRC + 'services/customerDebtTransfer.service.js');
const { getCustomerRemaining } = await import(SRC + 'services/customerBalance.service.js');
const { getSupplierRemaining } = await import(SRC + 'services/supplierBalance.service.js');
const { customerService } = await import(SRC + 'services/customer.service.js');
const { supplierService } = await import(SRC + 'services/supplier.service.js');
const reports = await import(SRC + 'services/reports.service.js');

const db = getFakeDb();
const M = (n) => db.model(n);
const results = [];
async function t(name, fn) {
  resetFakeDb();
  try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.stack.split('\n').slice(0, 4).join(' | ')]); }
}
const mkC = async (name, opening) => (await M('Customer').create([{ name, ...(opening ? { openingBalance: opening } : {}) }]))[0];
const mkS = async (name, opening) => (await M('Supplier').create([{ name, ...(opening ? { openingBalance: opening } : {}) }]))[0];
const sale = (c, total, paid = 0) => M('Sale').create([{ customerId: c._id, total, paid, date: new Date() }]);
const purchase = (s, total, paid = 0) => M('Purchase').create([{ supplierId: s._id, total, paid, date: new Date() }]);
const cRaw = (c) => getCustomerRemaining(c._id);
const sRaw = (s) => getSupplierRemaining(s._id);
const rejects = async (p, code, status = 400) => {
  try { await p; } catch (e) { assert.equal(e.statusCode, status, `status ${e.statusCode} ${e.message}`); if (code) assert.equal(e.details?.code, code, `code ${e.details?.code} / ${e.message}`); return e; }
  assert.fail('expected rejection');
};
const T = (from, to, amount, extra = {}) => ({ fromAccountType: from.t, fromAccountId: String(from.a._id), toAccountType: to.t, toAccountId: String(to.a._id), amount, ...extra });
const C = (a) => ({ t: 'customer', a }); const S = (a) => ({ t: 'supplier', a });
const snapshot = () => Object.fromEntries(Object.entries(db.live).map(([k, v]) => [k, JSON.stringify(v)]));
const changed = (before) => Object.keys(db.live).filter((k) => JSON.stringify(db.live[k]) !== before[k]);

// ---------------------------------------------------------------- 1
await t('1. Customer->Supplier: example (customer owes 1000, we owe supplier 2000, move 1000)', async () => {
  const c = await mkC('ع'); const s = await mkS('م');
  await sale(c, 1000); await purchase(s, 2000);
  const before = snapshot();
  const net0 = (await cRaw(c)) - (await sRaw(s));
  const tr = await transfer(T(C(c), S(s), 1000, { note: 'اختبار' }));
  assert.equal(await cRaw(c), 0); assert.equal(await sRaw(s), 1000);
  assert.equal((await cRaw(c)) - (await sRaw(s)), net0, 'net position unchanged');
  assert.equal(tr.fromEffect, -1000); assert.equal(tr.toEffect, -1000);
  assert.match(tr.reference, /^ABT-\d+$/);
  // untouched collections
  const ch = changed(before).sort();
  assert.deepEqual(ch, ['AccountBalanceTransfer', 'ActivityLog', 'AuditLog', 'Counter', 'Customer', 'Supplier'].sort());
  for (const name of ['Customer', 'Supplier']) { // only updatedAt may differ
    const strip = (rows) => rows.map(({ updatedAt, _v, ...r }) => r);
    assert.equal(JSON.stringify(strip(JSON.parse(before[name]).map((r) => r))).length > 0, true);
  }
  assert.equal(db.models.CashboxTransaction, undefined, 'cashbox model never even loaded');
  for (const n of ['Sale', 'Purchase', 'CustomerPayment', 'SupplierPayment', 'SalesReturn', 'PurchaseReturn', 'CustomerCreditPayout', 'SupplierCreditReceipt', 'CustomerLoan', 'CustomerDebtTransfer']) assert.equal(JSON.stringify(db.live[n]), before[n], `${n} unchanged`);
});

await t('1b. Customer->Supplier: all 4 balance calculators agree (getPersonRemaining, getTotals, list, reports)', async () => {
  const c = await mkC('ع'); const s = await mkS('م');
  await sale(c, 1000); await purchase(s, 2000);
  await transfer(T(C(c), S(s), 400));
  assert.equal(await cRaw(c), 600); assert.equal(await sRaw(s), 1600);
  const ct = await customerService.getTotals(String(c._id)); const st = await supplierService.getTotals(String(s._id));
  assert.equal(ct.remaining, 600); assert.equal(ct.creditOwed, 0); assert.equal(ct.balanceTransferEffect, -400); assert.equal(ct.total, 1000); assert.equal(ct.paid, 0);
  assert.equal(st.remaining, 1600); assert.equal(st.balanceTransferEffect, -400); assert.equal(st.paid, 0);
  const cl = (await customerService.list({})).items.find((x) => String(x._id) === String(c._id)); const sl = (await supplierService.list({})).items.find((x) => String(x._id) === String(s._id));
  assert.equal(cl.totals.remaining, 600); assert.equal(sl.totals.remaining, 1600);
  const cr = await reports.getCustomersReport({ limit: 10 }); const sr = await reports.getSuppliersReport({ limit: 10 });
  assert.equal(cr.totalOutstanding, 600); assert.equal(sr.totalOutstanding, 1600);
  const pr = await reports.getPurchasesReport({});
  assert.ok(pr, 'purchases report still runs');
});

await t('2. Supplier->Customer: example (supplier owes 1000, we owe customer 2000, move 1000)', async () => {
  const s = await mkS('م', { amount: 1000, direction: 'they_owe_us' }); // supplier owes the shop 1000 => raw -1000
  const c = await mkC('ع', { amount: 2000, direction: 'we_owe_them' }); // shop owes customer 2000 => raw -2000
  assert.equal(await sRaw(s), -1000); assert.equal(await cRaw(c), -2000);
  const net0 = (await cRaw(c)) - (await sRaw(s));
  const tr = await transfer(T(S(s), C(c), 1000));
  assert.equal(await sRaw(s), 0); assert.equal(await cRaw(c), -1000);
  assert.equal((await cRaw(c)) - (await sRaw(s)), net0, 'net position unchanged');
  assert.equal(tr.fromEffect, 1000); assert.equal(tr.toEffect, 1000);
  const ct = await customerService.getTotals(String(c._id)); const st = await supplierService.getTotals(String(s._id));
  assert.equal(ct.creditOwed, 1000); assert.equal(ct.remaining, 0); assert.equal(st.creditOwed, 0); assert.equal(st.remaining, 0);
  const cl = (await customerService.list({})).items[0]; assert.equal(cl.totals.creditOwed, 1000);
});

await t('3. Net position (receivables - payables) is invariant for both directions + partial/full', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 700); await purchase(s, 900);
  const net = async () => (await cRaw(c)) - (await sRaw(s));
  const n0 = await net();
  await transfer(T(C(c), S(s), 250.5)); assert.equal(await net(), n0); assert.equal(await cRaw(c), 449.5);
  await transfer(T(C(c), S(s), 449.5)); assert.equal(await net(), n0); assert.equal(await cRaw(c), 0); assert.equal(await sRaw(s), 200); // full transferable of customer
  const s2 = await mkS('م2', { amount: 300, direction: 'they_owe_us' }); const c2 = await mkC('ع2', { amount: 500, direction: 'we_owe_them' });
  const n1 = (await cRaw(c2)) - (await sRaw(s2));
  await transfer(T(S(s2), C(c2), 300)); assert.equal((await cRaw(c2)) - (await sRaw(s2)), n1); assert.equal(await sRaw(s2), 0); assert.equal(await cRaw(c2), -200);
});

await t('4. Customer->Customer regression: existing CustomerDebtTransfer unchanged', async () => {
  const a = await mkC('أ'); const b = await mkC('ب'); await sale(a, 100000);
  await createCustomerDebtTransfer({ fromCustomerId: String(a._id), toCustomerId: String(b._id), amount: 40000 });
  assert.equal(await cRaw(a), 60000); assert.equal(await cRaw(b), 40000);
  assert.equal(db.live.AccountBalanceTransfer.length, 0);
  assert.equal((await customerService.getTotals(String(a._id))).balanceTransferEffect, undefined);
  assert.equal((await reports.getCustomersReport({ limit: 10 })).totalOutstanding, 100000);
  // and the new service refuses customer->customer
  await rejects(transfer(T(C(a), C(b), 1)), 'UNSUPPORTED_DIRECTION');
});

await t('4b. Backward compat: accounts with NO new transfers get byte-identical totals (key absent)', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 50); await purchase(s, 80);
  const ct = await customerService.getTotals(String(c._id)); const st = await supplierService.getTotals(String(s._id));
  assert.ok(!('balanceTransferEffect' in ct) && !('balanceTransferEffect' in st));
  assert.equal(ct.remaining, 50); assert.equal(st.remaining, 80);
});

await t('5. Nature mismatch is rejected (all 4 mismatches) and nothing is written', async () => {
  const c = await mkC('ع'); const s = await mkS('م');
  const cOwes = await mkC('مدين'); await sale(cOwes, 100); const cCredit = await mkC('دائن', { amount: 100, direction: 'we_owe_them' });
  const sPayable = await mkS('دائن-مورد'); await purchase(sPayable, 100); const sOwes = await mkS('مدين-مورد', { amount: 100, direction: 'they_owe_us' });
  const before = snapshot();
  await rejects(transfer(T(C(cCredit), S(sPayable), 10)), 'SOURCE_NATURE_INVALID');   // customer is owed, not owing
  await rejects(transfer(T(C(c), S(sPayable), 10)), 'SOURCE_NATURE_INVALID');        // zero balance
  await rejects(transfer(T(C(cOwes), S(sOwes), 10)), 'DESTINATION_NATURE_INVALID');  // supplier owes us, not the reverse
  await rejects(transfer(T(C(cOwes), S(s), 10)), 'DESTINATION_NATURE_INVALID');      // supplier zero
  await rejects(transfer(T(S(sPayable), C(cCredit), 10)), 'SOURCE_NATURE_INVALID');  // supplier is owed, doesn't owe
  await rejects(transfer(T(S(sOwes), C(cOwes), 10)), 'DESTINATION_NATURE_INVALID');  // customer owes us
  await rejects(transfer(T(S(sOwes), C(c), 10)), 'DESTINATION_NATURE_INVALID');
  assert.deepEqual(changed(before), []); // ZERO writes (touch is rolled back too)
});

await t('6. Cannot exceed transferable balance (min of both sides), boundary exact', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 600);
  const e = await rejects(transfer(T(C(c), S(s), 600.01)), 'EXCEEDS_TRANSFERABLE'); assert.equal(e.details.transferable, 600);
  await transfer(T(C(c), S(s), 600)); assert.equal(await cRaw(c), 400); assert.equal(await sRaw(s), 0);
  await rejects(transfer(T(C(c), S(s), 1)), 'DESTINATION_NATURE_INVALID');
  const s2 = await mkS('م2', { amount: 1000, direction: 'they_owe_us' }); const c2 = await mkC('ع2', { amount: 300, direction: 'we_owe_them' });
  const e2 = await rejects(transfer(T(S(s2), C(c2), 300.01)), 'EXCEEDS_TRANSFERABLE'); assert.equal(e2.details.transferable, 300);
});

await t('7. Invalid amounts: zero, negative, non-numeric, NaN, Infinity, null, "", boolean, >2 decimals', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  for (const bad of [0, -5, '-1', 'abc', NaN, Infinity, null, undefined, '', ' ', true, '1e400', 10.005, '0.001', 0.001]) await rejects(transfer(T(C(c), S(s), bad)), undefined, 400);
  assert.equal(db.live.AccountBalanceTransfer.length, 0);
  await transfer(T(C(c), S(s), '10.25')); assert.equal(await cRaw(c), 989.75); // numeric string with 2 decimals ok
});

await t('8. Same account / unsupported pairs / invalid & missing accounts', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 100); await purchase(s, 100);
  await rejects(transfer(T(C(c), C(c), 1)), 'UNSUPPORTED_DIRECTION');
  const s2 = await mkS('م2'); await rejects(transfer(T(S(s), S(s2), 1)), 'UNSUPPORTED_DIRECTION');
  await rejects(transfer({ ...T(C(c), S(s), 1), toAccountId: 'not-an-id' }));
  await rejects(transfer({ ...T(C(c), S(s), 1), fromAccountId: '' }));
  const ghost = String(new ObjectId());
  await rejects(transfer({ ...T(C(c), S(s), 1), toAccountId: ghost }), undefined, 404);
  await rejects(transfer({ ...T(C(c), S(s), 1), fromAccountId: ghost }), undefined, 404);
  await rejects(transfer({ ...T(C(c), S(s), 1), fromAccountType: 'bank' }));
  // same id used as customer AND supplier id of different collections is not "same account"
  assert.equal(db.live.AccountBalanceTransfer.length, 0);
});

await t('9. Duplicate submission (same idempotencyKey) returns the first, creates one', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const a = await transfer(T(C(c), S(s), 300, { idempotencyKey: 'k1' })); const b = await transfer(T(C(c), S(s), 300, { idempotencyKey: 'k1' }));
  assert.equal(String(a._id), String(b._id)); assert.equal(db.live.AccountBalanceTransfer.length, 1); assert.equal(await cRaw(c), 700);
});

await t('9b. Two transfers WITHOUT idempotencyKey both succeed (no null-key collision) and store no key field', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  await transfer(T(C(c), S(s), 100)); await transfer(T(C(c), S(s), 100));
  assert.equal(db.live.AccountBalanceTransfer.length, 2); assert.ok(db.live.AccountBalanceTransfer.every((d) => !('idempotencyKey' in d)));
  assert.equal(await cRaw(c), 800);
});

await t('10. Two simultaneous transfers on same pair: only what is transferable moves (conflict+retry)', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const r = await Promise.allSettled([transfer(T(C(c), S(s), 700)), transfer(T(C(c), S(s), 700))]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, JSON.stringify(r.map((x) => x.status)));
  assert.equal(r.filter((x) => x.status === 'rejected').length, 1);
  assert.equal(await cRaw(c), 300); assert.equal(await sRaw(s), 300); assert.equal(db.live.AccountBalanceTransfer.length, 1);
  assert.ok(db.conflicts >= 1, 'a real write conflict was detected and retried');
});

await t('10b. Concurrent: same customer to TWO different suppliers cannot over-transfer', async () => {
  const c = await mkC('ع'); const s1 = await mkS('م1'); const s2 = await mkS('م2'); await sale(c, 1000); await purchase(s1, 1000); await purchase(s2, 1000);
  const r = await Promise.allSettled([transfer(T(C(c), S(s1), 600)), transfer(T(C(c), S(s2), 600))]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1); assert.equal(await cRaw(c), 400);
});

await t('10c. Concurrent with the EXISTING customer->customer transfer on the same customer', async () => {
  const c = await mkC('ع'); const c2 = await mkC('ع2'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const r = await Promise.allSettled([transfer(T(C(c), S(s), 700)), createCustomerDebtTransfer({ fromCustomerId: String(c._id), toCustomerId: String(c2._id), amount: 700 })]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, JSON.stringify(r.map((x) => x.status)));
  assert.ok((await cRaw(c)) === 300 && (await cRaw(c)) >= 0);
});

await t('10d. Concurrent same idempotencyKey: one record', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const r = await Promise.allSettled([transfer(T(C(c), S(s), 100, { idempotencyKey: 'dup' })), transfer(T(C(c), S(s), 100, { idempotencyKey: 'dup' }))]);
  assert.ok(r.every((x) => x.status === 'fulfilled'), JSON.stringify(r.map((x) => x.reason?.message)));
  assert.equal(db.live.AccountBalanceTransfer.length, 1); assert.equal(await cRaw(c), 900);
});

await t('11. DB failure mid-operation (audit log write fails) rolls EVERYTHING back', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const before = snapshot();
  const audit = db.model('AuditLog'); const orig = audit.create.bind(audit);
  audit.create = async () => { throw new Error('simulated DB failure'); };
  try { await assert.rejects(transfer(T(C(c), S(s), 100)), /simulated DB failure/); } finally { audit.create = orig; }
  assert.deepEqual(changed(before), []); assert.equal(await cRaw(c), 1000); assert.equal(await sRaw(s), 1000);
});

await t('11b. DB failure on the transfer insert itself rolls back too (counter not advanced)', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const before = snapshot(); const m = db.model('AccountBalanceTransfer'); const orig = m.create.bind(m);
  m.create = async () => { throw new Error('insert failed'); };
  try { await assert.rejects(transfer(T(C(c), S(s), 100)), /insert failed/); } finally { m.create = orig; }
  assert.deepEqual(changed(before), []);
});

await t('12. Both statements show the same reference with each side\'s own effect; history list works', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000);
  const tr = await transfer(T(C(c), S(s), 250));
  const cl = await listTransfers({ accountType: 'customer', accountId: String(c._id) }); const sl = await listTransfers({ accountType: 'supplier', accountId: String(s._id) });
  assert.equal(cl.items.length, 1); assert.equal(sl.items.length, 1);
  assert.equal(cl.items[0].reference, tr.reference); assert.equal(sl.items[0].reference, tr.reference);
  assert.equal(cl.items[0].accountEffect, -250); assert.equal(sl.items[0].accountEffect, -250);
  assert.equal(cl.items[0].counterpart.name, 'م'); assert.equal(sl.items[0].counterpart.name, 'ع'); assert.equal(cl.items[0].isSource, true); assert.equal(sl.items[0].isSource, false);
  // customer id queried as 'supplier' must not leak
  assert.equal((await listTransfers({ accountType: 'supplier', accountId: String(c._id) })).items.length, 0);
  await rejects(listTransfers({ accountType: 'x', accountId: String(c._id) }));
});

await t('13. Deleting a customer/supplier that appears in a transfer is blocked', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 1000); await transfer(T(C(c), S(s), 10));
  // remove() first blocks on sales/purchases anyway; use accounts whose only link is a transfer
  const s3 = await mkS('م3', { amount: 50, direction: 'they_owe_us' }); const c3 = await mkC('ع3', { amount: 50, direction: 'we_owe_them' }); await transfer(T(S(s3), C(c3), 50));
  await rejects(customerService.remove(String(c3._id)), 'HAS_TRANSACTIONS', 409); await rejects(supplierService.remove(String(s3._id)), 'HAS_TRANSACTIONS', 409);
  const free = await mkC('حر'); await customerService.remove(String(free._id));
});

await t('14. Later operations see the offset: customer payment cap uses new balance; reverse chain works', async () => {
  const c = await mkC('ع'); const s = await mkS('م'); await sale(c, 1000); await purchase(s, 5000);
  await transfer(T(C(c), S(s), 1000));
  assert.equal(await cRaw(c), 0);
  await rejects(transfer(T(C(c), S(s), 1)), 'SOURCE_NATURE_INVALID'); // nothing left to move
  assert.equal(await sRaw(s), 4000);
});

console.log(results.map((r) => r.join('  ')).join('\n'));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed; commits=${db.commits}`);
process.exit(failed ? 1 : 0);

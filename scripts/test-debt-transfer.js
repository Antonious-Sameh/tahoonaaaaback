/**
 * End-to-end check of the customer/supplier debt-transfer feature against a
 * REAL MongoDB (needs a replica set — transactions). Never run this against
 * production data: it creates its own customers/suppliers and DROPS the
 * database it connects to when it finishes.
 *
 *   TEST_MONGODB_URI="mongodb://127.0.0.1:27017/debt_transfer_test?replicaSet=rs0" \
 *     node scripts/test-debt-transfer.js
 *
 * The database name must contain "test" or the script refuses to run.
 */
import mongoose from 'mongoose';

const uri = process.env.TEST_MONGODB_URI;
if (!uri || !/test/i.test(uri.split('?')[0].split('/').pop())) {
  console.error('Set TEST_MONGODB_URI to a throwaway database whose name contains "test".');
  process.exit(2);
}
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-only-access-secret-not-for-production';
process.env.ADMIN_READONLY_KEY = process.env.ADMIN_READONLY_KEY || 'test-only-admin-readonly-key-not-for-production';

const { default: Customer } = await import('../src/models/Customer.js');
const { default: Supplier } = await import('../src/models/Supplier.js');
const { default: Sale } = await import('../src/models/Sale.js');
const { default: Purchase } = await import('../src/models/Purchase.js');
const { default: CashboxTransaction } = await import('../src/models/CashboxTransaction.js');
const { default: CustomerDebtTransfer } = await import('../src/models/CustomerDebtTransfer.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: ActivityLog } = await import('../src/models/ActivityLog.js');
const { customerService } = await import('../src/services/customer.service.js');
const { supplierService } = await import('../src/services/supplier.service.js');
const { createCustomerDebtTransfer, listCustomerDebtTransfers } = await import('../src/services/customerDebtTransfer.service.js');
const { createSupplierCreditReceipt } = await import('../src/services/supplierCreditReceipt.service.js');
const reports = await import('../src/services/reports.service.js');
const cashbox = await import('../src/services/cashbox.service.js');

let passed = 0;
let failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name} ${extra}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- helpers --------------------------------------------------------------
let seq = 0;
const mkCustomer = (name, { owes = 0, credit = 0 } = {}) => Customer.create({
  name,
  openingBalance: owes ? { amount: owes, direction: 'they_owe_us' } : credit ? { amount: credit, direction: 'we_owe_them' } : { amount: 0 },
});
// For a supplier: weOwe = the shop owes the supplier, theyOwe = the supplier owes the shop.
const mkSupplier = (name, { weOwe = 0, theyOwe = 0 } = {}) => Supplier.create({
  name,
  openingBalance: weOwe ? { amount: weOwe, direction: 'we_owe_them' } : theyOwe ? { amount: theyOwe, direction: 'they_owe_us' } : { amount: 0, direction: 'we_owe_them' },
});
const cBal = async (c) => { const t = (await customerService.getOne(c._id)).totals; return { remaining: t.remaining, creditOwed: t.creditOwed }; };
const sBal = async (s) => { const t = (await supplierService.getOne(s._id)).totals; return { remaining: t.remaining, creditOwed: t.creditOwed }; };
const eq = (a, b) => a.remaining === b.remaining && a.creditOwed === b.creditOwed;
const show = (o) => `{remaining:${o.remaining}, creditOwed:${o.creditOwed}}`;
const K = () => `k-${Date.now()}-${(seq += 1)}-${Math.random()}`;
const T = (from, to, amount, extra = {}) => createCustomerDebtTransfer({
  ...(from.kind === 'c' ? { fromCustomerId: String(from.doc._id) } : { fromSupplierId: String(from.doc._id) }),
  ...(to.kind === 'c' ? { toCustomerId: String(to.doc._id) } : { toSupplierId: String(to.doc._id) }),
  amount, idempotencyKey: K(), ...extra,
});
const C = (doc) => ({ kind: 'c', doc });
const S = (doc) => ({ kind: 's', doc });

const snapshotGlobals = async () => {
  const [cash, sales, purchases, salesRep, profitRep, purchRep] = await Promise.all([
    cashbox.getSummary(),
    Sale.aggregate([{ $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$total' }, paid: { $sum: '$paid' }, profit: { $sum: '$profit' } } }]),
    Purchase.aggregate([{ $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$total' }, paid: { $sum: '$paid' } } }]),
    reports.getSalesReport({}),
    reports.getProfitReport({}),
    reports.getPurchasesReport({}),
  ]);
  const cashCount = await CashboxTransaction.countDocuments();
  const strip = (r) => JSON.stringify(r, (k, v) => (k === 'supplierBalances' || k === 'topCustomers' || k === 'topSuppliers' ? undefined : v));
  return JSON.stringify({ cash, cashCount, sales, purchases, salesRep: strip(salesRep), profitRep: strip(profitRep), purchRep: strip(purchRep) });
};

// ---- run ------------------------------------------------------------------
await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
await mongoose.connection.dropDatabase();
for (const m of Object.values(mongoose.models)) await m.init();

try {
  // Real-looking activity so "untouched" assertions mean something.
  const seedC = await mkCustomer('seed-customer');
  const seedS = await mkSupplier('seed-supplier');
  await Sale.collection.insertOne({
    invoiceNumber: 'T-1', customerId: seedC._id,
    items: [{ productId: new mongoose.Types.ObjectId(), name: 'p', price: 100, cost: 60, quantity: 50 }],
    subtotal: 5000, discount: 0, total: 5000, paid: 1000, remaining: 4000, profit: 2000, paymentMethod: 'credit', date: new Date(),
  });
  await Purchase.collection.insertOne({
    purchaseNumber: 'P-1', supplierId: seedS._id,
    items: [{ productId: new mongoose.Types.ObjectId(), name: 'p', price: 60, quantity: 50 }],
    subtotal: 3000, discount: 0, total: 3000, paid: 500, remaining: 2500, paymentMethod: 'credit', date: new Date(),
  });
  await CashboxTransaction.create([{ type: 'in', amount: 7777, reason: 'seed', refType: 'manual', date: new Date() }]);
  const before = await snapshotGlobals();

  section('1. customer -> customer (existing behaviour)');
  let a = await mkCustomer('C-A', { owes: 3000 });
  let b = await mkCustomer('C-B');
  await T(C(a), C(b), 3000);
  check('A: 3000 -> 0', eq(await cBal(a), { remaining: 0, creditOwed: 0 }));
  check('B: 0 -> 3000', eq(await cBal(b), { remaining: 3000, creditOwed: 0 }));

  section('2. customer -> supplier (supplier balance 0)');
  a = await mkCustomer('C2-A', { owes: 3000 });
  let s = await mkSupplier('S2');
  await T(C(a), S(s), 3000);
  check('customer 0', eq(await cBal(a), { remaining: 0, creditOwed: 0 }), show(await cBal(a)));
  check('supplier owes the shop 3000 (creditOwed 3000, remaining 0)', eq(await sBal(s), { remaining: 0, creditOwed: 3000 }), show(await sBal(s)));

  section('3. customer -> supplier the supplier ALREADY owes the shop 1000');
  a = await mkCustomer('C3-A', { owes: 3000 });
  s = await mkSupplier('S3', { theyOwe: 1000 });
  await T(C(a), S(s), 3000);
  check('supplier owes 4000', eq(await sBal(s), { remaining: 0, creditOwed: 4000 }), show(await sBal(s)));

  section('4. customer -> supplier the shop OWES 1000 (netting)');
  a = await mkCustomer('C4-A', { owes: 3000 });
  s = await mkSupplier('S4', { weOwe: 1000 });
  await T(C(a), S(s), 3000);
  check('supplier net owes the shop 2000', eq(await sBal(s), { remaining: 0, creditOwed: 2000 }), show(await sBal(s)));
  check('customer 0', eq(await cBal(a), { remaining: 0, creditOwed: 0 }));

  section('5. partial: customer -> supplier the shop owes 5000, move 3000');
  a = await mkCustomer('C5-A', { owes: 3000 });
  s = await mkSupplier('S5', { weOwe: 5000 });
  await T(C(a), S(s), 1000);
  check('customer 2000', eq(await cBal(a), { remaining: 2000, creditOwed: 0 }));
  check('shop owes supplier 4000 now', eq(await sBal(s), { remaining: 4000, creditOwed: 0 }), show(await sBal(s)));

  section('6. supplier -> supplier');
  let s1 = await mkSupplier('S6-1', { theyOwe: 2000 });
  let s2 = await mkSupplier('S6-2');
  await T(S(s1), S(s2), 1500);
  check('source supplier owes 500', eq(await sBal(s1), { remaining: 0, creditOwed: 500 }), show(await sBal(s1)));
  check('destination supplier owes 1500', eq(await sBal(s2), { remaining: 0, creditOwed: 1500 }), show(await sBal(s2)));
  let s3 = await mkSupplier('S6-3', { weOwe: 400 });
  await T(S(s1), S(s3), 500);
  check('dest supplier the shop owed 400 -> owes 100 net', eq(await sBal(s3), { remaining: 0, creditOwed: 100 }), show(await sBal(s3)));
  check('source now 0', eq(await sBal(s1), { remaining: 0, creditOwed: 0 }));

  section('7. supplier -> customer');
  s = await mkSupplier('S7', { theyOwe: 2000 });
  b = await mkCustomer('C7-B', { owes: 500 });
  await T(S(s), C(b), 800);
  check('supplier owes 1200', eq(await sBal(s), { remaining: 0, creditOwed: 1200 }), show(await sBal(s)));
  check('customer 500 + 800 = 1300', eq(await cBal(b), { remaining: 1300, creditOwed: 0 }), show(await cBal(b)));

  section('8. rules / rejections');
  s = await mkSupplier('S8', { theyOwe: 1000 });
  a = await mkCustomer('C8-A', { owes: 1000 });
  b = await mkCustomer('C8-B');
  const cr = await mkCustomer('C8-credit', { credit: 500 });
  const countBefore = await CustomerDebtTransfer.countDocuments();
  let e = await rejects(() => T(C(a), S(s), 1000.01));
  check('amount above debt rejected (customer source)', e?.statusCode === 400, String(e?.message));
  e = await rejects(() => T(S(s), C(b), 1000.01));
  check('amount above debt rejected (supplier source)', e?.statusCode === 400);
  e = await rejects(() => T(C(a), S(s), 0));
  check('zero rejected', e?.statusCode === 400);
  e = await rejects(() => T(C(a), S(s), -5));
  check('negative rejected', e?.statusCode === 400);
  e = await rejects(() => T(C(a), C(a), 10));
  check('same customer rejected', e?.statusCode === 400);
  e = await rejects(() => T(S(s), S(s), 10));
  check('same supplier rejected', e?.statusCode === 400);
  e = await rejects(() => T(C(b), S(s), 10));
  check('source with no debt rejected', e?.statusCode === 400);
  const s8credit = await mkSupplier('S8-credit', { weOwe: 900 });
  e = await rejects(() => T(S(s8credit), C(b), 10));
  check('supplier the shop owes has nothing to transfer', e?.statusCode === 400);
  e = await rejects(() => T(S(s), C(cr), 100));
  check('customer destination the shop owes credit to is still refused', e?.statusCode === 400);
  e = await rejects(() => T(C(a), S({ _id: new mongoose.Types.ObjectId() }), 10));
  check('missing destination -> 404', e?.statusCode === 404);
  e = await rejects(() => createCustomerDebtTransfer({ fromCustomerId: String(a._id), fromSupplierId: String(s._id), toCustomerId: String(b._id), amount: 10 }));
  check('both customer and supplier on one side rejected', e?.statusCode === 400);
  check('no transfer record was created by any rejection', (await CustomerDebtTransfer.countDocuments()) === countBefore);
  check('balances untouched by rejections', eq(await cBal(a), { remaining: 1000, creditOwed: 0 }) && eq(await sBal(s), { remaining: 0, creditOwed: 1000 }));

  section('9. duplicate submission');
  a = await mkCustomer('C9-A', { owes: 1000 });
  s = await mkSupplier('S9');
  const key = K();
  const r1 = await T(C(a), S(s), 400, { idempotencyKey: key });
  const r2 = await T(C(a), S(s), 400, { idempotencyKey: key });
  check('same key twice returns the same record', String(r1._id) === String(r2._id));
  check('applied once', eq(await cBal(a), { remaining: 600, creditOwed: 0 }) && eq(await sBal(s), { remaining: 0, creditOwed: 400 }));
  const key2 = K();
  const both = await Promise.allSettled([T(C(a), S(s), 100, { idempotencyKey: key2 }), T(C(a), S(s), 100, { idempotencyKey: key2 })]);
  check('concurrent double-click: both succeed with one record', both.every((x) => x.status === 'fulfilled') && (await CustomerDebtTransfer.countDocuments({ idempotencyKey: key2 })) === 1, JSON.stringify(both.map((x) => x.status)));
  check('applied once (500 left)', eq(await cBal(a), { remaining: 500, creditOwed: 0 }), show(await cBal(a)));

  section('10. concurrency: two different transfers of the full debt');
  a = await mkCustomer('C10-A', { owes: 1000 });
  s = await mkSupplier('S10');
  const s10b = await mkSupplier('S10b');
  const res = await Promise.allSettled([T(C(a), S(s), 1000), T(C(a), S(s10b), 1000)]);
  const ok = res.filter((x) => x.status === 'fulfilled').length;
  check('exactly one succeeds', ok === 1, JSON.stringify(res.map((x) => x.status)));
  const sum = (await sBal(s)).creditOwed + (await sBal(s10b)).creditOwed;
  check('total moved is exactly 1000 (never over-transferred)', sum === 1000 && (await cBal(a)).remaining === 0, `sum=${sum}`);

  section('11. atomicity: failure after the write rolls everything back');
  a = await mkCustomer('C11-A', { owes: 1000 });
  s = await mkSupplier('S11');
  const origCreate = AuditLog.create.bind(AuditLog);
  AuditLog.create = async () => { throw new Error('simulated failure'); };
  e = await rejects(() => T(C(a), S(s), 500));
  AuditLog.create = origCreate;
  check('operation failed', !!e);
  check('no transfer record left behind', (await CustomerDebtTransfer.countDocuments({ fromCustomerId: a._id })) === 0);
  check('neither balance moved', eq(await cBal(a), { remaining: 1000, creditOwed: 0 }) && eq(await sBal(s), { remaining: 0, creditOwed: 0 }));

  section('12. history / statements / linkage');
  a = await mkCustomer('C12-A', { owes: 1000 });
  s = await mkSupplier('S12');
  const rec = await T(C(a), S(s), 250, { note: 'ملاحظة' });
  const la = await listCustomerDebtTransfers({ customerId: String(a._id) });
  const ls = await listCustomerDebtTransfers({ supplierId: String(s._id) });
  check('listed under the source customer', la.items.length === 1 && String(la.items[0]._id) === String(rec._id));
  check('listed under the destination supplier — SAME record (linked)', ls.items.length === 1 && String(ls.items[0]._id) === String(rec._id));
  check('record carries from/to kind, names, amount, date', ls.items[0].fromType === 'customer' && ls.items[0].toType === 'supplier' && ls.items[0].fromName === 'C12-A' && ls.items[0].toName === 'S12' && ls.items[0].amount === 250 && !!ls.items[0].date);
  check('snapshot balances after (750 / 250)', ls.items[0].fromBalanceAfter === 750 && ls.items[0].toBalanceAfter === 250, `${ls.items[0].fromBalanceAfter}/${ls.items[0].toBalanceAfter}`);
  check('not listed for unrelated parties', (await listCustomerDebtTransfers({ customerId: String(b._id) })).items.every((x) => String(x.fromCustomerId) === String(b._id) || String(x.toCustomerId) === String(b._id)));
  check('totals expose transferredOut/In', (await customerService.getOne(a._id)).totals.transferredOut === 250 && (await supplierService.getOne(s._id)).totals.transferredIn === 250);
  check('activity + audit entries written', (await ActivityLog.countDocuments({ refId: rec._id })) === 1 && (await AuditLog.countDocuments({ entityId: rec._id })) === 1);
  const delErr = await rejects(() => supplierService.remove(s._id));
  check('supplier in a transfer cannot be deleted', delErr?.statusCode === 409);

  section('13. legacy record (written before suppliers existed)');
  const la1 = await mkCustomer('L-A', { owes: 900 });
  const lb1 = await mkCustomer('L-B');
  await CustomerDebtTransfer.collection.insertOne({
    fromCustomerId: la1._id, toCustomerId: lb1._id, fromName: 'L-A', toName: 'L-B', amount: 400,
    fromBalanceAfter: 500, toBalanceAfter: 400, note: '', date: new Date(), createdAt: new Date(), updatedAt: new Date(),
  });
  check('legacy balances correct', eq(await cBal(la1), { remaining: 500, creditOwed: 0 }) && eq(await cBal(lb1), { remaining: 400, creditOwed: 0 }));
  const ll = await listCustomerDebtTransfers({ customerId: String(la1._id) });
  check('legacy record reads as customer/customer', ll.items[0].fromType === 'customer' && ll.items[0].toType === 'customer');
  await T(C(lb1), S(await mkSupplier('L-S')), 400);
  check('can be moved onward after a legacy transfer', eq(await cBal(lb1), { remaining: 0, creditOwed: 0 }));

  section('14. list() (customers/suppliers pages) and reports agree with getOne');
  const listed = (await supplierService.list({ search: 'S6-' })).items;
  const byName = Object.fromEntries(listed.map((x) => [x.name, x.totals]));
  check('supplier list: S6-1 / S6-2 / S6-3', byName['S6-1'].creditOwed === 0 && byName['S6-2'].creditOwed === 1500 && byName['S6-3'].creditOwed === 100, JSON.stringify(Object.values(byName).map((t) => t.creditOwed)));
  const cl = (await customerService.list({ search: 'C7-B' })).items[0];
  check('customer list matches getOne', cl.totals.remaining === 1300);
  const custRep = await reports.getCustomersReport({ limit: 200 });
  const supRep = await reports.getSuppliersReport({ limit: 200 });
  const expectCust = (await Promise.all((await Customer.find()).map((c) => cBal(c)))).reduce((x, y) => x + y.remaining, 0);
  const expectSup = (await Promise.all((await Supplier.find()).map((x) => sBal(x)))).reduce((x, y) => x + y.remaining, 0);
  check('customers report total outstanding == sum of customer balances', Math.abs(custRep.totalOutstanding - expectCust) < 0.005, `${custRep.totalOutstanding} vs ${expectCust}`);
  check('suppliers report total outstanding == sum of supplier balances', Math.abs(supRep.totalOutstanding - expectSup) < 0.005, `${supRep.totalOutstanding} vs ${expectSup}`);

  section('15. the supplier\'s normal flows still work on the new balance');
  s = await mkSupplier('S15');
  a = await mkCustomer('C15-A', { owes: 1000 });
  await T(C(a), S(s), 1000);
  const rcpt = await createSupplierCreditReceipt({ supplierId: String(s._id), amount: 1000, idempotencyKey: K() });
  check('supplier settles the transferred debt in cash (credit receipt)', !!rcpt && eq(await sBal(s), { remaining: 0, creditOwed: 0 }), show(await sBal(s)));

  section('16. nothing else moved');
  // Cash rose only by the one credit receipt above (a genuine cash event) — undo it for the comparison.
  const after = await snapshotGlobals();
  const strip = (j) => { const o = JSON.parse(j); delete o.cash; delete o.cashCount; return JSON.stringify(o); };
  check('sales / purchases / profit / reports figures identical to before', strip(before) === strip(after));
  const cashCountNow = await CashboxTransaction.countDocuments();
  check('cashbox only has the seed entry + the 1 genuine receipt', cashCountNow === 2, String(cashCountNow));
  check('no Sale/Purchase/CustomerPayment created by transfers', (await Sale.countDocuments()) === 1 && (await Purchase.countDocuments()) === 1);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

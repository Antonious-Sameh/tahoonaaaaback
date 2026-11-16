import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Supplier from '../models/Supplier.js';
import CustomerDebtTransfer from '../models/CustomerDebtTransfer.js';
import { AppError } from '../middleware/errorHandler.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { recordActivity } from './activityLog.service.js';
import { recordAuditLog } from './auditLog.service.js';
import { withTransaction } from '../utils/transactions.js';
import { round2 } from '../models/shared/money.js';
import { getCustomerRemaining } from './customerBalance.service.js';
import { getSupplierRemaining } from './supplierBalance.service.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Moves part or all of one customer's debt to another customer — e.g. A owes
 * 100,000, 40,000 is transferred to B, so A owes 60,000 and B owes 40,000.
 * See CustomerDebtTransfer.js for what a transfer is (and is not).
 *
 * What this function deliberately NEVER does: create a CashboxTransaction,
 * a CustomerPayment, a Sale, or touch any existing invoice. No money moved,
 * nothing was sold — only who owes it changed. The only writes are the
 * transfer record itself plus the activity/audit entries (and a no-op
 * "touch" of the two customer documents, see below).
 *
 * Every rule is enforced here, server-side, against a fresh read taken
 * inside the same transaction — nothing is trusted from the caller:
 *  - the two customers must be different, and both must exist;
 *  - `amount` must be positive;
 *  - the source must actually owe money (a source with no debt, or one the
 *    shop owes credit to, has nothing to transfer);
 *  - `amount` can never exceed what the source currently owes;
 *  - the destination must not be owed credit by the shop (creditOwed) — a
 *    transfer into such an account would silently net against that credit,
 *    a settlement this feature intentionally does not perform. Settle the
 *    credit first (e.g. via a credit payout), then transfer.
 *
 * Concurrency: getCustomerRemaining is a read (an aggregate), and two
 * concurrent transactions that each only READ a balance and then write a
 * new document never conflict with each other in MongoDB — so two
 * simultaneous transfers out of the same customer could each pass the
 * "amount <= remaining" check against the same starting balance and
 * together move more than the customer owes. To close that, both customer
 * documents are written to (touched) at the very start of the transaction,
 * before any balance is read: a second concurrent transfer touching either
 * customer then hits a write conflict, and withTransaction retries it
 * against the fresh, already-updated state (its own docstring explains the
 * retry). Documents are touched in a fixed order (by id) so two transfers
 * in opposite directions between the same pair of customers can't wait on
 * each other. This protects transfer-vs-transfer only; it does not (and
 * need not) serialize against unrelated operations like a payment, which
 * already validate against their own live balance read.
 *
 * Either side can be a customer OR a supplier (all four directions). One
 * rule keeps the maths identical to every other part of the system: a
 * transfer always moves "debt owed TO THE SHOP". `owes` below is that figure
 * for a party — a customer's `remaining` (their raw balance, +1), a
 * supplier's `-raw` (a supplier's raw balance is "we owe them", so the
 * amount THEY owe us is its negative, -1). The source's `owes` goes down by
 * `amount`, the destination's goes up by `amount`, and the same signs are used
 * by personBalance.service.js / personService.js / reports.service.js when
 * they fold the transfer into each balance, so nothing is ever counted twice
 * or with a flipped sign. Example: the shop owes a supplier 1,000 (owes = -1,000)
 * and a customer's 3,000 debt is moved onto it -> owes = +2,000, i.e. the
 * supplier now owes the shop a net 2,000.
 *
 * Destination rule by kind: a CUSTOMER that the shop owes credit to is still
 * refused (the existing rule, unchanged). A SUPPLIER may receive debt while
 * the shop owes it money — the transfer simply nets against what the shop
 * owes the supplier, as the owner specified.
 *
 * `idempotencyKey` (optional) is the same duplicate-submission guard the
 * other money endpoints use: a retry with the same key returns the original
 * transfer instead of creating a second one.
 */
const PARTIES = {
  customer: {
    Model: Customer,
    getRaw: getCustomerRemaining,
    // owes-the-shop figure = sign * raw balance (see docstring above).
    owesSign: 1,
    idField: { from: 'fromCustomerId', to: 'toCustomerId' },
    activityType: 'customer',
    label: 'العميل',
    sourceLabel: 'العميل المصدر',
    targetLabel: 'العميل المستلم',
  },
  supplier: {
    Model: Supplier,
    getRaw: getSupplierRemaining,
    owesSign: -1,
    idField: { from: 'fromSupplierId', to: 'toSupplierId' },
    activityType: 'supplier',
    label: 'المورد',
    sourceLabel: 'المورد المصدر',
    targetLabel: 'المورد المستلم',
  },
};

/**
 * Reads one side of the request body: exactly one of the customer/supplier
 * ids must be present. Returns `{ type, id }`.
 */
function resolveSide(side, customerId, supplierId) {
  const hasCustomer = customerId !== undefined && customerId !== null && customerId !== '';
  const hasSupplier = supplierId !== undefined && supplierId !== null && supplierId !== '';
  const sideLabel = side === 'from' ? 'المصدر' : 'المستلم';
  if (hasCustomer && hasSupplier) {
    throw new AppError(`يجب تحديد طرف واحد فقط (عميل أو مورد) للطرف ${sideLabel}`, 400);
  }
  if (!hasCustomer && !hasSupplier) {
    throw new AppError(`الطرف ${sideLabel} غير محدد`, 400);
  }
  const type = hasCustomer ? 'customer' : 'supplier';
  const id = hasCustomer ? customerId : supplierId;
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(`معرّف ${side === 'from' ? PARTIES[type].sourceLabel : PARTIES[type].targetLabel} غير صالح`, 400);
  }
  return { type, id: String(id) };
}

export async function createCustomerDebtTransfer({ fromCustomerId, fromSupplierId, toCustomerId, toSupplierId, amount, note, idempotencyKey }) {
  const fromSide = resolveSide('from', fromCustomerId, fromSupplierId);
  const toSide = resolveSide('to', toCustomerId, toSupplierId);

  if (fromSide.type === toSide.type && fromSide.id === toSide.id) {
    throw new AppError(
      fromSide.type === 'customer' ? 'لا يمكن نقل مديونية من عميل إلى نفسه' : 'لا يمكن نقل مديونية من مورد إلى نفسه',
      400,
      { code: 'SAME_CUSTOMER' },
    );
  }

  const amountNum = round2(Number(amount));
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    throw new AppError('قيمة النقل يجب أن تكون أكبر من صفر', 400);
  }

  const key = idempotencyKey && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : null;
  const fromKind = PARTIES[fromSide.type];
  const toKind = PARTIES[toSide.type];

  return withTransaction(async (session) => {
    if (key) {
      const existing = await CustomerDebtTransfer.findOne({ idempotencyKey: key }).session(session);
      if (existing) return existing;
    }

    // Touch both parties first, in a fixed order — see the docstring's
    // Concurrency section. `updatedAt` is set explicitly so this is always a
    // real write (a conflicting concurrent transaction is what we're after),
    // and matchedCount doubles as the existence check. The order key includes
    // the type so a customer and a supplier are ordered consistently too.
    const touchOrder = [
      { side: 'from', ...fromSide },
      { side: 'to', ...toSide },
    ].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    for (const item of touchOrder) {
      const kind = PARTIES[item.type];
      const touched = await kind.Model.updateOne({ _id: item.id }, { $set: { updatedAt: new Date() } }, { session });
      if (touched.matchedCount === 0) {
        throw new AppError(`${item.side === 'from' ? kind.sourceLabel : kind.targetLabel} غير موجود`, 404);
      }
    }

    const [from, to] = await Promise.all([
      fromKind.Model.findById(fromSide.id).session(session),
      toKind.Model.findById(toSide.id).session(session),
    ]);
    if (!from) throw new AppError(`${fromKind.sourceLabel} غير موجود`, 404);
    if (!to) throw new AppError(`${toKind.targetLabel} غير موجود`, 404);

    // "How much does each side owe the shop right now" — see the docstring.
    const fromRaw = await fromKind.getRaw(from._id, session);
    const fromOwes = round2(fromKind.owesSign * fromRaw);
    if (fromOwes <= 0) {
      throw new AppError(`لا توجد مديونية على ${fromKind.sourceLabel} لنقلها`, 400, { code: 'NO_DEBT_TO_TRANSFER' });
    }
    if (amountNum > fromOwes) {
      throw new AppError(
        `مبلغ النقل أكبر من المديونية المتاحة على ${fromKind.sourceLabel}`,
        400,
        { code: 'EXCEEDS_REMAINING', remaining: fromOwes },
      );
    }

    const toRaw = await toKind.getRaw(to._id, session);
    const toOwes = round2(toKind.owesSign * toRaw);
    // Customers keep the original rule (refuse a destination the shop owes
    // credit to). A supplier destination nets against what the shop owes it.
    if (toSide.type === 'customer' && toOwes < 0) {
      throw new AppError(
        'العميل المستلم له رصيد مستحق عند المحل — لا يمكن النقل إليه قبل تسوية رصيده',
        400,
        { code: 'TARGET_HAS_CREDIT', creditOwed: round2(-toOwes) },
      );
    }

    const fromBalanceAfter = round2(fromOwes - amountNum);
    const toBalanceAfter = round2(toOwes + amountNum);

    let created;
    try {
      [created] = await CustomerDebtTransfer.create(
        [{
          fromType: fromSide.type,
          toType: toSide.type,
          [fromKind.idField.from]: from._id,
          [toKind.idField.to]: to._id,
          fromName: from.name,
          toName: to.name,
          amount: amountNum,
          fromBalanceAfter,
          toBalanceAfter,
          note: note || '',
          idempotencyKey: key,
        }],
        { session },
      );
    } catch (err) {
      // Rare race: two requests with the same idempotencyKey both passed the
      // findOne above — the sparse unique index catches it here.
      if (key && isDuplicateKeyError(err)) {
        const raced = await CustomerDebtTransfer.findOne({ idempotencyKey: key }).session(session);
        if (raced) return raced;
      }
      throw err;
    }

    await recordActivity(
      {
        type: fromKind.activityType,
        description: `تم نقل مديونية بمبلغ ${amountNum} من ${fromKind.label} ${from.name} إلى ${toKind.label} ${to.name}`,
        amount: amountNum,
        refId: created._id,
      },
      { session },
    );

    // Action name kept as-is for every direction so existing audit-log
    // filters keep working; the parties' kinds are in `values`.
    await recordAuditLog(
      {
        action: 'customer.debtTransfer.create',
        entityType: 'CustomerDebtTransfer',
        entityId: created._id,
        values: {
          fromType: fromSide.type,
          toType: toSide.type,
          fromId: from._id,
          toId: to._id,
          amount: amountNum,
          fromBalanceBefore: fromOwes,
          fromBalanceAfter,
          toBalanceBefore: toOwes,
          toBalanceAfter,
          note: note || '',
        },
      },
      { session },
    );

    return created;
  });
}

/**
 * Transfers this customer OR supplier took part in — as source or
 * destination — newest first, paginated. Pass exactly one of `customerId` /
 * `supplierId`. Each row carries both names (snapshotted at transfer time)
 * and both sides' kinds (`fromType`/`toType`, 'customer' for every record
 * written before suppliers were supported) so the page can say "to X" or
 * "from Y" without a second lookup.
 */
export async function listCustomerDebtTransfers({ customerId, supplierId, page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (customerId && supplierId) {
    throw new AppError('حدد عميلاً أو مورداً فقط', 400);
  }
  const type = supplierId ? 'supplier' : 'customer';
  const personId = supplierId || customerId;
  if (!personId || !mongoose.isValidObjectId(personId)) {
    throw new AppError(type === 'supplier' ? 'معرّف مورد غير صالح' : 'معرّف عميل غير صالح', 400);
  }

  const pageNum = Math.max(1, Math.trunc(Number(page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PAGE_SIZE));
  const oid = new mongoose.Types.ObjectId(personId);
  const { from: fromField, to: toField } = PARTIES[type].idField;
  const match = { $or: [{ [fromField]: oid }, { [toField]: oid }] };

  const [rows, total] = await Promise.all([
    CustomerDebtTransfer.find(match).sort({ date: -1 }).skip((pageNum - 1) * pageSize).limit(pageSize).lean(),
    CustomerDebtTransfer.countDocuments(match),
  ]);
  const items = rows.map((row) => ({ ...row, fromType: row.fromType || 'customer', toType: row.toType || 'customer' }));

  return {
    items,
    pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

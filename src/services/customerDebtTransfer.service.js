import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import CustomerDebtTransfer from '../models/CustomerDebtTransfer.js';
import { AppError } from '../middleware/errorHandler.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { recordActivity } from './activityLog.service.js';
import { recordAuditLog } from './auditLog.service.js';
import { withTransaction } from '../utils/transactions.js';
import { round2 } from '../models/shared/money.js';
import { getCustomerRemaining } from './customerBalance.service.js';

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
 * `idempotencyKey` (optional) is the same duplicate-submission guard the
 * other money endpoints use: a retry with the same key returns the original
 * transfer instead of creating a second one.
 */
export async function createCustomerDebtTransfer({ fromCustomerId, toCustomerId, amount, note, idempotencyKey }) {
  if (!fromCustomerId || !mongoose.isValidObjectId(fromCustomerId)) {
    throw new AppError('معرّف العميل المصدر غير صالح', 400);
  }
  if (!toCustomerId || !mongoose.isValidObjectId(toCustomerId)) {
    throw new AppError('معرّف العميل المستلم غير صالح', 400);
  }
  if (String(fromCustomerId) === String(toCustomerId)) {
    throw new AppError('لا يمكن نقل مديونية من عميل إلى نفسه', 400, { code: 'SAME_CUSTOMER' });
  }

  const amountNum = round2(Number(amount));
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    throw new AppError('قيمة النقل يجب أن تكون أكبر من صفر', 400);
  }

  const key = idempotencyKey && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : null;

  return withTransaction(async (session) => {
    if (key) {
      const existing = await CustomerDebtTransfer.findOne({ idempotencyKey: key }).session(session);
      if (existing) return existing;
    }

    // Touch both customers first, in a fixed order — see the docstring's
    // Concurrency section. `updatedAt` is set explicitly so this is always a
    // real write (a conflicting concurrent transaction is what we're after),
    // and matchedCount doubles as the existence check.
    const ids = [String(fromCustomerId), String(toCustomerId)].sort();
    for (const id of ids) {
      const touched = await Customer.updateOne({ _id: id }, { $set: { updatedAt: new Date() } }, { session });
      if (touched.matchedCount === 0) {
        throw new AppError(String(fromCustomerId) === id ? 'العميل المصدر غير موجود' : 'العميل المستلم غير موجود', 404);
      }
    }

    const [from, to] = await Promise.all([
      Customer.findById(fromCustomerId).session(session),
      Customer.findById(toCustomerId).session(session),
    ]);
    if (!from) throw new AppError('العميل المصدر غير موجود', 404);
    if (!to) throw new AppError('العميل المستلم غير موجود', 404);

    const fromRemaining = await getCustomerRemaining(from._id, session);
    if (fromRemaining <= 0) {
      throw new AppError('لا توجد مديونية على العميل المصدر لنقلها', 400, { code: 'NO_DEBT_TO_TRANSFER' });
    }
    if (amountNum > fromRemaining) {
      throw new AppError(
        'مبلغ النقل أكبر من المديونية المتاحة على العميل المصدر',
        400,
        { code: 'EXCEEDS_REMAINING', remaining: fromRemaining },
      );
    }

    const toRemaining = await getCustomerRemaining(to._id, session);
    if (toRemaining < 0) {
      throw new AppError(
        'العميل المستلم له رصيد مستحق عند المحل — لا يمكن النقل إليه قبل تسوية رصيده',
        400,
        { code: 'TARGET_HAS_CREDIT', creditOwed: round2(-toRemaining) },
      );
    }

    const fromBalanceAfter = round2(fromRemaining - amountNum);
    const toBalanceAfter = round2(toRemaining + amountNum);

    let created;
    try {
      [created] = await CustomerDebtTransfer.create(
        [{
          fromCustomerId: from._id,
          toCustomerId: to._id,
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
        type: 'customer',
        description: `تم نقل مديونية بمبلغ ${amountNum} من العميل ${from.name} إلى العميل ${to.name}`,
        amount: amountNum,
        refId: created._id,
      },
      { session },
    );

    await recordAuditLog(
      {
        action: 'customer.debtTransfer.create',
        entityType: 'CustomerDebtTransfer',
        entityId: created._id,
        values: {
          fromCustomerId: from._id,
          toCustomerId: to._id,
          amount: amountNum,
          fromBalanceBefore: fromRemaining,
          fromBalanceAfter,
          toBalanceBefore: toRemaining,
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
 * Transfers this customer took part in — as source OR destination — newest
 * first, paginated. Each row carries both names (snapshotted at transfer
 * time) so the page can say "to X" or "from Y" without a second lookup.
 */
export async function listCustomerDebtTransfers({ customerId, page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (!customerId || !mongoose.isValidObjectId(customerId)) {
    throw new AppError('معرّف عميل غير صالح', 400);
  }

  const pageNum = Math.max(1, Math.trunc(Number(page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PAGE_SIZE));
  const oid = new mongoose.Types.ObjectId(customerId);
  const match = { $or: [{ fromCustomerId: oid }, { toCustomerId: oid }] };

  const [items, total] = await Promise.all([
    CustomerDebtTransfer.find(match).sort({ date: -1 }).skip((pageNum - 1) * pageSize).limit(pageSize).lean(),
    CustomerDebtTransfer.countDocuments(match),
  ]);

  return {
    items,
    pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

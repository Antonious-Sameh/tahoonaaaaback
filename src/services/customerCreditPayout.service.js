import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import CustomerCreditPayout from '../models/CustomerCreditPayout.js';
import CashboxTransaction from '../models/CashboxTransaction.js';
import { AppError } from '../middleware/errorHandler.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { recordActivity } from './activityLog.service.js';
import { recordAuditLog } from './auditLog.service.js';
import { withTransaction } from '../utils/transactions.js';
import { round2 } from '../models/shared/money.js';
import { getCustomerRemaining } from './customerBalance.service.js';
import { getBalance } from './cashbox.service.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Pays back part or all of a customer's creditOwed balance (money the shop
 * owes THEM — see personService.js's getTotals doc block, almost always
 * arising from a return worth more than what they still owed at the time).
 * The mirror-image of createCustomerPayment: that records money coming IN
 * from a customer against `remaining`; this records money going OUT to a
 * customer against `creditOwed`.
 *
 * Before this existed, creditOwed was a purely informational figure with no
 * way to actually settle it in the system — the shop owner would hand the
 * customer cash and have nothing to show for it here, permanently
 * overstating creditOwed and leaving no cashbox trail for money that
 * genuinely left the register.
 *
 * `getCustomerRemaining` returns a single signed figure (negative means
 * credit owed to the customer) — the current creditOwed is derived from it
 * the same way personService.getTotals derives its own creditOwed.
 *
 * Rejects an amount larger than the current creditOwed (same "no invented
 * balance" policy as createCustomerPayment rejecting overpaying past
 * `remaining`), and — since this is real cash leaving the register — also
 * rejects an amount larger than what's actually in the cashbox right now
 * (same balance-sufficiency rule as purchase.service.js/
 * supplierPayment.service.js's own 'out' transactions).
 */
export async function createCustomerCreditPayout({ customerId, amount, note, idempotencyKey }) {
  if (!customerId || !mongoose.isValidObjectId(customerId)) {
    throw new AppError('معرّف عميل غير صالح', 400);
  }

  const amountNum = round2(Number(amount));
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    throw new AppError('قيمة الدفع يجب أن تكون أكبر من صفر', 400);
  }

  const key = idempotencyKey && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : null;

  const payout = await withTransaction(async (session) => {
    if (key) {
      const existing = await CustomerCreditPayout.findOne({ idempotencyKey: key }).session(session);
      if (existing) return existing;
    }

    const customer = await Customer.findById(customerId).session(session);
    if (!customer) throw new AppError('العميل غير موجود', 404);

    const rawRemaining = await getCustomerRemaining(customer._id, session);
    const currentCreditOwed = rawRemaining < 0 ? round2(-rawRemaining) : 0;

    if (currentCreditOwed <= 0) {
      throw new AppError('لا يوجد مبلغ مستحق لهذا العميل حاليًا', 400, { code: 'NO_CREDIT_OWED' });
    }
    if (amountNum > currentCreditOwed) {
      throw new AppError(
        'المبلغ أكبر من المستحق الفعلي لهذا العميل',
        400,
        { code: 'EXCEEDS_CREDIT_OWED', creditOwed: currentCreditOwed },
      );
    }

    // Real cash leaving the register — same balance-sufficiency rule as
    // every other 'out' transaction in this project (purchase payments,
    // supplier settlements, manual withdrawals, expenses).
    const cashboxBalance = await getBalance(session);
    if (amountNum > cashboxBalance) {
      throw new AppError('رصيد الصندوق غير كافٍ لدفع هذا المبلغ للعميل', 400);
    }

    const creditOwedAfter = round2(currentCreditOwed - amountNum);

    let created;
    try {
      [created] = await CustomerCreditPayout.create(
        [{ customerId: customer._id, amount: amountNum, creditOwedAfter, note: note || '', idempotencyKey: key }],
        { session },
      );
    } catch (err) {
      // Rare race: two requests with the same idempotencyKey both passed
      // the findOne check above and both reached create() — the sparse
      // unique index catches it here.
      if (key && isDuplicateKeyError(err)) {
        const raced = await CustomerCreditPayout.findOne({ idempotencyKey: key }).session(session);
        if (raced) return raced;
      }
      throw err;
    }

    await CashboxTransaction.create(
      [{
        type: 'out',
        amount: amountNum,
        reason: `دفع مستحق للعميل ${customer.name}`,
        refType: 'customer_credit_payout',
        refId: created._id,
        date: created.date,
      }],
      { session },
    );

    await recordActivity(
      {
        type: 'customer',
        description: `تم دفع مستحق للعميل ${customer.name} بمبلغ ${amountNum}`,
        amount: amountNum,
        refId: created._id,
      },
      { session },
    );

    await recordAuditLog(
      {
        action: 'customer.creditPayout.create',
        entityType: 'CustomerCreditPayout',
        entityId: created._id,
        values: { customerId: customer._id, amount: amountNum, creditOwedBefore: currentCreditOwed, creditOwedAfter },
      },
      { session },
    );

    return created;
  });

  return payout;
}

/** Matches the shape of listCustomerPayments: paginated, newest first, scoped to one customer. */
export async function listCustomerCreditPayouts({ customerId, page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (!customerId || !mongoose.isValidObjectId(customerId)) {
    throw new AppError('معرّف عميل غير صالح', 400);
  }

  const pageNum = Math.max(1, Math.trunc(Number(page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PAGE_SIZE));
  const skip = (pageNum - 1) * pageSize;

  const [{ items, totalCount }] = await CustomerCreditPayout.aggregate([
    { $match: { customerId: new mongoose.Types.ObjectId(customerId) } },
    { $sort: { date: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: pageSize }],
        totalCount: [{ $count: 'count' }],
      },
    },
  ]);

  const total = totalCount[0]?.count || 0;
  return {
    items,
    pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

/**
 * Deletes a payout AND its linked cashbox transaction together — same
 * undo pattern as deleteExpense/deleteCustomerPayment/deleteSupplierPayment.
 * Safe by construction: creditOwed is always computed live (see
 * personService.getTotals), never stored, so removing this payout
 * automatically makes the customer's creditOwed correct again.
 */
export async function deleteCustomerCreditPayout(id) {
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new AppError('معرّف العملية غير صالح', 400);
  }
  const payout = await CustomerCreditPayout.findById(id);
  if (!payout) throw new AppError('العملية غير موجودة', 404);

  return withTransaction(async (session) => {
    const customer = await Customer.findById(payout.customerId).session(session);

    await CustomerCreditPayout.deleteOne({ _id: id }, { session });
    await CashboxTransaction.deleteMany({ refType: 'customer_credit_payout', refId: id }, { session });

    await recordActivity(
      {
        type: 'customer',
        description: `تم حذف دفع مستحق بمبلغ ${payout.amount} للعميل ${customer?.name || ''}`,
        amount: payout.amount,
      },
      { session },
    );
    await recordAuditLog(
      {
        action: 'customer.creditPayout.delete',
        entityType: 'CustomerCreditPayout',
        entityId: payout._id,
        values: { customerId: payout.customerId, amount: payout.amount },
      },
      { session },
    );

    return { success: true };
  });
}
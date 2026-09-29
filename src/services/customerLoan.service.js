import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import CustomerLoan from '../models/CustomerLoan.js';
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
 * Hands a customer a loan/advance — unconditional (no check against their
 * current balance in either direction; see CustomerLoan.js for why this
 * differs from CustomerCreditPayout). The only real constraint is the
 * cashbox itself: this is genuine cash leaving the register, so it can
 * never exceed what's actually in there (same `getBalance` check as
 * CustomerCreditPayout / SupplierPayment).
 */
export async function createCustomerLoan({ customerId, amount, note, idempotencyKey }) {
  if (!customerId || !mongoose.isValidObjectId(customerId)) {
    throw new AppError('معرّف عميل غير صالح', 400);
  }

  const amountNum = round2(Number(amount));
  if (Number.isNaN(amountNum) || amountNum <= 0) {
    throw new AppError('قيمة السلفة يجب أن تكون أكبر من صفر', 400);
  }

  const key = idempotencyKey && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : null;

  const loan = await withTransaction(async (session) => {
    if (key) {
      const existing = await CustomerLoan.findOne({ idempotencyKey: key }).session(session);
      if (existing) return existing;
    }

    const customer = await Customer.findById(customerId).session(session);
    if (!customer) throw new AppError('العميل غير موجود', 404);

    const cashboxBalance = await getBalance(session);
    if (amountNum > cashboxBalance) {
      throw new AppError('رصيد الصندوق غير كافٍ لصرف هذه السلفة', 400, { code: 'INSUFFICIENT_CASHBOX' });
    }

    // Unconditional: a loan adds to what the customer owes regardless of
    // their current balance (debt, zero, or even credit owed to them — see
    // this function's own docstring and CustomerLoan.js).
    const currentRemaining = await getCustomerRemaining(customer._id, session);
    const balanceAfter = round2(currentRemaining + amountNum);

    let created;
    try {
      [created] = await CustomerLoan.create(
        [{ customerId: customer._id, amount: amountNum, balanceAfter, note: note || '', idempotencyKey: key }],
        { session },
      );
    } catch (err) {
      // Rare race: two requests with the same idempotencyKey both passed
      // the findOne check above and both reached create() — the sparse
      // unique index catches it here.
      if (key && isDuplicateKeyError(err)) {
        const raced = await CustomerLoan.findOne({ idempotencyKey: key }).session(session);
        if (raced) return raced;
      }
      throw err;
    }

    await CashboxTransaction.create(
      [{
        type: 'out',
        amount: amountNum,
        reason: `سلفة للعميل ${customer.name}`,
        refType: 'customer_loan',
        refId: created._id,
        date: created.date,
      }],
      { session },
    );

    await recordActivity(
      {
        type: 'customer',
        description: `تم صرف سلفة للعميل ${customer.name} بمبلغ ${amountNum}`,
        amount: amountNum,
        refId: created._id,
      },
      { session },
    );

    await recordAuditLog(
      {
        action: 'customer.loan.create',
        entityType: 'CustomerLoan',
        entityId: created._id,
        values: { customerId: customer._id, amount: amountNum, balanceBefore: currentRemaining, balanceAfter },
      },
      { session },
    );

    return created;
  });

  return loan;
}

/** Matches the shape of listCustomerCreditPayouts: paginated, newest first, scoped to one customer. */
export async function listCustomerLoans({ customerId, page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (!customerId || !mongoose.isValidObjectId(customerId)) {
    throw new AppError('معرّف عميل غير صالح', 400);
  }

  const pageNum = Math.max(1, Math.trunc(Number(page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PAGE_SIZE));
  const skip = (pageNum - 1) * pageSize;

  const [{ items, totalCount }] = await CustomerLoan.aggregate([
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
 * Deletes a loan AND its linked cashbox transaction together — same undo
 * pattern as deleteCustomerCreditPayout, but with one extra guard: a loan
 * increases what the customer owes, so removing it decreases it. If the
 * customer has since paid down their balance counting on that loan being
 * part of what they owed, removing it retroactively could push their
 * balance negative (i.e. make it look like they overpaid). Blocked
 * outright rather than silently allowed — same "no operation may leave an
 * inconsistent balance behind" principle as the cashbox-sufficiency checks
 * elsewhere, just checked against the CUSTOMER's balance here instead of
 * the cashbox's (deleting this is always safe for the cashbox itself: an
 * 'out' transaction being removed only ever adds cash back).
 */
export async function deleteCustomerLoan(id) {
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new AppError('معرّف السلفة غير صالح', 400);
  }
  const loan = await CustomerLoan.findById(id);
  if (!loan) throw new AppError('السلفة غير موجودة', 404);

  return withTransaction(async (session) => {
    const customer = await Customer.findById(loan.customerId).session(session);

    // Current balance already includes this loan (not yet deleted) — what
    // it would be WITHOUT it is simply that minus the loan amount.
    const currentRemaining = await getCustomerRemaining(loan.customerId, session);
    if (round2(currentRemaining - loan.amount) < 0) {
      throw new AppError(
        'متقدرش تحذف السلفة دي — العميل سدد جزء بافتراض إنها عليه، وحذفها هيخلي رصيده يدخل بالسالب',
        400,
        { code: 'WOULD_GO_NEGATIVE' },
      );
    }

    await CustomerLoan.deleteOne({ _id: id }, { session });
    await CashboxTransaction.deleteMany({ refType: 'customer_loan', refId: id }, { session });

    await recordActivity(
      {
        type: 'customer',
        description: `تم حذف سلفة بمبلغ ${loan.amount} للعميل ${customer?.name || ''}`,
        amount: loan.amount,
      },
      { session },
    );
    await recordAuditLog(
      {
        action: 'customer.loan.delete',
        entityType: 'CustomerLoan',
        entityId: loan._id,
        values: { customerId: loan.customerId, amount: loan.amount },
      },
      { session },
    );

    return { success: true };
  });
}

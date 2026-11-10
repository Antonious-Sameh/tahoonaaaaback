import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Supplier from '../models/Supplier.js';
import AccountBalanceTransfer from '../models/AccountBalanceTransfer.js';
import { AppError } from '../middleware/errorHandler.js';
import { isDuplicateKeyError } from '../utils/mongoErrors.js';
import { getRequestContext } from '../utils/requestContext.js';
import { recordActivity } from './activityLog.service.js';
import { recordAuditLog } from './auditLog.service.js';
import { withTransaction } from '../utils/transactions.js';
import { nextSequence } from './sequence.service.js';
import { getCustomerRemaining } from './customerBalance.service.js';
import { getSupplierRemaining } from './supplierBalance.service.js';
import { DIRECTIONS, TransferRuleError, resolveDirection, parseAmount, planTransfer } from './accountBalanceTransfer.rules.js';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const MODELS = { customer: Customer, supplier: Supplier };
const LABELS = {
  customer: { word: 'العميل', notFoundFrom: 'العميل المصدر غير موجود', notFoundTo: 'العميل المستلم غير موجود' },
  supplier: { word: 'المورد', notFoundFrom: 'المورد المصدر غير موجود', notFoundTo: 'المورد المستلم غير موجود' },
};

const getRemainingByType = (type, id, session) => (type === 'customer' ? getCustomerRemaining(id, session) : getSupplierRemaining(id, session));

function toAppError(err) {
  if (err instanceof TransferRuleError) {
    return new AppError(err.message, 400, { code: err.code, ...(err.details || {}) });
  }
  return err;
}

/**
 * Offsets (مقاصة) part or all of a Customer's balance against a Supplier's —
 * customer -> supplier or supplier -> customer. See AccountBalanceTransfer.js
 * for what a transfer is, and accountBalanceTransfer.rules.js for the exact
 * accounting rules (which balance natures are allowed, the transferable
 * maximum, and the signed effect on each side). Customer -> Customer stays
 * with customerDebtTransfer.service.js, untouched.
 *
 * What this function deliberately NEVER does: create a CashboxTransaction, a
 * Sale, a Purchase, any payment/receipt/return, or touch stock. The only
 * writes are the transfer record, the activity/audit entries, and a no-op
 * "touch" of the two account documents (see Concurrency).
 *
 * Everything is validated server-side against a fresh read inside the same
 * transaction; nothing is trusted from the caller. Existence is the only
 * "active" notion in this data model (Customer/Supplier have no inactive flag
 * and are hard-deleted), so a missing account is rejected with 404.
 *
 * Concurrency: same technique as createCustomerDebtTransfer — both account
 * documents are written to (touched) at the very start of the transaction,
 * in a fixed order, before any balance is read. Two simultaneous transfers
 * that involve either account then hit a write conflict, and withTransaction
 * retries the loser against the fresh state, so together they can never move
 * more than is transferable. The same touch also serializes against a
 * concurrent Customer -> Customer debt transfer involving the same customer.
 * (The transfer reference comes from an atomic Counter, which is a second,
 * independent serialization point between any two transfers.)
 *
 * `idempotencyKey` (optional): a retry with the same key returns the original
 * transfer instead of creating a second one.
 */
export async function createAccountBalanceTransfer({ fromAccountType, fromAccountId, toAccountType, toAccountId, amount, note, idempotencyKey }) {
  let direction;
  let amountNum;
  try {
    direction = resolveDirection(fromAccountType, toAccountType);
    amountNum = parseAmount(amount);
  } catch (err) {
    throw toAppError(err);
  }
  if (!fromAccountId || !mongoose.isValidObjectId(fromAccountId)) throw new AppError('معرّف الحساب المصدر غير صالح', 400);
  if (!toAccountId || !mongoose.isValidObjectId(toAccountId)) throw new AppError('معرّف الحساب المستلم غير صالح', 400);

  const key = idempotencyKey && String(idempotencyKey).trim() ? String(idempotencyKey).trim() : null;
  const cleanNote = note ? String(note).trim().slice(0, 500) : '';

  return withTransaction(async (session) => {
    if (key) {
      const existing = await AccountBalanceTransfer.findOne({ idempotencyKey: key }).session(session);
      if (existing) return existing;
    }

    // Touch both accounts first, in a fixed order (see Concurrency above).
    // matchedCount doubles as the existence check.
    const accounts = [
      { role: 'from', type: fromAccountType, id: String(fromAccountId) },
      { role: 'to', type: toAccountType, id: String(toAccountId) },
    ].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
    for (const acc of accounts) {
      const touched = await MODELS[acc.type].updateOne({ _id: acc.id }, { $set: { updatedAt: new Date() } }, { session });
      if (touched.matchedCount === 0) {
        throw new AppError(acc.role === 'from' ? LABELS[acc.type].notFoundFrom : LABELS[acc.type].notFoundTo, 404);
      }
    }

    const [from, to] = await Promise.all([
      MODELS[fromAccountType].findById(fromAccountId).session(session),
      MODELS[toAccountType].findById(toAccountId).session(session),
    ]);
    if (!from) throw new AppError(LABELS[fromAccountType].notFoundFrom, 404);
    if (!to) throw new AppError(LABELS[toAccountType].notFoundTo, 404);

    const [fromRaw, toRaw] = await Promise.all([
      getRemainingByType(fromAccountType, from._id, session),
      getRemainingByType(toAccountType, to._id, session),
    ]);
    const customerRaw = fromAccountType === 'customer' ? fromRaw : toRaw;
    const supplierRaw = fromAccountType === 'supplier' ? fromRaw : toRaw;

    let plan;
    try {
      plan = planTransfer({ direction, customerRaw, supplierRaw, amount: amountNum });
    } catch (err) {
      throw toAppError(err);
    }

    const reference = await nextSequence('accountBalanceTransfer', 'ABT', session);

    let created;
    try {
      [created] = await AccountBalanceTransfer.create(
        [{
          reference,
          fromAccountType,
          fromAccountId: from._id,
          toAccountType,
          toAccountId: to._id,
          fromName: from.name,
          toName: to.name,
          amount: amountNum,
          fromEffect: plan.fromEffect,
          toEffect: plan.toEffect,
          fromBalanceAfter: plan.fromBalanceAfter,
          toBalanceAfter: plan.toBalanceAfter,
          note: cleanNote,
          createdByDeviceId: getRequestContext()?.deviceId || null,
          // Omitted entirely (never null) when there is no key — see the model's index.
          ...(key ? { idempotencyKey: key } : {}),
        }],
        { session },
      );
    } catch (err) {
      // Rare race: two requests with the same idempotencyKey both passed the
      // findOne above — the sparse unique index catches it here.
      if (key && isDuplicateKeyError(err)) {
        const raced = await AccountBalanceTransfer.findOne({ idempotencyKey: key }).session(session);
        if (raced) return raced;
      }
      throw err;
    }

    await recordActivity(
      {
        type: fromAccountType,
        description: `مقاصة ${created.reference}: نقل ${amountNum} من ${LABELS[fromAccountType].word} ${from.name} إلى ${LABELS[toAccountType].word} ${to.name}`,
        amount: amountNum,
        refId: created._id,
      },
      { session },
    );

    await recordAuditLog(
      {
        action: 'accountBalanceTransfer.create',
        entityType: 'AccountBalanceTransfer',
        entityId: created._id,
        values: {
          reference,
          direction,
          fromAccountType,
          fromAccountId: from._id,
          toAccountType,
          toAccountId: to._id,
          amount: amountNum,
          fromBalanceBefore: fromRaw,
          fromBalanceAfter: plan.fromBalanceAfter,
          toBalanceBefore: toRaw,
          toBalanceAfter: plan.toBalanceAfter,
          note: cleanNote,
        },
      },
      { session },
    );

    return created;
  });
}

/**
 * Transfers an account took part in — as source OR destination — newest
 * first, paginated. Each row carries `accountEffect` (the signed effect on
 * the queried account — the same figure its balance formula uses) and the
 * `counterpart` account, so a statement can show the same reference on both
 * sides with each side's own effect.
 */
export async function listAccountBalanceTransfers({ accountType, accountId, page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  if (!MODELS[accountType]) throw new AppError('نوع الحساب غير صالح', 400);
  if (!accountId || !mongoose.isValidObjectId(accountId)) throw new AppError('معرّف الحساب غير صالح', 400);

  const pageNum = Math.max(1, Math.trunc(Number(page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PAGE_SIZE));
  const oid = new mongoose.Types.ObjectId(String(accountId));
  const match = {
    $or: [
      { fromAccountType: accountType, fromAccountId: oid },
      { toAccountType: accountType, toAccountId: oid },
    ],
  };

  const [rows, total] = await Promise.all([
    AccountBalanceTransfer.find(match).sort({ date: -1 }).skip((pageNum - 1) * pageSize).limit(pageSize).lean(),
    AccountBalanceTransfer.countDocuments(match),
  ]);

  const items = rows.map((row) => {
    const isFrom = row.fromAccountType === accountType && String(row.fromAccountId) === String(oid);
    return {
      ...row,
      isSource: isFrom,
      accountEffect: isFrom ? row.fromEffect : row.toEffect,
      counterpart: isFrom
        ? { type: row.toAccountType, id: row.toAccountId, name: row.toName }
        : { type: row.fromAccountType, id: row.fromAccountId, name: row.fromName },
    };
  });

  return {
    items,
    pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

export { DIRECTIONS };

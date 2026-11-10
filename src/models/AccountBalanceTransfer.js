import mongoose from 'mongoose';
import { moneyField, round2 } from './shared/money.js';

const { Schema, model, models } = mongoose;

export const ACCOUNT_TYPES = ['customer', 'supplier'];

/**
 * A balance offset (مقاصة) between a Customer and a Supplier — in either
 * direction:
 *
 *  - customer → supplier: the customer owes the shop, and the shop owes the
 *    supplier. `amount` of the customer's debt is settled against what the
 *    shop owes the supplier: the customer owes `amount` less, and the shop
 *    owes the supplier `amount` less.
 *  - supplier → customer: the supplier owes the shop (a credit the shop is
 *    owed), and the shop owes the customer. The supplier's debt to the shop
 *    and the shop's debt to the customer are both reduced by `amount`.
 *
 * Like CustomerDebtTransfer, this is NOT a sale, purchase, payment, receipt
 * or return, and never touches the cashbox, stock, or any sales/purchase/
 * expense figure: no money moved and nothing was sold. It is only a
 * re-assignment recorded as one more term in both accounts' balance formula
 * (see balanceTransferEffect.js).
 *
 * `fromEffect` / `toEffect` are the SIGNED amounts added to each account's
 * raw balance (the same raw figure getPersonRemaining returns: positive =
 * customer owes the shop / the shop owes the supplier). Storing the effect
 * (instead of re-deriving it from the direction at read time) means every
 * balance calculation is a plain sum, and the record stays correct even if
 * the derivation rule is ever extended. Net position is preserved because
 * the two effects always offset each other once polarity is accounted for
 * (see accountBalanceTransfer.rules.js).
 *
 * A transfer is a permanent, immutable record — there is intentionally no
 * update or delete. A mistaken one is corrected by recording a transfer in
 * the other direction where the rules allow it.
 *
 * `fromBalanceAfter` / `toBalanceAfter` are raw signed snapshots of each
 * side's balance right after this transfer (same philosophy as
 * CustomerPayment.balanceAfter); they intentionally are NOT moneyField (those
 * can't be negative).
 */
const accountBalanceTransferSchema = new Schema(
  {
    reference: { type: String, required: true, trim: true, maxlength: 50 },
    fromAccountType: { type: String, enum: ACCOUNT_TYPES, required: true },
    fromAccountId: { type: Schema.Types.ObjectId, required: true },
    toAccountType: { type: String, enum: ACCOUNT_TYPES, required: true },
    toAccountId: { type: Schema.Types.ObjectId, required: true },
    fromName: { type: String, required: true, trim: true, maxlength: 200 },
    toName: { type: String, required: true, trim: true, maxlength: 200 },
    amount: moneyField({ required: true, min: 0.01 }),
    fromEffect: { type: Number, required: true, set: round2 },
    toEffect: { type: Number, required: true, set: round2 },
    fromBalanceAfter: { type: Number, required: true, set: round2 },
    toBalanceAfter: { type: Number, required: true, set: round2 },
    note: { type: String, default: '', trim: true, maxlength: 500 },
    // Device that performed the operation (same source as AuditLog.actor),
    // null when there is no request context.
    createdByDeviceId: { type: String, default: null, trim: true, maxlength: 200 },
    date: { type: Date, required: true, default: Date.now },
    // Absent (not null) when the caller sent no key — see the index below.
    idempotencyKey: { type: String, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);

// accountId FIRST: the balance pipelines ($lookup in personService/reports) join on
// fromAccountId / toAccountId alone, so those must be the index prefix.
accountBalanceTransferSchema.index({ fromAccountId: 1, fromAccountType: 1, date: -1 });
accountBalanceTransferSchema.index({ toAccountId: 1, toAccountType: 1, date: -1 });
// partialFilterExpression instead of `sparse`: a sparse unique index still
// indexes documents whose field is explicitly null, so two key-less transfers
// would collide on E11000. Only real string keys are indexed here.
accountBalanceTransferSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
accountBalanceTransferSchema.index({ reference: 1 }, { unique: true });

export default models.AccountBalanceTransfer || model('AccountBalanceTransfer', accountBalanceTransferSchema);

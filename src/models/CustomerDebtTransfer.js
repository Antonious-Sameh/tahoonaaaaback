import mongoose from 'mongoose';
import { moneyField } from './shared/money.js';

const { Schema, model, models } = mongoose;

export const PARTY_TYPES = ['customer', 'supplier'];

/**
 * A debt moved from one customer's account to another's — e.g. customer A
 * owes the shop 100,000 and 40,000 of that is transferred to customer B, so
 * A now owes 60,000 and B owes 40,000.
 *
 * This is deliberately NOT a Sale, a CustomerPayment, or anything that
 * touches the cashbox: no money entered or left the shop, and nothing was
 * sold. It is a pure re-assignment of who owes what, so it lives in its own
 * collection and is folded into both customers' balances as one more term
 * (see personBalance.service.js / personService.js / reports.service.js —
 * `- transferred out + transferred in`). Old invoices are never touched:
 * they keep showing the customer they were originally made for.
 *
 * A transfer is a permanent, immutable record — there is intentionally no
 * update or delete. A wrong transfer is corrected by recording a transfer
 * the other way, limited (like any transfer) to what the receiving side
 * still owes, so the history always shows exactly what happened.
 *
 * Either side may also be a SUPPLIER (customer -> supplier, supplier ->
 * customer, supplier -> supplier). The collection and model name are kept as
 * they are on purpose (renaming would be a data migration); a supplier side
 * is stored in the new optional `fromSupplierId`/`toSupplierId` fields and
 * `fromType`/`toType` say which kind each side is. Every document written
 * before suppliers were supported has only the customer fields and no type —
 * it is read as 'customer' on both sides, so no existing record changes.
 * Exactly one of (fromCustomerId, fromSupplierId) and exactly one of
 * (toCustomerId, toSupplierId) is set on every document.
 *
 * Meaning of "debt" is always "what this party owes the shop": for a customer
 * that is the usual `remaining`; for a supplier it is the amount the supplier
 * owes the shop (the `creditOwed` side of a supplier's balance). A transfer
 * lowers the source's debt and raises the destination's by `amount`.
 *
 * `fromName`/`toName` are snapshots of the names at the time of the
 * transfer, so the record stays readable even if a customer is renamed
 * later. `fromBalanceAfter`/`toBalanceAfter` are snapshots of each side's
 * remaining balance immediately after this transfer (same philosophy as
 * CustomerPayment.balanceAfter).
 */
const customerDebtTransferSchema = new Schema(
  {
    fromType: { type: String, enum: PARTY_TYPES, default: 'customer' },
    toType: { type: String, enum: PARTY_TYPES, default: 'customer' },
    fromCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: undefined },
    toCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: undefined },
    fromSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', default: undefined },
    toSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', default: undefined },
    fromName: { type: String, required: true, trim: true, maxlength: 200 },
    toName: { type: String, required: true, trim: true, maxlength: 200 },
    amount: moneyField({ required: true, min: 0.01 }),
    // Signed snapshots of "what this party owes the shop" right after the
    // transfer. Never negative for a customer or a source (so identical to
    // before for every old record), but a SUPPLIER receiving debt while the
    // shop still owes it money ends up negative (e.g. -500 = the shop still
    // owes it 500 net), hence the explicit lower bound.
    fromBalanceAfter: moneyField({ required: true, min: Number.MIN_SAFE_INTEGER }),
    toBalanceAfter: moneyField({ required: true, min: Number.MIN_SAFE_INTEGER }),
    note: { type: String, default: '', trim: true, maxlength: 500 },
    date: { type: Date, required: true, default: Date.now },
    idempotencyKey: { type: String, default: null, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);

// Each side must reference exactly one party, matching its declared type.
customerDebtTransferSchema.pre('validate', function checkParties(next) {
  for (const side of ['from', 'to']) {
    const type = this[`${side}Type`] || 'customer';
    const customerId = this[`${side}CustomerId`];
    const supplierId = this[`${side}SupplierId`];
    const ok = type === 'customer' ? !!customerId && !supplierId : !!supplierId && !customerId;
    if (!ok) return next(new Error(`${side} side must reference exactly one ${type}`));
  }
  return next();
});

customerDebtTransferSchema.index({ fromCustomerId: 1, date: -1 });
customerDebtTransferSchema.index({ toCustomerId: 1, date: -1 });
customerDebtTransferSchema.index({ fromSupplierId: 1, date: -1 }, { sparse: true });
customerDebtTransferSchema.index({ toSupplierId: 1, date: -1 }, { sparse: true });
customerDebtTransferSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export default models.CustomerDebtTransfer || model('CustomerDebtTransfer', customerDebtTransferSchema);

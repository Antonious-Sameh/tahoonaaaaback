import mongoose from 'mongoose';
import { moneyField } from './shared/money.js';

const { Schema, model, models } = mongoose;

/**
 * The mirror-image of CustomerPayment: money the SHOP hands back to a
 * customer who is owed a credit (creditOwed > 0 — see personService.js's
 * getTotals doc block for how that figure arises, almost always from a
 * return whose value exceeded what the customer still owed at the time).
 *
 * This is intentionally its own model rather than a CustomerPayment with a
 * negative amount: CustomerPayment's `amount` is a strictly-positive
 * "money coming in" figure baked into money.js's moneyField(min: 0) and
 * into every aggregation that sums it as reducing the customer's
 * `remaining` (never their `creditOwed`) — overloading its sign to also
 * mean "money going out, reducing creditOwed instead" would quietly change
 * what that field means everywhere else it's read. A separate model keeps
 * both directions unambiguous.
 *
 * `creditOwedAfter` is a snapshot of the customer's creditOwed immediately
 * after this payout, mirroring CustomerPayment.balanceAfter's snapshot
 * philosophy — history keeps showing what was true at that moment even as
 * later activity moves the live figure.
 *
 * This ONLY reduces creditOwed — it is not a way to give a customer store
 * credit they don't already have; createCustomerCreditPayout (in
 * customerCreditPayout.service.js) rejects an amount larger than their
 * current creditOwed, same as CustomerPayment rejects overpaying past
 * `remaining`.
 */
const customerCreditPayoutSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    // Strictly positive — same reasoning as CustomerPayment.amount.
    amount: moneyField({ required: true, min: 0.01 }),
    // Snapshot of the customer's remaining creditOwed right after this
    // payout — never negative (a payout can never exceed the creditOwed at
    // the time it's recorded; see customerCreditPayout.service.js).
    creditOwedAfter: moneyField({ required: true }),
    note: { type: String, default: '', trim: true, maxlength: 500 },
    date: { type: Date, required: true, default: Date.now },
    // Same duplicate-submission guard as CustomerPayment/SalesReturn.
    idempotencyKey: { type: String, default: null, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);

customerCreditPayoutSchema.index({ customerId: 1, date: -1 });
customerCreditPayoutSchema.index({ date: -1 });
customerCreditPayoutSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export default models.CustomerCreditPayout || model('CustomerCreditPayout', customerCreditPayoutSchema);
import mongoose from 'mongoose';
import { moneyField } from './shared/money.js';

const { Schema, model, models } = mongoose;

/**
 * Cash handed to a customer as a loan/advance — unconditionally (unlike
 * CustomerCreditPayout, which only pays down an EXISTING creditOwed
 * balance), and regardless of whatever the customer currently owes or is
 * owed. A loan is a real cashbox outflow (see customerLoan.service.js) that
 * simply increases what the customer owes — the shop's own money leaving
 * the register for the customer's benefit, not a sale and not a
 * settlement. Deliberately its own collection/model, not a repurposed
 * CustomerCreditPayout: the two are financially similar (both move cash
 * out to a customer and both push the balance the same direction), but a
 * "دفع مستحق" (paying back money the shop already owed them) and a "سلفة"
 * (handing them a fresh advance) are different real-world events to the
 * shop owner and must stay distinguishable in the record, not merged.
 *
 * `balanceAfter` is a SNAPSHOT of the customer's remaining balance right
 * after this loan was given — same snapshot philosophy as CustomerPayment/
 * CustomerCreditPayout/CustomerDebtTransfer.
 */
const customerLoanSchema = new Schema(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    amount: moneyField({ required: true, min: 0.01 }),
    balanceAfter: moneyField({ required: true }),
    note: { type: String, default: '', trim: true, maxlength: 500 },
    date: { type: Date, required: true, default: Date.now },
    idempotencyKey: { type: String, default: null, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);

customerLoanSchema.index({ customerId: 1, date: -1 });
customerLoanSchema.index({ date: -1 });
customerLoanSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export default models.CustomerLoan || model('CustomerLoan', customerLoanSchema);

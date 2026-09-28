import mongoose from 'mongoose';
import { moneyField } from './shared/money.js';

const { Schema, model, models } = mongoose;

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
 * `fromName`/`toName` are snapshots of the names at the time of the
 * transfer, so the record stays readable even if a customer is renamed
 * later. `fromBalanceAfter`/`toBalanceAfter` are snapshots of each side's
 * remaining balance immediately after this transfer (same philosophy as
 * CustomerPayment.balanceAfter).
 */
const customerDebtTransferSchema = new Schema(
  {
    fromCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    toCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    fromName: { type: String, required: true, trim: true, maxlength: 200 },
    toName: { type: String, required: true, trim: true, maxlength: 200 },
    amount: moneyField({ required: true, min: 0.01 }),
    fromBalanceAfter: moneyField({ required: true }),
    toBalanceAfter: moneyField({ required: true }),
    note: { type: String, default: '', trim: true, maxlength: 500 },
    date: { type: Date, required: true, default: Date.now },
    idempotencyKey: { type: String, default: null, trim: true, maxlength: 200 },
  },
  { timestamps: true },
);

customerDebtTransferSchema.index({ fromCustomerId: 1, date: -1 });
customerDebtTransferSchema.index({ toCustomerId: 1, date: -1 });
customerDebtTransferSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export default models.CustomerDebtTransfer || model('CustomerDebtTransfer', customerDebtTransferSchema);

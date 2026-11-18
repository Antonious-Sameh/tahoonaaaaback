import mongoose from 'mongoose';
import { ACTIVITY_TYPES } from './constants.js';

const { Schema, model, models } = mongoose;

/**
 * Light, human-readable activity feed — matches the current frontend's
 * `state.activity` exactly (one line per notable action, newest first).
 *
 * NOT the same thing as the future `AuditLog` (see the Audit Log phase),
 * which will additionally record which device/session performed the action
 * and before/after values for security review. Keep this one purely as the
 * user-facing feed it already is.
 */
const activityLogSchema = new Schema(
  {
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    amount: { type: Number, default: 0 },
    // Loosely typed on purpose — the target collection depends on `type`,
    // same reasoning as CashboxTransaction.refId.
    refId: { type: Schema.Types.ObjectId, default: null },
    // Extra activity types this single entry should ALSO show up under in the
    // type filter. Used by a debt transfer between a customer and a supplier:
    // one entry (so the unfiltered feed lists it once), stored with the
    // sender's `type` as before, and `relatedTypes: ['customer', 'supplier']`
    // so BOTH the customers and the suppliers filter find it. Absent on every
    // older entry, which keeps filtering by `type` alone, exactly as before.
    relatedTypes: { type: [{ type: String, enum: ACTIVITY_TYPES }], default: undefined },
    date: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

activityLogSchema.index({ date: -1 });

export default models.ActivityLog || model('ActivityLog', activityLogSchema);

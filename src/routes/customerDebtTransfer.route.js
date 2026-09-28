import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import * as controller from '../controllers/customerDebtTransfer.controller.js';

const router = Router();

router.use(requireAuth);

const objectId = (message) => z.string().refine((v) => mongoose.isValidObjectId(v), { message });

// Shape/sign check only — every real rule (amount <= what the source owes,
// destination not owed credit, ...) needs a database read, so it's enforced
// in customerDebtTransfer.service.js.
const createTransferSchema = z.object({
  fromCustomerId: objectId('معرّف العميل المصدر غير صالح'),
  toCustomerId: objectId('معرّف العميل المستلم غير صالح'),
  amount: z.coerce.number().positive('قيمة النقل يجب أن تكون أكبر من صفر'),
  note: z.string().trim().max(500).optional().default(''),
  idempotencyKey: z.string().trim().max(200).optional(),
});

const listTransfersQuerySchema = z.object({
  customerId: objectId('معرّف عميل غير صالح'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

router.get('/', validateQuery(listTransfersQuerySchema), controller.list);
router.post('/', validateBody(createTransferSchema), controller.create);
// Intentionally no DELETE/PATCH: a transfer is a permanent record. A wrong
// transfer is corrected by recording a transfer the other way.

export default router;

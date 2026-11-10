import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import * as controller from '../controllers/accountBalanceTransfer.controller.js';

const router = Router();

router.use(requireAuth);

const objectId = (message) => z.string().refine((v) => mongoose.isValidObjectId(v), { message });
const accountType = z.enum(['customer', 'supplier'], { errorMap: () => ({ message: 'نوع الحساب غير صالح' }) });

// Shape check only — the amount is deliberately NOT coerced here: the service
// validates it strictly (numeric, > 0, at most 2 decimals) and rejects
// anything else with a clear message, instead of silently turning "" or null
// into 0. Every accounting rule needs a database read, so it lives in
// accountBalanceTransfer.service.js.
const createTransferSchema = z.object({
  fromAccountType: accountType,
  fromAccountId: objectId('معرّف الحساب المصدر غير صالح'),
  toAccountType: accountType,
  toAccountId: objectId('معرّف الحساب المستلم غير صالح'),
  amount: z.union([z.number(), z.string().trim().min(1, 'قيمة النقل مطلوبة')]),
  note: z.string().trim().max(500).optional().default(''),
  idempotencyKey: z.string().trim().max(200).optional(),
});

const listTransfersQuerySchema = z.object({
  accountType,
  accountId: objectId('معرّف الحساب غير صالح'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

router.get('/', validateQuery(listTransfersQuerySchema), controller.list);
router.post('/', validateBody(createTransferSchema), controller.create);
// Intentionally no DELETE/PATCH: a transfer is a permanent record.

export default router;

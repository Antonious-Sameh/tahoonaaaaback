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
// a customer destination not owed credit, ...) needs a database read, so it's
// enforced in customerDebtTransfer.service.js. Each side is EITHER a customer
// OR a supplier: the original customer-only body
// ({ fromCustomerId, toCustomerId }) is still accepted exactly as before.
const optionalObjectId = (message) => objectId(message).optional();

const createTransferSchema = z
  .object({
    fromCustomerId: optionalObjectId('معرّف العميل المصدر غير صالح'),
    fromSupplierId: optionalObjectId('معرّف المورد المصدر غير صالح'),
    toCustomerId: optionalObjectId('معرّف العميل المستلم غير صالح'),
    toSupplierId: optionalObjectId('معرّف المورد المستلم غير صالح'),
    amount: z.coerce.number().positive('قيمة النقل يجب أن تكون أكبر من صفر'),
    note: z.string().trim().max(500).optional().default(''),
    idempotencyKey: z.string().trim().max(200).optional(),
  })
  .refine((v) => !!v.fromCustomerId !== !!v.fromSupplierId, { message: 'حدد طرفاً واحداً فقط (عميل أو مورد) للمصدر', path: ['fromCustomerId'] })
  .refine((v) => !!v.toCustomerId !== !!v.toSupplierId, { message: 'حدد طرفاً واحداً فقط (عميل أو مورد) للمستلم', path: ['toCustomerId'] });

// Exactly one of customerId / supplierId — the party whose transfers to list.
const listTransfersQuerySchema = z
  .object({
    customerId: optionalObjectId('معرّف عميل غير صالح'),
    supplierId: optionalObjectId('معرّف مورد غير صالح'),
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(100).optional().default(20),
  })
  .refine((v) => !!v.customerId !== !!v.supplierId, { message: 'حدد عميلاً أو مورداً', path: ['customerId'] });

router.get('/', validateQuery(listTransfersQuerySchema), controller.list);
router.post('/', validateBody(createTransferSchema), controller.create);
// Intentionally no DELETE/PATCH: a transfer is a permanent record. A wrong
// transfer is corrected by recording a transfer the other way.

export default router;

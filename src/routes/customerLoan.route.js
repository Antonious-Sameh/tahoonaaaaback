import { Router } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { validateObjectIdParam } from '../middleware/validateObjectId.js';
import * as controller from '../controllers/customerLoan.controller.js';

const router = Router();

router.use(requireAuth);

const objectId = (message) => z.string().refine((v) => mongoose.isValidObjectId(v), { message });

const createLoanSchema = z.object({
  customerId: objectId('معرّف عميل غير صالح'),
  amount: z.coerce.number().positive('قيمة السلفة يجب أن تكون أكبر من صفر'),
  note: z.string().trim().max(500).optional().default(''),
  idempotencyKey: z.string().trim().max(200).optional(),
});

const listLoansQuerySchema = z.object({
  customerId: objectId('معرّف عميل غير صالح'),
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

router.get('/', validateQuery(listLoansQuerySchema), controller.list);
router.post('/', validateBody(createLoanSchema), controller.create);
router.delete('/:id', validateObjectIdParam(), controller.remove);

export default router;

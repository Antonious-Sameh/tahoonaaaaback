import { asyncHandler } from '../middleware/asyncHandler.js';
import * as customerDebtTransferService from '../services/customerDebtTransfer.service.js';

export const list = asyncHandler(async (req, res) => {
  const { customerId, supplierId, page, limit } = req.validatedQuery;
  const result = await customerDebtTransferService.listCustomerDebtTransfers({ customerId, supplierId, page, limit });
  res.json({ success: true, data: result.items, pagination: result.pagination });
});

export const create = asyncHandler(async (req, res) => {
  const { fromCustomerId, fromSupplierId, toCustomerId, toSupplierId, amount, note, idempotencyKey } = req.body;
  const transfer = await customerDebtTransferService.createCustomerDebtTransfer({
    fromCustomerId, fromSupplierId, toCustomerId, toSupplierId, amount, note, idempotencyKey,
  });
  res.status(201).json({ success: true, data: transfer });
});

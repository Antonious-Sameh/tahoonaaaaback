import { asyncHandler } from '../middleware/asyncHandler.js';
import * as accountBalanceTransferService from '../services/accountBalanceTransfer.service.js';

export const list = asyncHandler(async (req, res) => {
  const { accountType, accountId, page, limit } = req.validatedQuery;
  const result = await accountBalanceTransferService.listAccountBalanceTransfers({ accountType, accountId, page, limit });
  res.json({ success: true, data: result.items, pagination: result.pagination });
});

export const create = asyncHandler(async (req, res) => {
  const { fromAccountType, fromAccountId, toAccountType, toAccountId, amount, note, idempotencyKey } = req.body;
  const transfer = await accountBalanceTransferService.createAccountBalanceTransfer({
    fromAccountType, fromAccountId, toAccountType, toAccountId, amount, note, idempotencyKey,
  });
  res.status(201).json({ success: true, data: transfer });
});

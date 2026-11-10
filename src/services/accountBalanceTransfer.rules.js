import { round2 } from '../models/shared/money.js';

/**
 * Pure (no database) decision logic for a Customer <-> Supplier balance
 * offset — kept separate from the service so every accounting rule can be
 * unit-tested without MongoDB, and so the service itself is only I/O.
 *
 * Both inputs are RAW signed balances exactly as getCustomerRemaining /
 * getSupplierRemaining return them (see personBalance.service.js):
 *   customer raw  > 0  => the customer owes the shop      (receivable)
 *   customer raw  < 0  => the shop owes the customer      (creditOwed)
 *   supplier raw  > 0  => the shop owes the supplier      (payable)
 *   supplier raw  < 0  => the supplier owes the shop      (credit owed to us)
 *
 * customer -> supplier  ("customer's debt is settled against what we owe
 *   the supplier"): requires customer raw > 0 AND supplier raw > 0.
 *   transferable = min(customer raw, supplier raw).
 *   effects: customer -amount, supplier -amount.
 *
 * supplier -> customer  ("what the supplier owes us is settled against what
 *   we owe the customer"): requires supplier raw < 0 AND customer raw < 0.
 *   transferable = min(-supplier raw, -customer raw).
 *   effects: supplier +amount, customer +amount.
 *
 * Net position (sum of receivables minus payables = customer raw - supplier
 * raw) is unchanged in both cases: (-a) - (-a) = 0 and (+a) - (+a) = 0.
 *
 * Any other combination of balance natures is rejected — it would not be a
 * real offset (it would create or inflate a balance instead of cancelling
 * two opposite ones).
 */

export const DIRECTIONS = {
  CUSTOMER_TO_SUPPLIER: 'customer_to_supplier',
  SUPPLIER_TO_CUSTOMER: 'supplier_to_customer',
};

export class TransferRuleError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Resolves the direction from the two account types, or throws. */
export function resolveDirection(fromType, toType) {
  if (fromType === 'customer' && toType === 'supplier') return DIRECTIONS.CUSTOMER_TO_SUPPLIER;
  if (fromType === 'supplier' && toType === 'customer') return DIRECTIONS.SUPPLIER_TO_CUSTOMER;
  throw new TransferRuleError(
    'هذه الخدمة مخصصة للنقل بين عميل ومورد فقط (نقل مديونية بين العملاء له شاشته الحالية)',
    'UNSUPPORTED_DIRECTION',
  );
}

/**
 * Validates and normalizes the amount. Rejects non-numeric, non-finite,
 * zero/negative values and anything with more than 2 decimal places (the
 * whole system stores money rounded to 2 places — silently rounding a user's
 * 10.005 would move a different amount than they typed).
 */
export function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
    throw new TransferRuleError('قيمة النقل يجب أن تكون أكبر من صفر', 'INVALID_AMOUNT');
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new TransferRuleError('قيمة النقل غير صالحة', 'INVALID_AMOUNT');
  }
  if (n <= 0) {
    throw new TransferRuleError('قيمة النقل يجب أن تكون أكبر من صفر', 'INVALID_AMOUNT');
  }
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new TransferRuleError('قيمة النقل لا يجوز أن تحتوي على أكثر من خانتين عشريتين', 'AMOUNT_PRECISION');
  }
  const amount = round2(n);
  if (amount <= 0) {
    throw new TransferRuleError('قيمة النقل يجب أن تكون أكبر من صفر', 'INVALID_AMOUNT');
  }
  return amount;
}

/**
 * Given the two raw balances and the requested amount, returns everything the
 * service needs to write: signed effects and the raw balances after. Throws a
 * TransferRuleError for any rule violation.
 */
export function planTransfer({ direction, customerRaw, supplierRaw, amount }) {
  if (direction === DIRECTIONS.CUSTOMER_TO_SUPPLIER) {
    if (customerRaw <= 0) {
      throw new TransferRuleError('العميل ليس عليه مديونية للمحل، فلا يوجد ما يُنقل منه', 'SOURCE_NATURE_INVALID');
    }
    if (supplierRaw <= 0) {
      throw new TransferRuleError('لا توجد مستحقات للمورد عند المحل لإجراء المقاصة عليها', 'DESTINATION_NATURE_INVALID');
    }
    const transferable = round2(Math.min(customerRaw, supplierRaw));
    if (amount > transferable) {
      throw new TransferRuleError(
        'المبلغ أكبر من الرصيد القابل للنقل (الأقل بين مديونية العميل ومستحقات المورد)',
        'EXCEEDS_TRANSFERABLE',
        { transferable, customerOwes: round2(customerRaw), weOweSupplier: round2(supplierRaw) },
      );
    }
    return {
      transferable,
      fromEffect: round2(-amount),
      toEffect: round2(-amount),
      fromBalanceAfter: round2(customerRaw - amount),
      toBalanceAfter: round2(supplierRaw - amount),
    };
  }

  if (direction === DIRECTIONS.SUPPLIER_TO_CUSTOMER) {
    if (supplierRaw >= 0) {
      throw new TransferRuleError('المورد ليس عليه مديونية للمحل، فلا يوجد ما يُنقل منه', 'SOURCE_NATURE_INVALID');
    }
    if (customerRaw >= 0) {
      throw new TransferRuleError('لا توجد مستحقات للعميل عند المحل لإجراء المقاصة عليها', 'DESTINATION_NATURE_INVALID');
    }
    const supplierOwes = round2(-supplierRaw);
    const weOweCustomer = round2(-customerRaw);
    const transferable = round2(Math.min(supplierOwes, weOweCustomer));
    if (amount > transferable) {
      throw new TransferRuleError(
        'المبلغ أكبر من الرصيد القابل للنقل (الأقل بين مديونية المورد ومستحقات العميل)',
        'EXCEEDS_TRANSFERABLE',
        { transferable, supplierOwes, weOweCustomer },
      );
    }
    return {
      transferable,
      fromEffect: round2(amount),
      toEffect: round2(amount),
      fromBalanceAfter: round2(supplierRaw + amount),
      toBalanceAfter: round2(customerRaw + amount),
    };
  }

  throw new TransferRuleError('اتجاه النقل غير مدعوم', 'UNSUPPORTED_DIRECTION');
}

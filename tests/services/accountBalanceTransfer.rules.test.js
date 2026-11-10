import { describe, it, expect } from 'vitest';
import { DIRECTIONS, TransferRuleError, resolveDirection, parseAmount, planTransfer } from '../../src/services/accountBalanceTransfer.rules.js';

const codeOf = (fn) => {
  try { fn(); } catch (err) { expect(err).toBeInstanceOf(TransferRuleError); return err.code; }
  throw new Error('expected a TransferRuleError');
};

describe('resolveDirection', () => {
  it('accepts only customer<->supplier', () => {
    expect(resolveDirection('customer', 'supplier')).toBe(DIRECTIONS.CUSTOMER_TO_SUPPLIER);
    expect(resolveDirection('supplier', 'customer')).toBe(DIRECTIONS.SUPPLIER_TO_CUSTOMER);
  });
  it('rejects customer->customer, supplier->supplier and unknown types', () => {
    expect(codeOf(() => resolveDirection('customer', 'customer'))).toBe('UNSUPPORTED_DIRECTION');
    expect(codeOf(() => resolveDirection('supplier', 'supplier'))).toBe('UNSUPPORTED_DIRECTION');
    expect(codeOf(() => resolveDirection('bank', 'supplier'))).toBe('UNSUPPORTED_DIRECTION');
  });
});

describe('parseAmount', () => {
  it('accepts positive numbers and numeric strings with up to 2 decimals', () => {
    expect(parseAmount(10)).toBe(10);
    expect(parseAmount('10.25')).toBe(10.25);
    expect(parseAmount(0.01)).toBe(0.01);
  });
  it('rejects zero, negative, non-numeric, non-finite, empty and over-precise values', () => {
    for (const bad of [0, -1, '-1', 'abc', NaN, Infinity, null, undefined, '', ' ', true, 10.005, '0.001']) {
      expect(() => parseAmount(bad)).toThrow();
    }
  });
});

describe('planTransfer customer -> supplier', () => {
  const dir = DIRECTIONS.CUSTOMER_TO_SUPPLIER;
  it('example: customer owes 1000, shop owes supplier 2000, move 1000', () => {
    const plan = planTransfer({ direction: dir, customerRaw: 1000, supplierRaw: 2000, amount: 1000 });
    expect(plan).toEqual({ transferable: 1000, fromEffect: -1000, toEffect: -1000, fromBalanceAfter: 0, toBalanceAfter: 1000 });
  });
  it('rejects when the customer does not owe the shop, or the shop does not owe the supplier', () => {
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: 0, supplierRaw: 100, amount: 1 }))).toBe('SOURCE_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: -50, supplierRaw: 100, amount: 1 }))).toBe('SOURCE_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: 100, supplierRaw: 0, amount: 1 }))).toBe('DESTINATION_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: 100, supplierRaw: -30, amount: 1 }))).toBe('DESTINATION_NATURE_INVALID');
  });
  it('caps at the smaller side', () => {
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: 1000, supplierRaw: 600, amount: 600.01 }))).toBe('EXCEEDS_TRANSFERABLE');
    expect(planTransfer({ direction: dir, customerRaw: 1000, supplierRaw: 600, amount: 600 }).transferable).toBe(600);
  });
});

describe('planTransfer supplier -> customer', () => {
  const dir = DIRECTIONS.SUPPLIER_TO_CUSTOMER;
  it('example: supplier owes 1000 (raw -1000), shop owes customer 2000 (raw -2000), move 1000', () => {
    const plan = planTransfer({ direction: dir, customerRaw: -2000, supplierRaw: -1000, amount: 1000 });
    expect(plan).toEqual({ transferable: 1000, fromEffect: 1000, toEffect: 1000, fromBalanceAfter: 0, toBalanceAfter: -1000 });
  });
  it('rejects wrong natures and over-transfer', () => {
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: -100, supplierRaw: 0, amount: 1 }))).toBe('SOURCE_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: -100, supplierRaw: 50, amount: 1 }))).toBe('SOURCE_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: 0, supplierRaw: -100, amount: 1 }))).toBe('DESTINATION_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: 20, supplierRaw: -100, amount: 1 }))).toBe('DESTINATION_NATURE_INVALID');
    expect(codeOf(() => planTransfer({ direction: dir, customerRaw: -300, supplierRaw: -1000, amount: 300.01 }))).toBe('EXCEEDS_TRANSFERABLE');
  });
});

describe('net position invariance', () => {
  it('customerRaw - supplierRaw is unchanged in both directions', () => {
    const a = planTransfer({ direction: DIRECTIONS.CUSTOMER_TO_SUPPLIER, customerRaw: 900, supplierRaw: 700, amount: 250.5 });
    expect(900 - 700).toBe(a.fromBalanceAfter - a.toBalanceAfter);
    const b = planTransfer({ direction: DIRECTIONS.SUPPLIER_TO_CUSTOMER, customerRaw: -900, supplierRaw: -700, amount: 300.25 });
    expect(-900 - -700).toBe(b.toBalanceAfter - b.fromBalanceAfter);
  });
});

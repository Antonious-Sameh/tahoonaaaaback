import { describe, it, expect, vi, beforeEach } from 'vitest';

const saleAgg = vi.hoisted(() => vi.fn());
const returnAgg = vi.hoisted(() => vi.fn());
const expenseAgg = vi.hoisted(() => vi.fn());
const purchaseAgg = vi.hoisted(() => vi.fn());
vi.mock('../../src/models/Sale.js', () => ({ default: { aggregate: (...a) => saleAgg(...a), collection: { name: 'sales' } } }));
vi.mock('../../src/models/SalesReturn.js', () => ({ default: { aggregate: (...a) => returnAgg(...a) } }));
vi.mock('../../src/models/Expense.js', () => ({ default: { aggregate: (...a) => expenseAgg(...a) } }));
vi.mock('../../src/models/Purchase.js', () => ({ default: { aggregate: (...a) => purchaseAgg(...a) } }));

import { listDays, mergeDays, getDailyReport, MAX_DAYS, CAIRO_TZ } from '../../src/services/dailyReport.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listDays', () => {
  it('lists every calendar day inclusive, across month and year ends', () => {
    expect(listDays('2025-12-30', '2026-01-02')).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
    expect(listDays('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(listDays('2026-09-15', '2026-09-15')).toEqual(['2026-09-15']);
  });

  it('is not shifted by DST changes (pure date arithmetic)', () => {
    const days = listDays('2026-04-20', '2026-05-05'); // Egypt DST starts end of April
    expect(days).toHaveLength(16);
    expect(new Set(days).size).toBe(16);
  });

  it('rejects bad input, reversed ranges and ranges over the cap', () => {
    expect(() => listDays('2026-9-1', '2026-09-02')).toThrow();
    expect(() => listDays('2026-09-10', '2026-09-01')).toThrow();
    expect(() => listDays('2024-01-01', '2026-01-01')).toThrow(String(MAX_DAYS));
  });
});

describe('mergeDays', () => {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03'];

  it('computes net sales, cogs, gross profit and net exactly like the profit report, per day', () => {
    const [d1] = mergeDays(days, {
      sales: [{ _id: '2026-09-01', sales: 1000, invoices: 4, cogs: 600 }],
      returns: [{ _id: '2026-09-01', returns: 100 }],
      returnedCogs: [{ _id: '2026-09-01', cost: 60 }],
      expenses: [{ _id: '2026-09-01', expenses: 50 }],
      purchases: [{ _id: '2026-09-01', purchases: 2000 }],
    });
    expect(d1).toEqual({
      date: '2026-09-01',
      sales: 1000, returns: 100, netSales: 900, invoices: 4,
      cogs: 540, grossProfit: 360, expenses: 50, net: 310, purchases: 2000,
    });
  });

  it('fills days with no activity with zeros (a continuous series for the chart)', () => {
    const out = mergeDays(days, { sales: [{ _id: '2026-09-02', sales: 10, invoices: 1, cogs: 4 }] });
    expect(out.map((d) => d.date)).toEqual(days);
    expect(out[0]).toMatchObject({ sales: 0, net: 0, invoices: 0 });
    expect(out[1]).toMatchObject({ sales: 10, netSales: 10, grossProfit: 6, net: 6 });
  });

  it('a day with only an expense has a negative net', () => {
    const [d] = mergeDays(['2026-09-01'], { expenses: [{ _id: '2026-09-01', expenses: 75 }] });
    expect(d.net).toBe(-75);
  });

  it('the days add up to the range totals', () => {
    const out = mergeDays(days, {
      sales: days.map((d, i) => ({ _id: d, sales: 100 * (i + 1), invoices: 1, cogs: 50 * (i + 1) })),
      expenses: [{ _id: '2026-09-03', expenses: 30 }],
    });
    expect(out.reduce((a, d) => a + d.netSales, 0)).toBe(600);
    expect(out.reduce((a, d) => a + d.net, 0)).toBe(270);
  });
});

describe('getDailyReport', () => {
  it('runs one grouped aggregation per collection, grouped by CAIRO day, and merges them', async () => {
    saleAgg.mockResolvedValue([{ _id: '2026-09-01', sales: 500, invoices: 2, cogs: 300 }]);
    returnAgg.mockResolvedValue([{ returns: [], returnedCogs: [] }]);
    expenseAgg.mockResolvedValue([]);
    purchaseAgg.mockResolvedValue([{ _id: '2026-09-02', purchases: 800 }]);

    const r = await getDailyReport({ from: '2026-09-01', to: '2026-09-02' });

    expect(r.days).toHaveLength(2);
    expect(r.days[0]).toMatchObject({ date: '2026-09-01', netSales: 500, grossProfit: 200 });
    expect(r.days[1]).toMatchObject({ date: '2026-09-02', purchases: 800, sales: 0 });

    const salePipeline = saleAgg.mock.calls[0][0];
    expect(salePipeline[0].$match.date.$gte).toBeInstanceOf(Date);
    expect(salePipeline[1].$group._id.$dateToString).toMatchObject({ format: '%Y-%m-%d', timezone: CAIRO_TZ });
  });

  it('refuses a missing range instead of scanning everything', async () => {
    await expect(getDailyReport({})).rejects.toThrow();
    expect(saleAgg).not.toHaveBeenCalled();
  });
});

import Sale from '../models/Sale.js';
import SalesReturn from '../models/SalesReturn.js';
import Expense from '../models/Expense.js';
import Purchase from '../models/Purchase.js';
import { cairoRangeMatch } from '../utils/timezone.js';
import { round2 } from '../models/shared/money.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Day-by-day figures for a date range — READ ONLY, used by System 5's
 * "تطور المبيعات" / profit trend charts.
 *
 * Every figure uses EXACTLY the same definitions as getProfitReport /
 * getSalesReport in reports.service.js, just grouped per Cairo calendar day,
 * so the days of a range always add up to that range's report totals:
 *   sales      = Σ Sale.total                    (invoice totals, after discount)
 *   returns    = Σ SalesReturn.totalReturnAmount (by the RETURN's date)
 *   netSales   = sales − returns
 *   cogs       = Σ items.cost × quantity − cost of returned items
 *   grossProfit= netSales − cogs
 *   expenses   = Σ Expense.amount
 *   net        = grossProfit − expenses          (same "net" as the profit report)
 *   purchases  = Σ Purchase.total
 *
 * Kept in its own file (not reports.service.js) so adding it changes
 * nothing in the shop's existing reports.
 */

export const CAIRO_TZ = 'Africa/Cairo';
export const MAX_DAYS = 370;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (field = '$date') => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: CAIRO_TZ } });

/** Every YYYY-MM-DD from `from` to `to` inclusive (pure string arithmetic, no timezone drift). */
export function listDays(from, to) {
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) throw new AppError('from و to لازم يكونوا بالشكل YYYY-MM-DD', 400);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new AppError('تاريخ غير صالح', 400);
  if (start > end) throw new AppError('تاريخ البداية بعد تاريخ النهاية', 400);
  const count = Math.round((end - start) / 86_400_000) + 1;
  if (count > MAX_DAYS) throw new AppError(`أقصى فترة للتقرير اليومي ${MAX_DAYS} يوم`, 400);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

const toMap = (rows) => new Map((rows || []).map((r) => [r._id, r]));

/** Pure: merges the per-day aggregation rows into one complete, zero-filled series. */
export function mergeDays(days, { sales = [], returns = [], returnedCogs = [], expenses = [], purchases = [] }) {
  const s = toMap(sales);
  const r = toMap(returns);
  const rc = toMap(returnedCogs);
  const e = toMap(expenses);
  const p = toMap(purchases);
  return days.map((date) => {
    const salesTotal = s.get(date)?.sales || 0;
    const returnsTotal = r.get(date)?.returns || 0;
    const netSales = round2(salesTotal - returnsTotal);
    const cogs = round2((s.get(date)?.cogs || 0) - (rc.get(date)?.cost || 0));
    const grossProfit = round2(netSales - cogs);
    const expensesTotal = e.get(date)?.expenses || 0;
    return {
      date,
      sales: round2(salesTotal),
      returns: round2(returnsTotal),
      netSales,
      invoices: s.get(date)?.invoices || 0,
      cogs,
      grossProfit,
      expenses: round2(expensesTotal),
      net: round2(grossProfit - expensesTotal),
      purchases: round2(p.get(date)?.purchases || 0),
    };
  });
}

export async function getDailyReport({ from, to } = {}) {
  const days = listDays(from, to);
  const match = { date: cairoRangeMatch(from, to) };

  const [sales, returnsAgg, expenses, purchases] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: dayOf(),
          sales: { $sum: '$total' },
          invoices: { $sum: 1 },
          cogs: { $sum: { $sum: { $map: { input: '$items', in: { $multiply: ['$$this.cost', '$$this.quantity'] } } } } },
        },
      },
    ]),
    SalesReturn.aggregate([
      { $match: match },
      { $addFields: { _day: dayOf() } },
      {
        $facet: {
          // Per RETURN (before unwinding items), same as getSalesReturnsBreakdown.
          returns: [{ $group: { _id: '$_day', returns: { $sum: '$totalReturnAmount' } } }],
          // Cost of the returned units at the ORIGINAL sale line's cost.
          returnedCogs: [
            { $unwind: '$items' },
            { $lookup: { from: Sale.collection.name, localField: 'saleId', foreignField: '_id', as: '_sale' } },
            { $unwind: '$_sale' },
            {
              $addFields: {
                _originalCost: {
                  $let: {
                    vars: {
                      matchedLine: {
                        $arrayElemAt: [
                          { $filter: { input: '$_sale.items', cond: { $eq: ['$$this.productId', '$items.productId'] } } },
                          0,
                        ],
                      },
                    },
                    in: '$$matchedLine.cost',
                  },
                },
              },
            },
            { $group: { _id: '$_day', cost: { $sum: { $multiply: ['$_originalCost', '$items.returnedQuantity'] } } } },
          ],
        },
      },
    ]),
    Expense.aggregate([{ $match: match }, { $group: { _id: dayOf(), expenses: { $sum: '$amount' } } }]),
    Purchase.aggregate([{ $match: match }, { $group: { _id: dayOf(), purchases: { $sum: '$total' } } }]),
  ]);

  const [{ returns = [], returnedCogs = [] } = {}] = returnsAgg;
  return { from, to, days: mergeDays(days, { sales, returns, returnedCogs, expenses, purchases }) };
}

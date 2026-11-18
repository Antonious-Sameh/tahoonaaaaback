import ActivityLog from "../models/ActivityLog.js";
import { cairoRangeMatch } from "../utils/timezone.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Records one entry in the human-readable activity feed. Mirrors the
 * frontend's `pushActivity` helper exactly — every future phase (customers,
 * sales, purchases, expenses, ...) calls this the same way instead of each
 * writing to `ActivityLog` directly.
 *
 * Pass `{ session }` when called from inside a larger MongoDB transaction
 * (e.g. creating a sale) so the activity entry only persists if the whole
 * transaction actually commits — a failed sale should never leave behind an
 * activity entry claiming it happened.
 */
export async function recordActivity(
  { type, description, amount = 0, refId = null, relatedTypes },
  { session } = {},
) {
  const doc = { type, description, amount, refId };
  // Only stored when it adds something beyond `type` itself, so ordinary
  // entries stay byte-for-byte what they were.
  const related = Array.isArray(relatedTypes) ? [...new Set([type, ...relatedTypes])] : [];
  if (related.length > 1) doc.relatedTypes = related;
  await ActivityLog.create([doc], { session });
}

/**
 * Read-only, paginated, newest-first — matches the shape of every other
 * list endpoint. Filterable by `type` and a `from`/`to` date range, matching
 * the frontend's Dashboard/Activity page filters exactly.
 */
export async function listActivity({
  page = 1,
  limit = DEFAULT_PAGE_SIZE,
  type,
  from,
  to,
} = {}) {
  const match = {};
  // An entry matches a type filter if it is of that type OR lists it in
  // `relatedTypes` (a transfer between a customer and a supplier appears under
  // both filters, but still once in the unfiltered feed).
  if (type && type !== "all") match.$or = [{ type }, { relatedTypes: type }];
  const range = cairoRangeMatch(from, to);
  if (Object.keys(range).length) match.date = range;

  const pageNum = Math.max(1, Math.trunc(Number(page)) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(Number(limit)) || DEFAULT_PAGE_SIZE),
  );
  const skip = (pageNum - 1) * pageSize;

  const [{ items, totalCount }] = await ActivityLog.aggregate([
    { $match: match },
    { $sort: { date: -1 } },
    {
      $facet: {
        items: [{ $skip: skip }, { $limit: pageSize }],
        totalCount: [{ $count: "count" }],
      },
    },
  ]);

  const total = totalCount[0]?.count || 0;
  return {
    items,
    pagination: {
      page: pageNum,
      limit: pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

export default recordActivity;

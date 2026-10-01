import { asyncHandler } from '../middleware/asyncHandler.js';
import { getDailyReport } from '../services/dailyReport.service.js';

/** GET /api/admin/reports/daily?from=YYYY-MM-DD&to=YYYY-MM-DD (read-only). */
export const daily = asyncHandler(async (req, res) => {
  const data = await getDailyReport(req.validatedQuery);
  res.json({ success: true, data });
});

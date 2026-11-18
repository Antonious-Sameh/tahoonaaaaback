import { connectDB, disconnectDB } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import * as models from '../src/models/index.js';

/**
 * Creates/updates all declared indexes on MongoDB. Run this manually:
 *   - once after first deploying to a fresh database, and
 *   - again any time a model's `.index(...)` calls change.
 *
 * Not run automatically on every cold start (see `autoIndex` in
 * src/config/db.js) — re-checking indexes on every serverless invocation
 * would be wasted round-trips to Atlas for something that only changes when
 * we ship a schema change.
 *
 * WARNING: `syncIndexes()` DROPS any index on a collection that the current
 * code does not declare. Do not run this against a real database just to get
 * the two supplier indexes of debt transfers — use
 * `npm run create-debt-transfer-indexes` (additive, dry-run by default).
 *
 * Usage: node scripts/sync-indexes.js
 */
async function main() {
  await connectDB();

  for (const [name, Model] of Object.entries(models)) {
    await Model.syncIndexes();
    logger.info(`Indexes synced for ${name}`);
  }

  await disconnectDB();
  logger.info('Done.');
}

main().catch((err) => {
  logger.error({ err }, 'Failed to sync indexes');
  process.exit(1);
});

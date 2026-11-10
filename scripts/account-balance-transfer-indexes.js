import { connectDB, disconnectDB } from '../src/config/db.js';
import { logger } from '../src/config/logger.js';
import * as models from '../src/models/index.js';
import AccountBalanceTransfer from '../src/models/AccountBalanceTransfer.js';

/**
 * Safe, ADDITIVE index setup for the AccountBalanceTransfer collection.
 *
 *   node scripts/account-balance-transfer-indexes.js            # create this model's indexes only
 *   node scripts/account-balance-transfer-indexes.js --diff     # READ-ONLY: for EVERY model, list what
 *                                                               #   `npm run sync-indexes` would create / DROP
 *
 * Why this exists: `npm run sync-indexes` calls Model.syncIndexes() on every
 * model, and syncIndexes() also DROPS any index in the database that the
 * schema does not declare. This script's default mode only calls
 * createIndexes() on the one new (empty) collection — it can never drop an
 * index nor touch another collection. It never reads or writes documents.
 */
async function main() {
  await connectDB();
  try {
    if (process.argv.includes('--diff')) {
      for (const [name, Model] of Object.entries(models)) {
        const { toCreate, toDrop } = await Model.diffIndexes();
        logger.info({ model: name, toCreate, toDrop }, toDrop.length ? `${name}: sync-indexes WOULD DROP ${toDrop.length} index(es)` : `${name}: nothing to drop`);
      }
      return;
    }
    await AccountBalanceTransfer.createIndexes();
    const indexes = await AccountBalanceTransfer.collection.indexes();
    logger.info({ indexes: indexes.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique, partial: i.partialFilterExpression })) }, 'AccountBalanceTransfer indexes ready');
  } finally {
    await disconnectDB();
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed');
  process.exit(1);
});

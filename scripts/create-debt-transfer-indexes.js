import { connectDB, disconnectDB } from '../src/config/db.js';
import mongoose from 'mongoose';

/**
 * Creates ONLY the two indexes the supplier side of debt transfers needs, on
 * the `customerdebttransfers` collection:
 *
 *   fromSupplierId_1_date_-1   { fromSupplierId: 1, date: -1 }  (sparse)
 *   toSupplierId_1_date_-1     { toSupplierId: 1, date: -1 }    (sparse)
 *
 * It deliberately does NOT call `syncIndexes()` (which compares a collection
 * with the schema and DROPS every index the code doesn't declare) and does
 * not touch any other collection. `createIndex` is purely additive and
 * idempotent: if an index with the same name and definition already exists it
 * is a no-op; nothing is ever dropped, rewritten or reindexed.
 *
 * Safe by default: without `--apply` it only connects, prints which database
 * it would use and which of the two indexes are missing, then exits.
 *
 *   node scripts/create-debt-transfer-indexes.js            # dry run (read-only)
 *   node scripts/create-debt-transfer-indexes.js --apply    # create what is missing
 *
 * (also: `npm run create-debt-transfer-indexes [-- --apply]`)
 */
const COLLECTION = 'customerdebttransfers';
const WANTED = [
  { name: 'fromSupplierId_1_date_-1', key: { fromSupplierId: 1, date: -1 } },
  { name: 'toSupplierId_1_date_-1', key: { toSupplierId: 1, date: -1 } },
];

async function main() {
  const apply = process.argv.includes('--apply');
  await connectDB();
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}  (collection: ${COLLECTION})`);
  console.log(apply ? 'Mode: APPLY (additive createIndex only)' : 'Mode: DRY RUN (nothing will be changed; add --apply to create)');

  const exists = (await db.listCollections({ name: COLLECTION }).toArray()).length > 0;
  const current = exists ? await db.collection(COLLECTION).indexes() : [];
  // Match by name OR by key, so an equivalent index that already exists under
  // another name is left alone instead of making createIndex fail.
  const sameKey = (i, idx) => JSON.stringify(i.key) === JSON.stringify(idx.key);

  for (const idx of WANTED) {
    const found = current.find((i) => i.name === idx.name || sameKey(i, idx));
    if (found) {
      const same = sameKey(found, idx) && found.sparse === true;
      console.log(`${same ? 'OK    ' : 'DIFFERS'} ${found.name} already exists${same ? '' : ' with a different definition — leaving it alone, resolve manually'}`);
      continue;
    }
    if (!apply) {
      console.log(`MISSING ${idx.name} (would be created)`);
      continue;
    }
    await db.collection(COLLECTION).createIndex(idx.key, { name: idx.name, sparse: true });
    console.log(`CREATED ${idx.name}`);
  }

  await disconnectDB();
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});

/* eslint-disable */
// Minimal stand-in for `mongoose` — ONLY what the services under test touch.
import { ObjectId, getFakeDb } from './mini-mongo.js';
const HEX = /^[0-9a-f]{24}$/i;
const mongoose = {
  Types: { ObjectId },
  isValidObjectId: (v) => v instanceof ObjectId || (typeof v === 'string' && HEX.test(v)),
  startSession: async () => getFakeDb().newSession(),
};
export default mongoose;

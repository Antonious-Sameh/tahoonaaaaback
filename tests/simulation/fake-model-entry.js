/* eslint-disable */
import { getFakeDb } from './mini-mongo.js';
const name = new URL(import.meta.url).searchParams.get('m');
const model = getFakeDb().model(name);
if (name === 'AccountBalanceTransfer') model.unique = ['idempotencyKey', 'reference'];
if (name === 'CustomerDebtTransfer') model.unique = ['idempotencyKey'];
export default model;

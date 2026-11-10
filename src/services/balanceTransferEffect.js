import mongoose from 'mongoose';
import { round2 } from '../models/shared/money.js';

/**
 * The ONE place that knows how AccountBalanceTransfer documents feed into a
 * Customer's or Supplier's balance. This project computes the same balance
 * in four places (personBalance.service.js, personService.js getTotals and
 * list, reports.service.js getPersonBalanceReport) — every one of them calls
 * into this file for the new term instead of re-implementing it, so they can
 * never disagree about it.
 *
 * The term is simply: the sum of the signed `fromEffect` of every transfer
 * this account was the source of, plus the sum of the signed `toEffect` of
 * every transfer it was the destination of (see AccountBalanceTransfer.js
 * for what those effects mean). It is added to the account's raw balance in
 * the same orientation getPersonRemaining already uses (positive = customer
 * owes the shop / the shop owes the supplier).
 *
 * Backward compatibility: an account with no AccountBalanceTransfer rows
 * gets exactly 0 from every function here, so every existing balance is
 * unchanged to the cent — and every caller only invokes these when the model
 * is passed in, so callers that don't pass it behave byte-for-byte as before.
 */

/** Signed effect of all transfers on one account (used inside transactions). */
export async function getBalanceTransferEffect({ BalanceTransferModel, accountType, personId, session }) {
  const pid = new mongoose.Types.ObjectId(String(personId));
  const query = BalanceTransferModel.aggregate([
    {
      $match: {
        $or: [
          { fromAccountType: accountType, fromAccountId: pid },
          { toAccountType: accountType, toAccountId: pid },
        ],
      },
    },
    {
      $group: {
        _id: null,
        effect: {
          $sum: {
            $add: [
              { $cond: [{ $and: [{ $eq: ['$fromAccountType', accountType] }, { $eq: ['$fromAccountId', pid] }] }, '$fromEffect', 0] },
              { $cond: [{ $and: [{ $eq: ['$toAccountType', accountType] }, { $eq: ['$toAccountId', pid] }] }, '$toEffect', 0] },
            ],
          },
        },
      },
    },
  ]);
  const [agg] = await (session ? query.session(session) : query);
  return round2(agg?.effect || 0);
}

/**
 * Pipeline stages for pipelines whose documents are the accounts themselves
 * (`_id` = account id): adds `outField` = signed effect of all transfers on
 * that account, and drops the temporary lookup arrays. The caller then adds
 * `outField` to its own `remaining` before flooring.
 */
export function balanceTransferEffectStages({ BalanceTransferModel, accountType, outField }) {
  const sumOf = (array, typeField, effectField) => ({
    $sum: {
      $map: {
        input: { $filter: { input: array, as: 't', cond: { $eq: [`$$t.${typeField}`, accountType] } } },
        as: 't',
        in: `$$t.${effectField}`,
      },
    },
  });

  return [
    {
      $lookup: {
        from: BalanceTransferModel.collection.name,
        localField: '_id',
        foreignField: 'fromAccountId',
        as: '_btOut',
      },
    },
    {
      $lookup: {
        from: BalanceTransferModel.collection.name,
        localField: '_id',
        foreignField: 'toAccountId',
        as: '_btIn',
      },
    },
    {
      $addFields: {
        [outField]: {
          $add: [sumOf('$_btOut', 'fromAccountType', 'fromEffect'), sumOf('$_btIn', 'toAccountType', 'toEffect')],
        },
      },
    },
    { $project: { _btOut: 0, _btIn: 0 } },
  ];
}

/** True when any transfer references this account (used to block deletion). */
export async function accountHasBalanceTransfers({ BalanceTransferModel, accountType, personId }) {
  const pid = new mongoose.Types.ObjectId(String(personId));
  return Boolean(await BalanceTransferModel.exists({
    $or: [
      { fromAccountType: accountType, fromAccountId: pid },
      { toAccountType: accountType, toAccountId: pid },
    ],
  }));
}

export default { getBalanceTransferEffect, balanceTransferEffectStages, accountHasBalanceTransfers };

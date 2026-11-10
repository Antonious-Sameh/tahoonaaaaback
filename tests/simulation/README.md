# Offline simulation of the Customer <-> Supplier balance offset

Not part of `npm test` (vitest). It runs the REAL service code
(`accountBalanceTransfer.service.js`, `personBalance.service.js`,
`personService.js`, `reports.service.js`, `utils/transactions.js`) against a small
in-memory imitation of MongoDB (aggregation subset, snapshot-isolated
transactions with write-conflict detection, unique indexes, strict ObjectId
comparison in aggregates).

    node --import ./tests/simulation/register.mjs tests/simulation/run.mjs

It is a SIMULATION: it proves the application logic (formulas, ordering of
writes inside the transaction, rollback behaviour, retry-on-conflict) but not
real MongoDB behaviour. Run the manual checklist against a real replica set
(staging copy, never production) before release.

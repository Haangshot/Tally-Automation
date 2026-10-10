import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildConsolidation, consolidateTrialBalances, companyCore } from '../src/features/controls/consolidation.js';
import { runConsolidation } from '../src/features/controls/index.js';
import { fakeReader } from './controls-fixtures.test.js';

/** getTrialBalance shapes, as reads.js returns them. */
const TB = {
  'Alpha Traders Pvt Ltd': {
    asOf: '2027-03-31',
    ledgers: [
      { name: 'Cash', group: 'Cash-in-Hand', debit: 1000, credit: 0 },
      { name: 'Beta Industries Ltd', group: 'Sundry Debtors', debit: 5000, credit: 0 },
      { name: 'Capital Account', group: 'Capital Account', debit: 0, credit: 6000 },
    ],
    totals: { debit: 6000, credit: 6000, balanced: true },
  },
  'Beta Industries Ltd': {
    asOf: '2027-03-31',
    ledgers: [
      { name: 'Cash', group: 'Cash-in-Hand', debit: 7000, credit: 0 },
      { name: 'Alpha Traders', group: 'Sundry Creditors', debit: 0, credit: 5000 },
      { name: 'Capital Account', group: 'Capital Account', debit: 0, credit: 2000 },
    ],
    totals: { debit: 7000, credit: 7000, balanced: true },
  },
};

describe('consolidation', () => {
  test('company names reduce to their identifying core', () => {
    assert.equal(companyCore('Alpha Traders Pvt. Ltd.'), 'alpha traders');
    assert.equal(companyCore('Smith and Sons Limited'), 'smith sons');
  });

  test('combines by ledger within group, keeps per-company columns, flags elimination candidates', () => {
    const r = consolidateTrialBalances(Object.entries(TB).map(([company, trialBalance]) => ({ company, trialBalance })));
    const cash = r.ledgers.find((l) => l.name === 'Cash');
    assert.deepEqual(cash.byCompany, { 'Alpha Traders Pvt Ltd': { debit: 1000, credit: 0 }, 'Beta Industries Ltd': { debit: 7000, credit: 0 } });
    assert.deepEqual(cash.combined, { amount: 8000, type: 'debit' });
    assert.equal(r.totals.combined.debit, 13000);
    assert.equal(r.totals.combined.balanced, true);

    assert.equal(r.eliminationCandidates.length, 1);
    const pair = r.eliminationCandidates[0];
    assert.deepEqual(pair.ledgers.map((l) => l.ledger).sort(), ['Alpha Traders', 'Beta Industries Ltd']);
    assert.equal(pair.mirrors, true, 'receivable in one, payable in the other, same amount');
    // Not eliminated: both still sit in the combined ledgers.
    assert.ok(r.ledgers.some((l) => l.name === 'Alpha Traders'));
    assert.match(r.note, /NOT eliminated/);
    assert.match(r.note, /by name/);
  });

  test('reads companies one at a time and reports a failure without dropping the rest', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const readerFor = (company) => ({
      getTrialBalance: async ({ asOf }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push([company, asOf]);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (!TB[company]) throw Object.assign(new Error('Company not open'), { code: 'TALLY_COMPANY_NOT_OPEN' });
        return TB[company];
      },
    });
    const r = await buildConsolidation({ companies: ['Alpha Traders Pvt Ltd', 'Beta Industries Ltd', 'Gamma'], asOf: '2027-03-31', readerFor });
    assert.equal(maxInFlight, 1, 'Tally handles one request at a time');
    assert.deepEqual(order.map(([c]) => c), ['Alpha Traders Pvt Ltd', 'Beta Industries Ltd', 'Gamma']);
    assert.equal(order[0][1], '2027-03-31');
    assert.deepEqual(r.companies, ['Alpha Traders Pvt Ltd', 'Beta Industries Ltd']);
    assert.equal(r.failed[0].company, 'Gamma');
  });

  test('null companies means every open company', async () => {
    const reader = fakeReader({ listCompanies: async () => [{ name: 'Alpha Traders Pvt Ltd' }, { name: 'Beta Industries Ltd' }] });
    const r = await runConsolidation(reader, { companies: null, asOf: null }, (c) => ({ getTrialBalance: async () => TB[c] }));
    assert.equal(r.companies.length, 2);
  });
});

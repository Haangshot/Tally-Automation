import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePf, computeEsi, computePt, roundRupee, ceilRupee, ruleInForce, PT_RULES, contributionPeriod,
} from '../src/features/payroll/rules.js';
import { rupeesInWords, integerInWords } from '../src/features/payroll/words.js';

const DATE = '2026-09-01';

describe('PF', () => {
  test('capped: contributions on wages up to 15,000 only', () => {
    const pf = computePf({ pfWages: 25000, capped: true, date: DATE });
    assert.equal(pf.contributionWages, 15000);
    assert.equal(pf.employee, 1800);
    assert.equal(pf.employerTotal, 1800);
    assert.equal(pf.employerEps, 1250); // 8.33% of 15,000 = 1,249.50 -> 1,250
    assert.equal(pf.employerEpf, 550);
    assert.equal(pf.edli, 75);
    assert.equal(pf.admin, 75);
  });

  test('uncapped: 12% on full wages, but EPS still capped at 1,250', () => {
    const pf = computePf({ pfWages: 25000, capped: false, date: DATE });
    assert.equal(pf.contributionWages, 25000);
    assert.equal(pf.employee, 3000);
    assert.equal(pf.employerTotal, 3000);
    assert.equal(pf.employerEps, 1250);
    assert.equal(pf.employerEpf, 1750);
    assert.equal(pf.edli, 75, 'EDLI is on wages up to the ceiling');
    assert.equal(pf.admin, 125, 'admin charges follow contribution wages');
  });

  test('below the ceiling capping changes nothing, and EPS is 8.33% rounded', () => {
    const a = computePf({ pfWages: 10000, capped: true, date: DATE });
    const b = computePf({ pfWages: 10000, capped: false, date: DATE });
    assert.deepEqual({ ...a, rule: null }, { ...b, rule: null });
    assert.equal(a.employee, 1200);
    assert.equal(a.employerEps, 833);
    assert.equal(a.employerEpf, 367);
    assert.equal(a.employerEps + a.employerEpf, a.employerTotal);
  });

  test('rounds to the nearest rupee', () => {
    const pf = computePf({ pfWages: 12345, capped: true, date: DATE });
    assert.equal(pf.employee, 1481); // 1,481.40
    assert.equal(pf.employerEps, 1028); // 1,028.34
    const half = computePf({ pfWages: 12345.84, capped: true, date: DATE }); // 1,481.50
    assert.equal(half.employee, 1482);
  });

  test('EDLI and admin are off when disabled', () => {
    const pf = computePf({ pfWages: 15000, date: DATE, includeEdli: false, includeAdmin: false });
    assert.equal(pf.edli, 0);
    assert.equal(pf.admin, 0);
  });

  test('zero wages give zero contributions', () => {
    const pf = computePf({ pfWages: 0, date: DATE });
    assert.equal(pf.employee + pf.employerTotal + pf.edli + pf.admin, 0);
  });
});

describe('ESI', () => {
  test('exactly 21,000 is covered; contributions rounded up', () => {
    const esi = computeEsi({ gross: 21000, date: DATE, month: '2026-09' });
    assert.equal(esi.covered, true);
    assert.equal(esi.employee, 158); // 157.50 -> 158
    assert.equal(esi.employer, 683); // 682.50 -> 683
  });

  test('21,001 is not covered, with a contribution-period warning', () => {
    const esi = computeEsi({ gross: 21001, date: DATE, month: '2026-09' });
    assert.equal(esi.covered, false);
    assert.equal(esi.employee, 0);
    assert.equal(esi.employer, 0);
    assert.equal(esi.warnings[0].code, 'ESI_CONTRIBUTION_PERIOD');
    assert.match(esi.warnings[0].message, /April–September 2026/);
  });

  test('rounds UP even a fraction of a paisa-rounded rupee', () => {
    // 0.75% of 10,001 = 75.0075 -> 75.01 -> 76
    const esi = computeEsi({ gross: 10001, date: DATE, month: '2026-09' });
    assert.equal(esi.employee, 76);
    // 3.25% of 10,000 = 325.00 exactly -> 325
    assert.equal(computeEsi({ gross: 10000, date: DATE }).employer, 325);
  });

  test('coverage follows full-month wages, contribution the earned wages', () => {
    const esi = computeEsi({ gross: 12000, coverageWages: 30000, date: DATE, month: '2026-09' });
    assert.equal(esi.covered, false, 'a 30,000 earner on short attendance does not fall into ESI');
  });

  test('not applicable means nothing', () => {
    const esi = computeEsi({ gross: 9000, applicable: false, date: DATE });
    assert.equal(esi.covered, false);
    assert.equal(esi.employee, 0);
  });

  test('low daily wage triggers the exemption warning', () => {
    const esi = computeEsi({ gross: 5000, date: DATE, daysInMonth: 30, month: '2026-09' });
    assert.ok(esi.warnings.some((w) => w.code === 'ESI_LOW_WAGE_EXEMPTION'));
  });

  test('contribution periods', () => {
    assert.equal(contributionPeriod('2026-11'), 'October 2026–March 2027');
    assert.equal(contributionPeriod('2027-02'), 'October 2026–March 2027');
  });
});

describe('professional tax', () => {
  const mh = (gross, gender, month = '2026-09') => computePt({ gross, state: 'Maharashtra', gender, month, date: `${month}-01` });

  test('Maharashtra men', () => {
    assert.equal(mh(7500, 'male').amount, 0);
    assert.equal(mh(7501, 'male').amount, 175);
    assert.equal(mh(10000, 'male').amount, 175);
    assert.equal(mh(10001, 'male').amount, 200);
    assert.equal(mh(10001, 'male', '2027-02').amount, 300, '₹300 in February');
    assert.equal(mh(9000, 'male', '2027-02').amount, 175, 'February only changes the top slab');
  });

  test('Maharashtra women', () => {
    assert.equal(mh(25000, 'female').amount, 0);
    assert.equal(mh(25001, 'female').amount, 200);
    assert.equal(mh(25001, 'female', '2027-02').amount, 300);
    assert.equal(mh(12000, 'female').amount, 0);
  });

  test('Maharashtra women before the 2023 change used the ₹10,000 exemption', () => {
    assert.equal(mh(12000, 'female', '2023-05').amount, 200);
  });

  test('other gender uses the men\'s slab with a warning', () => {
    const pt = mh(12000, 'other');
    assert.equal(pt.amount, 200);
    assert.equal(pt.warnings[0].code, 'PT_GENDER_ASSUMED');
  });

  test('Karnataka threshold of 25,000 from 2023-04-01', () => {
    const ka = (gross, month = '2026-09') => computePt({ gross, state: 'KA', gender: 'male', month, date: `${month}-01` });
    assert.equal(ka(24999).amount, 0);
    assert.equal(ka(25000).amount, 200);
    assert.equal(ka(20000, '2023-03').amount, 200, 'the old ₹15,000 threshold applied before April 2023');
    assert.equal(ka(20000, '2023-04').amount, 0);
  });

  test('an unknown state is 0 with a warning naming it', () => {
    const pt = computePt({ gross: 50000, state: 'Goa', gender: 'male', month: '2026-09', date: DATE });
    assert.equal(pt.amount, 0);
    assert.equal(pt.warnings[0].code, 'PT_STATE_NOT_CONFIGURED');
    assert.match(pt.warnings[0].message, /Goa/);
  });

  test('not applicable is 0 without a warning', () => {
    const pt = computePt({ gross: 50000, state: 'Maharashtra', gender: 'male', month: '2026-09', date: DATE, applicable: false });
    assert.equal(pt.amount, 0);
    assert.equal(pt.warnings.length, 0);
  });

  test('rule selection is by effective date', () => {
    assert.equal(ruleInForce(PT_RULES.maharashtra, '2023-06-30').effectiveFrom, '2017-04-01');
    assert.equal(ruleInForce(PT_RULES.maharashtra, '2023-07-01').effectiveFrom, '2023-07-01');
  });
});

describe('rounding and words', () => {
  test('rupee rounding helpers', () => {
    assert.equal(roundRupee(10.5), 11);
    assert.equal(roundRupee(10.49), 10);
    assert.equal(ceilRupee(10.01), 11);
    assert.equal(ceilRupee(10), 10);
  });

  test('Indian numbering in words', () => {
    assert.equal(integerInWords(0), 'Zero');
    assert.equal(integerInWords(105), 'One Hundred Five');
    assert.equal(integerInWords(123456), 'One Lakh Twenty Three Thousand Four Hundred Fifty Six');
    assert.equal(integerInWords(10000000), 'One Crore');
    assert.equal(rupeesInWords(23450.5), 'Rupees Twenty Three Thousand Four Hundred Fifty and Fifty Paise Only');
    assert.equal(rupeesInWords(1200000), 'Rupees Twelve Lakh Only');
  });
});

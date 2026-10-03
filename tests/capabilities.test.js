import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityProfiler, CAPABILITY_MAP, requireCapability, decide, readFlags, modeOf, isoDate,
} from '../src/tally/capabilities.js';

/**
 * A company row shaped like the one TallyPrime actually returns. The values
 * below were taken from a live probe rather than invented, including the
 * PREVIS… fields Tally reports instead of a live switch for some features.
 */
function companyRow(overrides = {}) {
  return {
    NAME: 'Tally_Aut',
    GUID: '01b3d0b2-e9e2-4548-8152-093e570aef41',
    STARTINGFROM: '20260401',
    BOOKSFROM: '20260401',
    COUNTRYNAME: 'India',
    COMPANYNUMBER: '100000',
    ISACCOUNTINGON: 'Yes',
    ISINVENTORYON: 'Yes',
    ISINTEGRATED: 'Yes',
    ISBILLWISEON: 'Yes',
    ISCOSTCENTRESON: 'Yes',
    ISBATCHWISEON: 'Yes',
    ISPERISHABLEON: 'Yes',
    ISGSTON: 'Yes',
    ISTDSON: 'Yes',
    ISTCSON: 'Yes',
    ISPAYROLLON: 'Yes',
    ISINTERESTON: 'Yes',
    ISJOBCOSTINGON: 'Yes',
    ISJOBWORKON: 'Yes',
    ISBOMON: 'No',
    ISEDITLOGON: 'No',
    ISTALLYAUDITON: 'No',
    ISSECURITYON: 'No',
    USEPRICELEVELS: 'Yes',
    ISDISCOUNTSON: 'Yes',
    ISCHQPRINTINGON: 'Yes',
    ISEBANKINGON: 'No',
    ISMULTIADDRESSON: 'No',
    USEZEROENTRIES: 'No',
    PREVISCOSTCATEGORYON: 'No',
    PREVISBUDGETSON: 'No',
    PREVISMULTICURRENCYON: 'No',
    PREVISMULTIGODOWNON: 'No',
    PREVISSALESORDERSON: 'No',
    PREVISPURCORDERSON: 'No',
    PREVISTRACKINGON: 'No',
    PREVISREJECTIONON: 'No',
    ...overrides,
  };
}

/** Stands in for TallyReader. Counts every call so caching can be asserted. */
function fakeReader({ rows, counts = {}, voucherTypes = [], fail = null } = {}) {
  const calls = { collection: 0, voucherTypes: 0 };
  return {
    company: 'Tally_Aut',
    calls,
    client: {
      async collection({ type }) {
        calls.collection += 1;
        if (fail) throw fail;
        if (type === 'Company') return rows ?? [companyRow()];
        const n = counts[type] ?? 0;
        return Array.from({ length: n }, (_, i) => ({ NAME: `${type} ${i + 1}` }));
      },
    },
    async listVoucherTypes() {
      calls.voucherTypes += 1;
      return { items: voucherTypes.map((name) => ({ name, parent: name })) };
    },
  };
}

describe('capability detection', () => {
  test('reads live switches straight off the company', async () => {
    const p = await new CapabilityProfiler({ reader: fakeReader() }).profile();

    assert.equal(p.ok, true);
    assert.equal(p.company, 'Tally_Aut');
    assert.equal(p.guid, '01b3d0b2-e9e2-4548-8152-093e570aef41');
    assert.equal(p.booksFrom, '2026-04-01');
    assert.equal(p.mode, 'accounts-with-inventory');

    assert.equal(p.features.gst.enabled, true);
    assert.equal(p.features.gst.source, 'company-flag');
    assert.equal(p.features.gst.known, true);

    assert.equal(p.features.bom.enabled, false);
    assert.equal(p.features.editLog.enabled, false);
  });

  test('a stale flag is believed only when the data agrees', async () => {
    // Budgets off, and no budgets exist: the two agree.
    const agree = await new CapabilityProfiler({
      reader: fakeReader({ counts: { Budget: 0 } }),
    }).profile();
    assert.equal(agree.features.budgets.enabled, false);
    assert.equal(agree.features.budgets.known, true);
    assert.equal(agree.features.budgets.source, 'stale-flag+data');
  });

  test('a stale flag contradicted by the data resolves to unknown, not enabled', async () => {
    // The switch was off at last save, yet budgets exist. We must not guess.
    const conflict = await new CapabilityProfiler({
      reader: fakeReader({ counts: { Budget: 3 } }),
    }).profile();

    const b = conflict.features.budgets;
    assert.equal(b.enabled, false, 'a conflict must never resolve to enabled');
    assert.equal(b.known, false);
    assert.equal(b.source, 'conflict');
    assert.match(b.note, /Treated as unavailable/);
  });

  test('one currency is the base currency, not multi-currency', async () => {
    const single = await new CapabilityProfiler({
      reader: fakeReader({ counts: { Currency: 1 } }),
    }).profile();
    assert.equal(single.features.multiCurrency.enabled, false);
    assert.equal(single.features.multiCurrency.known, true);

    const many = await new CapabilityProfiler({
      reader: fakeReader({
        rows: [companyRow({ PREVISMULTICURRENCYON: 'Yes' })],
        counts: { Currency: 3 },
      }),
    }).profile();
    assert.equal(many.features.multiCurrency.enabled, true);
  });

  test('order processing is corroborated by the voucher type existing', async () => {
    const off = await new CapabilityProfiler({ reader: fakeReader({ voucherTypes: [] }) }).profile();
    assert.equal(off.features.salesOrders.enabled, false);

    const on = await new CapabilityProfiler({
      reader: fakeReader({
        rows: [companyRow({ PREVISSALESORDERSON: 'Yes' })],
        voucherTypes: ['Sales Order', 'Purchase Order'],
      }),
    }).profile();
    assert.equal(on.features.salesOrders.enabled, true);
    assert.equal(on.features.salesOrders.source, 'stale-flag+data');
  });

  test('a company we cannot read is not a company with nothing enabled', async () => {
    const err = Object.assign(new Error('TallyPrime is not running.'), { code: 'NOT_RUNNING' });
    const p = await new CapabilityProfiler({ reader: fakeReader({ fail: err }) }).profile();

    assert.equal(p.ok, false);
    assert.equal(p.code, 'NOT_RUNNING');
    assert.deepEqual(p.features, {});

    // And the gate must refuse, not wave it through.
    const refusal = requireCapability(p, 'gst');
    assert.equal(refusal.code, 'CAPABILITY_UNKNOWN');
    assert.match(refusal.message, /Refusing rather than assuming/);
  });

  test('accounts-only companies are recognised', async () => {
    const p = await new CapabilityProfiler({
      reader: fakeReader({ rows: [companyRow({ ISINVENTORYON: 'No' })] }),
    }).profile();
    assert.equal(p.mode, 'accounts-only');
    assert.equal(p.features.inventory.enabled, false);
  });

  test('the profile is cached, then released on demand', async () => {
    const reader = fakeReader();
    const profiler = new CapabilityProfiler({ reader, ttlMs: 60_000 });

    await profiler.profile();
    const afterFirst = reader.calls.collection;
    assert.ok(afterFirst > 0);

    await profiler.profile();
    assert.equal(reader.calls.collection, afterFirst, 'second call should be served from cache');

    profiler.invalidate();
    await profiler.profile();
    assert.ok(reader.calls.collection > afterFirst, 'invalidate must force a re-read');
  });
});

describe('the capability gate', () => {
  test('passes an enabled capability and blocks a disabled one', async () => {
    const p = await new CapabilityProfiler({ reader: fakeReader() }).profile();

    assert.equal(requireCapability(p, 'gst'), null);
    assert.equal(requireCapability(p, 'billWise'), null);

    const blocked = requireCapability(p, 'bom');
    assert.equal(blocked.code, 'CAPABILITY_DISABLED');
    assert.equal(blocked.capability, 'bom');
    // The refusal has to be actionable: name the switch and where it lives.
    assert.match(blocked.message, /Bill of Materials is not enabled/);
    assert.match(blocked.message, /F11 > Inventory Features/);
  });

  test('an unknown capability key is not an error', () => {
    assert.equal(requireCapability({ ok: true, features: {} }, 'nonsense'), null);
  });

  test('every capability explains where its switch lives', () => {
    for (const [key, spec] of Object.entries(CAPABILITY_MAP)) {
      assert.ok(spec.label, `${key} needs a label`);
      assert.ok(spec.gates, `${key} needs to say what it gates`);
      assert.match(spec.where, /F11|Company|Gateway/, `${key} needs a findable location`);
      assert.match(spec.flag, /^[A-Z]/, `${key} needs a Tally flag`);
    }
  });

  test('every stale flag names the evidence that corroborates it', () => {
    for (const [key, spec] of Object.entries(CAPABILITY_MAP)) {
      if (spec.stale) assert.ok(spec.corroborate, `${key} is stale so it needs corroboration`);
    }
  });
});

describe('capability helpers', () => {
  test('only yes/no fields become flags', () => {
    const flags = readFlags({ ISGSTON: 'Yes', ISBOMON: 'No', NAME: 'Acme', COMPANYNUMBER: '100000' });
    assert.deepEqual(flags, { ISGSTON: true, ISBOMON: false });
  });

  test('an absent flag is not a disabled flag', () => {
    const d = decide('gst', CAPABILITY_MAP.gst, {}, {});
    assert.equal(d.enabled, false);
    assert.equal(d.known, false);
    assert.equal(d.source, 'absent');
  });

  test('Tally dates become ISO dates', () => {
    assert.equal(isoDate('20260401'), '2026-04-01');
    assert.equal(isoDate(''), '');
    assert.equal(isoDate('nonsense'), '');
  });

  test('a non-integrated company is called out as such', () => {
    assert.equal(modeOf({ ISINVENTORYON: true, ISINTEGRATED: false }),
      'accounts-with-inventory (not integrated)');
  });
});

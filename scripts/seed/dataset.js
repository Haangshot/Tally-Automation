/**
 * A realistic six-month book for testing: an office-furniture trader in Pune
 * (our GSTIN 27AABCT1332L1ZE, Maharashtra).
 *
 * Everything here is invented, but it is invented the way real books look:
 * purchases precede the sales they supply, intrastate parties attract
 * CGST+SGST and out-of-state parties attract IGST, customers pay late and
 * sometimes only in part, and each month closes with rent, salary and
 * utilities.
 *
 * Tax and totals are COMPUTED, never typed, so an invoice cannot disagree
 * with itself. Every voucher carries a referenceNumber, which is what makes
 * re-running the seeder safe: duplicate detection refuses a second post.
 */
import { round2 } from '../../src/tally/normalize.js';

/** Our own state. Anything else on an invoice is an interstate supply. */
export const HOME_STATE_CODE = '27';

/**
 * TallyPrime in Educational Mode accepts voucher dates on the 1st, 2nd and
 * 31st of a month and refuses every other day — with the unhelpful message
 * "Voucher date is missing". A licensed Tally takes the dates as written.
 *
 * This squeezes the calendar into the days Educational Mode allows while
 * keeping every voucher in its own month and never reordering two vouchers
 * against each other, so stock still cannot go negative:
 *
 *   day 1-7 -> the 1st      day 8-20 -> the 2nd      day 21+ -> the 31st
 *
 * A month without a 31st puts its late vouchers on the 2nd rather than
 * pushing them into the next month, which would move them out of the period
 * they belong to.
 */
export function snapToEducationalDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  let snapped;
  if (day <= 7) snapped = 1;
  else if (day <= 20) snapped = 2;
  else snapped = lastDay === 31 ? 31 : 2;

  return `${year}-${String(month).padStart(2, '0')}-${String(snapped).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ masters

/** Stock catalogue. `unit` must match a unit symbol that exists in Tally. */
export const STOCK_ITEMS = [
  { name: 'Executive Desk 1800mm', unit: 'Unit', hsnSac: '940330', gstRate: 18 },
  { name: 'Ergonomic Task Chair', unit: 'Unit', hsnSac: '940130', gstRate: 18 },
  { name: 'Steel Filing Cabinet 4-Drawer', unit: 'Unit', hsnSac: '940320', gstRate: 18 },
  { name: 'Conference Table 8-Seater', unit: 'Unit', hsnSac: '940330', gstRate: 18 },
  { name: 'Workstation Partition Panel', unit: 'Unit', hsnSac: '940360', gstRate: 18 },
  { name: 'Reception Sofa 3-Seater', unit: 'Unit', hsnSac: '940140', gstRate: 18 },
  { name: 'Melamine Board 18mm', unit: 'Unit', hsnSac: '441012', gstRate: 18 },
  { name: 'Edge Banding Tape 22mm', unit: 'Mtr', hsnSac: '391910', gstRate: 18 },
  { name: 'Wood Adhesive 5L', unit: 'Ltr', hsnSac: '350691', gstRate: 18 },
  { name: 'Chair Castor Wheel Set', unit: 'Box', hsnSac: '830260', gstRate: 18 },
];

/** Ledgers the book needs. Parties carry a GSTIN; its state drives the tax split. */
export const LEDGERS = [
  // Funding and banking
  { name: 'Proprietor Capital A/c', parent: 'Capital Account' },
  { name: 'HDFC Bank Current A/c', parent: 'Bank Accounts' },

  // Tax withheld on our own payments
  { name: 'TDS Payable', parent: 'Duties & Taxes' },

  // Assets
  { name: 'Office Equipment', parent: 'Fixed Assets' },

  // Cost of goods
  { name: 'Freight Inward', parent: 'Direct Expenses' },

  // Running costs
  { name: 'Office Rent', parent: 'Indirect Expenses' },
  { name: 'Salaries & Wages', parent: 'Indirect Expenses' },
  { name: 'Electricity Charges', parent: 'Indirect Expenses' },
  { name: 'Telephone & Internet', parent: 'Indirect Expenses' },
  { name: 'Courier & Freight Outward', parent: 'Indirect Expenses' },
  { name: 'Printing & Stationery', parent: 'Indirect Expenses' },
  { name: 'Professional Fees', parent: 'Indirect Expenses' },
  { name: 'Bank Charges', parent: 'Indirect Expenses' },
  { name: 'Repairs & Maintenance', parent: 'Indirect Expenses' },
  { name: 'Travelling Expenses', parent: 'Indirect Expenses' },
  { name: 'Advertisement & Marketing', parent: 'Indirect Expenses' },

  // Customers
  {
    name: 'Sunrise Interiors Pvt Ltd', parent: 'Sundry Debtors', gstin: '27AADCS4567M1ZP',
    state: 'Maharashtra', address: 'Plot 14, Baner Road, Pune 411045', phone: '02025881400', billWise: true,
  },
  {
    name: 'Deccan Office Solutions', parent: 'Sundry Debtors', gstin: '27AAECD8842K1Z9',
    state: 'Maharashtra', address: 'Lodha Supremus, Worli, Mumbai 400018', phone: '02224961122', billWise: true,
  },
  {
    name: 'Metro Workspaces LLP', parent: 'Sundry Debtors', gstin: '27AAFFM2211R1ZB',
    state: 'Maharashtra', address: 'Unit 7, Wagle Estate, Thane 400604', phone: '02225823377', billWise: true,
  },
  {
    name: 'Bengaluru Tech Parks Pvt Ltd', parent: 'Sundry Debtors', gstin: '29AABCB1429F1Z6',
    state: 'Karnataka', address: 'Tower B, Outer Ring Road, Bengaluru 560103', phone: '08041227700', billWise: true,
  },
  {
    name: 'Gurgaon Corporate Interiors', parent: 'Sundry Debtors', gstin: '06AAHCG7731N1Z2',
    state: 'Haryana', address: 'Sector 44, Gurugram 122003', phone: '01244455660', billWise: true,
  },
  {
    name: 'Ahmedabad Business Centre', parent: 'Sundry Debtors', gstin: '24AACCA5590L1ZK',
    state: 'Gujarat', address: 'SG Highway, Ahmedabad 380015', phone: '07926850099', billWise: true,
  },

  // Suppliers (three more already exist, created by scripts/setup-gst-masters.js)
  {
    name: 'Nagpur Timber & Boards', parent: 'Sundry Creditors', gstin: '27AAGCN3321P1ZQ',
    state: 'Maharashtra', address: 'MIDC Hingna, Nagpur 440016', phone: '07122345611', billWise: true,
  },
  {
    name: 'Chennai Hardware Traders', parent: 'Sundry Creditors', gstin: '33AABCC9087H1ZX',
    state: 'Tamil Nadu', address: 'Anna Salai, Chennai 600002', phone: '04428520033', billWise: true,
  },
];

/** Where each party sits, so the tax split can be chosen without guessing. */
const PARTY_STATE = Object.fromEntries([
  ...LEDGERS.filter((l) => l.gstin).map((l) => [l.name, l.gstin.slice(0, 2)]),
  // Suppliers that setup-gst-masters.js already created.
  ['Rushabh Creatify Supplies Pvt Ltd', '27'],
  ['Karnataka Components Ltd', '29'],
  ['Gujarat Packaging Co', '24'],
]);

// ------------------------------------------------------------------ helpers

const UNIT_OF = Object.fromEntries(STOCK_ITEMS.map((i) => [i.name, i.unit]));

const BANK = 'HDFC Bank Current A/c';

function isIntrastate(party) {
  const code = PARTY_STATE[party];
  if (!code) throw new Error(`No state known for party "${party}" - add it to PARTY_STATE.`);
  return code === HOME_STATE_CODE;
}

/**
 * One stock invoice, with the tax worked out from its own lines.
 *
 * `side` is 'purchase' or 'sales' and picks which half of the GST ledgers is
 * used; a credit or debit note reuses the half belonging to the sale or
 * purchase it reverses.
 */
function stockInvoice({ voucherType, side, date, party, ref, refDate, lines, rate = 18, narration }) {
  const items = lines.map(([stockItem, quantity, unitRate]) => {
    const unit = UNIT_OF[stockItem];
    if (!unit) throw new Error(`Unknown stock item "${stockItem}".`);
    return { stockItem, quantity, unit, rate: unitRate, amount: round2(quantity * unitRate) };
  });

  const subtotal = round2(items.reduce((sum, i) => sum + i.amount, 0));
  const prefix = side === 'purchase' ? 'Input' : 'Output';
  const direction = side === 'purchase' ? 'debit' : 'credit';
  const taxes = isIntrastate(party)
    ? [
      { ledger: `${prefix} CGST`, type: direction, amount: round2((subtotal * rate) / 200) },
      { ledger: `${prefix} SGST`, type: direction, amount: round2((subtotal * rate) / 200) },
    ]
    : [
      { ledger: `${prefix} IGST`, type: direction, amount: round2((subtotal * rate) / 100) },
    ];

  const total = round2(subtotal + taxes.reduce((sum, t) => sum + t.amount, 0));

  return {
    kind: 'inventory_invoice',
    payload: {
      voucherType,
      date,
      party,
      account: side === 'purchase' ? 'Purchase' : 'Sales',
      items,
      taxes,
      total,
      referenceNumber: ref,
      ...(refDate ? { referenceDate: refDate } : {}),
      ...(narration ? { narration } : {}),
    },
  };
}

const purchase = (args) => stockInvoice({ ...args, voucherType: 'Purchase', side: 'purchase' });
const sale = (args) => stockInvoice({ ...args, voucherType: 'Sales', side: 'sales' });
const creditNote = (args) => stockInvoice({ ...args, voucherType: 'Credit Note', side: 'sales' });
const debitNote = (args) => stockInvoice({ ...args, voucherType: 'Debit Note', side: 'purchase' });

/** A plain accounting voucher: ledger lines only, no stock. */
function voucher({ voucherType, date, entries, party, ref, narration }) {
  return {
    kind: 'accounting_voucher',
    payload: {
      voucherType,
      date,
      entries: entries.map(([ledger, type, amount]) => ({ ledger, type, amount: round2(amount) })),
      ...(party ? { party } : {}),
      ...(ref ? { referenceNumber: ref } : {}),
      ...(narration ? { narration } : {}),
    },
  };
}

/** Money in from a customer. */
const receipt = ({ date, party, amount, ref, narration }) => voucher({
  voucherType: 'Receipt',
  date,
  party,
  ref,
  narration,
  entries: [[BANK, 'debit', amount], [party, 'credit', amount]],
});

/** Money out to a supplier. */
const payment = ({ date, party, amount, ref, narration }) => voucher({
  voucherType: 'Payment',
  date,
  party,
  ref,
  narration,
  entries: [[party, 'debit', amount], [BANK, 'credit', amount]],
});

/** An overhead paid straight out of the bank (or out of cash). */
const expense = ({ date, ledger, amount, ref, narration, from = BANK }) => voucher({
  voucherType: 'Payment',
  date,
  ref,
  narration,
  entries: [[ledger, 'debit', amount], [from, 'credit', amount]],
});

// ------------------------------------------------------------- transactions

const MONTHS = [
  { key: 'APR26', rent: '2026-04-05', salaryOn: '2026-04-30', salary: 145000, elecOn: '2026-04-18', elec: 9840, netOn: '2026-04-12', cashOn: '2026-04-10' },
  { key: 'MAY26', rent: '2026-05-05', salaryOn: '2026-05-30', salary: 145000, elecOn: '2026-05-19', elec: 12460, netOn: '2026-05-12', cashOn: '2026-05-11' },
  { key: 'JUN26', rent: '2026-06-05', salaryOn: '2026-06-30', salary: 152000, elecOn: '2026-06-18', elec: 14180, netOn: '2026-06-12', cashOn: '2026-06-10' },
  { key: 'JUL26', rent: '2026-07-06', salaryOn: '2026-07-31', salary: 152000, elecOn: '2026-07-17', elec: 13290, netOn: '2026-07-13', cashOn: '2026-07-10' },
  { key: 'AUG26', rent: '2026-08-05', salaryOn: '2026-08-31', salary: 158500, elecOn: '2026-08-19', elec: 11730, netOn: '2026-08-12', cashOn: '2026-08-10' },
  { key: 'SEP26', rent: '2026-09-04', salaryOn: '2026-09-21', salary: 158500, elecOn: '2026-09-17', elec: 8960, netOn: '2026-09-11', cashOn: '2026-09-10' },
];

const RENT = 55000;
const INTERNET = 4250;

/**
 * The whole book, in date order. Every item is bought before it is sold, so
 * stock never goes negative at any point in the timeline.
 */
export function buildVouchers() {
  const list = [];

  // --- capital brought in on day one
  list.push(voucher({
    voucherType: 'Receipt',
    date: '2026-04-01',
    ref: 'CAP/OPEN/01',
    narration: 'Proprietor capital introduced into the current account',
    entries: [[BANK, 'debit', 2500000], ['Proprietor Capital A/c', 'credit', 2500000]],
  }));

  // --- stock bought in
  list.push(purchase({
    date: '2026-04-02',
    party: 'Rushabh Creatify Supplies Pvt Ltd',
    ref: 'RC/26-27/104',
    refDate: '2026-04-01',
    narration: 'Opening stock of desks and task chairs',
    lines: [['Executive Desk 1800mm', 20, 8500], ['Ergonomic Task Chair', 40, 4200]],
  }));
  list.push(purchase({
    date: '2026-04-08',
    party: 'Karnataka Components Ltd',
    ref: 'KCL/2026/0412',
    refDate: '2026-04-06',
    lines: [['Chair Castor Wheel Set', 60, 950], ['Steel Filing Cabinet 4-Drawer', 15, 6800]],
  }));
  list.push(purchase({
    date: '2026-04-20',
    party: 'Nagpur Timber & Boards',
    ref: 'NTB/1187',
    refDate: '2026-04-18',
    lines: [['Melamine Board 18mm', 120, 1450], ['Edge Banding Tape 22mm', 500, 28]],
  }));
  list.push(purchase({
    date: '2026-05-06',
    party: 'Gujarat Packaging Co',
    ref: 'GPC/26/0331',
    refDate: '2026-05-04',
    lines: [['Wood Adhesive 5L', 80, 640]],
  }));
  list.push(purchase({
    date: '2026-05-18',
    party: 'Rushabh Creatify Supplies Pvt Ltd',
    ref: 'RC/26-27/188',
    refDate: '2026-05-16',
    lines: [['Conference Table 8-Seater', 8, 22000], ['Reception Sofa 3-Seater', 6, 18500]],
  }));
  list.push(purchase({
    date: '2026-06-09',
    party: 'Chennai Hardware Traders',
    ref: 'CHT/26-27/0077',
    refDate: '2026-06-05',
    lines: [['Workstation Partition Panel', 45, 3200]],
  }));
  list.push(purchase({
    date: '2026-06-24',
    party: 'Karnataka Components Ltd',
    ref: 'KCL/2026/0688',
    refDate: '2026-06-22',
    lines: [['Ergonomic Task Chair', 50, 4150]],
  }));
  list.push(purchase({
    date: '2026-07-14',
    party: 'Nagpur Timber & Boards',
    ref: 'NTB/1342',
    refDate: '2026-07-11',
    lines: [['Melamine Board 18mm', 100, 1480]],
  }));
  list.push(purchase({
    date: '2026-08-05',
    party: 'Rushabh Creatify Supplies Pvt Ltd',
    ref: 'RC/26-27/263',
    refDate: '2026-08-03',
    lines: [['Executive Desk 1800mm', 25, 8650], ['Steel Filing Cabinet 4-Drawer', 20, 6900]],
  }));
  list.push(purchase({
    date: '2026-09-03',
    party: 'Gujarat Packaging Co',
    ref: 'GPC/26/0498',
    refDate: '2026-09-01',
    lines: [['Wood Adhesive 5L', 60, 655], ['Chair Castor Wheel Set', 40, 975]],
  }));

  // --- stock sold on
  list.push(sale({
    date: '2026-04-11',
    party: 'Sunrise Interiors Pvt Ltd',
    ref: 'AOI/26-27/001',
    narration: 'Baner office fit-out, phase 1',
    lines: [['Executive Desk 1800mm', 6, 12500], ['Ergonomic Task Chair', 12, 6200]],
  }));
  list.push(sale({
    date: '2026-04-25',
    party: 'Bengaluru Tech Parks Pvt Ltd',
    ref: 'AOI/26-27/002',
    lines: [['Steel Filing Cabinet 4-Drawer', 5, 9900], ['Ergonomic Task Chair', 10, 6100]],
  }));
  list.push(sale({
    date: '2026-05-09',
    party: 'Deccan Office Solutions',
    ref: 'AOI/26-27/003',
    lines: [['Melamine Board 18mm', 40, 2150], ['Edge Banding Tape 22mm', 200, 45]],
  }));
  list.push(sale({
    date: '2026-05-22',
    party: 'Metro Workspaces LLP',
    ref: 'AOI/26-27/004',
    lines: [['Conference Table 8-Seater', 2, 32500], ['Ergonomic Task Chair', 16, 6250]],
  }));
  list.push(sale({
    date: '2026-06-11',
    party: 'Gurgaon Corporate Interiors',
    ref: 'AOI/26-27/005',
    lines: [['Executive Desk 1800mm', 8, 12750], ['Workstation Partition Panel', 12, 4700]],
  }));
  list.push(sale({
    date: '2026-06-27',
    party: 'Sunrise Interiors Pvt Ltd',
    ref: 'AOI/26-27/006',
    lines: [['Ergonomic Task Chair', 25, 6300], ['Chair Castor Wheel Set', 15, 1400]],
  }));
  list.push(sale({
    date: '2026-07-08',
    party: 'Ahmedabad Business Centre',
    ref: 'AOI/26-27/007',
    lines: [['Reception Sofa 3-Seater', 3, 27500], ['Conference Table 8-Seater', 2, 32800]],
  }));
  list.push(sale({
    date: '2026-07-21',
    party: 'Deccan Office Solutions',
    ref: 'AOI/26-27/008',
    lines: [['Melamine Board 18mm', 60, 2200], ['Wood Adhesive 5L', 25, 980]],
  }));
  list.push(sale({
    date: '2026-08-12',
    party: 'Bengaluru Tech Parks Pvt Ltd',
    ref: 'AOI/26-27/009',
    lines: [['Executive Desk 1800mm', 15, 12900], ['Steel Filing Cabinet 4-Drawer', 12, 10100]],
  }));
  list.push(sale({
    date: '2026-08-28',
    party: 'Metro Workspaces LLP',
    ref: 'AOI/26-27/010',
    lines: [['Workstation Partition Panel', 20, 4800], ['Ergonomic Task Chair', 14, 6350]],
  }));
  list.push(sale({
    date: '2026-09-09',
    party: 'Sunrise Interiors Pvt Ltd',
    ref: 'AOI/26-27/011',
    lines: [['Executive Desk 1800mm', 10, 13100], ['Chair Castor Wheel Set', 20, 1450]],
  }));
  list.push(sale({
    date: '2026-09-18',
    party: 'Gurgaon Corporate Interiors',
    ref: 'AOI/26-27/012',
    lines: [['Reception Sofa 3-Seater', 2, 28000], ['Steel Filing Cabinet 4-Drawer', 8, 10200]],
  }));

  // --- returns, both directions
  list.push(creditNote({
    date: '2026-07-30',
    party: 'Sunrise Interiors Pvt Ltd',
    ref: 'AOI/CN/26-27/001',
    narration: 'Two chairs returned against AOI/26-27/006 - damaged armrests',
    lines: [['Ergonomic Task Chair', 2, 6300]],
  }));
  list.push(debitNote({
    date: '2026-08-19',
    party: 'Karnataka Components Ltd',
    ref: 'AOI/DN/26-27/001',
    narration: 'Three chairs returned to supplier against KCL/2026/0688',
    lines: [['Ergonomic Task Chair', 3, 4150]],
  }));

  // --- customers paying, mostly late, the last two only in part
  const receipts = [
    ['2026-04-28', 'Sunrise Interiors Pvt Ltd', 176292, 'NEFT/2604281'],
    ['2026-05-14', 'Bengaluru Tech Parks Pvt Ltd', 130390, 'NEFT/2605141'],
    ['2026-05-29', 'Deccan Office Solutions', 112100, 'RTGS/2605291'],
    ['2026-06-16', 'Metro Workspaces LLP', 194700, 'NEFT/2606161'],
    ['2026-07-02', 'Gurgaon Corporate Interiors', 186912, 'RTGS/2607021'],
    ['2026-07-17', 'Sunrise Interiors Pvt Ltd', 210630, 'NEFT/2607171'],
    ['2026-08-04', 'Ahmedabad Business Centre', 174758, 'NEFT/2608041'],
    ['2026-08-21', 'Deccan Office Solutions', 184670, 'RTGS/2608211'],
    ['2026-09-05', 'Bengaluru Tech Parks Pvt Ltd', 250000, 'RTGS/2609051'],
    ['2026-09-16', 'Metro Workspaces LLP', 218182, 'NEFT/2609161'],
  ];
  for (const [date, party, amount, ref] of receipts) {
    list.push(receipt({ date, party, amount, ref, narration: `Collection from ${party}` }));
  }

  // --- suppliers being paid, the last one only in part
  const payments = [
    ['2026-04-30', 'Rushabh Creatify Supplies Pvt Ltd', 398840, 'PAY/2604301'],
    ['2026-05-12', 'Karnataka Components Ltd', 187620, 'PAY/2605121'],
    ['2026-05-28', 'Nagpur Timber & Boards', 221840, 'PAY/2605281'],
    ['2026-06-15', 'Gujarat Packaging Co', 60416, 'PAY/2606151'],
    ['2026-06-30', 'Rushabh Creatify Supplies Pvt Ltd', 338660, 'PAY/2606301'],
    ['2026-07-13', 'Chennai Hardware Traders', 169920, 'PAY/2607131'],
    ['2026-07-29', 'Karnataka Components Ltd', 244850, 'PAY/2607291'],
    ['2026-08-17', 'Nagpur Timber & Boards', 174640, 'PAY/2608171'],
    ['2026-09-08', 'Rushabh Creatify Supplies Pvt Ltd', 250000, 'PAY/2609081'],
  ];
  for (const [date, party, amount, ref] of payments) {
    list.push(payment({ date, party, amount, ref, narration: `Payment to ${party}` }));
  }

  // --- the monthly overheads
  for (const m of MONTHS) {
    list.push(expense({
      date: m.rent, ledger: 'Office Rent', amount: RENT, ref: `RENT/${m.key}`,
      narration: 'Office rent for the month',
    }));
    list.push(expense({
      date: m.salaryOn, ledger: 'Salaries & Wages', amount: m.salary, ref: `SAL/${m.key}`,
      narration: 'Staff salaries for the month',
    }));
    list.push(expense({ date: m.elecOn, ledger: 'Electricity Charges', amount: m.elec, ref: `ELEC/${m.key}` }));
    list.push(expense({ date: m.netOn, ledger: 'Telephone & Internet', amount: INTERNET, ref: `NET/${m.key}` }));
    list.push(voucher({
      voucherType: 'Contra',
      date: m.cashOn,
      ref: `CASH/${m.key}`,
      narration: 'Cash drawn for petty expenses',
      entries: [['Cash', 'debit', 25000], [BANK, 'credit', 25000]],
    }));
  }

  // --- the irregular ones
  list.push(expense({
    date: '2026-04-16', ledger: 'Printing & Stationery', amount: 6480, ref: 'PS/2604161',
    from: 'Cash', narration: 'Letterheads and invoice books',
  }));
  list.push(expense({
    date: '2026-04-22', ledger: 'Freight Inward', amount: 14750, ref: 'FRT/2604221',
    narration: 'Inward freight on NTB/1187',
  }));
  list.push(expense({
    date: '2026-05-25', ledger: 'Courier & Freight Outward', amount: 18900, ref: 'FRO/2605251',
    narration: 'Deliveries to Mumbai and Thane',
  }));
  list.push(expense({
    date: '2026-06-18', ledger: 'Advertisement & Marketing', amount: 45000, ref: 'ADV/2606181',
    narration: 'Trade show stall, Pune Design Week',
  }));
  list.push(expense({
    date: '2026-07-10', ledger: 'Repairs & Maintenance', amount: 12500, ref: 'RM/2607101',
    narration: 'Workshop compressor service',
  }));
  list.push(expense({
    date: '2026-08-14', ledger: 'Travelling Expenses', amount: 18400, ref: 'TRV/2608141',
    narration: 'Site visits, Bengaluru and Gurugram',
  }));
  list.push(expense({
    date: '2026-08-26', ledger: 'Office Equipment', amount: 62000, ref: 'CAP/2608261',
    narration: 'Two laptops for the sales desk',
  }));
  list.push(expense({
    date: '2026-09-12', ledger: 'Courier & Freight Outward', amount: 21350, ref: 'FRO/2609121',
    narration: 'Deliveries to Gurugram',
  }));
  list.push(expense({
    date: '2026-09-15', ledger: 'Printing & Stationery', amount: 4120, ref: 'PS/2609151', from: 'Cash',
  }));

  // --- professional fees, net of TDS
  for (const [date, quarter] of [['2026-06-28', 'Q1'], ['2026-09-19', 'Q2']]) {
    list.push(voucher({
      voucherType: 'Payment',
      date,
      ref: `PROF/${quarter}/2627`,
      narration: 'Accountant retainer, net of 10% TDS under 194J',
      entries: [
        ['Professional Fees', 'debit', 25000],
        ['TDS Payable', 'credit', 2500],
        [BANK, 'credit', 22500],
      ],
    }));
  }

  // --- quarterly bank charges
  list.push(voucher({
    voucherType: 'Journal',
    date: '2026-06-30',
    ref: 'BNK/Q1/2627',
    narration: 'Bank charges for the quarter',
    entries: [['Bank Charges', 'debit', 1770], [BANK, 'credit', 1770]],
  }));
  list.push(voucher({
    voucherType: 'Journal',
    date: '2026-09-20',
    ref: 'BNK/Q2/2627',
    narration: 'Bank charges for the quarter',
    entries: [['Bank Charges', 'debit', 2065], [BANK, 'credit', 2065]],
  }));

  return list.sort((a, b) => a.payload.date.localeCompare(b.payload.date));
}

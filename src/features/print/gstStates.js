/**
 * GST state codes, and the intra/inter-state decision that depends on them.
 *
 * The first two digits of a GSTIN are the registering state's code. Whether a
 * supply is intra-state (CGST + SGST) or inter-state (IGST) depends on the
 * supplier's state and the place of supply — not on where the buyer happens to
 * be registered, though for a registered buyer receiving goods at their own
 * address the two usually coincide.
 *
 * Presented as validation assistance: confirm the place of supply with your
 * tax adviser for anything unusual (bill-to-ship-to, services, SEZ, exports).
 */

export const GST_STATES = Object.freeze({
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  10: 'Bihar',
  11: 'Sikkim',
  12: 'Arunachal Pradesh',
  13: 'Nagaland',
  14: 'Manipur',
  15: 'Mizoram',
  16: 'Tripura',
  17: 'Meghalaya',
  18: 'Assam',
  19: 'West Bengal',
  20: 'Jharkhand',
  21: 'Odisha',
  22: 'Chhattisgarh',
  23: 'Madhya Pradesh',
  24: 'Gujarat',
  26: 'Dadra and Nagar Haveli and Daman and Diu',
  27: 'Maharashtra',
  29: 'Karnataka',
  30: 'Goa',
  31: 'Lakshadweep',
  32: 'Kerala',
  33: 'Tamil Nadu',
  34: 'Puducherry',
  35: 'Andaman and Nicobar Islands',
  36: 'Telangana',
  37: 'Andhra Pradesh',
  38: 'Ladakh',
  97: 'Other Territory',
});

/** Union territories without a legislature levy UTGST rather than SGST. */
const UTGST_CODES = new Set(['04', '26', '31', '35', '38']);

const ALIASES = Object.freeze({
  orissa: '21',
  pondicherry: '34',
  'new delhi': '07',
  'nct of delhi': '07',
  'jammu & kashmir': '01',
  'andaman & nicobar islands': '35',
  'dadra & nagar haveli': '26',
  'daman & diu': '26',
  'daman and diu': '26',
  'dadra and nagar haveli': '26',
});

/** The two-digit state code of a GSTIN, or null. */
export function stateCodeFromGstin(gstin) {
  const m = /^(\d{2})[A-Z0-9]{13}$/i.exec(String(gstin ?? '').trim());
  if (!m) return null;
  return GST_STATES[m[1]] ? m[1] : null;
}

/**
 * Resolve "27", "27-Maharashtra", "Maharashtra (27)" or "maharashtra" to "27".
 * Returns null when nothing matches; it never guesses.
 */
export function resolveStateCode(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const digits = /(?:^|\D)(\d{1,2})(?:\D|$)/.exec(text);
  if (digits) {
    const code = digits[1].padStart(2, '0');
    if (GST_STATES[code]) return code;
  }
  const name = text.replace(/\(\s*\d+\s*\)/g, '').replace(/^\d+\s*[-–]\s*/, '').trim().toLowerCase();
  if (ALIASES[name]) return ALIASES[name];
  for (const [code, state] of Object.entries(GST_STATES)) {
    if (state.toLowerCase() === name) return code;
  }
  return null;
}

export function stateName(code) {
  return code ? GST_STATES[code] ?? null : null;
}

export function isUnionTerritoryCode(code) {
  return UTGST_CODES.has(code);
}

/** "Maharashtra (27)" for printing. */
export function stateLabel(code) {
  const name = stateName(code);
  return name ? `${name} (${code})` : null;
}

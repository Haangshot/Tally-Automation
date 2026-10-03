/**
 * Matching extracted names to Tally masters.
 *
 * This is deliberately deterministic and done in code. The model reads the
 * document; it does not get to decide that "ABC Trdrs" is the ledger
 * "ABC Traders Pvt Ltd" — that judgement is auditable here, always produces
 * the same answer for the same inputs, and reports its confidence so a human
 * can see what was assumed.
 */

/**
 * Legal-form suffixes and connectors only.
 *
 * Words like "Traders", "Enterprises" or "Industries" are part of the business
 * name and must stay: dropping them makes "ABC Tradrs" and "ABC Traders"
 * tokenize differently — the one pair that most needs to match.
 */
const NOISE = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company',
  'corp', 'corporation', 'and', '&', 'the', 'm/s', 'ms',
]);

/** Lower-case, strip punctuation and legal-form noise, collapse whitespace. */
export function normalizeName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[.,'"()\-_/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(raw) {
  return normalizeName(raw)
    .split(' ')
    .filter((t) => t && !NOISE.has(t));
}

/**
 * Levenshtein distance.
 *
 * `maxLenDiff` is a cheap early exit for comparing short tokens, where a large
 * length gap already means "not the same word". It must NOT be applied to whole
 * names: "XYZ Enterprises" and "XYZ Enterprises Pvt Ltd" differ by 8 characters
 * and are the same company.
 */
export function editDistance(a, b, maxLenDiff = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxLenDiff) return Infinity;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Similarity in [0, 1], combining token overlap with character distance so
 * that neither word order nor a small typo defeats a match.
 */
export function similarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) {
    const longest = Math.max(na.length, nb.length);
    return Math.max(0, 1 - editDistance(na, nb) / longest);
  }

  const setA = new Set(ta);
  const setB = new Set(tb);
  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) { shared += 1; continue; }
    // A near-miss token still counts, scaled by how near it is.
    let best = 0;
    for (const other of setB) {
      const d = editDistance(token, other, 6);
      if (!Number.isFinite(d)) continue;
      const score = 1 - d / Math.max(token.length, other.length);
      if (score > best) best = score;
    }
    if (best >= 0.8) shared += best;
  }

  // Three signals, because each alone gets a common case wrong:
  //  - coverage: how much of the *larger* name is accounted for
  //  - containment: whether the shorter name sits wholly inside the longer
  //    ("HDFC" in "HDFC Bank"), which coverage alone punishes
  //  - characters: breaks ties between two equally-covered candidates
  const coverage = shared / Math.max(setA.size, setB.size);
  const containment = shared / Math.min(setA.size, setB.size);
  const chars = Math.max(0, 1 - editDistance(na, nb) / Math.max(na.length, nb.length));

  return round3(coverage * 0.55 + containment * 0.25 + chars * 0.20);
}

const EXACT = 0.999;
const CONFIDENT = 0.84;
const POSSIBLE = 0.6;

/**
 * Match one extracted name against a list of Tally masters.
 *
 * Returns `{ status, match, score, candidates }` where status is:
 *   'exact'     — identical after normalisation; use it
 *   'confident' — one clear winner; propose it, still visible to the approver
 *   'ambiguous' — several plausible; a human must choose
 *   'none'      — nothing close enough; offer to create it
 */
export function matchMaster(extractedName, masters, { key = 'name' } = {}) {
  const name = String(extractedName ?? '').trim();
  if (!name) return { status: 'none', match: null, score: 0, candidates: [], reason: 'No name was extracted.' };

  const scored = masters
    .map((m) => ({ master: m, score: similarity(name, m[key]) }))
    .filter((c) => c.score >= POSSIBLE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: 'none', match: null, score: 0, candidates: [], reason: `Nothing in Tally resembles "${name}".` };
  }

  const [best, second] = scored;
  const candidates = scored.slice(0, 5).map((c) => ({ name: c.master[key], score: c.score }));

  if (best.score >= EXACT) {
    return { status: 'exact', match: best.master, score: best.score, candidates };
  }

  // A clear winner needs to be both good and meaningfully better than the next.
  const margin = second ? round3(best.score - second.score) : 1;
  if (best.score >= CONFIDENT && margin >= 0.08) {
    return { status: 'confident', match: best.master, score: best.score, candidates };
  }

  return {
    status: 'ambiguous',
    match: null,
    score: best.score,
    candidates,
    reason: second
      ? `"${name}" could be "${best.master[key]}" or "${second.master[key]}".`
      : `"${name}" is only a partial match for "${best.master[key]}".`,
  };
}

/**
 * A party can also be matched by GSTIN, which is exact and beats any name
 * similarity. Used first, with the name match as a fallback.
 */
export function matchPartyByGstin(gstin, ledgers) {
  const wanted = String(gstin ?? '').trim().toUpperCase();
  if (!wanted) return null;
  const hit = ledgers.find((l) => String(l.gstin ?? '').trim().toUpperCase() === wanted);
  return hit ? { status: 'exact', match: hit, score: 1, candidates: [{ name: hit.name, score: 1 }], via: 'gstin' } : null;
}

/** GSTIN first, then name. */
export function matchParty({ name, gstin }, ledgers) {
  return matchPartyByGstin(gstin, ledgers) ?? matchMaster(name, ledgers);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export { NOISE, EXACT, CONFIDENT, POSSIBLE };

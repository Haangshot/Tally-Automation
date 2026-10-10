import { dataStore } from '../features/localStore.js';

/**
 * The agent's own period lock: once a month or year is closed, nothing dated
 * inside it may be staged or approved through this agent.
 *
 * It is a lock on the agent, not on Tally. TallyPrime has its own period lock
 * (Alt+F2 > Lock period, or security levels with "Disallow back-dated
 * entries") for people entering vouchers directly; this one guarantees the
 * agent cannot be the thing that reopens closed books.
 *
 * Every lock and unlock is kept in `history`, so an audit can see when a
 * period was reopened and by whom.
 */
export class PeriodLock {
  constructor({ store = dataStore('period-lock', { fallback: { lockedThrough: null, history: [] } }) } = {}) {
    this.store = store;
  }

  /** `{ lockedThrough, by, at, reason }`, with lockedThrough null when nothing is locked. */
  async read() {
    const doc = await this.store.read();
    return { lockedThrough: doc.lockedThrough ?? null, by: doc.by ?? null, at: doc.at ?? null, reason: doc.reason ?? null, history: doc.history ?? [] };
  }

  /**
   * Lock everything dated on or before `through`. Moving the lock backwards is
   * an unlock in disguise, so it is refused here and must go through `unlock`.
   */
  async lock({ through, by, reason = null }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(through ?? ''))) {
      throw Object.assign(new Error('through must be a date, YYYY-MM-DD.'), { code: 'BAD_REQUEST' });
    }
    return this.store.update((doc) => {
      if (doc.lockedThrough && through < doc.lockedThrough) {
        throw Object.assign(
          new Error(`The books are already locked through ${doc.lockedThrough}. Reopen them first to move the lock back.`),
          { code: 'PERIOD_LOCKED' },
        );
      }
      const at = new Date().toISOString();
      return {
        lockedThrough: through, by, at, reason,
        history: [...(doc.history ?? []), { event: 'lock', through, by, at, reason }],
      };
    });
  }

  /** Reopen back to `through` (exclusive of nothing: entries after it are allowed), or fully when null. */
  async unlock({ through = null, by, reason = null }) {
    if (through !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(through))) {
      throw Object.assign(new Error('through must be a date, YYYY-MM-DD, or empty to unlock everything.'), { code: 'BAD_REQUEST' });
    }
    return this.store.update((doc) => {
      if (doc.lockedThrough && through && through > doc.lockedThrough) {
        throw Object.assign(new Error('That would extend the lock, not reopen it. Use lock instead.'), { code: 'BAD_REQUEST' });
      }
      const at = new Date().toISOString();
      return {
        lockedThrough: through, by, at, reason,
        history: [...(doc.history ?? []), { event: 'unlock', from: doc.lockedThrough ?? null, to: through, by, at, reason }],
      };
    });
  }
}

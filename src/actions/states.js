/**
 * The action lifecycle. Every transition in the system goes through
 * `assertTransition`, so there is exactly one place where "can this action
 * move from here to there?" is answered.
 */

export const STATES = Object.freeze({
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  EXECUTING: 'executing',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  FAILED: 'failed',
  NEEDS_REVIEW: 'needs_review',
});

/** Terminal states never move again. */
export const TERMINAL_STATES = Object.freeze([STATES.VERIFIED, STATES.REJECTED]);

const ALLOWED = Object.freeze({
  [STATES.DRAFT]: [STATES.PENDING_APPROVAL, STATES.REJECTED],
  [STATES.PENDING_APPROVAL]: [STATES.EXECUTING, STATES.REJECTED, STATES.DRAFT],
  // Once executing, the only way out is an observed outcome.
  [STATES.EXECUTING]: [STATES.VERIFIED, STATES.FAILED, STATES.NEEDS_REVIEW],
  // A failed write can be re-queued for approval; it can never jump to executing.
  [STATES.FAILED]: [STATES.PENDING_APPROVAL, STATES.REJECTED],
  // needs_review means Tally accepted something we could not confirm: a human decides.
  [STATES.NEEDS_REVIEW]: [STATES.VERIFIED, STATES.FAILED, STATES.REJECTED],
  [STATES.VERIFIED]: [],
  [STATES.REJECTED]: [],
});

export class TransitionError extends Error {
  constructor(from, to) {
    super(`An action in state "${from}" cannot move to "${to}".`);
    this.name = 'TransitionError';
    this.code = 'INVALID_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from, to) {
  return (ALLOWED[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** Is this action still waiting on a human? */
export function isOpen(state) {
  return state === STATES.DRAFT || state === STATES.PENDING_APPROVAL;
}

/** Has this action been posted, or is it being posted, to Tally? */
export function hasReachedTally(state) {
  return state === STATES.EXECUTING
    || state === STATES.VERIFIED
    || state === STATES.NEEDS_REVIEW
    // A failed action may or may not have reached Tally; assume it did.
    || state === STATES.FAILED;
}

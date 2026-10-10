import { dataStore } from '../features/localStore.js';

/**
 * Who may do what.
 *
 * Off until someone is added. With an empty user list the server behaves as it
 * always has: any named person may approve, because that is what an existing
 * installation relies on and switching it on silently would lock people out.
 * The moment the first user is added, every named action is checked against
 * that list, and a name that is not on it is refused rather than let through.
 *
 * This is the agent's own access control. It does not read or change Tally's
 * users and permissions (Company > Security), which stay Tally's business.
 *
 * Roles are ordered; each includes everything below it.
 *   viewer   — read reports and the queue
 *   preparer — stage entries, upload documents, run calculations
 *   approver — approve, reject, retry; subject to an optional amount limit
 *   admin    — manage users, lock periods, everything else
 */
export const ROLES = Object.freeze(['viewer', 'preparer', 'approver', 'admin']);

const rank = (role) => ROLES.indexOf(role);

export class RoleRegistry {
  constructor({ store = dataStore('users', { fallback: { users: [] } }) } = {}) {
    this.store = store;
  }

  async list() {
    const doc = await this.store.read();
    return doc.users ?? [];
  }

  async enabled() {
    return (await this.list()).length > 0;
  }

  async find(name) {
    const wanted = String(name ?? '').trim().toLowerCase();
    if (!wanted) return null;
    return (await this.list()).find((u) => u.name.toLowerCase() === wanted) ?? null;
  }

  /**
   * Add or change a user. The first user added must be an admin, or nobody
   * would be able to manage the list once it is switched on.
   */
  async upsert({ name, role, approvalLimit = null }, { by } = {}) {
    const clean = String(name ?? '').trim();
    if (!clean) throw coded('BAD_USER', 'A user needs a name.');
    if (!ROLES.includes(role)) throw coded('BAD_USER', `Role must be one of ${ROLES.join(', ')}.`);
    if (approvalLimit !== null && approvalLimit !== undefined
      && !(Number.isFinite(Number(approvalLimit)) && Number(approvalLimit) > 0)) {
      throw coded('BAD_USER', 'approvalLimit must be a positive amount, or empty for no limit.');
    }

    return this.store.update((doc) => {
      const users = doc.users ?? [];
      if (users.length === 0 && role !== 'admin') {
        throw coded('FIRST_USER_MUST_BE_ADMIN', 'The first user added must be an admin, or nobody could manage the list afterwards.');
      }
      const i = users.findIndex((u) => u.name.toLowerCase() === clean.toLowerCase());
      const entry = {
        name: clean,
        role,
        approvalLimit: approvalLimit === null || approvalLimit === undefined || approvalLimit === '' ? null : Number(approvalLimit),
        updatedAt: new Date().toISOString(),
        updatedBy: by ?? null,
      };
      if (i >= 0) users[i] = entry; else users.push(entry);
      if (!users.some((u) => u.role === 'admin')) {
        throw coded('LAST_ADMIN', 'At least one admin must remain.');
      }
      return { ...doc, users };
    });
  }

  async remove(name) {
    return this.store.update((doc) => {
      const users = (doc.users ?? []).filter((u) => u.name.toLowerCase() !== String(name).trim().toLowerCase());
      if (users.length > 0 && !users.some((u) => u.role === 'admin')) {
        throw coded('LAST_ADMIN', 'At least one admin must remain.');
      }
      return { ...doc, users };
    });
  }

  /**
   * Is `name` allowed to act at `role`? Returns null when allowed, or a
   * refusal `{ status, code, message }`.
   */
  async check(name, role, { amount = null } = {}) {
    if (!(await this.enabled())) return null;
    const user = await this.find(name);
    if (!user) {
      return { status: 403, code: 'UNKNOWN_USER', message: `"${name ?? ''}" is not a user of this agent. Ask an admin to add them.` };
    }
    if (rank(user.role) < rank(role)) {
      return { status: 403, code: 'ROLE_TOO_LOW', message: `${user.name} is a ${user.role}; this needs ${role} or above.` };
    }
    if (role === 'approver' && amount !== null && user.approvalLimit !== null && user.role !== 'admin'
      && Number(amount) > user.approvalLimit) {
      return {
        status: 403,
        code: 'OVER_APPROVAL_LIMIT',
        message: `${user.name} may approve up to ${user.approvalLimit.toFixed(2)}; this entry is ${Number(amount).toFixed(2)}. An admin or a higher-limit approver must approve it.`,
      };
    }
    return null;
  }
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

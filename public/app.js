/*
 * The browser UI.
 *
 * Two rules shape everything here.
 *
 * One: a draft is never shown as done until the server says it was read back
 * out of Tally. A card shows `verified` only when verification.verified is
 * true — a post that Tally accepted but that could not be read back stays
 * visibly unresolved.
 *
 * Two: each screen does one thing. The chat is a conversation and nothing
 * else; approvals live on their own screen; the dashboard is the only place
 * that shows everything at once. The approval queue used to sit beside the
 * chat, which meant neither could be read properly.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  sessionId: `ui-${Math.random().toString(36).slice(2, 10)}`,
  view: 'chat',
  actions: [],
  archived: [],
  selected: new Set(),
  queueFilter: 'open',
  settings: null,
  busy: false,
  /** Invoices uploaded in this session, newest first. Re-rendered when the
   *  queue changes, so an invoice card shows where its approval really is. */
  documents: [],
  /** The File objects behind them, kept so a duplicate can be re-sent. */
  files: new Map(),
  /** True once the chat has any turn in it, so the intro can step aside. */
  chatStarted: false,
};

const OPEN_STATES = ['pending_approval', 'draft', 'failed', 'needs_review'];

/** States whose action the server will delete. Anything else archives only. */
const DELETABLE = ['draft', 'rejected'];

/**
 * Who approvals are recorded as. Asked once, then remembered in this browser.
 *
 * Nothing posts without a name against it, so every caller of this awaits it
 * and gives up quietly when the person cancels.
 */
function storedApprover() {
  return localStorage.getItem('tally-agent-user') || null;
}

async function approver({ force = false } = {}) {
  const known = storedApprover();
  if (known && !force) return known;

  const who = await askForName(known ?? '');
  if (!who) return null;
  localStorage.setItem('tally-agent-user', who);
  drawApprover();
  return who;
}

function drawApprover() {
  const who = storedApprover();
  $('#who-name').textContent = who ?? 'Set approver';
  $('#who-initials').textContent = who
    ? who.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || who[0].toUpperCase()
    : '?';
  const field = $('#set-approver');
  if (field) field.value = who ?? '';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ------------------------------------------------------------------ sheets
 *
 * Every question the UI asks goes through here rather than through the
 * browser's own prompt/confirm, which cannot show a file path, a set of
 * choices, or anything the person needs in order to answer well.
 */

const scrim = () => document.getElementById('scrim');

/**
 * Show a sheet. `buttons` are [{ label, value, kind }]; resolves with the
 * chosen value, or null if dismissed. Escape and a click outside both dismiss.
 */
function sheet({ title, body = '', buttons = [], onOpen = null }) {
  return new Promise((resolve) => {
    const host = scrim();
    host.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${body}
        <div class="sheet-actions">
          ${buttons.map((b, i) => `
            <button class="btn ${b.kind ?? ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}
        </div>
      </div>`;
    host.classList.remove('hidden');

    let settled = false;
    const close = (value) => {
      if (settled) return;
      settled = true;
      host.classList.add('hidden');
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        const primary = buttons.findIndex((b) => b.kind === 'primary');
        if (primary >= 0) close(buttons[primary].value);
      }
    };

    host.querySelectorAll('.sheet-actions button').forEach((btn) => {
      btn.onclick = () => close(buttons[Number(btn.dataset.i)].value);
    });
    host.onclick = (e) => { if (e.target === host) close(null); };
    document.addEventListener('keydown', onKey);
    onOpen?.(host.querySelector('.sheet'), close);
  });
}

/** A yes/no that says plainly what the yes will do. */
async function confirmSheet(title, message, confirmLabel, kind = 'primary') {
  return await sheet({
    title,
    body: `<p>${esc(message)}</p>`,
    buttons: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, value: true, kind },
    ],
  }) === true;
}

async function askForName(current) {
  // The node keeps its value after the sheet is torn down, so reading it
  // afterwards is safe and avoids threading state through the dialog.
  let input = null;
  const value = await sheet({
    title: 'Who is approving?',
    body: `<p>Recorded against every approval and rejection in the history. Stored in this browser only.</p>
           <input type="text" id="sheet-name" value="${esc(current)}" placeholder="name or email" autocomplete="name">`,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save', kind: 'primary' },
    ],
    onOpen: (el) => {
      input = el.querySelector('#sheet-name');
      input.focus();
      input.select();
    },
  });
  if (value !== 'save') return null;
  return (input?.value ?? '').trim() || null;
}

function banner(message) {
  const el = $('#banner');
  if (!message) { el.classList.add('hidden'); return; }
  el.textContent = message;
  el.classList.remove('hidden');
}

const money = (n) => Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleString() : '—');

// ------------------------------------------------------------------ chrome

function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  $('#mode-toggle').title = mode === 'dark' ? 'Switch to light' : 'Switch to dark';
  localStorage.setItem('tally-agent-mode', mode);
}

$('#mode-toggle').onclick = () => {
  setMode(document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark');
};

// Follow the system unless this browser has been told otherwise.
{
  const saved = localStorage.getItem('tally-agent-mode');
  const system = window.matchMedia?.('(prefers-color-scheme: dark)');
  setMode(saved ?? (system?.matches ? 'dark' : 'light'));
  if (!saved) system?.addEventListener?.('change', (e) => {
    document.documentElement.dataset.mode = e.matches ? 'dark' : 'light';
  });
}

$('#who-chip').onclick = () => approver({ force: true });
$('#conn').onclick = () => show('dashboard');

$('#sidebar-toggle').onclick = () => {
  const shell = $('.shell');
  shell.classList.toggle('collapsed');
  localStorage.setItem('tally-agent-sidebar', shell.classList.contains('collapsed') ? 'collapsed' : 'open');
};
if (localStorage.getItem('tally-agent-sidebar') === 'collapsed') $('.shell').classList.add('collapsed');

/* ------------------------------------------------------------------ routing
 *
 * One view is visible at a time. Each view loads its own data when it opens
 * rather than keeping every screen live, so a screen you are not looking at
 * cannot make the one you are looking at jump.
 */
const VIEWS = ['dashboard', 'chat', 'approvals', 'invoices', 'archive', 'history', 'settings'];

function show(view) {
  if (!VIEWS.includes(view)) view = 'chat';
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  location.hash = view;

  if (view === 'dashboard') loadDashboard();
  if (view === 'history') loadAudit();
  if (view === 'settings') loadSettings();
  if (view === 'archive') loadArchive();
  if (view === 'approvals') drawQueue();
  if (view === 'chat') $('#chat-input').focus();
}

$$('.nav-item').forEach((b) => { b.onclick = () => show(b.dataset.view); });
$$('[data-goto]').forEach((b) => { b.onclick = () => show(b.dataset.goto); });

// ------------------------------------------------------------------ health

/**
 * Health is the one endpoint whose failure status is itself the answer.
 *
 * /api/health returns 503 when Tally is unreachable — the server is fine, the
 * dependency is not, and the body carries the full diagnosis. Routing it
 * through api(), which throws on any non-2xx, turned "Tally is closed" into
 * "Cannot reach the agent server", which sends you to debug the wrong process.
 * So this reads the body on 503 and only reports the server down when the
 * fetch itself fails.
 */
async function refreshHealth() {
  try {
    let res;
    try {
      res = await fetch('/api/health');
    } catch (netErr) {
      throw Object.assign(new Error(netErr.message), { serverDown: true });
    }

    const h = await res.json().catch(() => null);
    if (!h) throw Object.assign(new Error(`HTTP ${res.status}`), { serverDown: true });

    const up = h.tally?.reachable && h.tally?.configuredCompanyIsOpen;
    $('#tally-dot').className = `dot ${up ? 'up' : 'down'}`;
    $('#tally-state').textContent = h.tally?.reachable
      ? (up ? 'Connected' : 'Company not open')
      : 'Tally not running';
    $('#company-name').textContent = h.tally?.activeCompany?.name ?? h.tally?.configuredCompany ?? '—';
    // Tally's own message names the port and the setting to check, so prefer
    // it over a generic one.
    banner(up ? null
      : h.tally?.reachable
        ? `Company "${h.tally.configuredCompany}" is not open in Tally. Open it, or pick another under Settings.`
        : (h.tally?.error?.message
          ?? 'TallyPrime is not reachable. Open Tally, then F1 > Settings > Connectivity > "TallyPrime acts as" = Both.'));
  } catch (err) {
    $('#tally-dot').className = 'dot down';
    $('#tally-state').textContent = 'Agent server down';
    $('#company-name').textContent = '—';
    banner(`Cannot reach the agent server at this address: ${err.message}. Is "npm start" still running?`);
  }
}

/* ==================================================================== chat */

function addTurn(kind, body, { who = null } = {}) {
  if (!state.chatStarted) {
    state.chatStarted = true;
    $('#chat-intro')?.remove();
  }
  const el = document.createElement('div');
  el.className = `turn ${kind}`;
  el.innerHTML = kind === 'you'
    ? `<div class="bubble">${esc(body)}</div>`
    : `<div class="who">${esc(who ?? (kind === 'agent' ? 'Agent' : 'System'))}</div>
       <div class="prose">${render(body)}</div>`;
  $('#chat-log').append(el);
  scrollChat();
  return el;
}

function scrollChat() {
  const log = $('#chat-log');
  log.scrollTop = log.scrollHeight;
}

/* ------------------------------------------------------------- the renderer
 *
 * Just enough markdown for what the agent actually emits — and tables get
 * the real work, because a list of invoices is the answer people ask for
 * most and a wall of sentences is the worst way to read one. Column
 * alignment from the separator row is honoured, so amounts land right.
 */
function render(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let table = null;
  let list = null;

  const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };

  const flushTable = () => {
    if (!table) return;
    const [head, ...rest] = table;
    // A separator row of dashes decides alignment; it is never a data row.
    const sepIndex = rest.findIndex((r) => /^[\s|:-]+$/.test(r));
    const sep = sepIndex === 0 ? cells(rest[0]) : [];
    const align = sep.map((c) => (c.endsWith(':') && !c.startsWith(':') ? 'r' : ''));
    const rows = rest.filter((r) => !/^[\s|:-]+$/.test(r));

    // Narration and similar prose columns are the only ones worth wrapping;
    // dates, numbers and names read better on a single line.
    const headCells = cells(head);
    const wraps = headCells.map((c) => /narration|remark|note|description|particular/i.test(c));
    const cls = (i) => {
      const names = [align[i], wraps[i] ? 'wrap' : ''].filter(Boolean).join(' ');
      return names ? ` class="${names}"` : '';
    };
    const headHtml = headCells.map((c, i) => `<th${cls(i)}>${inline(c)}</th>`).join('');
    const bodyHtml = rows.map((r) => {
      const cs = cells(r);
      // A row whose first cell is a bold "total" is the summary row.
      const isTotal = /^\*\*?\s*(total|grand total)\b/i.test(cs[0] ?? '');
      return `<tr${isTotal ? ' class="total"' : ''}>${
        cs.map((c, i) => `<td${cls(i)}>${inline(c)}</td>`).join('')}</tr>`;
    }).join('');

    // A full voucher table carries ten columns. Squeezed into the pane width
    // they wrap a word per line and become unreadable, so the table keeps its
    // natural column widths and scrolls sideways inside its own box.
    out.push(
      `<div class="table-scroll"><table><thead><tr>${headHtml}</tr></thead>`
      + `<tbody>${bodyHtml}</tbody></table></div>`,
    );
    table = null;
  };

  const flush = () => { flushTable(); flushList(); };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); (table ??= []).push(line.trim()); continue; }
    flushTable();

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      (list ??= { tag, items: [] }).items.push((bullet ?? numbered)[1]);
      continue;
    }
    flushList();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { out.push(`<h3>${inline(heading[2])}</h3>`); continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); continue; }
    if (line.trim() === '') continue;

    out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('\n');
}

const inline = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  .replace(/(^|[\s(])\*([^*]+?)\*(?=[\s).,;:]|$)/g, '$1<i>$2</i>')
  .replace(/`(.+?)`/g, '<code>$1</code>');

async function send(text = null) {
  const input = $('#chat-input');
  const message = (text ?? input.value).trim();
  if (!message || state.busy) return;

  state.busy = true;
  $('#send').disabled = true;
  input.value = '';
  autoGrow();
  addTurn('you', message);

  const thinking = addTurn('agent', '');
  thinking.querySelector('.prose').innerHTML = '<span class="spinner"></span> <span class="muted">thinking…</span>';

  try {
    const r = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId: state.sessionId }),
    });

    const tools = r.toolCalls?.length
      ? `<div class="tool-trace">${r.toolCalls.map((t) => `<span>${esc(t.name)}${t.ok ? '' : ' · failed'}</span>`).join('')}</div>`
      : '';

    // Anything the turn staged gets one line and a way straight to it,
    // rather than a queue sitting beside the conversation all the time.
    const staged = r.staged?.length
      ? `<div class="staged-note">
           <b>${r.staged.length} ${r.staged.length === 1 ? 'entry is' : 'entries are'} ready for approval.</b>
           <span class="spacer"></span>
           <button class="btn tiny primary" data-goto-approvals>Review</button>
         </div>`
      : '';

    thinking.querySelector('.prose').innerHTML = tools + render(r.reply || '(no reply)') + staged;
    thinking.querySelector('[data-goto-approvals]')?.addEventListener('click', () => show('approvals'));

    if (r.stoppedBy) addTurn('system', `Stopped: ${r.stoppedBy.message}`);
    if (r.staged?.length) await refreshQueue();
    scrollChat();
  } catch (err) {
    thinking.className = 'turn system';
    thinking.querySelector('.prose').innerHTML = `<b>${esc(err.code ?? 'Error')}</b> — ${esc(err.message)}`;
  } finally {
    state.busy = false;
    $('#send').disabled = false;
    input.focus();
  }
}

/** The composer grows with the text, up to the height the CSS caps it at. */
function autoGrow() {
  const el = $('#chat-input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

$('#send').onclick = () => send();
$('#chat-input').addEventListener('input', autoGrow);
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$$('.suggest').forEach((b) => { b.onclick = () => send(b.dataset.ask); });

$('#chat-clear').onclick = () => {
  state.sessionId = `ui-${Math.random().toString(36).slice(2, 10)}`;
  state.chatStarted = false;
  $('#chat-log').innerHTML = `
    <div class="chat-intro" id="chat-intro">
      <h2>What would you like to look at?</h2>
      <p>I can read anything in this company and prepare entries, but I cannot post.
         Everything I prepare waits under <b>Approvals</b>,
         and nothing reaches Tally until you approve it there.</p>
    </div>`;
  $('#chat-input').focus();
};

/* =============================================================== dashboard */

async function loadDashboard() {
  const stats = $('#dash-stats');
  try {
    const d = await api('/api/dashboard');
    const c = d.counts;

    const stat = (n, k, sub, cls = '', goto = null) => `
      <div class="stat ${cls} ${goto ? 'clickable' : ''}" ${goto ? `data-goto="${goto}"` : ''}>
        <div class="n">${n}</div>
        <div class="k">${esc(k)}</div>
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      </div>`;

    stats.innerHTML = [
      stat(c.pendingApproval, 'Awaiting approval', c.pendingApproval ? `₹${money(d.value.awaitingTotal)} in total` : 'Nothing to do', c.pendingApproval ? 'due' : '', 'approvals'),
      stat(c.posted, 'Posted to Tally', `${c.postedToday} today · ₹${money(d.value.postedTotal)}`, 'good', 'history'),
      stat(c.failed + c.needsReview, 'Needs attention', c.failed + c.needsReview ? 'Failed or unconfirmed' : 'All clear', c.failed + c.needsReview ? 'alert' : '', 'approvals'),
      stat(c.drafts, 'Held drafts', 'Blocked by a check', '', 'approvals'),
      stat(c.rejected, 'Rejected', 'Never posted', '', 'approvals'),
      stat(c.archived, 'Archived', 'Hidden from the queue', '', 'archive'),
    ].join('');
    stats.querySelectorAll('[data-goto]').forEach((el) => { el.onclick = () => show(el.dataset.goto); });

    $('#dash-sub').textContent = `As of ${new Date(d.generatedAt).toLocaleTimeString()} · ${c.total} entr${c.total === 1 ? 'y' : 'ies'} on record`;

    $('#dash-awaiting').innerHTML = miniList(d.awaiting, 'Nothing is waiting for approval.');
    $('#dash-attention').innerHTML = miniList(d.needsAttention, 'Nothing failed or unconfirmed.', true);
    $('#dash-posted').innerHTML = miniList(d.recentlyPosted, 'Nothing has been posted yet.');

    // The period Tally is open on is not the financial year, and a date past
    // it is refused on import. That is the single most common cause of a
    // failed post here, so say it before it happens rather than after.
    const p = d.tally.period;
    $('#dash-tally').innerHTML = d.tally.reachable
      ? `<dl class="kv">
           <dt>TallyPrime</dt><dd><span class="state verified">Connected</span></dd>
           <dt>Company</dt><dd>${esc(d.tally.company ?? '—')}</dd>
           <dt>Open period</dt><dd>${p ? `${esc(p.from)} to ${esc(p.to)}` : '—'}</dd>
           <dt>Financial year to</dt><dd>${esc(p?.financialYearEnd ?? '—')}</dd>
         </dl>
         ${d.tally.periodShortOfYear ? `
           <div class="finding warn">Tally is open on a period ending ${esc(p.to)}, short of the
             financial year end ${esc(p.financialYearEnd)}. Entries dated after ${esc(p.to)} will be
             refused on import. Widen it in TallyPrime with Alt+F2 (Change Period).</div>` : ''}`
      : `<div class="finding error">${esc(d.tally.error?.message ?? 'TallyPrime is not reachable.')}</div>`;
  } catch (err) {
    stats.innerHTML = `<div class="finding error">Could not load the dashboard: ${esc(err.message)}</div>`;
  }
}

/**
 * A Tally failure message carries its whole diagnosis — several paragraphs of
 * it, deliberately, because that is what a person needs when they open the
 * entry. On a dashboard row they need the first line and nothing more; the
 * rest is one click away in Approvals.
 */
function firstLine(text, max = 90) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function miniList(rows, emptyText, showProblem = false) {
  if (!rows?.length) return `<div class="empty">${esc(emptyText)}</div>`;
  return `<div class="mini-list">${rows.map((r) => `
    <div class="mini">
      <div class="m-main">
        <div class="m-title">${esc(r.title)}</div>
        <div class="m-sub"${showProblem && r.problems?.[0] ? ` title="${esc(r.problems[0])}"` : ''}>${[
          r.party,
          r.reference,
          r.voucherNumber ? `voucher ${r.voucherNumber}` : null,
          r.approvedBy ? `by ${r.approvedBy}` : null,
          showProblem ? (firstLine(r.problems?.[0]) || null) : null,
        ].filter(Boolean).map(esc).join(' · ') || when(r.createdAt)}</div>
      </div>
      ${r.amount != null ? `<div class="m-amt">${money(r.amount)}</div>` : ''}
      <span class="state ${esc(r.state)}">${esc(r.state.replace(/_/g, ' '))}</span>
    </div>`).join('')}</div>`;
}

$('#dash-refresh').onclick = loadDashboard;
$('#dash-doctor').onclick = () => { show('settings'); $('#run-doctor').click(); };

/* ================================================================ the queue */

async function refreshQueue() {
  try {
    const r = await api('/api/actions?limit=200');
    state.actions = r.items;
    drawQueue();
    drawBadges();
    // An invoice card shows its own approval step, so it follows the queue.
    if (state.documents.length) drawDocuments();
  } catch (err) {
    $('#queue').innerHTML = `<div class="empty">Could not load the queue: ${esc(err.message)}</div>`;
  }
}

function drawBadges() {
  const pending = state.actions.filter((a) => a.state === 'pending_approval').length;
  const badge = $('#badge-approvals');
  badge.textContent = pending;
  badge.classList.toggle('hidden', pending === 0);
}

function filtered() {
  const f = state.queueFilter;
  if (f === 'all') return state.actions;
  if (f === 'open') return state.actions.filter((a) => OPEN_STATES.includes(a.state));
  return state.actions.filter((a) => a.state === f);
}

function drawQueue() {
  const list = filtered();

  if (list.length === 0) {
    $('#queue').innerHTML = `<div class="empty">${
      state.queueFilter === 'open'
        ? 'Nothing is waiting for approval.'
        : 'Nothing here under this filter.'}</div>`;
    updateSelection();
    return;
  }
  $('#queue').innerHTML = list.map((a) => card(a)).join('');
  wireCards($('#queue'));
  updateSelection();
}

$$('#queue-filters .chip').forEach((chip) => {
  chip.onclick = () => {
    state.queueFilter = chip.dataset.filter;
    $$('#queue-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    drawQueue();
  };
});

function card(a, { archived = false } = {}) {
  const p = a.preview ?? {};
  const done = a.state === 'verified' || a.state === 'rejected';
  const canApprove = a.state === 'pending_approval' && !archived;

  const rows = (p.entries ?? []).map((e) => `
    <tr>
      <td>${esc(e.ledger)}</td>
      <td class="amt dr">${e.debit ? `Dr ${money(e.debit)}` : ''}</td>
      <td class="amt cr">${e.credit ? `Cr ${money(e.credit)}` : ''}</td>
    </tr>`).join('');

  const plain = (p.lines ?? []).map(([k, v]) => `
    <tr><td>${esc(k)}</td><td colspan="2">${esc(v)}</td></tr>`).join('');

  const totals = p.totals ? `
    <tr class="total">
      <td>Total</td>
      <td class="amt dr">Dr ${money(p.totals.debit)}</td>
      <td class="amt cr">Cr ${money(p.totals.credit)}</td>
    </tr>` : '';

  const stock = (p.inventory ?? []).length ? `
    <div class="stock-lines">
      ${p.inventory.map((i) => `
        <div class="ln">
          <span class="name">${esc(i.stockItem)}${i.godown ? ` <span class="muted">· ${esc(i.godown)}</span>` : ''}</span>
          <span class="qty">${esc(i.quantity)} @ ${money(i.rate)}</span>
          <span class="qty">${money(i.amount)}</span>
        </div>`).join('')}
    </div>` : '';

  const findings = [
    ...(p.errors ?? []).map((m) => `<div class="finding error">${esc(m)}</div>`),
    ...(p.warnings ?? []).map((m) => `<div class="finding warn">${esc(m)}</div>`),
  ].join('');

  // The result line. Only a read-back makes this a success.
  let result = '';
  if (a.state === 'verified' && a.verification?.verified) {
    const v = a.verification;
    result = `<div class="verified-note">Posted and read back from Tally${
      v.voucherNumber ? ` — voucher no. ${esc(v.voucherNumber)}, master id ${esc(v.masterId)}` : ''}${
      v.stockLines ? `, ${v.stockLines} stock line(s)` : ''}. Approved by ${esc(a.approval?.by ?? '—')}.</div>`;
  } else if (a.state === 'needs_review') {
    result = '<div class="finding warn">Posted, but the outcome could not be confirmed. Check Tally before retrying — a blind retry could post it twice.</div>';
  } else if (a.state === 'failed') {
    const why = (a.execution?.problems ?? []).map((m) => `<div class="finding error">${esc(m)}</div>`).join('');
    result = why || '<div class="finding error">The post failed.</div>';
  } else if (a.state === 'executing') {
    result = '<div class="pending-note"><span class="spinner"></span> posting…</div>';
  }

  const deletable = DELETABLE.includes(a.state);

  return `
  <div class="draft ${p.errors?.length ? 'blocked' : ''} ${done ? 'done' : ''}" data-id="${esc(a.id)}">
    <div class="draft-head">
      ${canApprove ? `<input type="checkbox" class="select-box" data-id="${esc(a.id)}"
        ${state.selected.has(a.id) ? 'checked' : ''}>` : ''}
      <div>
        <div class="title">${esc(p.title ?? a.kind)}</div>
        <div class="id">${esc(a.id.slice(0, 16))}</div>
      </div>
      <span class="state ${esc(a.state)}">${esc(a.state.replace(/_/g, ' '))}</span>
    </div>
    ${stock}
    ${rows || plain ? `<table class="entries">${rows}${plain}${totals}</table>` : ''}
    ${findings}
    ${result}
    <div class="draft-actions">
      ${canApprove ? `
        <button class="btn primary tiny act-approve">Approve</button>
        <button class="btn tiny act-edit">Edit</button>
        <button class="btn danger tiny act-reject">Reject</button>` : ''}
      ${a.state === 'failed' && !archived ? '<button class="btn tiny act-retry">Retry</button>' : ''}
      ${a.state === 'draft' && !archived ? '<button class="btn danger tiny act-reject">Discard</button>' : ''}
      ${a.state === 'needs_review' && !archived ? '<button class="btn tiny act-recover">Check Tally</button>' : ''}
      ${archived
        ? '<button class="btn ghost tiny act-unarchive">Restore</button>'
        : '<button class="btn ghost tiny act-archive">Hide</button>'}
      ${deletable ? '<button class="btn plain tiny act-delete">Delete</button>' : ''}
      <span class="spacer"></span>
      <span class="when">${when(a.createdAt)}</span>
    </div>
  </div>`;
}

function wireCards(root) {
  root.querySelectorAll('.select-box').forEach((box) => {
    box.onchange = () => {
      if (box.checked) state.selected.add(box.dataset.id);
      else state.selected.delete(box.dataset.id);
      updateSelection();
    };
  });

  root.querySelectorAll('.draft').forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('.act-approve')?.addEventListener('click', () => approve([id]));
    el.querySelector('.act-reject')?.addEventListener('click', () => reject(id));
    el.querySelector('.act-retry')?.addEventListener('click', () => retry(id));
    el.querySelector('.act-edit')?.addEventListener('click', () => edit(id));
    el.querySelector('.act-recover')?.addEventListener('click', () => recover());
    el.querySelector('.act-archive')?.addEventListener('click', () => setArchived(id, true));
    el.querySelector('.act-unarchive')?.addEventListener('click', () => setArchived(id, false));
    el.querySelector('.act-delete')?.addEventListener('click', () => remove(id));
  });
}

function updateSelection() {
  // Only still-approvable selections count.
  for (const id of [...state.selected]) {
    const a = state.actions.find((x) => x.id === id);
    if (!a || a.state !== 'pending_approval') state.selected.delete(id);
  }
  const n = state.selected.size;
  $('#approve-selected').textContent = `Approve ${n}`;
  $('#approve-selected').disabled = n === 0;

  const approvable = filtered().filter((a) => a.state === 'pending_approval');
  $('#select-all').checked = approvable.length > 0 && n === approvable.length;
}

$('#select-all').onchange = (e) => {
  state.selected.clear();
  if (e.target.checked) {
    filtered().filter((a) => a.state === 'pending_approval').forEach((a) => state.selected.add(a.id));
  }
  drawQueue();
};

$('#approve-selected').onclick = () => approve([...state.selected]);
$('#queue-refresh').onclick = refreshQueue;

/** Anything that changed the queue should also refresh whatever is on screen. */
async function afterChange() {
  await refreshQueue();
  if (state.view === 'dashboard') await loadDashboard();
  if (state.view === 'archive') await loadArchive();
}

/** A message that belongs to an action, not to the conversation. */
function notify(message, kind = '') {
  const host = state.view === 'chat' ? null : $(`#view-${state.view} .view-body`);
  if (!host) { addTurn('system', message); return; }
  const el = document.createElement('div');
  el.className = `finding ${kind}`;
  el.textContent = message;
  host.prepend(el);
  setTimeout(() => el.remove(), 8000);
}

async function approve(ids) {
  ids = ids.filter(Boolean);
  if (ids.length === 0) return;
  const by = await approver();
  if (!by) return;

  const what = ids.length === 1 ? 'this entry' : `${ids.length} entries`;
  const ok = await confirmSheet(
    'Post to Tally?',
    `Approving writes ${what} into your books as ${by}. It cannot be undone from here.`,
    ids.length === 1 ? 'Approve and post' : `Approve ${ids.length}`,
  );
  if (!ok) return;

  for (const id of ids) {
    const el = document.querySelector(`.draft[data-id="${id}"] .draft-actions`);
    if (el) el.innerHTML = '<span class="spinner"></span> <span class="muted">posting…</span>';
    try {
      await api(`/api/actions/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ by }),
      });
    } catch (err) {
      if (err.code === 'STATE_CONFLICT') {
        notify('That entry had already been handled — it was not posted twice.', 'warn');
      } else {
        notify(`Could not approve: ${err.message}`, 'error');
      }
    }
  }
  state.selected.clear();
  await afterChange();
}

async function reject(id) {
  const by = await approver();
  if (!by) return;
  const ok = await confirmSheet(
    'Reject this entry?',
    'It stays in the history as rejected and is never posted. The invoice can be uploaded again afterwards.',
    'Reject',
    'danger',
  );
  if (!ok) return;
  try {
    await api(`/api/actions/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ by, reason: 'Rejected in the review screen' }),
    });
  } catch (err) {
    notify(`Could not reject: ${err.message}`, 'error');
  }
  await afterChange();
}

async function retry(id) {
  const by = await approver();
  if (!by) return;
  try {
    await api(`/api/actions/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ by }) });
  } catch (err) {
    notify(`Could not retry: ${err.message}`, 'error');
  }
  await afterChange();
}

async function recover() {
  const by = await approver();
  if (!by) return;
  try {
    const r = await api('/api/actions/recover', { method: 'POST', body: JSON.stringify({ by }) });
    notify(r.reconciled
      ? `Checked Tally: ${r.reconciled} entr${r.reconciled === 1 ? 'y' : 'ies'} reconciled.`
      : 'Nothing to reconcile yet. Entries are left alone for two minutes in case a post is still in flight.');
  } catch (err) {
    notify(`Recovery failed: ${err.message}`, 'error');
  }
  await afterChange();
}

/* --------------------------------------------------------- hide and delete
 *
 * Two different things, kept apart on purpose.
 *
 * Hiding takes an entry out of the queue and leaves it on record. Deleting
 * removes the record, so the server only allows it for an entry that never
 * reached Tally — the record of a posted entry is what stops the same
 * invoice going in a second time. The UI says so rather than offering a
 * button that will be refused.
 */
async function setArchived(id, archived) {
  const by = await approver();
  if (!by) return;
  try {
    await api(`/api/actions/${encodeURIComponent(id)}/${archived ? 'archive' : 'unarchive'}`, {
      method: 'POST',
      body: JSON.stringify({ by }),
    });
  } catch (err) {
    notify(`Could not ${archived ? 'hide' : 'restore'} it: ${err.message}`, 'error');
  }
  await afterChange();
}

async function remove(id) {
  const a = state.actions.find((x) => x.id === id) ?? state.archived.find((x) => x.id === id);
  const by = await approver();
  if (!by) return;

  const ok = await confirmSheet(
    'Delete this entry?',
    `It is removed from the queue for good. The history keeps the line saying it existed and that you deleted it.${
      a?.state === 'rejected' ? '' : ' It was never posted, so nothing in Tally changes.'}`,
    'Delete',
    'danger',
  );
  if (!ok) return;

  try {
    await api(`/api/actions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ by }),
    });
  } catch (err) {
    if (err.code === 'DELETE_REFUSED') {
      const hide = await confirmSheet('Cannot be deleted', err.message, 'Hide it instead');
      if (hide) await setArchived(id, true);
      return;
    }
    notify(`Could not delete: ${err.message}`, 'error');
  }
  await afterChange();
}

async function purge(scope, message) {
  const by = await approver();
  if (!by) return;
  if (!(await confirmSheet('Delete in bulk?', message, 'Delete', 'danger'))) return;
  try {
    const r = await api('/api/actions/purge', { method: 'POST', body: JSON.stringify({ scope, by }) });
    notify(r.deleted
      ? `Deleted ${r.deleted} entr${r.deleted === 1 ? 'y' : 'ies'}.${
        r.keptBecausePosted ? ` ${r.keptBecausePosted} were kept because they reached Tally.` : ''}`
      : 'There was nothing safe to delete.');
  } catch (err) {
    notify(`Could not delete: ${err.message}`, 'error');
  }
  await afterChange();
}

$('#purge-rejected').onclick = () => purge(
  'rejected',
  'Every rejected entry is removed from the queue for good. None of them ever reached Tally, and the history keeps a line for each.',
);
$('#purge-archived').onclick = () => purge(
  'archived',
  'Archived entries that never reached Tally are deleted. Anything that was posted stays, because that record is what stops it posting twice.',
);

/**
 * Editing a draft means describing the change in chat. The agent re-prepares
 * it, which keeps every version of an entry validated the same way rather
 * than letting the browser hand-edit a payload straight into the queue.
 */
function edit(id) {
  const a = state.actions.find((x) => x.id === id);
  show('chat');
  $('#chat-input').value = `Change the draft ${id.slice(0, 12)} (${a?.preview?.title ?? ''}): `;
  autoGrow();
  $('#chat-input').focus();
}

/* ================================================================= archive */

async function loadArchive() {
  try {
    const r = await api('/api/actions?limit=200&archived=only');
    state.archived = r.items;
    $('#archive-list').innerHTML = r.items.length
      ? r.items.map((a) => card(a, { archived: true })).join('')
      : '<div class="empty">Nothing is hidden. Use “Hide” on any entry to move it here.</div>';
    wireCards($('#archive-list'));
  } catch (err) {
    $('#archive-list').innerHTML = `<div class="finding error">Could not load the archive: ${esc(err.message)}</div>`;
  }
}
$('#archive-refresh').onclick = loadArchive;

/* ================================================================ invoices */

const dz = $('#dropzone');
dz.onclick = () => $('#file-input').click();
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  upload([...e.dataTransfer.files]);
};
$('#file-input').onchange = (e) => upload([...e.target.files]);
$('#invoice-refresh').onclick = refreshQueue;

/**
 * Upload, then deal with whatever comes back.
 *
 * `onDuplicate` decides what the server does with a file it already holds:
 * 'ask' (the default) stops at the duplicate and hands the decision back
 * here, where a sheet puts it to the person with the stored path in front
 * of them.
 */
async function upload(files, { onDuplicate = 'ask' } = {}) {
  if (files.length === 0) return;
  for (const f of files) state.files.set(f.name, f);

  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('onDuplicate', onDuplicate);
  const by = storedApprover();
  if (by) form.append('by', by);

  const list = $('#doc-list');
  const pending = document.createElement('div');
  pending.className = 'doc';
  pending.innerHTML = `<div class="invoice"><span class="spinner"></span> &nbsp;Reading ${files.length} document${files.length === 1 ? '' : 's'}…</div>`;
  list.prepend(pending);

  state.busy = true;
  try {
    const r = await api('/api/documents', { method: 'POST', body: form });
    pending.remove();

    const duplicates = [];
    for (const doc of r.documents) {
      if (doc.stage === 'duplicate') { duplicates.push(doc); continue; }
      // A re-read of the same file replaces the card it supersedes.
      state.documents = state.documents.filter((d) => !(d.source?.hash && d.source.hash === doc.source?.hash));
      state.documents.unshift(doc);
    }
    drawDocuments();
    await refreshQueue();
    // Asked one at a time: each needs its own answer.
    for (const doc of duplicates) await handleDuplicate(doc);
  } catch (err) {
    pending.innerHTML = `<div class="finding error">${esc(err.message)}</div>`;
  } finally {
    state.busy = false;
  }
  $('#file-input').value = '';
}

/**
 * This file is already in the system.
 *
 * The one thing a person needs here is where the earlier copy is, so the
 * path is shown, copyable, and the file itself can be opened. Nothing is
 * updated or duplicated unless that choice is made explicitly.
 */
async function handleDuplicate(doc) {
  const d = doc.duplicate ?? {};
  const e = d.existing ?? {};
  const stateLabel = {
    pending_approval: 'waiting for your approval',
    draft: 'still a draft',
    executing: 'being posted right now',
    verified: 'approved and posted to Tally',
    needs_review: 'posted, but not confirmed',
  }[e.state] ?? e.state ?? 'nothing yet';

  const body = `
    <p>${esc(d.reason ?? 'This exact file is already in the system, so it was not read a second time.')}</p>
    <dl>
      <dt>File</dt><dd>${esc(doc.file)}</dd>
      <dt>Stored at</dt><dd><span class="path">${esc(d.path ?? '—')}</span></dd>
      <dt>Uploaded</dt><dd>${d.uploadedBefore ? when(d.uploadedBefore) : '—'}</dd>
      ${e.invoiceNumber ? `<dt>Invoice</dt><dd>${esc(e.invoiceNumber)}${e.party ? ` · ${esc(e.party)}` : ''}</dd>` : ''}
      ${e.actionId ? `<dt>Status</dt><dd>${esc(stateLabel)}${e.voucherNumber ? ` · voucher ${esc(e.voucherNumber)}` : ''}</dd>` : ''}
    </dl>`;

  const buttons = [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Keep both', value: 'separate' },
  ];
  if (d.canUpdate) buttons.push({ label: 'Replace the draft', value: 'update', kind: 'primary' });

  const choice = await sheet({
    title: 'Already uploaded',
    body,
    buttons,
    onOpen: (el) => {
      // A path is only useful if it can be taken somewhere else.
      const path = el.querySelector('.path');
      if (path && d.path) {
        path.style.cursor = 'copy';
        path.title = 'Click to copy';
        path.onclick = async () => {
          await navigator.clipboard.writeText(d.absolutePath ?? d.path).catch(() => {});
          const was = path.textContent;
          path.textContent = 'copied';
          setTimeout(() => { path.textContent = was; }, 1200);
        };
      }
      if (d.hash) {
        const open = document.createElement('button');
        open.className = 'btn plain spacer';
        open.textContent = 'Open the stored file';
        open.onclick = () => window.open(`/api/documents/uploads/${encodeURIComponent(d.hash)}/file`, '_blank');
        el.querySelector('.sheet-actions').prepend(open);
      }
    },
  });

  if (choice !== 'update' && choice !== 'separate') return;

  const file = state.files.get(doc.file);
  if (!file) {
    banner(`Could not find "${doc.file}" to send again. Choose it from the dropzone once more.`);
    return;
  }
  if (choice === 'update' && !(await approver())) return;
  await upload([file], { onDuplicate: choice });
}

/* ---------------------------------------------------------------- the card
 *
 * An invoice is shown the way it is printed — parties, then items, then a
 * total — followed by where it has got to and what is left for a person to
 * do. The steps are the point: nothing moves past "Approval" on its own.
 */

const DOC_STEPS = [
  { key: 'read', label: 'Read' },
  { key: 'checked', label: 'Checked' },
  { key: 'matched', label: 'Matched' },
  { key: 'approval', label: 'Approval' },
  { key: 'posted', label: 'Posted' },
];

/** Where this document has got to, joined with its action's live state. */
function progressOf(d) {
  const action = d.actionId ? state.actions.find((a) => a.id === d.actionId) : null;
  const actionState = action?.state ?? d.actionState ?? null;
  const errors = d.errors ?? [];
  const readFailed = !d.invoiceNumber && d.total == null && errors.length > 0;
  const unmatched = Object.values(d.mappings ?? {}).some((m) => !m.ledger);

  const status = {
    read: readFailed ? 'blocked' : 'done',
    checked: readFailed ? 'todo' : errors.length && !unmatched ? 'blocked' : 'done',
    matched: readFailed ? 'todo' : !d.mappings ? 'todo' : unmatched ? 'blocked' : 'done',
    approval: 'todo',
    posted: 'todo',
  };

  if (actionState === 'verified') { status.approval = 'done'; status.posted = 'done'; }
  else if (actionState === 'executing') { status.approval = 'done'; status.posted = 'current'; }
  else if (actionState === 'needs_review' || actionState === 'failed') { status.approval = 'done'; status.posted = 'blocked'; }
  else if (actionState === 'rejected') { status.approval = 'blocked'; }
  else if (actionState === 'pending_approval') { status.approval = 'current'; }

  return { action, actionState, status, errors, unmatched };
}

function stepsHtml(status) {
  return `<div class="steps">${DOC_STEPS.map((st) => `
    <div class="step ${status[st.key]}"><span class="bullet"></span><span class="label">${esc(st.label)}</span></div>`).join('')}</div>`;
}

function drawDocuments() {
  const list = $('#doc-list');
  list.innerHTML = '';
  for (const d of state.documents) list.append(docCard(d));
  const waiting = state.documents.filter((d) => progressOf(d).actionState === 'pending_approval').length;
  const badge = $('#badge-invoices');
  badge.textContent = waiting;
  badge.classList.toggle('hidden', waiting === 0);
}

function docCard(d) {
  const el = document.createElement('div');
  el.className = 'doc';
  const { actionState, status, errors } = progressOf(d);

  const badge = actionState === 'verified' ? { cls: 'verified', text: 'Posted' }
    : actionState === 'pending_approval' ? { cls: 'awaiting', text: 'Needs your approval' }
    : actionState === 'executing' ? { cls: 'executing', text: 'Posting' }
    : actionState === 'rejected' ? { cls: 'rejected', text: 'Rejected' }
    : actionState === 'failed' ? { cls: 'failed', text: 'Failed' }
    : actionState === 'needs_review' ? { cls: 'needs_review', text: 'Unconfirmed' }
    : errors.length ? { cls: 'exceptions', text: 'Held back' }
    : { cls: '', text: String(d.stage ?? '').replace(/_/g, ' ') };

  const tax = d.tax ?? {};
  const itemRows = (d.lineItems ?? []).map((li, i) => `
    <tr>
      <td class="num muted">${i + 1}</td>
      <td class="desc">${esc(li.description ?? '—')}${li.hsnSac ? `<div class="hsn">HSN ${esc(li.hsnSac)}</div>` : ''}</td>
      <td class="num">${li.quantity == null ? '' : esc(li.quantity)}${li.unit ? ` ${esc(li.unit)}` : ''}</td>
      <td class="num">${li.rate == null ? '' : money(li.rate)}</td>
      <td class="num muted">${li.taxRate == null ? '' : `${esc(li.taxRate)}%`}</td>
      <td class="num">${li.amount == null ? '' : money(li.amount)}</td>
    </tr>`).join('');

  const totalRow = (label, value) => (value == null || Number(value) === 0
    ? ''
    : `<div class="row"><span>${esc(label)}</span><span>${money(value)}</span></div>`);

  const mapping = d.mappings ? `<div class="mapping">${Object.entries(d.mappings).map(([role, m]) => {
    const cls = !m.ledger ? 'unmatched' : (m.status === 'exact' || m.status === 'confident') ? '' : 'guess';
    return `<span class="map-pill ${cls}">${esc(role)} → ${m.ledger ? `<b>${esc(m.ledger)}</b>` : 'no ledger'}${
      m.via === 'gstin' ? ' · by GSTIN' : ''}</span>`;
  }).join('')}</div>` : '';

  const footNote = actionState === 'pending_approval'
    ? '<span class="note">Nothing is in Tally yet. It posts only when you approve it.</span>'
    : actionState === 'verified'
      ? '<span class="note ready">Approved and posted to Tally.</span>'
      : errors.length
        ? '<span class="note hold">Held back. Fix what is flagged above, then upload it again.</span>'
        : '<span class="note">Read and checked.</span>';

  const counterparty = (d.documentType === 'sales' ? d.buyer : d.supplier) ?? d.party ?? '—';

  el.innerHTML = `
    <div class="doc-head">
      <span class="file">${esc(d.file)}</span>
      ${d.documentType ? `<span class="kind">${esc(String(d.documentType).replace(/_/g, ' '))}</span>` : ''}
      <span class="spacer"></span>
      <span class="state ${badge.cls}">${esc(badge.text)}</span>
    </div>

    <div class="invoice">
      <div class="invoice-top">
        <div class="party">
          <div class="role">${d.documentType === 'sales' ? 'Billed to' : 'From'}</div>
          <div class="name">${esc(counterparty)}</div>
          ${d.party ? `<div class="sub">Ledger · ${esc(d.party)}</div>` : ''}
        </div>
        <div class="invoice-meta">
          <div>Invoice <b>${esc(d.invoiceNumber ?? '—')}</b></div>
          <div>Dated <b>${esc(d.invoiceDate ?? '—')}</b></div>
          ${d.lineItems?.length ? `<div>${d.lineItems.length} line item${d.lineItems.length === 1 ? '' : 's'}</div>` : ''}
        </div>
      </div>

      ${itemRows ? `
        <table class="items">
          <thead><tr><th></th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST</th><th class="num">Amount</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>` : ''}

      <div class="totals">
        ${totalRow('Taxable value', tax.taxable)}
        ${totalRow('CGST', tax.cgst)}
        ${totalRow('SGST', tax.sgst)}
        ${totalRow('IGST', tax.igst)}
        ${totalRow('Round off', d.roundOff)}
        <div class="row grand"><span>Total</span><span>${money(d.total)}</span></div>
      </div>
    </div>

    ${stepsHtml(status)}
    ${mapping}
    ${errors.map((e) => `<div class="finding error">${esc(e.message)}</div>`).join('')}
    ${(d.warnings ?? []).map((w) => `<div class="finding warn">${esc(w.message)}</div>`).join('')}

    <div class="doc-foot">
      ${actionState === 'pending_approval' ? `
        <button class="btn primary tiny act-approve">Approve and post</button>
        <button class="btn danger tiny act-reject">Reject</button>` : ''}
      ${footNote}
      <span class="spacer"></span>
      ${d.actionId ? '<button class="btn ghost tiny act-review">In approvals</button>' : ''}
      ${d.source?.hash ? '<button class="btn ghost tiny act-open">Open file</button>' : ''}
      <button class="btn plain tiny act-dismiss" title="Remove this card. The entry itself is untouched.">Dismiss</button>
    </div>
    ${d.source?.path ? `<div class="source-line">Stored at <span class="path">${esc(d.source.path)}</span>
      <button class="btn plain tiny act-copy">Copy path</button></div>` : ''}`;

  el.querySelector('.act-approve')?.addEventListener('click', () => approve([d.actionId]));
  el.querySelector('.act-reject')?.addEventListener('click', () => reject(d.actionId));
  el.querySelector('.act-review')?.addEventListener('click', () => show('approvals'));
  el.querySelector('.act-open')?.addEventListener('click', () => {
    window.open(`/api/documents/uploads/${encodeURIComponent(d.source.hash)}/file`, '_blank');
  });
  // Dismiss clears the card only. The staged entry lives in the queue, which
  // is the one place it can be approved or deleted from.
  el.querySelector('.act-dismiss')?.addEventListener('click', () => {
    state.documents = state.documents.filter((x) => x !== d);
    drawDocuments();
  });
  el.querySelector('.act-copy')?.addEventListener('click', async (ev) => {
    await navigator.clipboard.writeText(d.source.absolutePath ?? d.source.path).catch(() => {});
    ev.target.textContent = 'Copied';
    setTimeout(() => { ev.target.textContent = 'Copy path'; }, 1200);
  });
  return el;
}

/* ================================================================== history */

async function loadAudit() {
  try {
    const rows = await api('/api/audit?limit=300');
    $('#audit-count').textContent = `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · append-only, never rewritten`;
    $('#audit-empty').style.display = rows.length ? 'none' : '';
    $('#audit-rows').innerHTML = rows.slice().reverse().map((r) => `
      <tr>
        <td class="t">${when(r.at)}</td>
        <td class="ev">${esc(r.event ?? '')}</td>
        <td>${r.to ? `<span class="state ${esc(r.to)}">${esc(r.to.replace(/_/g, ' '))}</span>` : ''}</td>
        <td>${esc(r.by ?? '')}</td>
        <td class="ev">${esc((r.actionId ?? '').slice(0, 16))}</td>
      </tr>`).join('');
  } catch (err) {
    banner(`Could not load the audit history: ${err.message}`);
  }
}
$('#audit-refresh').onclick = loadAudit;

/* ================================================================= settings */

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    state.settings = s;
    $('#set-model').value = s.model ?? '';
    $('#set-effort').value = s.effort ?? 'medium';
    $('#set-url').value = s.tallyUrl ?? '';
    $('#set-gstin').value = s.companyGstin ?? '';
    $('#set-company').innerHTML = (s.availableCompanies ?? [s.company])
      .map((c) => `<option ${c === s.company ? 'selected' : ''}>${esc(c)}</option>`).join('');
    drawApprover();
  } catch (err) {
    banner(`Could not load settings: ${err.message}`);
  }
}

$('#settings-save').onclick = async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model: $('#set-model').value.trim(),
        effort: $('#set-effort').value,
        tallyUrl: $('#set-url').value.trim(),
        company: $('#set-company').value,
        companyGstin: $('#set-gstin').value.trim(),
      }),
    });
    await refreshHealth();
    await loadSettings();
    notify('Settings applied to this running server. Edit .env to make them permanent.', 'ok');
  } catch (err) {
    banner(`Could not apply settings: ${err.message}`);
  }
};
$('#settings-reload').onclick = loadSettings;

$('#set-approver').onchange = () => {
  const who = $('#set-approver').value.trim();
  if (who) localStorage.setItem('tally-agent-user', who);
  else localStorage.removeItem('tally-agent-user');
  drawApprover();
};

$('#run-doctor').onclick = async () => {
  const out = $('#doctor-output');
  out.innerHTML = '<div class="pending-note"><span class="spinner"></span> running checks…</div>';
  try {
    const r = await api('/api/diagnostics');
    out.innerHTML = r.checks.map((c) => `
      <div class="finding ${c.status === 'fail' ? 'error' : c.status === 'warn' ? 'warn' : 'ok'}">
        <b>${esc(c.name)}</b> — ${esc(c.detail)}
        ${c.fix ? `<div class="muted" style="margin-top:3px">→ ${esc(c.fix)}</div>` : ''}
      </div>`).join('');
  } catch (err) {
    out.innerHTML = `<div class="finding error">${esc(err.message)}</div>`;
  }
};

/* ==================================================================== start */

drawApprover();
refreshHealth();
refreshQueue();
show(location.hash.slice(1) || 'chat');
setInterval(refreshHealth, 20000);
setInterval(() => {
  if (state.busy) return;
  refreshQueue();
  if (state.view === 'dashboard') loadDashboard();
}, 10000);

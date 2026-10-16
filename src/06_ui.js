
/* =====================================================================
 * SECTION 11 — UI: bootstrapping, wiring and rendering
 * ===================================================================== */
const vfs = new VFS(Store.get('vfs', null) || undefined);
const memory = new MemoryStore();
const personas = new PersonaStore();
const artifacts = new ArtifactStore();
const mock = new MockEngine();
const router = new ProviderRouter(mock);

/* ---------- Toasts ---------- */
function toast(msg, type = 'info', ms = 4200) {
  const box = $('#toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}
window.addEventListener('error', (e) => { if (e.message && !/ResizeObserver/.test(e.message)) toast('Error: ' + e.message, 'error'); });
window.addEventListener('unhandledrejection', (e) => { const m = e.reason && e.reason.message ? e.reason.message : String(e.reason); if (!/Abort/.test(m)) toast('Error: ' + m, 'error'); });

/* ---------- Terminal log ---------- */
let termLines = 0;
function log(msg, type = 'info') {
  const box = $('#termLog'); if (!box) return;
  const line = document.createElement('div');
  line.className = 'tl ' + type;
  const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtTime(Date.now());
  if (type !== 'cmd') line.appendChild(ts);
  line.appendChild(document.createTextNode(String(msg)));
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.appendChild(line);
  while (box.children.length > 1500) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
  termLines++; $('#termCount').textContent = termLines;
}

/* ---------- Modal manager with focus trap ---------- */
const modalStack = [];
function openModal(el, focusSel) {
  el.hidden = false; el.removeAttribute('inert'); el.setAttribute('aria-hidden', 'false');
  modalStack.push({ el, prev: document.activeElement });
  $('#scrim').hidden = false;
  Anim.in(el, { y: 0, scale: 0.97 });
  setTimeout(() => { const f = focusSel ? $(focusSel, el) : el.querySelector('input,textarea,select,button'); f && f.focus(); }, 30);
}
function closeModal(el) {
  const i = modalStack.findIndex((m) => m.el === el); if (i < 0) return;
  const [{ prev }] = modalStack.splice(i, 1);
  if (el.id === 'memDrawer') { el.classList.remove('open'); el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); $('#memBtn').setAttribute('aria-expanded', 'false'); }
  else el.hidden = true;
  if (!modalStack.length) $('#scrim').hidden = true;
  if (prev && prev.focus) prev.focus();
}
document.addEventListener('keydown', (e) => {
  const top = modalStack[modalStack.length - 1];
  if (top && e.key === 'Tab') {
    const f = $$('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select,textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', top.el).filter((x) => x.offsetParent !== null);
    if (f.length) { const first = f[0], last = f[f.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } else if (!top.el.contains(document.activeElement)) { e.preventDefault(); first.focus(); } }
  }
  if (e.key === 'Escape' && top) { e.preventDefault(); if (top.el.id === 'hitlModal') hitl.decide('reject'); else if (top.el.id === 'promptModal') promptResolve(null); else closeModal(top.el); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); selectTab($('#tab-chat')); $('#chatInput').focus(); }
  if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); toggleTerminal(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'm' && !top) { e.preventDefault(); openMemory(); }
});
$('#scrim').addEventListener('click', () => { const top = modalStack[modalStack.length - 1]; if (top && top.el.id !== 'hitlModal') top.el.id === 'promptModal' ? promptResolve(null) : closeModal(top.el); });
$$('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.closest('.modal'))));

/* Generic prompt modal (returns Promise<string|null>) */
let promptResolver = null;
function promptResolve(v) { const r = promptResolver; promptResolver = null; closeModal($('#promptModal')); r && r(v); }
function askInput(title, label, value = '') {
  return new Promise((resolve) => {
    promptResolver = resolve;
    $('#promptTitle').textContent = title; $('#promptLabel').firstChild.textContent = label; $('#promptInput').value = value;
    openModal($('#promptModal'), '#promptInput');
  });
}
$('#promptForm').addEventListener('submit', (e) => { e.preventDefault(); promptResolve($('#promptInput').value); });
$('#promptOk').addEventListener('click', () => promptResolve($('#promptInput').value));
$('#promptCancel').addEventListener('click', () => promptResolve(null));

/* ---------- Tabs (ARIA, arrow-key navigation) ---------- */
function selectTab(tab) {
  const list = tab.closest('[role=tablist]');
  $$('[role=tab]', list).forEach((t) => { const sel = t === tab; t.setAttribute('aria-selected', String(sel)); t.tabIndex = sel ? 0 : -1; const p = document.getElementById(t.getAttribute('aria-controls')); if (p) p.hidden = !sel; });
  const panel = document.getElementById(tab.getAttribute('aria-controls')); if (panel) Anim.in(panel, { y: 4, duration: 0.2 });
}
$$('[data-tablist]').forEach((list) => {
  list.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) selectTab(t); });
  list.addEventListener('keydown', (e) => {
    const tabs = $$('[role=tab]', list); const i = tabs.indexOf(document.activeElement); if (i < 0) return;
    let n = null; if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length; else if (e.key === 'Home') n = 0; else if (e.key === 'End') n = tabs.length - 1;
    if (n != null) { e.preventDefault(); tabs[n].focus(); selectTab(tabs[n]); }
  });
});

/* ---------- Human-in-the-Loop ---------- */
class HitlUI {
  constructor() { this.queue = []; this.cur = null; this.original = ''; }
  request(req) {
    return new Promise((resolve) => {
      const item = { ...req, resolve };
      if (req.signal) req.signal.addEventListener('abort', () => { if (this.cur === item) this.decide('reject'); else { this.queue = this.queue.filter((q) => q !== item); resolve({ action: 'reject' }); this.updateBadge(); } }, { once: true });
      this.queue.push(item); this.updateBadge();
      if (!this.cur) this.next();
    });
  }
  updateBadge() { $('#hitlQueue').textContent = this.queue.length ? `+${this.queue.length} queued` : ''; }
  next() {
    if (this.cur || !this.queue.length) { this.updateBadge(); return; }
    this.cur = this.queue.shift(); this.updateBadge();
    const c = this.cur;
    $('#hitlReason').textContent = '⚠ ' + c.reason;
    $('#hitlOp').textContent = c.op;
    $('#hitlSource').textContent = `· requested by ${c.source}`;
    this.original = JSON.stringify(c.payload, null, 2);
    const ta = $('#hitlPayload'); ta.value = this.original; ta.readOnly = true;
    $('#hitlEdit').setAttribute('aria-pressed', 'false'); $('#hitlEdit').textContent = 'Edit'; $('#hitlEditHint').textContent = '(read-only — click Edit to modify)';
    $('#hitlApprove').textContent = 'Approve';
    openModal($('#hitlModal'), '#hitlReject');
    Anim.pulse($('#hitlModal'));
  }
  toggleEdit() {
    const ta = $('#hitlPayload'); ta.readOnly = !ta.readOnly;
    const on = !ta.readOnly;
    $('#hitlEdit').setAttribute('aria-pressed', String(on)); $('#hitlEdit').textContent = on ? 'Lock' : 'Edit';
    $('#hitlEditHint').textContent = on ? '(editing — Approve will use your edited payload)' : '(read-only — click Edit to modify)';
    $('#hitlApprove').textContent = on ? 'Approve edited' : 'Approve';
    if (on) ta.focus();
  }
  decide(action) {
    const c = this.cur; if (!c) return;
    let result = { action: 'approve', payload: c.payload };
    if (action === 'reject') result = { action: 'reject' };
    else {
      const txt = $('#hitlPayload').value;
      if (txt.trim() !== this.original.trim()) {
        try { result = { action: 'edit', payload: JSON.parse(txt) }; }
        catch (e) { toast('Edited payload is not valid JSON: ' + e.message, 'error'); return; }
      }
    }
    this.cur = null;
    closeModal($('#hitlModal'));
    c.resolve(result);
    setTimeout(() => { if (!this.cur) this.next(); }, 60);
  }
}
const hitl = new HitlUI();
$('#hitlApprove').addEventListener('click', () => hitl.decide('approve'));
$('#hitlReject').addEventListener('click', () => hitl.decide('reject'));
$('#hitlEdit').addEventListener('click', () => hitl.toggleEdit());

/* ---------- Engine wiring ---------- */
let tasks; // assigned below
const snapshots = new SnapshotLog(
  () => ({ vfs: vfs.toJSON(), tasks: tasks ? tasks.toJSON() : [], memory: memory.facts, artifacts: artifacts.toJSON() }),
  (s) => { if (s.vfs) vfs.load(s.vfs); if (s.tasks && tasks) tasks.load(s.tasks); if (Array.isArray(s.memory)) { memory.facts = s.memory; memory.save(); } if (s.artifacts) artifacts.load(s.artifacts); },
);
const engine = new ReActEngine({ router, vfs, memory, personas, artifacts, hitl, snapshots, log });
tasks = new TaskQueue(engine, snapshots, vfs);

/* ---------- Persistence hooks ---------- */
const persistVfs = throttle(() => Store.set('vfs', vfs.toJSON()), 400);
const renderTreesThrottled = throttle(() => { renderTrees(); }, 120);
vfs.on('change', () => { persistVfs(); renderTreesThrottled(); if (viewer.path && !vfs.isFile(viewer.path)) closeViewer(); else if (viewer.path && !viewer.dirty) refreshViewer(); });
vfs.on('cwd', () => { $('#termCwd').textContent = vfs.cwd + ' $'; });

/* =====================================================================
 * UI · Router header + provider modal
 * ===================================================================== */
const STATUS_COLORS = { ready: 'var(--ok)', cooldown: 'var(--warn)', error: 'var(--err)', nokey: '#444', disabled: '#2a2a2a' };
function renderRouterStatus() {
  const configured = router.configured();
  const active = router.active;
  $('#activeProvider').textContent = active === 'mock' ? (configured ? 'mock (fallback)' : 'mock · offline') : PROVIDERS[active].label + ' · ' + router.cfg[active].model;
  $('#statusDot').className = 'status-dot ' + (active === 'mock' ? 'mock' : 'live');
  const strip = $('#routerStrip'); strip.textContent = '';
  router.order.forEach((pid, i) => {
    const st = router.providerStatus(pid);
    const d = document.createElement('span');
    d.className = 'badge'; d.style.borderColor = STATUS_COLORS[st.code]; d.style.color = st.code === 'ready' ? 'var(--ok)' : st.code === 'cooldown' ? 'var(--warn)' : 'var(--dim)';
    if (pid === active) { d.style.background = 'var(--accent-soft)'; d.style.color = '#fff'; }
    d.textContent = `${i + 1}·${pid.slice(0, 4)}`; d.title = `${PROVIDERS[pid].label}: ${st.text}${router.state[pid].lastError ? '\nlast error: ' + router.state[pid].lastError : ''}`;
    strip.appendChild(d);
  });
  if (!$('#providerModal').hidden) updateProviderRowStatus();
}
function renderProviderRows() {
  const box = $('#providerRows'); box.textContent = '';
  router.order.forEach((pid, i) => {
    const P = PROVIDERS[pid], c = router.cfg[pid];
    const row = document.createElement('div'); row.className = 'card prow'; row.dataset.pid = pid;
    row.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="row"><span class="badge">#${i + 1}</span><strong style="font-family:var(--display);font-size:20px;letter-spacing:.06em">${escapeHtml(P.label)}</strong>
          <span class="badge pstat"></span><span class="dim pstats" style="font-size:11px"></span></div>
        <div class="row">
          <label class="row" style="gap:4px;font-size:12px"><input type="checkbox" data-act="enabled" ${c.enabled ? 'checked' : ''}> enabled</label>
          <button class="btn sm" data-act="up" aria-label="Move ${escapeHtml(P.label)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn sm" data-act="down" aria-label="Move ${escapeHtml(P.label)} down" ${i === router.order.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn sm" data-act="reset">Reset cooldown</button>
        </div>
      </div>
      <div class="grid2" style="margin-top:8px">
        <label class="field">Model${P.freeOnly ? ' (must end with :free)' : ''}<input class="input" data-act="model" value="${escapeHtml(c.model)}" spellcheck="false"></label>
        <label class="field">API keys (one per line — rotated round-robin)<textarea class="input keys" data-act="keys" rows="2" spellcheck="false" autocomplete="off" style="-webkit-text-security:disc">${escapeHtml(c.keys.join('\n'))}</textarea></label>
      </div>
      <div class="dim perr" style="font-size:11px;margin-top:4px"></div>`;
    box.appendChild(row);
  });
  updateProviderRowStatus();
}
function updateProviderRowStatus() {
  $$('#providerRows .prow').forEach((row) => {
    const pid = row.dataset.pid, st = router.providerStatus(pid), s = router.state[pid];
    const b = $('.pstat', row); b.textContent = st.text; b.style.borderColor = STATUS_COLORS[st.code]; b.style.color = STATUS_COLORS[st.code] === '#444' ? 'var(--muted)' : STATUS_COLORS[st.code];
    $('.pstats', row).textContent = `ok ${s.ok} · fail ${s.fail}${router.active === pid ? ' · ACTIVE' : ''}`;
    $('.perr', row).textContent = s.lastError ? 'last error: ' + s.lastError : '';
  });
}
$('#providerRows').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const pid = b.closest('.prow').dataset.pid;
  if (b.dataset.act === 'up' || b.dataset.act === 'down') { router.move(pid, b.dataset.act === 'up' ? -1 : 1); renderProviderRows(); const nb = $(`.prow[data-pid="${pid}"] [data-act="${b.dataset.act}"]`); (nb && !nb.disabled ? nb : $(`.prow[data-pid="${pid}"] [data-act="enabled"]`)).focus(); }
  if (b.dataset.act === 'reset') { router.resetCooldowns(pid); toast(`${PROVIDERS[pid].label} cooldown cleared`, 'success'); }
});
$('#providerRows').addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const pid = el.closest('.prow').dataset.pid;
  if (el.dataset.act === 'enabled') router.cfg[pid].enabled = el.checked;
  if (el.dataset.act === 'model') { const v = el.value.trim() || PROVIDERS[pid].defaultModel; if (PROVIDERS[pid].freeOnly && !/:free$/.test(v)) toast('OpenRouter is restricted to :free models — the provider will be skipped until the model ends with ":free"', 'warn'); router.cfg[pid].model = v; }
  if (el.dataset.act === 'keys') router.setKeys(pid, el.value.split(/[\n,]+/));
  router.save();
});
$('#providerRows').addEventListener('focusin', (e) => { if (e.target.classList.contains('keys')) e.target.style.webkitTextSecurity = 'none'; });
$('#providerRows').addEventListener('focusout', (e) => { if (e.target.classList.contains('keys')) e.target.style.webkitTextSecurity = 'disc'; });
$('#routerBtn').addEventListener('click', () => { renderProviderRows(); $('#forceMock').checked = router.forceMock; $('#mockDelay').value = mock.delay; openModal($('#providerModal')); });
$('#forceMock').addEventListener('change', (e) => { router.forceMock = e.target.checked; router.save(); });
$('#mockDelay').addEventListener('change', (e) => { mock.delay = clamp(parseInt(e.target.value, 10) || 0, 0, 200); Store.set('mock.delay', mock.delay); });
$('#resetCooldowns').addEventListener('click', () => { router.resetCooldowns(); toast('All cooldowns cleared', 'success'); });
router.on('status', renderRouterStatus);
setInterval(() => { if (Object.values(router.state).some((s) => s.cooldownUntil > 0 || Object.keys(s.keyCooldowns).length)) renderRouterStatus(); }, 1000);

/* =====================================================================
 * UI · Personas
 * ===================================================================== */
let editingPersonaId = personas.selectedId;
function renderPersonaSelect() {
  const sel = $('#personaSelect'); sel.textContent = '';
  personas.items.forEach((p) => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
  sel.value = personas.selectedId;
}
function renderPersonaModal() {
  const list = $('#personaList'); list.textContent = '';
  personas.items.forEach((p) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = (p.id === personas.selectedId ? '● ' : '') + p.name;
    b.setAttribute('aria-current', String(p.id === editingPersonaId)); b.addEventListener('click', () => { editingPersonaId = p.id; renderPersonaModal(); });
    list.appendChild(b);
  });
  const p = personas.get(editingPersonaId) || { name: '', system_prompt: '', knowledge_snippets: '' };
  $('#pfName').value = p.name; $('#pfPrompt').value = p.system_prompt; $('#pfKnow').value = p.knowledge_snippets;
  $('#personaDelete').disabled = !personas.get(editingPersonaId) || personas.items.length <= 1;
}
$('#personaSelect').addEventListener('change', (e) => { personas.select(e.target.value); toast(`Persona: ${personas.selected.name}`, 'success', 1800); });
$('#personaEditBtn').addEventListener('click', () => { editingPersonaId = personas.selectedId; renderPersonaModal(); openModal($('#personaModal'), '#pfName'); });
$('#personaNew').addEventListener('click', () => { editingPersonaId = null; renderPersonaModal(); $('#pfName').focus(); });
$('#personaForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#pfName').value.trim(); if (!name) { toast('Persona name is required', 'error'); return; }
  const saved = personas.upsert({ id: editingPersonaId || undefined, name, system_prompt: $('#pfPrompt').value, knowledge_snippets: $('#pfKnow').value });
  editingPersonaId = saved.id; renderPersonaModal(); toast('Persona saved', 'success');
});
$('#personaDelete').addEventListener('click', () => { try { personas.remove(editingPersonaId); editingPersonaId = personas.selectedId; renderPersonaModal(); toast('Persona deleted', 'success'); } catch (e) { toast(e.message, 'error'); } });
$('#personaUse').addEventListener('click', () => { if (!editingPersonaId) { toast('Save the persona first', 'warn'); return; } personas.select(editingPersonaId); renderPersonaModal(); toast(`Using ${personas.selected.name}`, 'success'); });
personas.on('change', renderPersonaSelect);

/* =====================================================================
 * UI · Memory drawer
 * ===================================================================== */
function openMemory() { const d = $('#memDrawer'); d.classList.add('open'); $('#memBtn').setAttribute('aria-expanded', 'true'); renderMemory(); openModal(d, '#memSearch'); }
$('#memBtn').addEventListener('click', openMemory);
$('#memClose').addEventListener('click', () => closeModal($('#memDrawer')));
function renderMemory() {
  $('#memCount').textContent = memory.facts.length;
  const drawerOpen = $('#memDrawer').classList.contains('open');
  if (!drawerOpen) return;
  const q = $('#memSearch').value;
  const list = $('#memList'); list.textContent = '';
  const items = memory.filter(q);
  $('#memInfo').textContent = q.trim() ? `${items.length} match(es) for "${q}"` : `${memory.facts.length} fact(s) stored`;
  if (!items.length) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = q ? 'No matching facts.' : 'No memories yet. Chat with the agent — facts and preferences are extracted automatically.'; list.appendChild(d); }
  items.forEach((f) => {
    const card = document.createElement('div'); card.className = 'fact'; card.dataset.id = f.id;
    card.innerHTML = `<div class="ft"></div><div class="fm"><span>${escapeHtml(f.source)} · ${escapeHtml(new Date(f.updated || f.created).toLocaleString())}${f.score != null ? ` · score ${f.score.toFixed(2)}` : ''}</span><span class="row" style="gap:4px"><button class="btn sm" data-act="edit">Edit</button><button class="btn sm danger" data-act="del" aria-label="Delete fact">✕</button></span></div>`;
    $('.ft', card).textContent = f.text;
    list.appendChild(card);
  });
}
$('#memSearch').addEventListener('input', renderMemory);
$('#memForm').addEventListener('submit', (e) => { e.preventDefault(); const f = memory.add($('#memNew').value, 'manual'); if (f) { $('#memNew').value = ''; toast('Fact saved', 'success', 1500); } else toast('Empty or duplicate fact', 'warn'); });
$('#memClearAll').addEventListener('click', () => { if (!memory.facts.length) return; snapshots.take('before clearing memory', 'user'); memory.clear(); toast('Memory cleared (snapshot taken)', 'success'); });
$('#memList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const card = b.closest('.fact'), id = card.dataset.id;
  if (b.dataset.act === 'del') { memory.remove(id); return; }
  if (b.dataset.act === 'edit') {
    const f = memory.facts.find((x) => x.id === id); if (!f) return;
    const ft = $('.ft', card); ft.textContent = '';
    const ta = document.createElement('textarea'); ta.className = 'input'; ta.rows = 3; ta.value = f.text; ta.style.width = '100%'; ta.setAttribute('aria-label', 'Edit fact');
    ft.appendChild(ta); ta.focus();
    b.textContent = 'Save'; b.dataset.act = 'save';
    ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); b.click(); } if (ev.key === 'Escape') { ev.stopPropagation(); renderMemory(); } });
    return;
  }
  if (b.dataset.act === 'save') { const ta = $('textarea', card); if (ta.value.trim()) { memory.update(id, ta.value); toast('Fact updated', 'success', 1500); } else memory.remove(id); }
});
memory.on('change', renderMemory);

/* =====================================================================
 * UI · VFS trees + file viewer
 * ===================================================================== */
const viewer = { path: null, dirty: false, preview: false };
function buildTree(container, { selected, compact } = {}) {
  container.textContent = '';
  const mk = (path) => {
    const ul = document.createElement('ul'); ul.setAttribute('role', path === '/' ? 'tree' : 'group');
    vfs.list(path).forEach((item) => {
      const li = document.createElement('li'); li.setAttribute('role', 'treeitem');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'node' + (item.path === selected ? ' sel' : '');
      b.dataset.path = item.path; b.dataset.type = item.type;
      b.innerHTML = item.type === 'dir' ? `<span class="dir">▾ ${escapeHtml(item.name)}/</span>` : `<span>· ${escapeHtml(item.name)}</span>${compact ? '' : `<span class="dim" style="margin-left:auto;font-size:10px">${item.size}b</span>`}`;
      li.appendChild(b);
      if (item.type === 'dir') { li.setAttribute('aria-expanded', 'true'); li.appendChild(mk(item.path)); }
      ul.appendChild(li);
    });
    return ul;
  };
  const root = document.createElement('div'); root.className = 'dim'; root.style.fontSize = '11px'; root.textContent = '/ (root)';
  container.appendChild(root); container.appendChild(mk('/'));
}
function renderTrees() { buildTree($('#fileTree'), { selected: viewer.path }); buildTree($('#termTree'), { selected: viewer.path, compact: true }); }
function onTreeClick(e) {
  const b = e.target.closest('.node'); if (!b) return;
  if (b.dataset.type === 'file') { openFile(b.dataset.path); selectTab($('#tab-files')); }
  else { const ul = b.nextElementSibling; if (ul) { ul.hidden = !ul.hidden; b.parentElement.setAttribute('aria-expanded', String(!ul.hidden)); b.firstChild.textContent = (ul.hidden ? '▸ ' : '▾ ') + b.dataset.path.split('/').pop() + '/'; } }
}
$('#fileTree').addEventListener('click', onTreeClick);
$('#termTree').addEventListener('click', onTreeClick);
function openFile(path) {
  if (!vfs.isFile(path)) { toast('Not a file: ' + path, 'error'); return; }
  viewer.path = vfs.norm(path); viewer.dirty = false; viewer.preview = false;
  refreshViewer(); renderTrees();
}
function refreshViewer() {
  const p = viewer.path; if (!p) return;
  $('#viewerPath').textContent = p; $('#viewerPath').classList.remove('muted');
  const ta = $('#viewerText'); ta.disabled = false; ta.value = vfs.read(p);
  const isHtml = /\.html?$/i.test(p), isMd = /\.md$/i.test(p);
  $('#viewerPreviewBtn').disabled = !(isHtml || isMd);
  $('#viewerSaveBtn').disabled = false; $('#viewerDelBtn').disabled = false;
  if (viewer.preview && (isHtml || isMd)) { $('#viewerFrame').srcdoc = isHtml ? ta.value : wrapDoc(`<div class="md">${renderMarkdown(ta.value)}</div>`); $('#viewerFrame').hidden = false; ta.hidden = true; }
  else { $('#viewerFrame').hidden = true; ta.hidden = false; }
  $('#viewerPreviewBtn').setAttribute('aria-pressed', String(viewer.preview)); $('#viewerPreviewBtn').textContent = viewer.preview ? 'Edit' : 'Preview';
}
function closeViewer() { viewer.path = null; $('#viewerPath').textContent = 'No file selected'; $('#viewerPath').classList.add('muted'); const ta = $('#viewerText'); ta.value = ''; ta.disabled = true; ta.hidden = false; $('#viewerFrame').hidden = true; ['#viewerSaveBtn', '#viewerDelBtn', '#viewerPreviewBtn'].forEach((s) => { $(s).disabled = true; }); }
$('#viewerText').addEventListener('input', () => { viewer.dirty = true; });
$('#viewerText').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#viewerSaveBtn').click(); } });
$('#viewerPreviewBtn').addEventListener('click', () => { viewer.preview = !viewer.preview; if (viewer.dirty) { $('#viewerSaveBtn').click(); } refreshViewer(); });
$('#viewerSaveBtn').addEventListener('click', () => { if (!viewer.path) return; try { snapshots.take(`before manual edit ${viewer.path}`, 'user'); viewer.dirty = false; vfs.write(viewer.path, $('#viewerText').value); log(`saved ${viewer.path}`, 'ok'); toast('Saved ' + viewer.path, 'success', 1500); } catch (e) { toast(e.message, 'error'); } });
$('#viewerDelBtn').addEventListener('click', async () => {
  if (!viewer.path) return; const p = viewer.path;
  const d = engine.autoApprove ? { action: 'approve' } : await hitl.request({ op: 'delete_file', reason: `Deletes ${p}`, payload: { path: p }, source: 'user' });
  if (d.action === 'reject') { toast('Delete rejected', 'warn'); return; }
  const target = d.action === 'edit' && d.payload && d.payload.path ? d.payload.path : p;
  try { snapshots.take(`before delete ${target}`, 'user'); vfs.delete(target, { recursive: true }); log(`deleted ${target}`, 'warn'); toast('Deleted ' + target, 'success'); } catch (e) { toast(e.message, 'error'); }
});
$('#newFileBtn').addEventListener('click', async () => {
  const p = await askInput('New file', 'Path', '/docs/new-file.md'); if (!p) return;
  try { if (vfs.exists(p)) throw new Error('Already exists: ' + vfs.norm(p)); snapshots.take(`before create ${p}`, 'user'); vfs.write(p, ''); openFile(p); selectTab($('#tab-files')); $('#viewerText').focus(); } catch (e) { toast(e.message, 'error'); }
});

/* =====================================================================
 * UI · Terminal drawer
 * ===================================================================== */
function toggleTerminal(force) {
  const t = $('#terminal'); const open = force != null ? force : t.classList.contains('collapsed');
  t.classList.toggle('collapsed', !open); $('#termHead').setAttribute('aria-expanded', String(open)); $('#termChevron').textContent = open ? '▼' : '▲';
  if (open) { renderTrees(); $('#termInput').focus(); const b = $('#termLog'); b.scrollTop = b.scrollHeight; }
}
$('#termHead').addEventListener('click', (e) => { if (!e.target.closest('#termClearBtn')) toggleTerminal(); });
$('#termHead').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTerminal(); } });
$('#termClearBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#termLog').textContent = ''; termLines = 0; $('#termCount').textContent = '0'; });
const termHist = []; let termHistIdx = 0;
$('#termForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#termInput'); const line = inp.value.trim(); inp.value = ''; if (!line) return;
  termHist.push(line); termHistIdx = termHist.length;
  log(line, 'cmd');
  if (line === 'clear') { $('#termClearBtn').click(); return; }
  try {
    if (/^(rm|mv|mkdir|touch|echo\b.*>)/.test(line)) snapshots.take(`before terminal: ${line.slice(0, 60)}`, 'terminal');
    const out = vfs.exec(line); if (out) log(out, 'out');
  } catch (err) { log(err.message, 'err'); }
});
$('#termInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && termHist.length) { e.preventDefault(); termHistIdx = Math.max(0, termHistIdx - 1); e.target.value = termHist[termHistIdx] || ''; }
  if (e.key === 'ArrowDown') { e.preventDefault(); termHistIdx = Math.min(termHist.length, termHistIdx + 1); e.target.value = termHist[termHistIdx] || ''; }
});

/* =====================================================================
 * UI · Artifacts (sandboxed iframe, tabs, versions)
 * ===================================================================== */
let artSourceMode = false;
function wrapDoc(body, extraCss = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:18px;background:#0b0b0b;color:#e6e6e6;font:14px/1.6 'IBM Plex Mono',ui-monospace,monospace}pre{background:#060606;border:1px solid #222;border-radius:8px;padding:12px;overflow:auto;white-space:pre-wrap}code{font-family:inherit}.md h1,.md h2,.md h3{font-family:'Bebas Neue',Impact,sans-serif;letter-spacing:.05em;color:#fff;font-weight:400}.md a{color:#FF4F00}.md blockquote{border-left:3px solid #FF4F00;margin:0;padding-left:10px;color:#999}.md table{border-collapse:collapse}.md td,.md th{border:1px solid #333;padding:4px 8px}.md code{background:#1a1a1a;padding:0 4px;border-radius:4px}.md pre code{background:none}.lang{color:#FF4F00;font-size:11px;text-transform:uppercase;letter-spacing:.1em}${extraCss}</style></head><body>${body}</body></html>`;
}
function artifactDoc(a, content) {
  if (a.type === 'html') return content;
  if (a.type === 'markdown') return wrapDoc(`<div class="md">${renderMarkdown(content)}</div>`);
  return wrapDoc(`<div class="lang">${escapeHtml(a.lang || 'code')} · ${escapeHtml(a.title)}</div><pre><code>${escapeHtml(content)}</code></pre>`);
}
let lastSrcdoc = '';
function renderArtifactView() {
  const a = artifacts.active;
  const tabsBox = $('#artTabs'); tabsBox.textContent = '';
  artifacts.order.forEach((id) => {
    const it = artifacts.items[id];
    const b = document.createElement('button'); b.type = 'button'; b.className = 'art-tab'; b.setAttribute('role', 'tab'); b.dataset.id = id;
    b.setAttribute('aria-selected', String(a && a.id === id)); b.tabIndex = a && a.id === id ? 0 : -1;
    b.innerHTML = `${it.streaming ? '<span class="live">● </span>' : ''}${escapeHtml(it.title)} <span class="dim">${escapeHtml(it.type)} v${it.versions.length}</span>`;
    tabsBox.appendChild(b);
  });
  const vs = $('#artVersion'); vs.textContent = '';
  ['#artVersion', '#artViewBtn', '#artSaveBtn', '#artDelBtn'].forEach((s) => { $(s).disabled = !a; });
  if (!a) { $('#artEmpty').hidden = false; $('#artFrame').hidden = true; $('#artSource').hidden = true; lastSrcdoc = ''; return; }
  a.versions.forEach((v, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `v${i + 1}${v.complete ? '' : i === a.versions.length - 1 && a.streaming ? ' (streaming)' : ' (partial)'} · ${fmtTime(v.ts)}`; vs.appendChild(o); });
  vs.value = a.viewVersion;
  renderArtifactContent();
}
function renderArtifactContent() {
  const a = artifacts.active; if (!a) return;
  const v = a.versions[clamp(a.viewVersion, 0, a.versions.length - 1)]; if (!v) return;
  $('#artEmpty').hidden = true;
  $('#artViewBtn').textContent = artSourceMode ? 'Preview' : 'Source'; $('#artViewBtn').setAttribute('aria-pressed', String(artSourceMode));
  if (artSourceMode) { $('#artFrame').hidden = true; const pre = $('#artSource'); pre.hidden = false; pre.textContent = v.content; return; }
  $('#artSource').hidden = true; $('#artFrame').hidden = false;
  const doc = artifactDoc(a, v.content);
  if (doc !== lastSrcdoc) { lastSrcdoc = doc; $('#artFrame').srcdoc = doc; }
}
const liveArtifactRender = throttle(() => { renderArtifactContent(); }, 280);
artifacts.on('change', renderArtifactView);
artifacts.on('open', () => { selectTab($('#tab-arts')); });
artifacts.on('update', (a) => { if (artifacts.active && artifacts.active.id === a.id && a.viewVersion === a.versions.length - 1) liveArtifactRender(); });
$('#artTabs').addEventListener('click', (e) => { const b = e.target.closest('.art-tab'); if (b) artifacts.setActive(b.dataset.id); });
$('#artTabs').addEventListener('keydown', (e) => { const tabs = $$('.art-tab', $('#artTabs')); const i = tabs.indexOf(document.activeElement); if (i < 0) return; let n = null; if (e.key === 'ArrowRight') n = (i + 1) % tabs.length; if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length; if (n != null) { e.preventDefault(); artifacts.setActive(tabs[n].dataset.id); $$('.art-tab')[n].focus(); } });
$('#artVersion').addEventListener('change', (e) => { const a = artifacts.active; if (a) { a.viewVersion = +e.target.value; artifacts.save(); renderArtifactContent(); } });
$('#artViewBtn').addEventListener('click', () => { artSourceMode = !artSourceMode; lastSrcdoc = ''; renderArtifactContent(); });
$('#artDelBtn').addEventListener('click', () => { const a = artifacts.active; if (a) { artifacts.remove(a.id); toast('Artifact removed', 'success', 1500); } });
$('#artSaveBtn').addEventListener('click', async () => {
  const a = artifacts.active; if (!a) return;
  const ext = a.type === 'html' ? 'html' : a.type === 'markdown' ? 'md' : ({ javascript: 'js', typescript: 'ts', python: 'py', css: 'css', json: 'json' })[a.lang] || 'txt';
  const p = await askInput('Save artifact to VFS', 'Path', `/artifacts/${a.id}.${ext}`); if (!p) return;
  const content = a.versions[a.viewVersion].content;
  if (vfs.isFile(p) && !engine.autoApprove) { const d = await hitl.request({ op: 'write_file', reason: `Overwrites existing file ${vfs.norm(p)}`, payload: { path: p }, source: 'user' }); if (d.action === 'reject') return; }
  try { snapshots.take(`before saving artifact ${a.id}`, 'user'); vfs.write(p, content); toast('Saved to ' + vfs.norm(p), 'success'); } catch (e) { toast(e.message, 'error'); }
});

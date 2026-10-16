
/* =====================================================================
 * UI · Chat / execution stream
 * ===================================================================== */
let chat = Store.get('chat', []); if (!Array.isArray(chat)) chat = [];
let busy = false, runCtrl = null;
const saveChat = () => { if (chat.length > 60) chat = chat.slice(-60); Store.set('chat', chat); };

function formatAssistant(raw) {
  const ph = [];
  const hold = (h) => `\u0003${ph.push(h) - 1}\u0003`;
  const chip = (attrs, live) => { const id = slugify(attrs.id || attrs.title || 'artifact'); return hold(`<button type="button" class="art-chip" data-art="${escapeHtml(id)}">◧ ${escapeHtml(attrs.title || id)} <span class="dim">${escapeHtml(attrs.type || 'code')}</span>${live ? ' <span class="spin" aria-label="streaming"></span>' : ''}</button>`); };
  let s = String(raw);
  s = s.replace(/<artifact\b([^>]*)>[\s\S]*?<\/artifact>/g, (_, a) => '\n' + chip(parseAttrs(a), false) + '\n');
  s = s.replace(/<artifact\b([^>]*)>[\s\S]*$/, (_, a) => '\n' + chip(parseAttrs(a), true) + '\n');
  s = s.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (_, body) => { let n = 'tool'; try { n = JSON.parse(body).name || n; } catch {} return '\n' + hold(`<span class="badge" style="color:var(--accent)">⚙ ${escapeHtml(n)}</span>`) + '\n'; });
  s = s.replace(/<tool_call>[\s\S]*$/, () => '\n' + hold('<span class="badge st-run"><span class="spin"></span> preparing tool call…</span>') + '\n');
  s = s.replace(/<[a-z_]*$/i, (m) => ('<artifact'.startsWith(m) || '<tool_call'.startsWith(m) ? '' : m));
  s = s.replace(/^Thought:/gm, '**Thought:**');
  return renderMarkdown(s).replace(/\u0003(\d+)\u0003/g, (_, i) => ph[+i]);
}

function scrollChat(force) { const b = $('#chatLog'); if (force || b.scrollTop + b.clientHeight >= b.scrollHeight - 80) b.scrollTop = b.scrollHeight; }
function appendUser(text) {
  const d = document.createElement('div'); d.className = 'msg user'; d.textContent = text;
  $('#chatLog').appendChild(d); Anim.in(d, { x: 10, y: 0 }); scrollChat(true);
}
/** Builds an assistant message view. Returns ReAct UI callbacks + a serialisable record. */
function createAssistantView(persona, record) {
  const data = record || { persona, ctx: null, steps: [], provider: null, error: null, note: null };
  const el = document.createElement('div'); el.className = 'msg assistant';
  el.innerHTML = `<div class="who"><span></span><span class="badge prov"></span></div><div class="ctx"></div><div class="steps"></div><div class="foot"></div>`;
  $('.who span', el).textContent = data.persona;
  $('#chatLog').appendChild(el); Anim.in(el);
  const stepEls = [];
  const renderCtx = () => {
    const box = $('.ctx', el); box.textContent = ''; const c = data.ctx; if (!c) return;
    const mk = (label, items) => { const d = document.createElement('details'); const s = document.createElement('summary'); s.textContent = label; d.appendChild(s); const ul = document.createElement('ul'); items.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }); d.appendChild(ul); box.appendChild(d); };
    if (c.memories && c.memories.length) mk(`🧠 ${c.memories.length} memor${c.memories.length === 1 ? 'y' : 'ies'} injected`, c.memories.map((m) => m.text || m));
    if (c.chunks && c.chunks.length) mk(`📚 ${c.chunks.length} knowledge chunk${c.chunks.length === 1 ? '' : 's'}`, c.chunks);
  };
  const ensureStep = (i) => {
    if (stepEls[i]) return stepEls[i];
    const s = document.createElement('div'); s.className = 'step';
    s.innerHTML = `<div class="step-h"><span>Step ${i + 1}</span><span class="spin"></span><span class="sp dim"></span></div><div class="md body"></div><div class="tools"></div>`;
    $('.steps', el).appendChild(s); stepEls[i] = s; return s;
  };
  const renderStepBody = (i) => { const st = data.steps[i]; const s = ensureStep(i); $('.body', s).innerHTML = formatAssistant(st.raw); };
  const throttled = new Map();
  const renderTool = (i, j) => {
    const s = ensureStep(i), t = data.steps[i].tools[j];
    let d = $$('.tool-trace', s)[j];
    if (!d) { d = document.createElement('details'); d.className = 'tool-trace'; d.innerHTML = '<summary></summary><pre class="args"></pre><pre class="obs"></pre>'; $('.tools', s).appendChild(d); }
    const stCls = t.status === 'ok' ? 'st-ok' : t.status === 'running' ? 'st-run' : t.status === 'rejected' ? 'st-warn' : 'st-err';
    const argStr = t.name === 'write_file' ? `${t.args.path || ''} (${String(t.args.content || '').length} bytes)` : t.name === 'execute_command' ? t.args.command : t.name === 'call_api' ? `${t.args.method || 'GET'} ${t.args.url || ''}` : t.args.path || '';
    $('summary', d).innerHTML = `<span class="${stCls}">${t.status === 'running' ? '<span class="spin"></span>' : t.status === 'ok' ? '✓' : t.status === 'rejected' ? '⊘' : '✗'}</span><span class="tname">${escapeHtml(t.name)}</span><span class="muted">${escapeHtml(String(argStr || '').slice(0, 120))}</span>${t.edited ? '<span class="badge st-warn">edited</span>' : ''}`;
    $('.args', d).textContent = 'args: ' + JSON.stringify(t.args, null, 2).slice(0, 3000);
    $('.obs', d).textContent = t.output != null ? 'observation:\n' + t.output : 'running…';
  };
  const ui = {
    context: (ctx) => { data.ctx = { memories: ctx.memories.map((m) => m.text), chunks: ctx.chunks, persona: ctx.persona }; renderCtx(); },
    stepStart: (i) => { data.steps[i] = { raw: '', tools: [], provider: null }; const s = ensureStep(i); stepEls.forEach((x) => x.classList.remove('active')); s.classList.add('active'); scrollChat(); },
    stepDelta: (i, raw) => { data.steps[i].raw = raw; if (!throttled.has(i)) throttled.set(i, rafThrottle(() => { renderStepBody(i); scrollChat(); })); throttled.get(i)(); },
    stepReset: (i) => { data.steps[i].raw = ''; renderStepBody(i); $('.sp', ensureStep(i)).textContent = 'retrying…'; },
    stepEnd: (i, raw, info) => {
      data.steps[i].raw = raw; data.steps[i].provider = info.provider; renderStepBody(i);
      const s = ensureStep(i); const sp = $('.spin', s); sp && sp.remove(); $('.sp', s).textContent = info.provider ? `via ${info.provider}` : '';
      if (info.provider) { data.provider = info.provider; $('.prov', el).textContent = info.provider; }
    },
    tool: (i, call, r) => {
      const tools = data.steps[i].tools;
      if (!r) { tools.push({ name: call.name, args: call.args || {}, status: 'running', output: null }); renderTool(i, tools.length - 1); scrollChat(); return; }
      const t = tools[tools.length - 1]; Object.assign(t, { status: r.rejected ? 'rejected' : r.ok ? 'ok' : 'error', output: r.output, edited: !!r.edited, args: r.args || t.args });
      renderTool(i, tools.length - 1); scrollChat();
    },
  };
  const finish = (res) => { stepEls.forEach((x) => x.classList.remove('active')); if (res && res.final && !data.steps.some((s) => s.raw === res.final)) { data.note = res.final; const n = document.createElement('div'); n.className = 'md'; n.innerHTML = renderMarkdown(res.final); $('.foot', el).appendChild(n); } $$('.step-h .spin', el).forEach((x) => x.remove()); };
  const fail = (msg) => { data.error = msg; const n = document.createElement('div'); n.className = 'st-err'; n.style.marginTop = '6px'; n.textContent = '✗ ' + msg; $('.foot', el).appendChild(n); finish(); };
  if (record) { // re-hydrate from storage
    renderCtx(); if (data.provider) $('.prov', el).textContent = data.provider;
    data.steps.forEach((st, i) => { ensureStep(i); renderStepBody(i); const sp = $('.spin', stepEls[i]); sp && sp.remove(); $('.sp', stepEls[i]).textContent = st.provider ? `via ${st.provider}` : ''; st.tools.forEach((_, j) => renderTool(i, j)); });
    if (data.note) { const n = document.createElement('div'); n.className = 'md'; n.innerHTML = renderMarkdown(data.note); $('.foot', el).appendChild(n); }
    if (data.error) { const n = document.createElement('div'); n.className = 'st-err'; n.textContent = '✗ ' + data.error; $('.foot', el).appendChild(n); }
  }
  return { ui, data, finish, fail, el };
}
function renderChatHistory() {
  $('#chatLog').textContent = '';
  if (!chat.length) {
    const d = document.createElement('div'); d.className = 'msg assistant';
    d.innerHTML = `<div class="who">AGENT STUDIO</div><div class="md">${renderMarkdown('Welcome! This workspace combines **personas**, **memory**, live **artifacts**, a **ReAct coding agent** over a virtual file system, and a **background task scheduler** with human approval.\n\nNo API key? Everything runs on the deterministic **offline mock engine** — try one of the example prompts below. Add keys via the **Router** button to stream from Gemini, Groq, Cerebras, OpenRouter (:free) or Mistral with automatic failover.')}</div>`;
    $('#chatLog').appendChild(d);
  }
  chat.forEach((m) => { if (m.role === 'user') appendUser(m.content); else createAssistantView(m.view?.persona || 'Agent', m.view || { persona: 'Agent', steps: [{ raw: m.content, tools: [] }] }); });
  scrollChat(true);
}
function setBusy(b) { busy = b; $('#sendBtn').disabled = b; $('#stopBtn').disabled = !b; $('#chatInput').setAttribute('aria-busy', String(b)); }
function historyForLLM() {
  return chat.slice(-10).map((m) => ({ role: m.role, content: String(m.content || '').replace(/(<artifact\b[^>]*>)([\s\S]*?)(<\/artifact>)/g, (_, o, body, c) => o + (body.length > 1200 ? body.slice(0, 1200) + '\n…[truncated]' : body) + c).slice(0, 4000) })).filter((m) => m.content);
}
async function sendMessage(text) {
  text = String(text || '').trim();
  if (!text) return;
  if (busy) { toast('The agent is still working — press Stop to cancel', 'warn'); return; }
  const history = historyForLLM();
  if (!chat.length) $('#chatLog').textContent = '';
  chat.push({ role: 'user', content: text }); saveChat();
  appendUser(text);
  setBusy(true); runCtrl = new AbortController();
  const view = createAssistantView(personas.selected.name);
  try {
    const res = await engine.run({ input: text, history, ui: view.ui, signal: runCtrl.signal });
    view.finish(res);
    chat.push({ role: 'assistant', content: res.final, view: view.data }); saveChat();
    engine.extractMemories(text, res.final).then((added) => { if (added.length) toast(`🧠 Remembered ${added.length} new fact${added.length > 1 ? 's' : ''}`, 'success', 2500); }).catch((e) => log('[memory] ' + e.message, 'err'));
  } catch (e) {
    if (e.name === 'AbortError') { view.fail('Stopped by user'); log('[chat] run aborted', 'warn'); }
    else { view.fail(e.message); toast(e.message, 'error'); log('[chat] ' + e.message, 'err'); }
    chat.push({ role: 'assistant', content: view.data.steps.map((s) => s.raw).join('\n') || '(no response)', view: view.data }); saveChat();
  } finally { setBusy(false); runCtrl = null; }
}
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); const t = $('#chatInput').value; $('#chatInput').value = ''; sendMessage(t); });
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#stopBtn').addEventListener('click', () => { if (runCtrl) runCtrl.abort(); });
$$('.hints [data-prompt]').forEach((b) => b.addEventListener('click', () => { if (busy) { toast('Agent is busy', 'warn'); return; } sendMessage(b.dataset.prompt); }));
$('#chatLog').addEventListener('click', (e) => { const c = e.target.closest('.art-chip'); if (c) { if (artifacts.items[c.dataset.art]) { artifacts.setActive(c.dataset.art); selectTab($('#tab-arts')); } else toast('Artifact no longer exists', 'warn'); } });
$('#clearChatBtn').addEventListener('click', () => { if (busy) { toast('Stop the current run first', 'warn'); return; } chat = []; saveChat(); renderChatHistory(); });

/* =====================================================================
 * UI · Tasks, scheduler, snapshots
 * ===================================================================== */
function renderTasks() {
  const list = $('#taskList'); list.textContent = '';
  if (!tasks.tasks.length) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = 'No tasks yet. Decompose a goal or add tasks manually, then run the scheduler.'; list.appendChild(d); }
  tasks.tasks.forEach((t, idx) => {
    const d = document.createElement('div'); d.className = 'task'; d.dataset.id = t.id;
    const deps = t.dependencies.map((id) => { const dt = tasks.get(id); return dt ? `#${tasks.tasks.indexOf(dt) + 1}` : '?'; }).join(', ');
    d.innerHTML = `<div><span class="dim">#${idx + 1}</span> <span class="t"></span></div>
      <div class="actions"><span class="badge s-${t.status}">${t.status === 'running' ? '<span class="spin"></span> ' : ''}${escapeHtml(t.status)}</span>
        ${['failed', 'rejected', 'blocked', 'done'].includes(t.status) ? '<button class="btn sm" data-act="retry">Retry</button>' : ''}
        ${t.status === 'running' ? '<button class="btn sm danger" data-act="stop">Stop</button>' : '<button class="btn sm danger" data-act="del" aria-label="Delete task">✕</button>'}</div>
      <div class="meta"><div>deps: ${escapeHtml(deps || 'none')} · criteria: <span class="crit"></span></div><div class="note"></div>
      <details><summary>log (${t.log.length})${t.result ? ' · result' : ''}</summary><pre style="white-space:pre-wrap;margin:4px 0" class="tlog"></pre></details></div>`;
    $('.t', d).textContent = t.task;
    $('.crit', d).textContent = t.acceptance_criteria || '—';
    $('.note', d).textContent = t.note ? '↳ ' + t.note : '';
    $('.tlog', d).textContent = t.log.join('\n') + (t.result ? `\n\nRESULT: ${t.result}` : '');
    list.appendChild(d);
  });
  const sel = $('#tfDeps'); const prev = new Set($$('option:checked', sel).map((o) => o.value)); sel.textContent = '';
  tasks.tasks.forEach((t, i) => { const o = document.createElement('option'); o.value = t.id; o.textContent = `#${i + 1} ${t.task.slice(0, 60)}`; o.selected = prev.has(t.id); sel.appendChild(o); });
}
const renderTasksThrottled = rafThrottle(renderTasks);
tasks.on('change', renderTasksThrottled);
tasks.on('state', (s) => { $('#schedState').textContent = s; $('#schedStartBtn').disabled = s === 'running'; $('#schedPauseBtn').disabled = s !== 'running'; if (s === 'idle') toast('Scheduler idle — queue drained', 'success', 2500); });
tasks.on('finished', (t) => toast(`Task ${t.status}: ${t.task.slice(0, 50)}`, t.status === 'done' ? 'success' : t.status === 'rejected' ? 'warn' : 'error', 2500));
$('#taskList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return; const id = b.closest('.task').dataset.id;
  try { if (b.dataset.act === 'retry') tasks.retry(id); if (b.dataset.act === 'del') tasks.remove(id); if (b.dataset.act === 'stop') tasks.stopCurrent(); } catch (err) { toast(err.message, 'error'); }
});
$('#taskForm').addEventListener('submit', (e) => {
  e.preventDefault();
  try { tasks.add({ task: $('#tfTask').value, acceptance_criteria: $('#tfCriteria').value, dependencies: $$('#tfDeps option:checked').map((o) => o.value) }); $('#tfTask').value = ''; $('#tfCriteria').value = ''; toast('Task added', 'success', 1500); } catch (err) { toast(err.message, 'error'); }
});
$('#schedStartBtn').addEventListener('click', () => { tasks.start(); log('[scheduler] started', 'sys'); });
$('#schedPauseBtn').addEventListener('click', () => { tasks.pause(); log('[scheduler] pausing after current task', 'sys'); });
$('#clearTasksBtn').addEventListener('click', () => { try { if (!tasks.tasks.length) return; snapshots.take('before clearing tasks', 'user'); tasks.clear(); } catch (err) { toast(err.message, 'error'); } });
$('#decomposeBtn').addEventListener('click', async () => {
  const goal = $('#goalInput').value.trim(); if (!goal) { toast('Enter a goal first', 'warn'); $('#goalInput').focus(); return; }
  const b = $('#decomposeBtn'); b.disabled = true; b.textContent = 'Planning…';
  try { const list = await engine.decompose(goal); tasks.addMany(list); $('#goalInput').value = ''; toast(`Goal decomposed into ${list.length} tasks`, 'success'); log(`[planner] ${list.length} tasks for "${goal}"`, 'ok'); }
  catch (err) { toast('Decomposition failed: ' + err.message, 'error'); }
  finally { b.disabled = false; b.textContent = 'Decompose'; }
});
$('#goalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#decomposeBtn').click(); } });

function renderSnapshots() {
  const box = $('#snapList'); box.textContent = '';
  $('#snapCount').textContent = snapshots.items.length;
  if (!snapshots.items.length) { const d = document.createElement('div'); d.className = 'muted'; d.textContent = 'Snapshots of VFS + tasks + memory + artifacts are recorded before every tool execution and task run.'; box.appendChild(d); return; }
  [...snapshots.items].reverse().forEach((s) => {
    const d = document.createElement('div'); d.className = 'snap';
    d.innerHTML = `<div><div class="lbl"></div><div class="dim" style="font-size:10.5px">${escapeHtml(fmtTime(s.ts))} · ${escapeHtml(s.source)} · ${s.state.vfs ? s.state.vfs.nodes.length : 0} nodes</div></div><button class="btn sm" data-id="${escapeHtml(s.id)}">Restore</button>`;
    $('.lbl', d).textContent = s.label;
    box.appendChild(d);
  });
}
function guardRestore() { if (busy || tasks.current) { toast('Stop the running agent/task before rolling back', 'error'); return false; } return true; }
$('#snapList').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (!b || !guardRestore()) return; try { const s = snapshots.restore(b.dataset.id); toast(`Rolled back to: ${s.label}`, 'success'); log(`[snapshot] restored "${s.label}"`, 'sys'); } catch (err) { toast(err.message, 'error'); } });
$('#undoBtn').addEventListener('click', () => { if (!guardRestore()) return; try { const s = snapshots.undo(); toast(`Undone: ${s.label}`, 'success'); log(`[snapshot] undo → "${s.label}"`, 'sys'); } catch (err) { toast(err.message, 'error'); } });
snapshots.on('change', renderSnapshots);

/* =====================================================================
 * UI · Settings, export / import
 * ===================================================================== */
$('#maxStepsInput').value = engine.maxSteps;
$('#maxStepsInput').addEventListener('change', (e) => { engine.maxSteps = clamp(parseInt(e.target.value, 10) || 6, 1, 20); e.target.value = engine.maxSteps; Store.set('maxSteps', engine.maxSteps); });
$('#autoApprove').checked = engine.autoApprove;
$('#autoApprove').addEventListener('change', (e) => { engine.autoApprove = e.target.checked; Store.set('autoApprove', engine.autoApprove); toast(e.target.checked ? 'Auto-approve ON — high-risk operations run without review' : 'Human-in-the-Loop approvals enabled', e.target.checked ? 'warn' : 'success'); });

function exportState() {
  const routerCfg = {}; for (const p in router.cfg) routerCfg[p] = { enabled: router.cfg[p].enabled, model: router.cfg[p].model }; // keys deliberately excluded
  return { app: 'agent-studio', version: 1, exportedAt: new Date().toISOString(), personas: personas.items, selectedPersona: personas.selectedId, memory: memory.facts, vfs: vfs.toJSON(), tasks: tasks.toJSON(), artifacts: artifacts.toJSON(), snapshots: snapshots.items, chat, router: { order: router.order, providers: routerCfg }, settings: { maxSteps: engine.maxSteps, autoApprove: engine.autoApprove, mockDelay: mock.delay } };
}
function importState(data) {
  if (!data || data.app !== 'agent-studio') throw new Error('Not an Agent Studio export file');
  if (busy || tasks.current) throw new Error('Stop running work before importing');
  snapshots.take('before import', 'import');
  if (Array.isArray(data.personas) && data.personas.length) { personas.items = data.personas.filter((p) => p && p.id && p.name).map((p) => ({ id: String(p.id), name: String(p.name), system_prompt: String(p.system_prompt || ''), knowledge_snippets: String(p.knowledge_snippets || '') })); if (!personas.items.length) personas.items = deepClone(DEFAULT_PERSONAS); personas.selectedId = personas.get(data.selectedPersona) ? data.selectedPersona : personas.items[0].id; personas.save(); }
  if (Array.isArray(data.memory)) { memory.facts = data.memory.filter((f) => f && f.text).map((f) => ({ id: f.id || uid('mem'), text: String(f.text), source: f.source || 'import', created: f.created || Date.now(), updated: f.updated || Date.now() })); memory.save(); }
  if (data.vfs) vfs.load(data.vfs);
  if (data.tasks) tasks.load(data.tasks);
  if (data.artifacts) artifacts.load(data.artifacts);
  if (Array.isArray(data.snapshots)) { snapshots.items = data.snapshots.filter((s) => s && s.id && s.state).concat(snapshots.items.slice(-1)); snapshots.save(); }
  if (Array.isArray(data.chat)) { chat = data.chat.filter((m) => m && (m.role === 'user' || m.role === 'assistant')); saveChat(); renderChatHistory(); }
  if (data.router && Array.isArray(data.router.order)) { const ord = data.router.order.filter((p) => PROVIDERS[p]); Object.keys(PROVIDERS).forEach((p) => { if (!ord.includes(p)) ord.push(p); }); router.order = ord; for (const p in data.router.providers || {}) if (router.cfg[p]) { router.cfg[p].enabled = data.router.providers[p].enabled !== false; router.cfg[p].model = data.router.providers[p].model || router.cfg[p].model; } router.save(); }
  if (data.settings) { engine.maxSteps = clamp(+data.settings.maxSteps || 6, 1, 20); Store.set('maxSteps', engine.maxSteps); $('#maxStepsInput').value = engine.maxSteps; engine.autoApprove = !!data.settings.autoApprove; Store.set('autoApprove', engine.autoApprove); $('#autoApprove').checked = engine.autoApprove; }
}
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(exportState(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `agent-studio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('State exported (API keys excluded)', 'success');
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { importState(JSON.parse(await f.text())); toast('State imported (snapshot taken first)', 'success'); } catch (err) { toast('Import failed: ' + err.message, 'error'); }
});

/* =====================================================================
 * BOOT
 * ===================================================================== */
renderPersonaSelect(); renderRouterStatus(); renderMemory(); renderTrees(); renderArtifactView(); renderTasks(); renderSnapshots(); renderChatHistory();
$('#termCwd').textContent = vfs.cwd + ' $';
$('#schedState').textContent = 'idle';
engine.on('retry', (r) => toast(`Retrying (attempt ${r.attempt + 1}) in ${r.wait}ms: ${r.error}`, 'warn', 2500));
tasks.on('error', ({ task, error }) => toast(`Task failed: ${task.task.slice(0, 40)} — ${error.message}`, 'error'));
log('Agent Studio ready. Type `help` for VFS commands.', 'sys');
log(router.configured() ? `[router] priority: ${router.order.join(' → ')} → mock` : '[router] no API keys configured — offline mock engine active', 'sys');
window.addEventListener('load', () => { if (!window.gsap) log('[ui] GSAP unavailable — animations disabled (graceful fallback)', 'dim'); else Anim.in($('header.top'), { y: -10 }); });

/* Public handle for debugging / automated tests (no secrets exposed). */
window.AgentStudio = Object.freeze({ vfs, memory, personas, artifacts, router, mock, engine, tasks, snapshots, hitl, sendMessage, exportState, importState, SSEParser, ArtifactParser, parseToolCalls, renderMarkdown, tfidfRank, parseResetValue, cooldownFromHeaders, providerStream, get busy() { return busy; } });
})();
</script>
</body>
</html>

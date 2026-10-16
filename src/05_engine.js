
/* =====================================================================
 * SECTION 6 — MARKDOWN RENDERER (escape-first, XSS-safe)
 * ===================================================================== */
function safeUrl(u) {
  const raw = String(u).replace(/&amp;/g, '&').trim();
  if (/^(https?:|mailto:|#|\/(?!\/))/i.test(raw) || !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return escapeHtml(raw);
  return '#';
}
function renderInline(text) {
  // text is RAW (unescaped). Handle backslash escapes + inline code first via placeholders.
  const ph = [];
  const hold = (html) => `\u0002${ph.push(html) - 1}\u0002`;
  let s = String(text).replace(/\\([\\`*_\[\]#>-])/g, (_, c) => hold(escapeHtml(c)));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${escapeHtml(c)}</code>`));
  s = escapeHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">[image: ${alt}]</a>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0002(\d+)\u0002/g, (_, i) => ph[+i]);
}
function renderMarkdown(src) {
  const blocks = [];
  let text = String(src || '').replace(/\r\n?/g, '\n');
  // fenced code (also an unterminated trailing fence while streaming)
  text = text.replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$(?![\s\S]))/g, (_, lang, code) => `\n\u0001${blocks.push(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`) - 1}\u0001\n`);
  const lines = text.split('\n');
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(renderInline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${renderInline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\u0001(\d+)\u0001$/))) { flushPara(); flushList(); out.push(blocks[+m[1]]); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); const l = Math.min(m[1].length, 4); out.push(`<h${l}>${renderInline(m[2])}</h${l}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); const q = [m[1]]; while (i + 1 < lines.length && /^>/.test(lines[i + 1])) q.push(lines[++i].replace(/^>\s?/, '')); out.push(`<blockquote>${q.map(renderInline).join('<br>')}</blockquote>`); continue; }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line); i++;
      const rows = []; while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if ((m = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/))) {
      flushPara();
      const type = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push(m[2]); continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('\n');
}

/* =====================================================================
 * SECTION 7 — ARTIFACT PARSER (incremental) + ARTIFACT STORE
 * ===================================================================== */
const ART_TYPES = { html: 'html', code: 'code', markdown: 'markdown', md: 'markdown', text: 'markdown' };
function parseAttrs(tag) { const a = {}; tag.replace(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, v1, v2) => { a[k.toLowerCase()] = v1 ?? v2; }); return a; }
class ArtifactParser {
  constructor({ onOpen, onUpdate, onClose }) { this.h = { onOpen, onUpdate, onClose }; this.buf = ''; this.cur = null; this.count = 0; }
  get open() { return !!this.cur; }
  feed(delta) {
    this.buf += delta;
    for (let guard = 0; guard < 1000; guard++) {
      if (!this.cur) {
        const idx = this.buf.indexOf('<artifact');
        if (idx < 0) { const lt = this.buf.lastIndexOf('<'); this.buf = lt >= 0 && '<artifact'.startsWith(this.buf.slice(lt, lt + 9)) ? this.buf.slice(lt) : ''; return; }
        const end = this.buf.indexOf('>', idx);
        if (end < 0) { this.buf = this.buf.slice(idx); return; }
        const after = this.buf[idx + 9];
        if (after && !/[\s>]/.test(after)) { this.buf = this.buf.slice(idx + 9); continue; }
        const attrs = parseAttrs(this.buf.slice(idx + 9, end));
        this.count++;
        this.cur = { id: slugify(attrs.id || attrs.title || `artifact-${this.count}`), type: ART_TYPES[(attrs.type || 'code').toLowerCase()] || 'code', title: attrs.title || attrs.id || `Artifact ${this.count}`, lang: attrs.lang || attrs.language || '', content: '' };
        this.h.onOpen && this.h.onOpen(this.cur);
        this.buf = this.buf.slice(end + 1).replace(/^\n/, '');
      } else {
        const ci = this.buf.indexOf('</artifact>');
        if (ci >= 0) {
          this.cur.content += this.buf.slice(0, ci);
          this.cur.content = this.cur.content.replace(/\n$/, '');
          this.h.onUpdate && this.h.onUpdate(this.cur);
          this.h.onClose && this.h.onClose(this.cur, true);
          this.cur = null; this.buf = this.buf.slice(ci + 11); continue;
        }
        let hold = 0;
        for (let k = Math.min(10, this.buf.length); k > 0; k--) if ('</artifact>'.startsWith(this.buf.slice(-k))) { hold = k; break; }
        const safe = this.buf.slice(0, this.buf.length - hold);
        if (safe) { this.cur.content += safe; this.h.onUpdate && this.h.onUpdate(this.cur); }
        this.buf = this.buf.slice(this.buf.length - hold);
        return;
      }
    }
  }
  end() { if (this.cur) { this.cur.content += this.buf; this.buf = ''; this.h.onUpdate && this.h.onUpdate(this.cur); this.h.onClose && this.h.onClose(this.cur, false); this.cur = null; } }
}

class ArtifactStore extends Emitter {
  constructor() { super(); const s = Store.get('artifacts', {}); this.items = s.items || {}; this.order = (s.order || []).filter((id) => this.items[id]); this.activeId = s.activeId && this.items[s.activeId] ? s.activeId : this.order[this.order.length - 1] || null; this.persist = throttle(() => this.save(), 500); }
  save() { Store.set('artifacts', { items: this.items, order: this.order, activeId: this.activeId }); }
  open({ id, type, title, lang }) {
    let a = this.items[id];
    if (!a) { a = this.items[id] = { id, type, title, lang, versions: [], viewVersion: 0 }; this.order.push(id); }
    a.type = type; a.title = title; a.lang = lang || a.lang;
    a.versions.push({ content: '', ts: Date.now(), complete: false });
    if (a.versions.length > 20) a.versions.shift();
    a.viewVersion = a.versions.length - 1; a.streaming = true;
    this.activeId = id;
    this.emit('open', a); this.emit('change');
    return a;
  }
  update(id, content) { const a = this.items[id]; if (!a) return; a.versions[a.versions.length - 1].content = content; this.emit('update', a); }
  close(id, complete) { const a = this.items[id]; if (!a) return; a.streaming = false; a.versions[a.versions.length - 1].complete = complete; this.emit('update', a); this.emit('change'); this.persist(); }
  remove(id) { delete this.items[id]; this.order = this.order.filter((x) => x !== id); if (this.activeId === id) this.activeId = this.order[this.order.length - 1] || null; this.save(); this.emit('change'); }
  setActive(id) { if (this.items[id]) { this.activeId = id; this.save(); this.emit('change'); } }
  get active() { return this.activeId ? this.items[this.activeId] : null; }
  toJSON() { return { items: this.items, order: this.order, activeId: this.activeId }; }
  load(s) { this.items = (s && s.items) || {}; this.order = ((s && s.order) || []).filter((id) => this.items[id]); this.activeId = s && s.activeId && this.items[s.activeId] ? s.activeId : this.order[0] || null; Object.values(this.items).forEach((a) => { a.streaming = false; }); this.save(); this.emit('change'); }
}

/* =====================================================================
 * SECTION 8 — TOOL CALL PROTOCOL + SNAPSHOTS
 * ===================================================================== */
const TOOL_NAMES = ['read_file', 'write_file', 'execute_command', 'call_api'];
function parseToolCalls(text) {
  const calls = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g; let m;
  while ((m = re.exec(text))) {
    const raw = m[1].trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    let obj = null, error = null;
    try { obj = JSON.parse(raw); }
    catch (e) {
      try { obj = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch { error = 'Invalid JSON in tool call: ' + e.message; }
    }
    if (obj && !error) {
      const name = obj.name || obj.tool || obj.function;
      const args = obj.args || obj.arguments || obj.parameters || obj.input || {};
      if (!TOOL_NAMES.includes(name)) error = `Unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}`;
      calls.push({ name: String(name), args: typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return { value: args }; } })() : args, raw, error });
    } else calls.push({ name: 'invalid', args: {}, raw, error });
  }
  return calls;
}

class SnapshotLog extends Emitter {
  constructor(getState, setState) { super(); this.getState = getState; this.setState = setState; this.items = Store.get('snapshots', []); if (!Array.isArray(this.items)) this.items = []; this.max = 40; }
  save() {
    while (!Store.set('snapshots', this.items) && this.items.length > 5) this.items.splice(0, Math.ceil(this.items.length / 3));
    this.emit('change');
  }
  take(label, source = 'user') {
    const snap = { id: uid('snap'), ts: Date.now(), label: String(label).slice(0, 140), source, state: deepClone(this.getState()) };
    this.items.push(snap);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    this.save();
    return snap;
  }
  restore(id) {
    const s = this.items.find((x) => x.id === id);
    if (!s) throw new Error('Snapshot not found');
    this.take(`before rollback to "${s.label}"`, 'rollback');
    this.setState(deepClone(s.state));
    this.emit('restored', s);
    return s;
  }
  undo() { const cand = [...this.items].reverse().find((x) => x.source !== 'rollback'); if (!cand) throw new Error('Nothing to undo'); return this.restore(cand.id); }
  clear() { this.items = []; this.save(); }
}

/* =====================================================================
 * SECTION 9 — ReAct ENGINE
 * ===================================================================== */
const TOOL_PROTOCOL = `## Tools (ReAct protocol)
You operate in a multi-step ReAct loop over an in-memory virtual file system (VFS).
On each turn: write a brief line starting with "Thought:", then, if you need to act, emit ONE tool call and STOP generating:
<tool_call>{"name":"<tool>","args":{...}}</tool_call>
Available tools:
- read_file {"path": "/abs/path"} → file content
- write_file {"path": "/abs/path", "content": "..."} → writes (creates parent dirs). Overwrites need human approval.
- execute_command {"command": "ls -l /project"} → VFS shell: ls [-l], cat, echo (> / >>), mkdir [-p], rm [-r], tree, pwd, cd, mv, touch
- call_api {"method": "POST", "url": "https://...", "body": {...}} → simulated external HTTP call; always requires human approval
The tool call body MUST be valid JSON (escape newlines and quotes in strings).
After each tool call you receive <observation>...</observation>. Continue until the task is done, then give your final answer WITHOUT any tool call.
If an observation says REJECTED, do not retry that operation.

## Artifacts
For substantial deliverables (web pages, components, code files, documents) wrap the content in:
<artifact type="html|code|markdown" id="kebab-case-id" title="Human title">...content...</artifact>
HTML artifacts must be complete standalone documents (inline CSS/JS). Reuse the same id to publish a new version.`;

class ReActEngine extends Emitter {
  constructor(ctx) { super(); Object.assign(this, ctx); this.maxSteps = Store.get('maxSteps', 6); this.autoApprove = Store.get('autoApprove', false); this.retries = 3; this.backoffBase = 600; }
  buildSystem(query, { taskMode = false } = {}) {
    const p = this.personas.selected;
    const chunks = this.personas.relevantChunks(query);
    const memories = this.memory.search(query, 5);
    let sys = `## Persona: ${p.name}\n${p.system_prompt}\n`;
    if (chunks.length) sys += `\n<knowledge>\n${chunks.map((c) => '- ' + c.replace(/\n/g, ' ')).join('\n')}\n</knowledge>\n`;
    if (memories.length) sys += `\n<memory>\n${memories.map((m) => '- ' + m.text).join('\n')}\n</memory>\nUse <memory> facts about the user to personalise your answer when relevant.\n`;
    sys += `\n${TOOL_PROTOCOL}\n`;
    if (taskMode) sys += `\n## Background task mode\nYou are executing a scheduled background task. Satisfy the acceptance criteria exactly, keep prose minimal, and finish with a one-line summary.\n`;
    sys += `\nCurrent VFS tree:\n${this.vfs.tree('/').split('\n').slice(0, 60).join('\n')}\n`;
    return { system: sys, ctx: { memories, chunks, persona: p.name } };
  }
  /** LLM call with retry + exponential backoff (router handles provider failover inside each attempt). */
  async callLLM({ system, messages, mode = 'react', onToken, onReset, signal, label = 'llm', onEvent }) {
    let lastErr;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        return await this.router.stream({ system, messages, mode, onToken, signal, onEvent: (ev) => { this.logRouterEvent(ev, label); onEvent && onEvent(ev); } });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        if (!e.retryable || attempt === this.retries - 1) break;
        const wait = this.backoffBase * 2 ** attempt;
        this.log(`[${label}] attempt ${attempt + 1} failed: ${e.message} — retrying in ${wait}ms`, 'warn');
        this.emit('retry', { attempt: attempt + 1, wait, error: e.message });
        onReset && onReset();
        await sleep(wait, signal);
      }
    }
    throw lastErr;
  }
  logRouterEvent(ev, label) {
    if (ev.type === 'try') this.log(`[router] ${label}: trying ${ev.provider} (key ${ev.key}/${ev.keys}, ${ev.model})`, 'sys');
    else if (ev.type === 'fail') this.log(`[router] ${ev.provider} key ${ev.key} failed (${ev.status || 'network'}): ${ev.error}${ev.cooldownMs ? ` — cooldown ${Math.round(ev.cooldownMs / 1000)}s` : ''}`, 'warn');
    else if (ev.type === 'skip') this.log(`[router] skip ${ev.provider}: ${ev.reason}`, 'dim');
    else if (ev.type === 'backoff') this.log(`[router] all providers busy — backing off ${ev.ms}ms`, 'warn');
    else if (ev.type === 'mock') this.log(`[router] using offline mock engine (${ev.reason})`, 'sys');
  }
  assessRisk(call) {
    const a = call.args || {};
    if (call.name === 'write_file' && a.path && this.vfs.isFile(a.path)) return `Overwrites existing file ${this.vfs.norm(a.path)} (${this.vfs.read(a.path).length} bytes)`;
    if (call.name === 'execute_command') return this.vfs.assessCommand(String(a.command || ''));
    if (call.name === 'call_api') return `External API payload: ${String(a.method || 'GET').toUpperCase()} ${a.url || '(no url)'}`;
    return null;
  }
  async executeTool(call, { source = 'chat', signal } = {}) {
    if (call.error) return { ok: false, output: `ERROR: ${call.error}` };
    let args = call.args || {};
    const risk = this.assessRisk(call);
    let edited = false;
    if (risk && !this.autoApprove) {
      this.log(`[hitl] approval requested: ${call.name} — ${risk}`, 'warn');
      const decision = await this.hitl.request({ op: call.name, reason: risk, payload: args, source, signal });
      if (decision.action === 'reject') { this.log(`[hitl] REJECTED ${call.name}`, 'err'); return { ok: false, rejected: true, output: `REJECTED: the human reviewer rejected this ${call.name} operation.` }; }
      if (decision.action === 'edit') { args = decision.payload; edited = true; this.log(`[hitl] approved with edits: ${JSON.stringify(args).slice(0, 200)}`, 'ok'); }
      else this.log(`[hitl] approved ${call.name}`, 'ok');
    }
    this.snapshots.take(`before ${call.name} ${(args.path || args.command || args.url || '').toString().slice(0, 80)}`, source);
    try {
      let out;
      switch (call.name) {
        case 'read_file': if (!args.path) throw new Error('read_file requires "path"'); out = this.vfs.read(args.path); break;
        case 'write_file': { if (!args.path) throw new Error('write_file requires "path"'); const c = String(args.content ?? ''); const p = this.vfs.write(args.path, c); out = `Wrote ${c.length} bytes to ${p}`; break; }
        case 'execute_command': { const cmd = String(args.command || ''); this.log(cmd, 'cmd'); out = this.vfs.exec(cmd) || '(no output)'; break; }
        case 'call_api': {
          const body = args.body ?? null;
          const resp = { status: 200, ok: true, id: 'req_' + hashStr(JSON.stringify(args)).toString(36), method: String(args.method || 'GET').toUpperCase(), url: String(args.url || ''), received: body, simulated: true };
          await sleep(120, signal);
          out = JSON.stringify(resp, null, 2); break;
        }
        default: throw new Error('Unknown tool ' + call.name);
      }
      out = String(out);
      if (out.length > 6000) out = out.slice(0, 6000) + `\n…[truncated ${out.length - 6000} chars]`;
      this.log(`[tool] ${call.name} ✓ ${out.split('\n')[0].slice(0, 160)}`, 'tool');
      return { ok: true, output: out, edited, args };
    } catch (e) {
      this.log(`[tool] ${call.name} ✗ ${e.message}`, 'err');
      return { ok: false, output: `ERROR: ${e.message}`, args };
    }
  }
  /**
   * Run a multi-step ReAct loop.
   * ui callbacks: context(ctx), stepStart(i), stepDelta(i, raw), stepReset(i), stepEnd(i, raw, info), tool(i, call, result|null)
   */
  async run({ input, history = [], ui = {}, signal, source = 'chat', taskMode = false, stopOnReject = false, maxSteps = this.maxSteps }) {
    const noop = () => {};
    const U = Object.assign({ context: noop, stepStart: noop, stepDelta: noop, stepReset: noop, stepEnd: noop, tool: noop }, ui);
    const { system, ctx } = this.buildSystem(input, { taskMode });
    U.context(ctx);
    const messages = [...history, { role: 'user', content: input }];
    const result = { final: '', steps: 0, rejected: false, toolsUsed: 0, provider: null };
    for (let step = 0; step < maxSteps; step++) {
      if (signal && signal.aborted) throw abortError();
      result.steps = step + 1;
      U.stepStart(step);
      let raw = '';
      const local = new AbortController();
      const onOuterAbort = () => local.abort();
      if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });
      let parser;
      const resetParser = () => {
        parser = new ArtifactParser({
          onOpen: (a) => this.artifacts.open(a),
          onUpdate: (a) => this.artifacts.update(a.id, a.content),
          onClose: (a, complete) => this.artifacts.close(a.id, complete),
        });
      };
      resetParser();
      let stoppedForTool = false;
      let res;
      try {
        res = await this.callLLM({
          system, messages, mode: 'react', signal: local.signal, label: `${source} step ${step + 1}`,
          onReset: () => { if (parser.open) parser.end(); raw = ''; resetParser(); U.stepReset(step); },
          onToken: (d) => {
            raw += d; parser.feed(d); U.stepDelta(step, raw);
            if (!parser.open && raw.includes('</tool_call>') && !stoppedForTool) { stoppedForTool = true; local.abort(); }
          },
        });
      } catch (e) {
        if (!(e.name === 'AbortError' && stoppedForTool && !(signal && signal.aborted))) { parser.end(); if (signal) signal.removeEventListener('abort', onOuterAbort); throw e; }
      }
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      parser.end();
      if (res) result.provider = res.provider;
      const lastClose = raw.lastIndexOf('</tool_call>');
      if (lastClose >= 0) raw = raw.slice(0, lastClose + 12);
      const calls = parseToolCalls(raw);
      U.stepEnd(step, raw, { provider: result.provider || (stoppedForTool ? this.router.active : null), calls: calls.length });
      messages.push({ role: 'assistant', content: raw });
      if (!calls.length) { result.final = raw; break; }
      const obs = [];
      for (const call of calls) {
        U.tool(step, call, null);
        const r = await this.executeTool(call, { source, signal });
        result.toolsUsed++;
        U.tool(step, call, r);
        obs.push(`[${call.name}] ${r.ok ? 'OK' : r.rejected ? 'REJECTED' : 'ERROR'}\n${r.output}`);
        if (r.rejected) result.rejected = true;
      }
      messages.push({ role: 'user', content: `<observation>\n${obs.join('\n\n')}\n</observation>` });
      if (result.rejected && stopOnReject) { result.final = 'Stopped: operation rejected by reviewer.'; break; }
      if (step === maxSteps - 1) result.final = `Reached the maximum of ${maxSteps} steps. Last observation:\n\n\`\`\`\n${obs.join('\n').slice(0, 800)}\n\`\`\``;
    }
    return result;
  }
  /** Asynchronous memory extraction after a response (LLM-backed, heuristic fallback). */
  async extractMemories(userText, assistantText) {
    let facts = [];
    try {
      const prompt = `Extract durable facts or preferences about the USER from this exchange (name, preferences, tools, projects, constraints). Return ONLY a JSON array of short third-person strings, or [] if none.\n\nUSER: ${userText}\nASSISTANT: ${String(assistantText).replace(/<artifact[\s\S]*?<\/artifact>/g, '[artifact]').slice(0, 1500)}`;
      const res = await this.router.stream({ system: 'You extract user memories as strict JSON arrays.', messages: [{ role: 'user', content: prompt }], mode: 'extract', onToken: () => {}, onEvent: () => {} });
      const m = res.text.match(/\[[\s\S]*\]/);
      if (m) facts = JSON.parse(m[0]).filter((x) => typeof x === 'string');
    } catch (e) { this.log(`[memory] LLM extraction failed (${e.message}); using heuristic`, 'warn'); }
    if (!facts.length) facts = MemoryStore.heuristicExtract(userText);
    const added = facts.map((f) => this.memory.add(f, 'auto')).filter(Boolean);
    if (added.length) this.log(`[memory] extracted ${added.length} fact(s): ${added.map((a) => a.text).join(' | ')}`, 'ok');
    return added;
  }
  async decompose(goal, signal) {
    const prompt = `Decompose the goal into 3-6 concrete tasks executable by an agent with VFS tools. Return ONLY a JSON array of objects: {"task": string, "dependencies": [indices of earlier tasks], "acceptance_criteria": string}. Prefer acceptance criteria that name a file path that must exist.\n\nGOAL: ${goal}`;
    const res = await this.callLLM({ system: 'You are a planning module that outputs strict JSON.', messages: [{ role: 'user', content: prompt }], mode: 'decompose', onToken: () => {}, signal, label: 'decompose' });
    const m = res.text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('Planner did not return a JSON array');
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.length) throw new Error('Planner returned no tasks');
    return arr.map((t) => ({ task: String(t.task || t.title || 'Untitled task'), dependencies: (t.dependencies || []).map(Number).filter((n) => Number.isInteger(n)), acceptance_criteria: String(t.acceptance_criteria || t.criteria || '') }));
  }
}

/* =====================================================================
 * SECTION 10 — TASK QUEUE (Meta Muse scheduler)
 * ===================================================================== */
const TASK_STATUSES = ['pending', 'running', 'blocked', 'done', 'failed', 'rejected'];
class TaskQueue extends Emitter {
  constructor(engine, snapshots, vfs) {
    super(); this.engine = engine; this.snapshots = snapshots; this.vfs = vfs;
    this.tasks = Store.get('tasks', []); if (!Array.isArray(this.tasks)) this.tasks = [];
    this.tasks.forEach((t) => { if (t.status === 'running') t.status = 'pending'; });
    this.running = false; this.current = null; this.ctrl = null; this.tickMs = 300;
  }
  save() { Store.set('tasks', this.tasks); this.emit('change'); }
  get(id) { return this.tasks.find((t) => t.id === id); }
  add({ task, dependencies = [], acceptance_criteria = '' }) {
    const t = { id: uid('task'), task: String(task).trim(), dependencies: dependencies.filter((d) => this.get(d)), status: 'pending', acceptance_criteria: String(acceptance_criteria).trim(), result: '', log: [], created: Date.now(), attempts: 0 };
    if (!t.task) throw new Error('Task description is required');
    this.tasks.push(t); this.refresh(); this.save(); return t;
  }
  addMany(list) { const ids = []; list.forEach((t) => { const deps = (t.dependencies || []).map((i) => ids[i]).filter(Boolean); ids.push(this.add({ ...t, dependencies: deps }).id); }); return ids; }
  remove(id) { if (this.current === id) throw new Error('Cannot remove a running task'); this.tasks = this.tasks.filter((t) => t.id !== id); this.tasks.forEach((t) => { t.dependencies = t.dependencies.filter((d) => d !== id); }); this.refresh(); this.save(); }
  clear() { if (this.current) throw new Error('Pause the scheduler first'); this.tasks = []; this.save(); }
  retry(id) { const t = this.get(id); if (!t || t.status === 'running') return; t.status = 'pending'; t.result = ''; t.note = ''; this.refresh(); this.save(); }
  hasCycle(id, seen = new Set()) { if (seen.has(id)) return true; seen.add(id); const t = this.get(id); return !!t && t.dependencies.some((d) => this.hasCycle(d, new Set(seen))); }
  /** Recompute blocked/pending based on dependency state. */
  refresh() {
    let changed = true, guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      for (const t of this.tasks) {
        if (!['pending', 'blocked'].includes(t.status)) continue;
        let blocked = null;
        if (this.hasCycle(t.id)) blocked = 'dependency cycle';
        else for (const d of t.dependencies) { const dt = this.get(d); if (!dt) continue; if (['failed', 'rejected', 'blocked'].includes(dt.status)) { blocked = `dependency "${dt.task.slice(0, 40)}" is ${dt.status}`; break; } }
        const next = blocked ? 'blocked' : 'pending';
        if (t.status !== next || (t.note || '') !== (blocked || '')) { t.status = next; t.note = blocked || ''; changed = true; }
      }
    }
  }
  ready() { return this.tasks.find((t) => t.status === 'pending' && t.dependencies.every((d) => (this.get(d) || { status: 'done' }).status === 'done')); }
  start() { if (this.running) return; this.running = true; this.emit('state', 'running'); this.loop(); }
  pause() { this.running = false; this.emit('state', this.current ? 'pausing' : 'paused'); }
  stopCurrent() { if (this.ctrl) this.ctrl.abort(); }
  async loop() {
    while (this.running) {
      this.refresh();
      const t = this.ready();
      if (!t) {
        const waiting = this.tasks.some((x) => x.status === 'pending');
        if (!waiting) { this.running = false; this.save(); this.emit('state', 'idle'); this.emit('drained'); return; }
        await sleep(this.tickMs); continue;
      }
      await this.runTask(t);
      await sleep(this.tickMs);
    }
    this.emit('state', 'paused');
  }
  async runTask(t) {
    this.current = t.id; t.status = 'running'; t.attempts++; t.startedAt = Date.now(); t.log = [];
    this.save();
    this.snapshots.take(`before task "${t.task.slice(0, 60)}"`, 'task');
    const L = (msg) => { t.log.push(`${fmtTime(Date.now())} ${msg}`); if (t.log.length > 60) t.log.shift(); this.emit('change'); };
    L('started');
    this.engine.log(`[task] ▶ ${t.task}`, 'sys');
    this.ctrl = new AbortController();
    try {
      const deps = t.dependencies.map((d) => this.get(d)).filter(Boolean).map((d) => `- ${d.task}: ${String(d.result).slice(0, 160)}`).join('\n');
      const input = `[TASK] Task: ${t.task}\nAcceptance criteria: ${t.acceptance_criteria || 'n/a'}\n${deps ? `Completed dependencies:\n${deps}\n` : ''}`;
      const res = await this.engine.run({
        input, source: `task:${t.id}`, taskMode: true, stopOnReject: true, signal: this.ctrl.signal,
        ui: {
          stepStart: (i) => L(`step ${i + 1}`),
          stepEnd: (i, raw) => { const th = (raw.match(/Thought:\s*(.+)/) || [])[1]; if (th) L(`thought: ${th.slice(0, 140)}`); },
          tool: (i, call, r) => { if (r) L(`${call.name} → ${r.rejected ? 'REJECTED' : r.ok ? 'ok' : 'error'}: ${r.output.split('\n')[0].slice(0, 120)}`); },
        },
      });
      t.result = res.final.replace(/<[^>]+>/g, '').trim().slice(0, 600);
      if (res.rejected) { t.status = 'rejected'; L('rejected by reviewer'); }
      else {
        const verdict = this.checkAcceptance(t, res);
        t.status = verdict.ok ? 'done' : 'failed';
        t.note = verdict.reason;
        L(`acceptance: ${verdict.ok ? 'PASS' : 'FAIL'} — ${verdict.reason}`);
      }
    } catch (e) {
      t.status = e.name === 'AbortError' ? 'pending' : 'failed';
      t.note = e.name === 'AbortError' ? 'interrupted' : e.message;
      L(`${t.status}: ${t.note}`);
      if (e.name !== 'AbortError') this.emit('error', { task: t, error: e });
    } finally {
      t.finishedAt = Date.now(); this.current = null; this.ctrl = null;
      this.engine.log(`[task] ${t.status.toUpperCase()} ${t.task}`, t.status === 'done' ? 'ok' : 'err');
      this.refresh(); this.save();
      this.emit('finished', t);
    }
  }
  checkAcceptance(t, res) {
    const crit = t.acceptance_criteria || '';
    const paths = crit.match(/\/[\w./-]+\.\w+|\/[\w-]+(?:\/[\w.-]+)+/g) || [];
    if (paths.length) {
      const missing = paths.filter((p) => !this.vfs.exists(p));
      return missing.length ? { ok: false, reason: `missing: ${missing.join(', ')}` } : { ok: true, reason: `verified ${paths.join(', ')} exist` };
    }
    if (/approv/i.test(crit) && res.toolsUsed === 0) return { ok: false, reason: 'no approved operation was executed' };
    return res.final.trim() ? { ok: true, reason: 'completed with a final answer' } : { ok: false, reason: 'empty result' };
  }
  toJSON() { return this.tasks; }
  load(arr) { this.tasks = Array.isArray(arr) ? arr.filter((t) => t && t.id && t.task).map((t) => ({ ...t, status: TASK_STATUSES.includes(t.status) && t.status !== 'running' ? t.status : 'pending', dependencies: Array.isArray(t.dependencies) ? t.dependencies : [], log: Array.isArray(t.log) ? t.log : [] })) : []; this.refresh(); this.save(); }
}

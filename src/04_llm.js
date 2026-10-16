
/* =====================================================================
 * SECTION 5 — LLM CLIENT: SSE PARSER, PROVIDERS, ROUTER, MOCK ENGINE
 * ===================================================================== */

/** Browser-native incremental Server-Sent-Events parser (handles CRLF, multi-line data, comments, split chunks). */
class SSEParser {
  constructor() { this.buf = ''; this.data = []; this.event = ''; }
  feed(chunk) {
    this.buf += chunk;
    const events = [];
    let nl;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const sepLen = this.buf[nl] === '\r' && this.buf[nl + 1] === '\n' ? 2 : 1;
      if (this.buf[nl] === '\r' && nl + 1 === this.buf.length) break; // wait: CR may be followed by LF in next chunk
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + sepLen);
      this._line(line, events);
    }
    return events;
  }
  _line(line, events) {
    if (line === '') { if (this.data.length) events.push({ event: this.event || 'message', data: this.data.join('\n') }); this.data = []; this.event = ''; return; }
    if (line.startsWith(':')) return;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let val = i < 0 ? '' : line.slice(i + 1); if (val.startsWith(' ')) val = val.slice(1);
    if (field === 'data') this.data.push(val); else if (field === 'event') this.event = val;
  }
  flush() { const ev = []; if (this.buf) { this._line(this.buf, ev); this.buf = ''; } this._line('', ev); return ev; }
}

class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.name = 'HttpError'; this.status = status; this.headers = headers; this.retryable = status === 429 || status >= 500; }
}

/** Parse rate-limit/Retry-After style header values to milliseconds-from-now. */
function parseResetValue(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (n > 1e12) return Math.max(0, n - now);          // epoch ms
    if (n > 1e9) return Math.max(0, n * 1000 - now);    // epoch seconds
    return n * 1000;                                      // seconds
  }
  const dur = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (dur && dur.slice(1).some(Boolean)) return ((+dur[1] || 0) * 3600 + (+dur[2] || 0) * 60 + (+dur[3] || 0)) * 1000 + (+dur[4] || 0);
  const date = Date.parse(s);
  if (!isNaN(date)) return Math.max(0, date - now);
  return null;
}
function cooldownFromHeaders(headers, status) {
  if (!headers || typeof headers.get !== 'function') return null;
  const ra = parseResetValue(headers.get('retry-after'));
  if (ra != null) return ra;
  const remainingReq = headers.get('x-ratelimit-remaining-requests') ?? headers.get('x-ratelimit-remaining');
  const remainingTok = headers.get('x-ratelimit-remaining-tokens');
  const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset', 'x-ratelimit-reset-requests-minute', 'x-ratelimit-reset-tokens-minute', 'x-ratelimit-reset-requests-day']
    .map((h) => parseResetValue(headers.get(h))).filter((x) => x != null);
  if (status === 429) return resets.length ? Math.max(...resets) : null;
  if (remainingReq === '0' || remainingTok === '0') return resets.length ? Math.max(...resets) : null;
  return null;
}

const PROVIDERS = {
  gemini: { label: 'Gemini', kind: 'gemini', defaultModel: 'gemini-1.5-flash', url: (m, k) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(k)}` },
  groq: { label: 'Groq', kind: 'openai', defaultModel: 'llama-3.3-70b-versatile', url: () => 'https://api.groq.com/openai/v1/chat/completions' },
  cerebras: { label: 'Cerebras', kind: 'openai', defaultModel: 'llama3.1-8b', url: () => 'https://api.cerebras.ai/v1/chat/completions' },
  openrouter: { label: 'OpenRouter', kind: 'openai', defaultModel: 'meta-llama/llama-3.3-70b-instruct:free', freeOnly: true, url: () => 'https://openrouter.ai/api/v1/chat/completions', extraHeaders: () => ({ 'HTTP-Referer': location.origin && location.origin !== 'null' ? location.origin : 'https://agent-studio.local', 'X-Title': 'Agent Studio' }) },
  mistral: { label: 'Mistral', kind: 'openai', defaultModel: 'mistral-small-latest', url: () => 'https://api.mistral.ai/v1/chat/completions' },
};

async function readSSE(res, onData, signal) {
  const parser = new SSEParser();
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    for (const ev of [...parser.feed(text), ...parser.flush()]) if (onData(ev.data) === false) return;
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      if (signal && signal.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(dec.decode(value, { stream: true }))) if (onData(ev.data) === false) return;
    }
    for (const ev of [...parser.feed(dec.decode()), ...parser.flush()]) if (onData(ev.data) === false) return;
  } finally { try { reader.releaseLock(); } catch {} }
}

/** One streaming request to one provider with one key. Resolves with { text, headers }. */
async function providerStream(pid, key, model, { system, messages, onToken, signal, temperature = 0.4 }) {
  const P = PROVIDERS[pid];
  let url, body, headers = { 'Content-Type': 'application/json' };
  if (P.kind === 'gemini') {
    const contents = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      if (contents.length && contents[contents.length - 1].role === role) contents[contents.length - 1].parts[0].text += '\n\n' + m.content;
      else contents.push({ role, parts: [{ text: m.content }] });
    }
    url = P.url(model, key);
    body = { contents, systemInstruction: { parts: [{ text: system }] }, generationConfig: { temperature } };
  } else {
    url = P.url(model, key);
    headers.Authorization = 'Bearer ' + key;
    if (P.extraHeaders) Object.assign(headers, P.extraHeaders());
    body = { model, stream: true, temperature, messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))] };
  }
  let res;
  try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal }); }
  catch (e) { if (e.name === 'AbortError') throw e; const err = new Error(`Network error: ${e.message}`); err.retryable = true; err.network = true; throw err; }
  if (!res.ok) {
    let detail = ''; try { detail = (await res.text()).slice(0, 300); } catch {}
    try { const j = JSON.parse(detail); detail = (j.error && (j.error.message || j.error)) || j.message || detail; } catch {}
    throw new HttpError(res.status, `${P.label} HTTP ${res.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, res.headers);
  }
  let text = '';
  let streamErr = null;
  await readSSE(res, (data) => {
    if (data === '[DONE]') return false;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) { streamErr = new HttpError(j.error.code && +j.error.code >= 400 ? +j.error.code : 500, `${P.label} stream error: ${j.error.message || JSON.stringify(j.error)}`, res.headers); return false; }
    let delta = '';
    if (P.kind === 'gemini') delta = (((j.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || '').join('') || '';
    else delta = (((j.choices || [])[0] || {}).delta || {}).content || '';
    if (delta) { text += delta; onToken(delta); }
  }, signal);
  if (streamErr) { streamErr.partial = text.length > 0; throw streamErr; }
  return { text, headers: res.headers };
}

/* ------------------------- Provider Router ------------------------- */
class ProviderRouter extends Emitter {
  constructor(mock) {
    super();
    this.mock = mock;
    const saved = Store.get('router', {});
    this.order = Array.isArray(saved.order) ? saved.order.filter((p) => PROVIDERS[p]) : [];
    Object.keys(PROVIDERS).forEach((p) => { if (!this.order.includes(p)) this.order.push(p); });
    this.cfg = {};
    for (const p of Object.keys(PROVIDERS)) {
      const c = (saved.providers || {})[p] || {};
      this.cfg[p] = { enabled: c.enabled !== false, keys: Array.isArray(c.keys) ? c.keys.filter(Boolean) : [], model: c.model || PROVIDERS[p].defaultModel };
    }
    this.state = {}; // runtime: cooldownUntil, keyIdx, keyCooldowns, lastError, ok, fail
    for (const p of Object.keys(PROVIDERS)) this.state[p] = { cooldownUntil: 0, keyIdx: 0, keyCooldowns: {}, lastError: '', ok: 0, fail: 0, lastUsed: 0 };
    const persisted = Store.get('router.cooldowns', {});
    for (const p in persisted) if (this.state[p]) { this.state[p].cooldownUntil = persisted[p].cooldownUntil || 0; this.state[p].keyCooldowns = persisted[p].keyCooldowns || {}; this.state[p].keyIdx = persisted[p].keyIdx || 0; }
    this.active = 'mock';
    this.forceMock = !!saved.forceMock;
    this.maxPasses = 2;
    this.sleep = sleep; // overridable in tests
  }
  save() { Store.set('router', { order: this.order, providers: this.cfg, forceMock: this.forceMock }); this.emit('status'); }
  saveCooldowns() { const o = {}; for (const p in this.state) o[p] = { cooldownUntil: this.state[p].cooldownUntil, keyCooldowns: this.state[p].keyCooldowns, keyIdx: this.state[p].keyIdx }; Store.set('router.cooldowns', o); }
  move(pid, dir) { const i = this.order.indexOf(pid), j = i + dir; if (i < 0 || j < 0 || j >= this.order.length) return; [this.order[i], this.order[j]] = [this.order[j], this.order[i]]; this.save(); }
  setKeys(pid, keys) { this.cfg[pid].keys = [...new Set(keys.map((k) => k.trim()).filter(Boolean))]; this.state[pid].keyIdx = 0; this.save(); }
  keyId(key) { return 'k' + hashStr(key).toString(36); }
  configured() { return !this.forceMock && this.order.some((p) => this.cfg[p].enabled && this.cfg[p].keys.length); }
  resetCooldowns(pid) { const ids = pid ? [pid] : Object.keys(this.state); ids.forEach((p) => { this.state[p].cooldownUntil = 0; this.state[p].keyCooldowns = {}; this.state[p].lastError = ''; }); this.saveCooldowns(); this.emit('status'); }
  providerStatus(pid, now = Date.now()) {
    const c = this.cfg[pid], s = this.state[pid];
    if (!c.enabled) return { code: 'disabled', text: 'disabled' };
    if (!c.keys.length) return { code: 'nokey', text: 'no key' };
    if (PROVIDERS[pid].freeOnly && !/:free$/.test(c.model)) return { code: 'error', text: 'model must end with :free' };
    if (s.cooldownUntil > now) return { code: 'cooldown', text: `cooldown ${Math.ceil((s.cooldownUntil - now) / 1000)}s` };
    const avail = c.keys.filter((k) => !(s.keyCooldowns[this.keyId(k)] > now)).length;
    if (!avail) return { code: 'cooldown', text: 'all keys cooling' };
    return { code: 'ready', text: `ready · ${avail}/${c.keys.length} keys` };
  }
  _coolKey(pid, key, ms, reason) {
    const s = this.state[pid];
    s.keyCooldowns[this.keyId(key)] = Date.now() + ms;
    const now = Date.now();
    const keys = this.cfg[pid].keys;
    const remaining = keys.map((k) => s.keyCooldowns[this.keyId(k)] || 0).filter((t) => t > now);
    if (remaining.length === keys.length) s.cooldownUntil = Math.min(...remaining);
    s.lastError = reason;
  }
  /**
   * Stream through providers in priority order with key rotation and failover.
   * Returns { text, provider, model }. Falls back to the offline mock engine as final resort.
   */
  async stream(opts) {
    const { signal, onToken, onEvent = () => {} } = opts;
    if (!this.configured()) return this._mock(opts, 'no providers configured');
    const errors = [];
    for (let pass = 0; pass < this.maxPasses; pass++) {
      let attempted = 0, minWait = Infinity;
      for (const pid of this.order) {
        const c = this.cfg[pid], s = this.state[pid], P = PROVIDERS[pid];
        if (!c.enabled || !c.keys.length) continue;
        if (P.freeOnly && !/:free$/.test(c.model)) { errors.push(`${pid}: model "${c.model}" is not a :free model`); continue; }
        const now = Date.now();
        if (s.cooldownUntil > now) { minWait = Math.min(minWait, s.cooldownUntil - now); onEvent({ type: 'skip', provider: pid, reason: `cooldown ${Math.ceil((s.cooldownUntil - now) / 1000)}s` }); continue; }
        const startIdx = s.keyIdx % c.keys.length;
        for (let k = 0; k < c.keys.length; k++) {
          const idx = (startIdx + k) % c.keys.length;
          const key = c.keys[idx];
          const kc = s.keyCooldowns[this.keyId(key)] || 0;
          if (kc > Date.now()) { minWait = Math.min(minWait, kc - Date.now()); continue; }
          attempted++;
          let emitted = false;
          this.active = pid; this.emit('status');
          onEvent({ type: 'try', provider: pid, key: idx + 1, keys: c.keys.length, model: c.model });
          try {
            const res = await providerStream(pid, key, c.model, { ...opts, onToken: (d) => { emitted = true; onToken(d); } });
            s.ok++; s.lastUsed = Date.now(); s.lastError = ''; s.keyIdx = idx; s.cooldownUntil = 0;
            const pre = cooldownFromHeaders(res.headers, 200); // proactive: remaining == 0
            if (pre) { this._coolKey(pid, key, pre, 'rate limit exhausted (proactive)'); s.keyIdx = (idx + 1) % c.keys.length; }
            this.saveCooldowns(); this.emit('status');
            return { text: res.text, provider: pid, model: c.model };
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            s.fail++;
            const status = e.status || 0;
            const fromHeaders = cooldownFromHeaders(e.headers, status);
            let reason = e.message;
            if (status === 429) this._coolKey(pid, key, fromHeaders ?? 60000, `429 rate limited`);
            else if (status === 401 || status === 403) this._coolKey(pid, key, 10 * 60000, `${status} auth error`);
            else if (status >= 500 || e.network) { s.cooldownUntil = Date.now() + (fromHeaders ?? 15000); s.lastError = reason; }
            else { s.lastError = reason; }
            s.keyIdx = (idx + 1) % c.keys.length; // round-robin rotation on failure
            errors.push(`${pid}#${idx + 1}: ${reason}`);
            onEvent({ type: 'fail', provider: pid, key: idx + 1, status, error: reason, cooldownMs: fromHeaders });
            this.saveCooldowns(); this.emit('status');
            if (emitted || e.partial) { const err = new Error(`${P.label} stream interrupted: ${reason}`); err.retryable = true; err.partial = true; throw err; }
            if (status >= 500 || e.network || (status && status !== 429 && status !== 401 && status !== 403)) break; // provider-level problem → next provider
            // 429/401/403 → try next key of same provider
          }
          if (this.state[pid].cooldownUntil > Date.now()) break;
        }
      }
      if (pass < this.maxPasses - 1) {
        const wait = isFinite(minWait) ? Math.min(minWait, 8000) : (attempted ? 1000 * (pass + 1) : 0);
        if (!attempted && !isFinite(minWait)) break;
        if (wait > 0) { onEvent({ type: 'backoff', ms: wait }); await this.sleep(wait, signal); }
      }
    }
    return this._mock(opts, 'all providers failed: ' + errors.slice(-4).join(' | '));
  }
  async _mock(opts, reason) {
    this.active = 'mock'; this.emit('status');
    (opts.onEvent || (() => {}))({ type: 'mock', reason });
    const text = await this.mock.stream(opts);
    return { text, provider: 'mock', model: 'mock-engine', reason };
  }
}

/* ------------------------- Mock Engine (offline) ------------------------- */
class MockEngine {
  constructor() { this.delay = Store.get('mock.delay', 6); this.flakySeen = new Set(); }
  async stream({ system = '', messages = [], mode = 'react', onToken, signal }) {
    const text = this.generate({ system, messages, mode });
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('<observation'));
    const key = lastUser ? lastUser.content : '';
    if (mode === 'react' && /\bflaky\b/i.test(key) && !this.flakySeen.has(key)) {
      this.flakySeen.add(key);
      await sleep(this.delay * 10, signal);
      const e = new Error('Mock transient error: 503 Service Unavailable (simulated)'); e.retryable = true; e.status = 503; throw e;
    }
    const rnd = prng(hashStr(text));
    let i = 0;
    while (i < text.length) {
      if (signal && signal.aborted) throw abortError();
      const n = 3 + Math.floor(rnd() * 12);
      onToken(text.slice(i, i + n));
      i += n;
      if (this.delay > 0) await sleep(this.delay, signal); else await Promise.resolve();
    }
    return text;
  }
  generate({ system, messages, mode }) {
    const last = messages[messages.length - 1]?.content || '';
    if (mode === 'extract') {
      const m = last.match(/USER:\s*([\s\S]*?)\nASSISTANT:/);
      return JSON.stringify(MemoryStore.heuristicExtract(m ? m[1] : last));
    }
    if (mode === 'decompose') return this.decompose(last.replace(/^[\s\S]*?GOAL:\s*/, '').trim());
    // ReAct mode
    let ui = messages.length - 1;
    while (ui >= 0 && (messages[ui].role !== 'user' || messages[ui].content.startsWith('<observation'))) ui--;
    const original = ui >= 0 ? messages[ui].content : '';
    const obs = messages.slice(ui + 1).filter((m) => m.role === 'user' && m.content.startsWith('<observation'));
    const step = obs.length;
    const lastObs = obs.length ? obs[obs.length - 1].content.replace(/<\/?observation>/g, '').trim() : '';
    const persona = (system.match(/## Persona: (.+)/) || [, 'Agent'])[1].trim();
    const mem = (system.match(/<memory>\n([\s\S]*?)\n<\/memory>/) || [, ''])[1].split('\n').map((s) => s.replace(/^- /, '').trim()).filter(Boolean);
    const memLine = mem.length ? `\n\n> 🧠 Recalled from memory: ${mem.slice(0, 2).join('; ')}` : '';
    const rejected = /REJECTED/.test(lastObs);
    const tc = (name, args) => `<tool_call>${JSON.stringify({ name, args })}</tool_call>`;
    const q = original.toLowerCase();

    if (original.startsWith('[TASK]')) return this.taskScript(original, step, lastObs, tc, rejected);

    let scenario = 'chat';
    if (/\b(my name is|i prefer|remember that|call me|i like|i work)\b/.test(q)) scenario = 'chat';
    else if (/\b(delete|remove|clean ?up|wipe)\b/.test(q)) scenario = 'delete';
    else if (/\b(deploy|webhook|publish|notify|external api|api call|call the api)\b/.test(q)) scenario = 'api';
    else if (/\b(landing|website|web ?page|page|html|site)\b/.test(q)) scenario = 'build';
    else if (/\b(function|code|script|algorithm|debounce|class|python|javascript|typescript)\b/.test(q)) scenario = 'code';
    else if (/\b(file|files|explore|readme|tree|list|workspace|read)\b/.test(q)) scenario = 'files';
    else if (/\bflaky\b/.test(q)) scenario = 'files';

    if (rejected) return `Thought: The operation was rejected by the human reviewer, so I will not retry it.\n\nUnderstood — I've left the workspace unchanged. Let me know if you'd like a different approach.${memLine}`;

    if (scenario === 'build') {
      const name = (original.match(/(?:called|named)\s+["“]?([A-Z][\w&' -]{1,40}?)["”]?(?:[.,!?]|$)/) || original.match(/for (?:an? )?([\w&' -]{3,40}?)(?:[.,!?]|$)/i) || [, 'Nova'])[1].trim();
      const html = this.landingHtml(name);
      if (step === 0) return `Thought: As ${persona}, I'll design a standalone landing page for **${escapeMd(name)}**, stream it as a live artifact, then persist it to the VFS.\n\n<artifact type="html" id="landing-page" title="${name.replace(/"/g, '')} — Landing">\n${html}\n</artifact>\n\nSaving the page into the workspace.\n${tc('write_file', { path: '/project/index.html', content: html })}`;
      if (step === 1) return `Thought: The file is written. Let me verify the project directory contents.\n${tc('execute_command', { command: 'ls -l /project' })}`;
      return `Done! The landing page for **${escapeMd(name)}** is live in the workspace preview and saved at \`/project/index.html\`.\n\n<artifact type="markdown" id="build-notes" title="Build Notes">\n# Build Notes — ${escapeMd(name)}\n\n## What was built\n- Responsive hero with call-to-action\n- Feature grid (3 cards) and footer\n- Dark theme with **#FF4F00** accent\n\n## Files\n| Path | Purpose |\n|---|---|\n| \`/project/index.html\` | Standalone page |\n\n## Verification\n\`\`\`\n${lastObs.slice(0, 400)}\n\`\`\`\n\n> Ask me again to publish a new **version** of the artifact.\n</artifact>${memLine}`;
    }
    if (scenario === 'code') {
      const code = `/**\n * debounce — delay invoking fn until wait ms have elapsed since the last call.\n * @param {Function} fn\n * @param {number} wait\n * @returns {Function & {cancel: Function}}\n */\nexport function debounce(fn, wait = 200) {\n  let timer = null;\n  const debounced = function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), wait);\n  };\n  debounced.cancel = () => clearTimeout(timer);\n  return debounced;\n}\n\n// Usage example\nconst log = debounce((msg) => console.log(msg), 300);\nlog('a'); log('b'); // only 'b' is logged after 300ms\n`;
      if (step === 0) return `Thought: I'll write a small, well-documented \`debounce\` utility and save it to /src.\n\n<artifact type="code" id="debounce-js" title="debounce.js" lang="javascript">\n${code}</artifact>\n\n${tc('write_file', { path: '/src/debounce.js', content: code })}`;
      if (step === 1) return `Thought: Let me read it back to confirm the write succeeded.\n${tc('read_file', { path: '/src/debounce.js' })}`;
      return `The \`debounce\` helper is saved at \`/src/debounce.js\` (${code.length} bytes) and verified by reading it back.\n\n- Supports \`this\` binding and arguments\n- Exposes \`.cancel()\`\n- Includes a usage example${memLine}`;
    }
    if (scenario === 'files') {
      if (step === 0) return `Thought: First I'll look at the overall structure of the workspace.\n${tc('execute_command', { command: 'tree /' })}`;
      if (step === 1) return `Thought: There is a README at the root; reading it will explain the layout.\n${tc('read_file', { path: '/README.md' })}`;
      return `Here's a summary of the workspace:\n\n<artifact type="markdown" id="workspace-summary" title="Workspace Summary">\n# Workspace Summary\n\n${lastObs.split('\n').filter((l) => /^- /.test(l)).join('\n') || '- (README had no bullet list)'}\n\n**Tip:** open the terminal drawer (Ctrl + backtick) to run \`ls\`, \`cat\`, \`tree\` directly.\n</artifact>\n\nThe README describes ${lastObs.split('\n').filter((l) => /^- /.test(l)).length} top-level areas.${memLine}`;
    }
    if (scenario === 'delete') {
      if (step === 0) return `Thought: The user wants to clean up temporary files. Deleting is destructive, so this will require approval.\n${tc('execute_command', { command: 'rm -r /tmp' })}`;
      return `Cleanup complete:\n\n\`\`\`\n${lastObs}\n\`\`\`\nA snapshot was taken before deletion — use **Undo** in the Snapshots panel to roll back.${memLine}`;
    }
    if (scenario === 'api') {
      if (step === 0) return `Thought: Deploying requires an external API call. I'll prepare the payload; a human must approve it.\n${tc('call_api', { method: 'POST', url: 'https://api.example.com/v1/deployments', body: { project: 'agent-studio', entry: '/project/index.html', environment: 'production' } })}`;
      return `Deployment request accepted by the (simulated) external API:\n\n\`\`\`json\n${lastObs}\n\`\`\`${memLine}`;
    }
    // chat
    const facts = MemoryStore.heuristicExtract(original);
    return `Hi! I'm **${escapeMd(persona)}**, running on the offline mock engine (add API keys in **Providers** to use Gemini, Groq, Cerebras, OpenRouter or Mistral).\n\n${facts.length ? `I noted the following and will remember it:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` : ''}Try asking me to:\n- **build a landing page** → live HTML artifact + \`write_file\`\n- **write code** → code artifact + read-back verification\n- **explore files** → \`tree\` / \`read_file\` ReAct loop\n- **delete temp files** or **deploy via API** → Human-in-the-Loop approval${memLine}`;
  }
  taskScript(original, step, lastObs, tc, rejected) {
    const task = (original.match(/Task:\s*(.+)/) || [, 'task'])[1].trim();
    const criteria = (original.match(/Acceptance criteria:\s*(.+)/) || [, ''])[1].trim();
    const pathM = (criteria + ' ' + task).match(/\/[\w./-]+\.\w+/);
    const path = pathM ? pathM[0] : `/tasks/${slugify(task)}.md`;
    const t = task.toLowerCase();
    if (rejected) return `Task halted: the operation was rejected by the reviewer.`;
    if (/\b(publish|deploy|external api|notify|webhook)\b/.test(t)) {
      if (step === 0) return `Thought: This task needs an external API call; requesting approval.\n${tc('call_api', { method: 'POST', url: 'https://api.example.com/v1/publish', body: { task, artifact: path } })}`;
      return `Task complete — external API responded: ${lastObs.slice(0, 160)}`;
    }
    if (/\b(delete|remove|clean)\b/.test(t)) {
      const target = (task.match(/\/[\w./-]+/) || ['/tmp'])[0];
      if (step === 0) return `Thought: Removing ${target} as requested (requires approval).\n${tc('execute_command', { command: `rm -r ${target}` })}`;
      return `Task complete: ${lastObs}`;
    }
    if (step === 0) {
      let content;
      if (/\.html$/.test(path)) content = `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(task)}</title><link rel="stylesheet" href="styles.css"></head>\n<body><main><h1>${escapeHtml(task)}</h1><p>Generated by the background scheduler.</p></main></body></html>\n`;
      else if (/\.css$/.test(path)) content = `:root{--bg:#080808;--accent:#FF4F00}\nbody{margin:0;background:var(--bg);color:#eee;font-family:'IBM Plex Mono',monospace}\nh1{color:var(--accent);font-family:'Bebas Neue',sans-serif;letter-spacing:.05em}\n`;
      else if (/\.(js|ts)$/.test(path)) content = `// ${task}\nexport function main() {\n  return 'ok';\n}\n`;
      else content = `# ${task}\n\n## Acceptance criteria\n- ${criteria || 'n/a'}\n\n## Plan\n1. Analyse requirements\n2. Implement\n3. Verify\n`;
      return `Thought: I'll produce ${path} to satisfy: "${criteria || task}".\n${tc('write_file', { path, content })}`;
    }
    return `Task complete. ${path} written; acceptance criteria satisfied: ${criteria || '(none specified)'}.`;
  }
  decompose(goal) {
    const g = goal.replace(/[\n"]/g, ' ').trim() || 'the goal';
    const slug = slugify(g).slice(0, 24);
    return JSON.stringify([
      { task: `Write requirements for: ${g}`, dependencies: [], acceptance_criteria: `File /goals/${slug}/requirements.md exists` },
      { task: `Create HTML scaffold for ${g}`, dependencies: [0], acceptance_criteria: `File /goals/${slug}/index.html exists` },
      { task: `Write stylesheet for ${g}`, dependencies: [0], acceptance_criteria: `File /goals/${slug}/styles.css exists` },
      { task: `Publish ${g} via external API`, dependencies: [1, 2], acceptance_criteria: 'External API call approved and returns 200' },
    ], null, 2);
  }
  landingHtml(name) {
    const n = escapeHtml(name);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${n}</title>
<style>
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#080808;color:#eee}
  header{min-height:70vh;display:grid;place-items:center;text-align:center;padding:40px;background:radial-gradient(circle at 70% 20%,rgba(255,79,0,.35),transparent 55%)}
  h1{font-size:clamp(40px,8vw,96px);margin:0;letter-spacing:.04em}h1 span{color:#FF4F00}
  p.lead{color:#aaa;max-width:560px;margin:16px auto 28px;font-size:18px}
  a.cta{background:#FF4F00;color:#000;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:700}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:40px;max-width:1000px;margin:auto}
  .card{border:1px solid #222;border-radius:14px;padding:22px;background:#0d0d0d}.card h3{color:#FF4F00;margin-top:0}
  footer{text-align:center;color:#555;padding:30px;border-top:1px solid #222}
</style>
</head>
<body>
<header><div><h1>${n}<span>.</span></h1><p class="lead">Crafted with care, served with fire. Discover what makes ${n} different.</p><a class="cta" href="#features" id="cta">Explore</a></div></header>
<section class="grid" id="features">
  <div class="card"><h3>Origin</h3><p>Sourced responsibly, roasted in small batches.</p></div>
  <div class="card"><h3>Craft</h3><p>Every detail tuned by people who care.</p></div>
  <div class="card"><h3>Community</h3><p>Built with and for our neighbours.</p></div>
</section>
<footer>&copy; ${new Date(2026, 0, 1).getFullYear()} ${n} · <span id="clicks">0</span> explorers</footer>
<script>let c=0;document.getElementById('cta').addEventListener('click',()=>{document.getElementById('clicks').textContent=++c;});<\/script>
</body>
</html>`;
  }
}
function escapeMd(s) { return String(s).replace(/([*_`\[\]])/g, '\\$1'); }

<script>
(() => {
'use strict';

/* =====================================================================
 * SECTION 0 — UTILITIES
 * ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(abortError());
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});
const abortError = () => { const e = new Error('Aborted'); e.name = 'AbortError'; return e; };
const uid = (p = 'id') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const deepClone = (o) => JSON.parse(JSON.stringify(o));
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function prng(seed) { let a = seed >>> 0 || 1; return () => { a ^= a << 13; a >>>= 0; a ^= a >>> 17; a ^= a << 5; a >>>= 0; return a / 4294967296; }; }
function rafThrottle(fn) { let queued = false, lastArgs; return (...args) => { lastArgs = args; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...lastArgs); }); }; }
function throttle(fn, ms) { let last = 0, timer = null, lastArgs; return (...args) => { lastArgs = args; const now = Date.now(); const run = () => { last = Date.now(); timer = null; fn(...lastArgs); }; if (now - last >= ms) run(); else if (!timer) timer = setTimeout(run, ms - (now - last)); }; }

const Store = {
  prefix: 'agentStudio.',
  get(key, fallback) { try { const v = localStorage.getItem(this.prefix + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) {
    try { localStorage.setItem(this.prefix + key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('localStorage write failed', key, e); if (typeof toast === 'function') toast('Storage quota exceeded while saving ' + key, 'error'); return false; }
  },
  remove(key) { try { localStorage.removeItem(this.prefix + key); } catch {} },
};

/* Tiny event emitter used as the native reactive layer (Petite-Vue optional). */
class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return () => this._h.get(ev).delete(fn); }
  emit(ev, data) { (this._h.get(ev) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
}

/* GSAP guard: animate only if the CDN loaded. */
const Anim = {
  get ok() { return typeof window.gsap !== 'undefined' && !window.__gsapFailed && !matchMedia('(prefers-reduced-motion: reduce)').matches; },
  in(el, opts = {}) { if (!el) return; if (this.ok) { try { window.gsap.from(el, Object.assign({ opacity: 0, y: 8, duration: 0.28, ease: 'power2.out', clearProps: 'all' }, opts)); } catch {} } },
  pulse(el) { if (el && this.ok) { try { window.gsap.fromTo(el, { boxShadow: '0 0 0 0 rgba(255,79,0,.6)' }, { boxShadow: '0 0 0 8px rgba(255,79,0,0)', duration: 0.6 }); } catch {} } },
};

/* =====================================================================
 * SECTION 1 — TEXT RELEVANCE (TF-IDF) shared by Memory + Knowledge
 * ===================================================================== */
const STOP = new Set('a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there these they this to was we were what when where which who will with you your can do does did not no yes please just also about would could should how why all any some more most other such only own same than too very s t don now let lets i\'m im ok'.split(/\s+/));
function stem(w) { if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3); if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2); if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2); if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); return w; }
function tokenize(text) { return (String(text).toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/g) || []).map((w) => w.replace(/[._-]+$/, '')).filter((w) => w.length > 1 && !STOP.has(w)).map(stem); }
function tfidfRank(query, docs, { k = 5, threshold = 0.08 } = {}) {
  const qTokens = tokenize(query);
  if (!qTokens.length || !docs.length) return [];
  const docTokens = docs.map((d) => tokenize(d.text));
  const N = docs.length;
  const df = new Map();
  docTokens.forEach((toks) => new Set(toks).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const vec = (toks) => { const tf = new Map(); toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1)); const v = new Map(); tf.forEach((c, t) => v.set(t, (c / toks.length) * idf(t))); return v; };
  const qv = vec(qTokens);
  const norm = (v) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
  const qn = norm(qv);
  return docs.map((d, i) => {
    const dv = vec(docTokens[i]);
    let dot = 0; qv.forEach((w, t) => { if (dv.has(t)) dot += w * dv.get(t); });
    return { doc: d, score: dot / (qn * norm(dv)) };
  }).filter((r) => r.score >= threshold).sort((a, b) => b.score - a.score).slice(0, k);
}

/* =====================================================================
 * SECTION 2 — VIRTUAL FILE SYSTEM
 * ===================================================================== */
class VFS extends Emitter {
  constructor(data) { super(); this.nodes = new Map(); this.cwd = '/'; if (data) this.load(data); else this.reset(); }
  reset() {
    this.nodes = new Map([['/', { type: 'dir', mtime: Date.now() }]]);
    this.cwd = '/';
    this.mkdir('/project'); this.mkdir('/src'); this.mkdir('/tmp'); this.mkdir('/docs');
    this.write('/README.md', '# Agent Studio Workspace\n\nThis is an in-memory virtual file system.\n\n- `/project` — generated web projects\n- `/src` — source code written by the agent\n- `/docs` — notes and plans\n- `/tmp` — scratch space (safe to delete)\n\nTry: `tree`, `cat /README.md`, `echo hi > /tmp/a.txt`.\n', { silent: true });
    this.write('/tmp/scratch.log', 'boot ok\n', { silent: true });
    this.write('/docs/notes.md', '## Notes\n\n- The agent can read_file, write_file and execute_command.\n', { silent: true });
    this.emit('change');
  }
  norm(p, base = this.cwd) {
    if (p == null || p === '') p = '.';
    p = String(p).trim();
    const parts = (p.startsWith('/') ? p : base.replace(/\/$/, '') + '/' + p).split('/');
    const out = [];
    for (const part of parts) { if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
    return '/' + out.join('/');
  }
  parent(p) { const n = this.norm(p); if (n === '/') return '/'; return n.slice(0, n.lastIndexOf('/')) || '/'; }
  base(p) { const n = this.norm(p); return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1); }
  exists(p) { return this.nodes.has(this.norm(p)); }
  isDir(p) { const n = this.nodes.get(this.norm(p)); return !!n && n.type === 'dir'; }
  isFile(p) { const n = this.nodes.get(this.norm(p)); return !!n && n.type === 'file'; }
  read(p) {
    const n = this.norm(p), node = this.nodes.get(n);
    if (!node) throw new Error(`No such file: ${n}`);
    if (node.type === 'dir') throw new Error(`Is a directory: ${n}`);
    return node.content;
  }
  mkdir(p, { silent } = {}) {
    const n = this.norm(p);
    if (this.isFile(n)) throw new Error(`File exists: ${n}`);
    const segs = n.split('/').filter(Boolean); let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      const node = this.nodes.get(cur);
      if (node && node.type === 'file') throw new Error(`Not a directory: ${cur}`);
      if (!node) this.nodes.set(cur, { type: 'dir', mtime: Date.now() });
    }
    if (!silent) this.emit('change');
    return n;
  }
  write(p, content, { append = false, silent = false } = {}) {
    const n = this.norm(p);
    if (n === '/') throw new Error('Cannot write to /');
    if (this.isDir(n)) throw new Error(`Is a directory: ${n}`);
    this.mkdir(this.parent(n), { silent: true });
    const prev = this.nodes.get(n);
    const text = String(content == null ? '' : content);
    this.nodes.set(n, { type: 'file', content: append && prev ? prev.content + text : text, mtime: Date.now() });
    if (!silent) this.emit('change', { path: n });
    return n;
  }
  list(p = '.') {
    const n = this.norm(p);
    if (!this.exists(n)) throw new Error(`No such directory: ${n}`);
    if (!this.isDir(n)) return [{ name: this.base(n), path: n, type: 'file' }];
    const prefix = n === '/' ? '/' : n + '/';
    const out = [];
    for (const [path, node] of this.nodes) {
      if (path === n || !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes('/')) out.push({ name: rest, path, type: node.type, size: node.type === 'file' ? node.content.length : 0 });
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }
  delete(p, { recursive = false } = {}) {
    const n = this.norm(p);
    if (n === '/') throw new Error('Refusing to delete /');
    if (!this.exists(n)) throw new Error(`No such file or directory: ${n}`);
    if (this.isDir(n)) {
      const kids = this.list(n);
      if (kids.length && !recursive) throw new Error(`Directory not empty: ${n} (use rm -r)`);
      for (const path of [...this.nodes.keys()]) if (path === n || path.startsWith(n + '/')) this.nodes.delete(path);
      if (this.cwd === n || this.cwd.startsWith(n + '/')) this.cwd = '/';
    } else this.nodes.delete(n);
    this.emit('change');
    return n;
  }
  move(src, dst) {
    const s = this.norm(src); let d = this.norm(dst);
    if (!this.exists(s)) throw new Error(`No such file or directory: ${s}`);
    if (s === '/') throw new Error('Cannot move /');
    if (this.isDir(d)) d = this.norm(this.base(s), d);
    if (d === s) return d;
    if (d.startsWith(s + '/')) throw new Error('Cannot move a directory into itself');
    const moves = [...this.nodes.entries()].filter(([path]) => path === s || path.startsWith(s + '/'));
    this.mkdir(this.parent(d), { silent: true });
    moves.forEach(([path]) => this.nodes.delete(path));
    moves.forEach(([path, node]) => this.nodes.set(d + path.slice(s.length), node));
    this.emit('change');
    return d;
  }
  tree(p = '/', prefix = '') {
    const n = this.norm(p);
    if (!this.exists(n)) throw new Error(`No such directory: ${n}`);
    const lines = prefix ? [] : [n];
    const kids = this.isDir(n) ? this.list(n) : [];
    kids.forEach((k, i) => {
      const last = i === kids.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + k.name + (k.type === 'dir' ? '/' : ''));
      if (k.type === 'dir') lines.push(...this.tree(k.path, prefix + (last ? '    ' : '│   ')));
    });
    return prefix ? lines : lines.join('\n');
  }
  toJSON() { return { cwd: this.cwd, nodes: [...this.nodes.entries()] }; }
  load(data) {
    if (!data || !Array.isArray(data.nodes)) throw new Error('Invalid VFS data');
    const m = new Map();
    for (const [p, node] of data.nodes) {
      if (typeof p !== 'string' || !node || (node.type !== 'dir' && node.type !== 'file')) continue;
      m.set(p, node.type === 'dir' ? { type: 'dir', mtime: node.mtime || Date.now() } : { type: 'file', content: String(node.content ?? ''), mtime: node.mtime || Date.now() });
    }
    if (!m.has('/')) m.set('/', { type: 'dir', mtime: Date.now() });
    this.nodes = m; this.cwd = typeof data.cwd === 'string' && m.has(data.cwd) ? data.cwd : '/';
    this.emit('change');
  }
  /* Tokenizer for shell-ish commands supporting quotes and escapes. */
  static splitArgs(line) {
    const out = []; let cur = '', q = null, has = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < line.length) cur += VFS.unescape(line[++i]); else cur += c; }
      else if (c === '"' || c === "'") { q = c; has = true; }
      else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; }
      else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
      else if (c === '>') { if (cur || has) { out.push(cur); cur = ''; has = false; } if (line[i + 1] === '>') { out.push('>>'); i++; } else out.push('>'); }
      else cur += c;
    }
    if (q) throw new Error('Unterminated quote');
    if (cur || has) out.push(cur);
    return out;
  }
  static unescape(c) { return ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c] ?? '\\' + c; }
  /** Analyse a command for risk without running it (used by HITL). */
  assessCommand(line) {
    let args; try { args = VFS.splitArgs(line); } catch { return null; }
    const [cmd, ...rest] = args;
    if (cmd === 'rm') { const targets = rest.filter((a) => !a.startsWith('-')); return `Deletes ${targets.map((t) => this.norm(t)).join(', ') || '(nothing)'}`; }
    if (cmd === 'mv') { const [s, d] = rest; if (d && this.exists(d) && !this.isDir(d)) return `Moves ${this.norm(s)} over existing file ${this.norm(d)}`; return `Moves ${this.norm(s || '')} → ${this.norm(d || '')}`; }
    const gt = rest.indexOf('>');
    if (cmd === 'echo' && gt >= 0 && rest[gt + 1] && this.isFile(rest[gt + 1])) return `Overwrites existing file ${this.norm(rest[gt + 1])}`;
    return null;
  }
  exec(line) {
    line = String(line || '').trim();
    if (!line) return '';
    const args = VFS.splitArgs(line);
    const cmd = args.shift();
    const flags = new Set(args.filter((a) => /^-[a-z]+$/i.test(a)).flatMap((a) => a.slice(1).split('')));
    const pos = args.filter((a) => !/^-[a-z]+$/i.test(a));
    switch (cmd) {
      case 'help': return 'Commands: ls [-l] [path], cat <file...>, echo <text> [> file | >> file], mkdir [-p] <dir...>, rm [-r] <path...>, tree [path], pwd, cd <dir>, mv <src> <dst>, touch <file...>, clear, help';
      case 'pwd': return this.cwd;
      case 'cd': { const t = this.norm(pos[0] || '/'); if (!this.isDir(t)) throw new Error(`cd: not a directory: ${t}`); this.cwd = t; this.emit('cwd'); return ''; }
      case 'ls': {
        const t = pos[0] || '.';
        const items = this.list(t);
        if (flags.has('l')) return items.map((i) => `${i.type === 'dir' ? 'd' : '-'}rw-r--r--  ${String(i.size || 0).padStart(6)}  ${i.name}${i.type === 'dir' ? '/' : ''}`).join('\n') || '(empty)';
        return items.map((i) => i.name + (i.type === 'dir' ? '/' : '')).join('  ') || '(empty)';
      }
      case 'cat': if (!pos.length) throw new Error('cat: missing file operand'); return pos.map((p) => this.read(p)).join('\n');
      case 'echo': {
        const gt = pos.findIndex((a) => a === '>' || a === '>>');
        if (gt >= 0) {
          const target = pos[gt + 1]; if (!target) throw new Error('echo: missing redirect target');
          const text = pos.slice(0, gt).join(' ') + '\n';
          const p = this.write(target, text, { append: pos[gt] === '>>' });
          return `wrote ${text.length} bytes to ${p}`;
        }
        return pos.join(' ');
      }
      case 'mkdir': if (!pos.length) throw new Error('mkdir: missing operand'); return pos.map((p) => { const n = this.norm(p); if (this.exists(n) && !flags.has('p')) throw new Error(`mkdir: exists: ${n}`); this.mkdir(n); return `created ${n}`; }).join('\n');
      case 'touch': if (!pos.length) throw new Error('touch: missing operand'); return pos.map((p) => { if (!this.exists(p)) this.write(p, ''); return `touched ${this.norm(p)}`; }).join('\n');
      case 'rm': if (!pos.length) throw new Error('rm: missing operand'); return pos.map((p) => `removed ${this.delete(p, { recursive: flags.has('r') || flags.has('f') })}`).join('\n');
      case 'mv': if (pos.length < 2) throw new Error('mv: need <src> <dst>'); return `moved ${this.norm(pos[0])} → ${this.move(pos[0], pos[1])}`;
      case 'tree': return this.tree(pos[0] || '/');
      default: throw new Error(`${cmd}: command not found (try help)`);
    }
  }
}

/* =====================================================================
 * SECTION 3 — MEMORY STORE (Dots)
 * ===================================================================== */
class MemoryStore extends Emitter {
  constructor() { super(); this.facts = Store.get('memory', []); if (!Array.isArray(this.facts)) this.facts = []; }
  save() { Store.set('memory', this.facts); this.emit('change'); }
  add(text, source = 'manual') {
    text = String(text || '').trim().replace(/\s+/g, ' ');
    if (!text) return null;
    if (this.isDuplicate(text)) return null;
    const f = { id: uid('mem'), text: text.slice(0, 500), source, created: Date.now(), updated: Date.now() };
    this.facts.unshift(f); this.save(); return f;
  }
  update(id, text) { const f = this.facts.find((x) => x.id === id); if (!f) return; f.text = String(text).trim().slice(0, 500); f.updated = Date.now(); this.save(); }
  remove(id) { this.facts = this.facts.filter((x) => x.id !== id); this.save(); }
  clear() { this.facts = []; this.save(); }
  isDuplicate(text) {
    const t = text.toLowerCase();
    if (this.facts.some((f) => f.text.toLowerCase() === t)) return true;
    const r = tfidfRank(text, this.facts.map((f) => ({ text: f.text, f })), { k: 1, threshold: 0.86 });
    return r.length > 0;
  }
  search(query, k = 5, threshold = 0.08) { return tfidfRank(query, this.facts.map((f) => ({ text: f.text, f })), { k, threshold }).map((r) => ({ ...r.doc.f, score: r.score })); }
  filter(q) { if (!q.trim()) return this.facts; const ranked = this.search(q, 100, 0.01); const sub = this.facts.filter((f) => f.text.toLowerCase().includes(q.toLowerCase()) && !ranked.some((r) => r.id === f.id)); return [...ranked, ...sub]; }
  /** Deterministic heuristic extractor — used by the mock engine and as fallback. */
  static heuristicExtract(userText) {
    const facts = [];
    const sentences = String(userText).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    const rules = [
      [/\bmy name is ([A-Z][\w-]*(?: [A-Z][\w-]*)?)/i, (m) => `User's name is ${m[1]}`],
      [/\bcall me ([A-Z][\w-]*)/i, (m) => `User wants to be called ${m[1]}`],
      [/\bi (?:really )?(?:prefer|like|love|enjoy) (.+)/i, (m) => `User prefers ${m[1]}`],
      [/\bi (?:hate|dislike|don't like|do not like|avoid) (.+)/i, (m) => `User dislikes ${m[1]}`],
      [/\bi (?:work|am working) (?:on|at|for|as) (.+)/i, (m) => `User works ${m[0].match(/\b(on|at|for|as)\b/i)[1].toLowerCase()} ${m[1]}`],
      [/\bi(?:'m| am) (?:a|an) (.+)/i, (m) => `User is a ${m[1]}`],
      [/\bi (?:use|code in|write) (.+)/i, (m) => `User uses ${m[1]}`],
      [/\bremember (?:that )?(.+)/i, (m) => m[1].replace(/^i\b/i, 'User').replace(/\bmy\b/gi, "user's")],
      [/\b(?:always|never) (.+)/i, (m) => `Preference: ${m[0]}`],
      [/\bmy (favou?rite \w+) is (.+)/i, (m) => `User's ${m[1]} is ${m[2]}`],
    ];
    for (const s of sentences) {
      for (const [re, fmt] of rules) {
        const m = s.match(re);
        if (m) { let f = fmt(m).replace(/[.!?]+$/, '').trim(); f = f.replace(/\bI\b/g, 'User'); if (f.length > 8) facts.push(f.charAt(0).toUpperCase() + f.slice(1)); break; }
      }
    }
    return [...new Set(facts)].slice(0, 6);
  }
}

/* =====================================================================
 * SECTION 4 — PERSONA STORE (Grok Bots)
 * ===================================================================== */
const DEFAULT_PERSONAS = [
  { id: 'p_engineer', name: 'Grok Bot · Engineer', system_prompt: 'You are Grok Bot, a pragmatic senior software engineer. Be concise, prefer working code, explain trade-offs briefly. Use tools to inspect and modify the workspace instead of guessing.', knowledge_snippets: 'Coding standards: use 2-space indentation, ES2020+, no external dependencies unless asked.\n\n---\n\nProject layout: web projects live in /project, reusable code in /src, documentation in /docs.\n\n---\n\nTesting: every function written should include a small usage example.' },
  { id: 'p_designer', name: 'Frontend Artisan', system_prompt: 'You are a meticulous frontend designer. Produce elegant, accessible, responsive HTML/CSS artifacts with strong typography and a dark aesthetic accented by International Orange (#FF4F00).', knowledge_snippets: 'Brand palette: background #080808, accent #FF4F00, borders #222.\n\n---\n\nTypography: Bebas Neue for headings, IBM Plex Mono for body and code.\n\n---\n\nAccessibility: minimum contrast 4.5:1, visible focus states, semantic landmarks.' },
  { id: 'p_analyst', name: 'Research Analyst', system_prompt: 'You are a careful research analyst. Structure answers with headings and bullet points, state assumptions, and summarise findings in a markdown artifact.', knowledge_snippets: 'Report format: Summary, Findings, Risks, Next steps.\n\n---\n\nCite files in the workspace by path when referencing them.' },
];
class PersonaStore extends Emitter {
  constructor() {
    super();
    this.items = Store.get('personas', null);
    if (!Array.isArray(this.items) || !this.items.length) this.items = deepClone(DEFAULT_PERSONAS);
    this.selectedId = Store.get('persona.selected', this.items[0].id);
    if (!this.get(this.selectedId)) this.selectedId = this.items[0].id;
  }
  save() { Store.set('personas', this.items); Store.set('persona.selected', this.selectedId); this.emit('change'); }
  get(id) { return this.items.find((p) => p.id === id); }
  get selected() { return this.get(this.selectedId) || this.items[0]; }
  select(id) { if (this.get(id)) { this.selectedId = id; this.save(); } }
  upsert(p) {
    const clean = { id: p.id || uid('p'), name: String(p.name || 'Untitled').trim().slice(0, 60) || 'Untitled', system_prompt: String(p.system_prompt || ''), knowledge_snippets: String(p.knowledge_snippets || '') };
    const i = this.items.findIndex((x) => x.id === clean.id);
    if (i >= 0) this.items[i] = clean; else this.items.push(clean);
    this.save(); return clean;
  }
  remove(id) {
    if (this.items.length <= 1) throw new Error('At least one persona is required');
    this.items = this.items.filter((p) => p.id !== id);
    if (this.selectedId === id) this.selectedId = this.items[0].id;
    this.save();
  }
  static chunks(p) { return String(p.knowledge_snippets || '').split(/\n\s*-{3,}\s*\n|\n\s*\n/).map((s) => s.trim()).filter(Boolean); }
  relevantChunks(query, k = 3) {
    const chunks = PersonaStore.chunks(this.selected);
    if (!chunks.length) return [];
    const ranked = tfidfRank(query, chunks.map((text) => ({ text })), { k, threshold: 0.05 }).map((r) => r.doc.text);
    return ranked.length ? ranked : chunks.slice(0, 1); // always give at least the primary chunk as grounding
  }
}

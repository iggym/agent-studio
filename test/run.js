const puppeteer = require('puppeteer-core');
const path = require('path');
const BLOCK_CDN = process.env.BLOCK_CDN === '1';
const results = []; let failed = 0;
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) failed++; };
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|net::|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  if (BLOCK_CDN) { await page.setRequestInterception(true); page.on('request', (r) => /cdnjs|fonts\.google|gstatic/.test(r.url()) ? r.abort() : r.continue()); }
  await page.goto('http://127.0.0.1:8765/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.AgentStudio);
  await page.evaluate(() => { AgentStudio.mock.delay = 0; });
  const idle = async () => { try { await page.waitForFunction(() => !AgentStudio.busy, { timeout: 30000 }); } catch (e) { console.log(await page.evaluate(() => ({ hitlHidden: document.getElementById('hitlModal').hidden, hitlQ: AgentStudio.hitl.queue.length, cur: !!AgentStudio.hitl.cur, log: document.getElementById('termLog').innerText.slice(-1200), chat: document.querySelector('#chatLog').lastElementChild.innerText.slice(-800) }))); throw e; } };
  const hitlOpen = () => page.waitForFunction(() => !document.getElementById('hitlModal').hidden, { timeout: 15000 });
  const send = async (t) => { await page.type('#chatInput', t); await page.keyboard.press('Enter'); await new Promise((r) => setTimeout(r, 50)); };

  // 1. Build landing page
  await send('Build a landing page for a coffee roastery called Ember & Oak');
  await idle();
  let s = await page.evaluate(() => ({ art: !!AgentStudio.artifacts.items['landing-page'], notes: !!AgentStudio.artifacts.items['build-notes'], file: AgentStudio.vfs.isFile('/project/index.html'), traces: document.querySelectorAll('.tool-trace').length, src: document.getElementById('artFrame').srcdoc.slice(0, 4000), sandbox: document.getElementById('artFrame').getAttribute('sandbox') }));
  ok('build: html artifact created', s.art); ok('build: markdown notes artifact', s.notes); ok('build: file written to VFS', s.file); ok('build: tool traces in chat', s.traces >= 2, `(${s.traces})`);
  ok('build: iframe sandbox w/o same-origin', !/same-origin/.test(s.sandbox));
  const srcLanding = await page.evaluate(() => { AgentStudio.artifacts.setActive('landing-page'); return document.getElementById('artFrame').srcdoc; });
  ok('build: iframe renders landing html', /Ember &amp; Oak/.test(srcLanding));

  // 2. Overwrite → HITL edit
  await send('Build a landing page for a coffee roastery called Ember & Oak');
  await hitlOpen();
  const reason = await page.$eval('#hitlReason', (e) => e.textContent);
  ok('hitl: overwrite intercepted', /Overwrites existing file \/project\/index.html/.test(reason));
  await page.click('#hitlEdit');
  await page.evaluate(() => { const ta = document.getElementById('hitlPayload'); const o = JSON.parse(ta.value); o.content = '<h1>EDITED</h1>'; ta.value = JSON.stringify(o); });
  await page.click('#hitlApprove');
  await idle();
  s = await page.evaluate(() => ({ c: AgentStudio.vfs.read('/project/index.html'), v: AgentStudio.artifacts.items['landing-page'].versions.length, edited: !!document.querySelector('.badge.st-warn') }));
  ok('hitl: edited payload applied', s.c === '<h1>EDITED</h1>'); ok('artifact versioning v2', s.v === 2); ok('chat shows edited badge', s.edited);

  // 3. Delete → reject
  await send('Delete the temp directory to clean up');
  await hitlOpen(); await page.click('#hitlReject'); await idle();
  s = await page.evaluate(() => ({ tmp: AgentStudio.vfs.exists('/tmp'), txt: document.querySelector('#chatLog').lastElementChild.textContent }));
  ok('hitl: reject keeps /tmp', s.tmp); ok('hitl: rejection reported', /rejected/i.test(s.txt));

  // 4. Delete again → approve via keyboard (Esc=reject test then approve)
  await send('Delete the temp directory to clean up');
  await hitlOpen(); await page.click('#hitlApprove'); await idle();
  ok('hitl: approve deletes /tmp', !(await page.evaluate(() => AgentStudio.vfs.exists('/tmp'))));
  // undo
  await page.evaluate(() => { const b = [...document.querySelectorAll('#tasksPanel')]; });
  await page.click('#tab-tasks');
  await page.click('#undoBtn');
  ok('snapshot undo restores /tmp', await page.evaluate(() => AgentStudio.vfs.exists('/tmp/scratch.log')));
  await page.click('#tab-chat');

  // 5. External API
  await send('Deploy the project via the external API');
  await hitlOpen(); ok('hitl: api payload', /External API payload: POST/.test(await page.$eval('#hitlReason', (e) => e.textContent)));
  await page.click('#hitlApprove'); await idle();
  ok('api: simulated response', /simulated/.test(await page.evaluate(() => document.querySelector('#chatLog').lastElementChild.textContent)));

  // 6. Memory
  await send('I prefer TypeScript and dark themes. My name is Iggy. Remember that I work on agent tooling.');
  await idle(); await page.waitForFunction(() => AgentStudio.memory.facts.length >= 2, { timeout: 10000 }).catch(() => {});
  const facts = await page.evaluate(() => AgentStudio.memory.facts.map((f) => f.text));
  ok('memory: extracted facts', facts.some((f) => /Iggy/.test(f)) && facts.some((f) => /TypeScript/i.test(f)), JSON.stringify(facts));
  await send('Write some TypeScript code for a debounce function');
  await idle();
  s = await page.evaluate(() => ({ ctx: document.querySelector('#chatLog').lastElementChild.querySelector('.ctx').textContent, file: AgentStudio.vfs.isFile('/src/debounce.js'), art: AgentStudio.artifacts.items['debounce-js'] && AgentStudio.artifacts.items['debounce-js'].type }));
  ok('memory: injected into next request', /memor/.test(s.ctx), s.ctx.slice(0, 80)); ok('code: file + code artifact', s.file && s.art === 'code');
  // memory drawer CRUD via UI
  await page.keyboard.down('Control'); await page.keyboard.press('m'); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.getElementById('memDrawer').classList.contains('open')); await new Promise((r) => setTimeout(r, 450));
  await page.type('#memNew', 'User deploys on Fridays'); await page.click('#memForm button[type=submit]');
  await page.type('#memSearch', 'typescript');
  const shown = await page.$$eval('#memList .fact', (els) => els.map((e) => e.querySelector('.ft').textContent));
  ok('memory: search ranks', shown.length >= 1 && /TypeScript/i.test(shown[0]), JSON.stringify(shown));
  await page.click('#memList .fact [data-act=edit]'); await page.evaluate(() => { document.querySelector('#memList textarea').value = 'User prefers TypeScript strictly'; }); await page.click('#memList .fact [data-act=save]');
  ok('memory: edit', await page.evaluate(() => AgentStudio.memory.facts.some((f) => f.text === 'User prefers TypeScript strictly')));
  const before = await page.evaluate(() => AgentStudio.memory.facts.length);
  await page.$eval('#memSearch', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await page.click('#memList .fact [data-act=del]');
  ok('memory: delete', (await page.evaluate(() => AgentStudio.memory.facts.length)) === before - 1);
  await page.keyboard.press('Escape');
  ok('memory drawer closes on Esc', await page.evaluate(() => !document.getElementById('memDrawer').classList.contains('open')));

  // 7. Flaky → retry
  await page.evaluate(() => { AgentStudio.engine.backoffBase = 20; });
  await send('Run a flaky request to test retry and backoff');
  await idle();
  const termTxt = await page.$eval('#termLog', (e) => e.textContent);
  ok('retry/backoff logged and recovered', /retrying in/.test(termTxt) && /Workspace Summary/.test(await page.evaluate(() => AgentStudio.artifacts.items['workspace-summary'] ? 'Workspace Summary' : '')));

  // 8. Personas CRUD
  await page.click('#personaEditBtn'); await page.waitForSelector('#personaModal:not([hidden])'); await new Promise((r) => setTimeout(r, 400));
  await page.click('#personaNew'); await page.type('#pfName', 'Test Bot'); await page.type('#pfPrompt', 'You are a test bot.'); await page.type('#pfKnow', 'Kiwi facts: kiwis are flightless.\n\nOther chunk about rockets.');
  await page.click('#personaForm button[type=submit]'); await page.click('#personaUse');
  s = await page.evaluate(() => ({ sel: AgentStudio.personas.selected.name, opt: [...document.querySelectorAll('#personaSelect option')].map((o) => o.textContent), sys: AgentStudio.engine.buildSystem('tell me about kiwi birds').system }));
  ok('persona: created & selected', s.sel === 'Test Bot' && s.opt.includes('Test Bot'));
  ok('persona: system prompt + relevant knowledge prepended', /You are a test bot/.test(s.sys) && /Kiwi facts/.test(s.sys) && !/rockets/.test(s.sys));
  await page.click('#personaDelete');
  ok('persona: delete', !(await page.evaluate(() => AgentStudio.personas.items.some((p) => p.name === 'Test Bot'))));
  await page.keyboard.press('Escape');

  // 9. Tasks: decompose + scheduler with HITL
  await page.click('#tab-tasks');
  await page.type('#goalInput', 'Ember site'); await page.click('#decomposeBtn');
  await page.waitForFunction(() => AgentStudio.tasks.tasks.length === 4, { timeout: 10000 });
  await page.click('#schedStartBtn');
  await hitlOpen(); ok('tasks: publish HITL', /External API/.test(await page.$eval('#hitlReason', (e) => e.textContent)));
  await page.click('#hitlApprove');
  await page.waitForFunction(() => !AgentStudio.tasks.running, { timeout: 30000 });
  s = await page.evaluate(() => AgentStudio.tasks.tasks.map((t) => t.status));
  ok('tasks: all done in dependency order', s.every((x) => x === 'done'), JSON.stringify(s));
  ok('tasks: files exist', await page.evaluate(() => AgentStudio.vfs.isFile('/goals/ember-site/index.html') && AgentStudio.vfs.isFile('/goals/ember-site/styles.css')));
  // rejection + blocked
  await page.evaluate(() => { const T = AgentStudio.tasks; T.clear(); const a = T.add({ task: 'Delete /docs folder', acceptance_criteria: '' }); T.add({ task: 'Write /docs/after.md', dependencies: [a.id], acceptance_criteria: 'File /docs/after.md exists' }); T.add({ task: 'Write /docs/indep.md', acceptance_criteria: 'File /docs/indep.md exists' }); });
  await page.click('#schedStartBtn');
  await hitlOpen(); await page.click('#hitlReject');
  await page.waitForFunction(() => !AgentStudio.tasks.running, { timeout: 30000 });
  s = await page.evaluate(() => AgentStudio.tasks.tasks.map((t) => t.status));
  ok('tasks: rejected / blocked / done', JSON.stringify(s) === '["rejected","blocked","done"]', JSON.stringify(s));
  // rollback to snapshot
  const snapCount = await page.evaluate(() => AgentStudio.snapshots.items.length);
  ok('snapshots recorded', snapCount > 5, `(${snapCount})`);
  await page.evaluate(() => { const s = AgentStudio.snapshots.items.find((x) => /before task "Write \/docs\/indep.md"/.test(x.label)); document.querySelector(`#snapList button[data-id="${s.id}"]`).click(); });
  ok('rollback: VFS restored to snapshot', await page.evaluate(() => !AgentStudio.vfs.exists('/docs/indep.md') && AgentStudio.tasks.tasks[2].status === 'running' ? false : !AgentStudio.vfs.exists('/docs/indep.md')));

  // 10. Terminal
  await page.click('#termHead');
  await page.type('#termInput', 'echo "hello world" > /tmp/t.txt'); await page.keyboard.press('Enter');
  await page.type('#termInput', 'cat /tmp/t.txt'); await page.keyboard.press('Enter');
  await page.type('#termInput', 'mv /tmp/t.txt /docs/t2.txt'); await page.keyboard.press('Enter');
  await page.type('#termInput', 'tree /docs'); await page.keyboard.press('Enter');
  await page.type('#termInput', 'bogus'); await page.keyboard.press('Enter');
  const tl = await page.$eval('#termLog', (e) => e.innerText);
  ok('terminal: echo/cat/mv/tree', /hello world/.test(tl) && /t2\.txt/.test(tl) && /command not found/.test(tl), JSON.stringify(tl.slice(-600)));
  // file viewer
  await page.evaluate(() => { [...document.querySelectorAll('#fileTree .node')].find((n) => n.dataset.path === '/README.md').click(); });
  ok('file viewer opens on click', /Agent Studio Workspace/.test(await page.$eval('#viewerText', (e) => e.value)));

  // 11. Unit checks: SSE, artifact parser, XSS, tool calls
  s = await page.evaluate(() => {
    const A = AgentStudio; const r = {};
    const p = new A.SSEParser(); let ev = [];
    ['data: {"a":', '1}\r', '\n\r\n: comment\n', 'data: x\ndata: y\n', '\ndata: [DONE]\n\n'].forEach((c) => { ev = ev.concat(p.feed(c)); });
    r.sse = JSON.stringify(ev.map((e) => e.data));
    const text = 'Hi <artifact type="markdown" id="n" title="N">## Head\nbody</artifact> after <artifact type="html" id="h">X</arti';
    const got = []; const ap = new A.ArtifactParser({ onOpen: (a) => got.push('open:' + a.id), onClose: (a, c) => got.push('close:' + a.id + ':' + c + ':' + a.content) });
    for (const ch of text) ap.feed(ch); ap.end(); r.art = got.join('|');
    r.xss = A.renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **b** `<b>`');
    r.tc = JSON.stringify(A.parseToolCalls('<tool_call>{"name":"read_file","args":{"path":"/a"}}</tool_call><tool_call>{bad</tool_call>').map((c) => [c.name, !!c.error]));
    r.reset = [A.parseResetValue('2m59.5s'), A.parseResetValue('30'), A.parseResetValue('500ms')];
    return r;
  });
  ok('SSE parser (split CRLF, multi-line, comments)', s.sse === '["{\\"a\\":1}","x\\ny","[DONE]"]', s.sse);
  ok('artifact parser incremental char-by-char', s.art === 'open:n|close:n:true:## Head\nbody|open:h|close:h:false:X</arti', JSON.stringify(s.art));
  ok('markdown XSS-safe', !/<img/.test(s.xss) && !/javascript:/.test(s.xss) && /<strong>b<\/strong>/.test(s.xss) && /&lt;b&gt;/.test(s.xss), s.xss);
  ok('tool call parsing', s.tc === '[["read_file",false],["invalid",true]]', s.tc);
  ok('reset header parsing', s.reset[0] === 179500 && s.reset[1] === 30000 && s.reset[2] === 500, JSON.stringify(s.reset));

  // 12. Router failover with mocked fetch
  s = await page.evaluate(async () => {
    const A = AgentStudio, R = A.router; const out = {}; const calls = [];
    const realFetch = window.fetch;
    const sse = (chunks, headers = {}) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach((x) => c.enqueue(e.encode(x))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
    const oai = (text) => sse([`data: {"choices":[{"delta":{"content":"${text.slice(0, 3)}"}}]}\n\nda`, `ta: {"choices":[{"delta":{"content":"${text.slice(3)}"}}]}\n\n`, 'data: [DONE]\n\n']);
    let script = {};
    window.fetch = async (url, init) => {
      const auth = (init.headers && init.headers.Authorization) || ''; const key = auth.replace('Bearer ', '') || (url.match(/key=([^&]+)/) || [])[1];
      calls.push(key);
      const h = script[key]; if (!h) throw new TypeError('Failed to fetch');
      return h(url, init);
    };
    R.sleep = async () => {};
    const resetAll = () => { R.resetCooldowns(); Object.keys(R.cfg).forEach((p) => { R.cfg[p].keys = []; R.cfg[p].enabled = true; R.state[p].keyIdx = 0; }); R.forceMock = false; };
    const run = async () => { let t = ''; const r = await R.stream({ system: 's', messages: [{ role: 'user', content: 'hello there' }], mode: 'react', onToken: (d) => { t += d; } }); return { provider: r.provider, text: t }; };
    try {
      // Scenario A: groq k1 429 (Retry-After 30) → groq k2 500 → cerebras ok
      resetAll(); R.order = ['groq', 'cerebras', 'gemini', 'openrouter', 'mistral'];
      R.cfg.groq.keys = ['g1', 'g2']; R.cfg.cerebras.keys = ['c1'];
      script = { g1: () => new Response('{"error":{"message":"rate"}}', { status: 429, headers: { 'retry-after': '30' } }), g2: () => new Response('oops', { status: 503 }), c1: () => oai('Hello!') };
      calls.length = 0; out.A = await run(); out.Acalls = calls.join(',');
      const now = Date.now();
      out.Ag1cool = Math.round(((R.state.groq.keyCooldowns[R.keyId('g1')] || 0) - now) / 1000);
      out.Agroqcool = Math.round((R.state.groq.cooldownUntil - now) / 1000);
      out.Astatus = R.providerStatus('groq').code; out.active = R.active;
      // Scenario B: next call skips groq (cooling), uses cerebras directly
      calls.length = 0; out.B = await run(); out.Bcalls = calls.join(',');
      // Scenario C: round-robin rotation on 401, key sticks
      resetAll(); R.order = ['mistral', 'groq', 'cerebras', 'gemini', 'openrouter']; R.cfg.mistral.keys = ['m1', 'm2', 'm3'];
      script = { m1: () => new Response('bad key', { status: 401 }), m2: () => oai('Rotated'), m3: () => oai('Third') };
      calls.length = 0; out.C = await run(); out.Ccalls = calls.join(','); out.CkeyIdx = R.state.mistral.keyIdx;
      calls.length = 0; await run(); out.C2calls = calls.join(',');
      // Scenario D: proactive cooldown from x-ratelimit-remaining-requests: 0
      resetAll(); R.order = ['groq', 'cerebras', 'gemini', 'openrouter', 'mistral']; R.cfg.groq.keys = ['g1'];
      script = { g1: () => sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'], { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m30s' }) };
      out.D = await run(); out.Dcool = Math.round((R.state.groq.cooldownUntil - Date.now()) / 1000);
      // Scenario E: gemini SSE streaming with split JSON
      resetAll(); R.order = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral']; R.cfg.gemini.keys = ['gk'];
      let gurl = '', gbody = null;
      script = { gk: (url, init) => { gurl = url; gbody = JSON.parse(init.body); return sse(['data: {"candidates":[{"content":{"parts":[{"text":"Gem"}]}}]}\r\n\r\ndata: {"candi', 'dates":[{"content":{"parts":[{"text":"ini"}]}}]}\r\n\r\n']); } };
      out.E = await run(); out.Eurl = /models\/gemini-1\.5-flash:streamGenerateContent\?alt=sse&key=gk/.test(gurl); out.Esys = !!(gbody.systemInstruction && gbody.contents[0].role === 'user');
      // Scenario F: everything fails (network + 500) → offline mock fallback
      resetAll(); R.cfg.groq.keys = ['x1']; R.cfg.mistral.keys = ['x2'];
      script = { x2: () => new Response('down', { status: 502 }) };
      calls.length = 0; out.F = await run(); out.Fcalls = calls.join(',');
      // Scenario G: OpenRouter non-free model skipped, free model used w/ headers
      resetAll(); R.order = ['openrouter', 'groq', 'cerebras', 'gemini', 'mistral']; R.cfg.openrouter.keys = ['or1']; R.cfg.openrouter.model = 'openai/gpt-4o';
      let orHeaders = null; script = { or1: (u, init) => { orHeaders = init.headers; return oai('Free!!'); } };
      calls.length = 0; out.G1 = await run(); out.G1calls = calls.length;
      R.cfg.openrouter.model = 'meta-llama/llama-3.3-70b-instruct:free'; out.G2 = await run(); out.Gref = !!(orHeaders && orHeaders['X-Title']);
      out.strip = document.getElementById('routerStrip').children.length;
      out.headerActive = document.getElementById('activeProvider').textContent;
    } catch (e) { out.err = e.stack; }
    finally { window.fetch = realFetch; resetAll(); R.order = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral']; R.cfg.openrouter.model = 'meta-llama/llama-3.3-70b-instruct:free'; R.sleep = (ms) => new Promise((r) => setTimeout(r, ms)); R.save(); }
    return out;
  });
  if (s.err) ok('router test threw', false, s.err);
  ok('router A: 429→rotate key→503→fallthrough to cerebras', s.A && s.A.provider === 'cerebras' && s.A.text === 'Hello!' && s.Acalls === 'g1,g2,c1', JSON.stringify([s.A, s.Acalls]));
  ok('router A: Retry-After cooldown on key (~30s)', s.Ag1cool >= 29 && s.Ag1cool <= 30, `(${s.Ag1cool}s)`);
  ok('router A: 5xx provider cooldown', s.Agroqcool >= 14 && s.Astatus === 'cooldown', `(${s.Agroqcool}s ${s.Astatus})`);
  ok('router B: cooling provider skipped', s.B.provider === 'cerebras' && s.Bcalls === 'c1', s.Bcalls);
  ok('router C: round-robin rotation on 401', s.C.provider === 'mistral' && s.C.text === 'Rotated' && s.Ccalls === 'm1,m2' && s.CkeyIdx === 1 && s.C2calls === 'm2', JSON.stringify([s.Ccalls, s.CkeyIdx, s.C2calls]));
  ok('router D: proactive rate-limit header cooldown (90s)', s.D.provider === 'groq' && s.Dcool >= 89 && s.Dcool <= 90, `(${s.Dcool})`);
  ok('router E: Gemini SSE stream + URL/body format', s.E.provider === 'gemini' && s.E.text === 'Gemini' && s.Eurl && s.Esys, JSON.stringify(s.E));
  ok('router F: all fail → offline mock fallback', s.F.provider === 'mock' && s.F.text.length > 20, JSON.stringify([s.F.provider, s.Fcalls]));
  ok('router G: OpenRouter non-:free skipped, :free used', s.G1.provider === 'mock' && s.G1calls === 0 && s.G2.provider === 'openrouter' && s.Gref);
  ok('router: header status strip rendered', s.strip === 5, `(${s.strip}, active=${s.headerActive})`);

  // 13. Export / import roundtrip (keys excluded)
  s = await page.evaluate(() => {
    const A = AgentStudio; A.router.cfg.groq.keys = ['secret-key']; const ex = A.exportState(); const json = JSON.stringify(ex);
    A.router.cfg.groq.keys = [];
    A.vfs.write('/zzz.txt', 'temp'); A.importState(JSON.parse(json));
    return { noKey: !json.includes('secret-key'), restored: !A.vfs.exists('/zzz.txt'), mem: A.memory.facts.length === ex.memory.length };
  });
  ok('export excludes API keys', s.noKey); ok('import restores state', s.restored && s.mem);

  // 14. Reload persists
  await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => !!window.AgentStudio);
  s = await page.evaluate(() => ({ msgs: document.querySelectorAll('#chatLog .msg').length, arts: AgentStudio.artifacts.order.length, file: AgentStudio.vfs.isFile('/src/debounce.js') }));
  ok('persistence across reload', s.msgs > 5 && s.arts >= 3 && s.file, JSON.stringify(s));

  // 15. Keyboard: Ctrl+K focuses input, tabs arrow nav
  await page.keyboard.down('Control'); await page.keyboard.press('k'); await page.keyboard.up('Control');
  ok('Ctrl+K focuses chat input', await page.evaluate(() => document.activeElement.id === 'chatInput'));
  await page.focus('#tab-chat'); await page.keyboard.press('ArrowRight');
  ok('tab arrow-key navigation', await page.evaluate(() => document.getElementById('tab-tasks').getAttribute('aria-selected') === 'true'));
  await page.screenshot({ path: path.join(__dirname, BLOCK_CDN ? 'shot-nocdn.png' : 'shot.png') });

  ok('no JS errors', errors.length === 0, JSON.stringify(errors));
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed}/${results.length} passed${BLOCK_CDN ? ' (CDN blocked)' : ''}`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log(results.join('\n')); process.exit(2); });

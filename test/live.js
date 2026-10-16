const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://127.0.0.1:8765/index.html'); await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle2' });
  await p.evaluate(() => { window.__samples = []; AgentStudio.sendMessage('Build a landing page called Nova'); const iv = setInterval(() => { const f = document.getElementById('artFrame'); window.__samples.push([AgentStudio.busy, f.hidden ? 0 : f.srcdoc.length, !!document.querySelector('.art-tab .live')]); if (!AgentStudio.busy && window.__samples.length > 3) clearInterval(iv); }, 100); });
  await p.waitForFunction(() => !AgentStudio.busy && window.__samples.length > 5, { timeout: 60000 });
  const s = await p.evaluate(() => ({ samples: window.__samples, gsap: typeof gsap, fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family).slice(0, 4) }));
  const midStream = s.samples.filter((x) => x[0] && x[1] > 0);
  console.log('samples', s.samples.length, 'live-preview samples during streaming:', midStream.length, 'distinct sizes:', new Set(midStream.map((x) => x[1])).size, 'live tab badge seen:', s.samples.some((x) => x[2]));
  console.log('gsap:', s.gsap, 'fonts:', s.fonts, 'errors:', errs);
  await b.close();
})();

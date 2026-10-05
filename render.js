// render.js — يحوّل شرائح HTML إلى صور JPEG (بديل HCTI المجاني). يشتغل داخل GitHub Actions (وتجرّبه محلياً بنفس الأمر).
// الاستعمال: node render.js <job.json> <outDir>
//   job.json = { id, width, height, scale, delay, slides: [{ html }, ...] }
//   يكتب outDir/s01.jpg … ثم manifest.json  { id, ok, files:[…], errors:[…], ms }
// نفس إعدادات HCTI في الـ workflow: 1080×1350، device_scale 2، تأخير 1200ms (يعطي وقت لسكربت تصغير الخط والخطوط).
// CHROME_PATH يحدد مسار كروم؛ على runner أوبونتو يكون /usr/bin/google-chrome.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

async function renderOne(browser, html, o) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: o.width, height: o.height, deviceScaleFactor: o.scale });
    // domcontentloaded ثم ننتظر الشبكة بحد أقصى؛ صورة بطيئة/ميتة ما توقف الشريحة كلها
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 20000 }).catch(() => {});
    await page.evaluate(() => (document.fonts && document.fonts.ready) || null).catch(() => {});
    await new Promise((r) => setTimeout(r, o.delay));
    return await page.screenshot({ type: 'jpeg', quality: o.quality, clip: { x: 0, y: 0, width: o.width, height: o.height } });
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  const [jobFile, outDir] = process.argv.slice(2);
  if (!jobFile || !outDir) { console.error('usage: node render.js <job.json> <outDir>'); process.exit(2); }
  if (!CHROME) { console.error('no Chrome found; set CHROME_PATH'); process.exit(2); }
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const o = {
    width: Number(job.width) || 1080, height: Number(job.height) || 1350, scale: Number(job.scale) || 2,
    delay: Number.isFinite(Number(job.delay)) ? Number(job.delay) : 1200, quality: Number(job.quality) || 92,
  };
  fs.mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] });
  const slides = job.slides || [];
  const files = new Array(slides.length).fill(null), errors = [];
  let next = 0;
  // 3 صفحات بالتوازي (runner عنده 4 أنوية)
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= slides.length) return;
      const name = 's' + String(i + 1).padStart(2, '0') + '.jpg';
      for (let attempt = 1; attempt <= 2 && !files[i]; attempt++) {
        try {
          const buf = await renderOne(browser, String(slides[i].html || ''), o);
          if (!buf || buf.length < 5000) throw new Error('صورة فاضية/صغيرة (' + (buf ? buf.length : 0) + ' بايت)');
          fs.writeFileSync(path.join(outDir, name), buf);
          files[i] = name;
        } catch (e) {
          if (attempt === 2) errors.push('slide ' + (i + 1) + ': ' + String(e && e.message || e).slice(0, 200));
        }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  await browser.close().catch(() => {});
  const ok = files.length > 0 && files.every(Boolean) && !errors.length;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ id: job.id || '', ok, files, errors, ms: Date.now() - t0 }));
  console.log(ok ? 'OK ' + files.length + ' slides in ' + (Date.now() - t0) + 'ms' : 'FAILED ' + errors.join(' | '));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

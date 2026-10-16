// Headless Chrome (real GPU) page driver for testing.
//
//   node tools/shot.mjs <url> [--out shot.png] [--w 1280] [--h 720] [--wait 3000]
//        [--actions '<JSON array>'] [--mobile] [--fail-on-error]
//
// Actions (executed in order after the initial --wait):
//   ["wait", ms]                 sleep
//   ["key", "Enter"]             press+release a key (puppeteer key names: ArrowUp, Space, KeyX, Escape...)
//   ["down", "ArrowUp"] / ["up", "ArrowUp"]
//   ["click", x, y]              mouse click at viewport coords
//   ["tap", "css selector"]      click the element matching the selector
//   ["eval", "js expression"]    evaluate in page, prints JSON result
//   ["shot", "file.png"]         screenshot
// Prints all console messages, page errors, and failed requests.
// Exit code 2 if --fail-on-error and any page error / console.error occurred.
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const url = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
if (!url) { console.error('usage: node tools/shot.mjs <url> [--out f.png] [--wait ms] [--actions json]'); process.exit(1); }

const W = Number(opt('w', 1280)), H = Number(opt('h', 720));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  acceptInsecureCerts: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
});
let errors = 0;
try {
  const page = await browser.newPage();
  if (flag('mobile')) {
    await page.emulate({ viewport: { width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  } else {
    await page.setViewport({ width: W, height: H });
  }
  page.on('console', (m) => { if (m.type() === 'error') errors++; console.log(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}\n${e.stack || ''}`); });
  page.on('requestfailed', (r) => { console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', (r) => { if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await new Promise((r) => setTimeout(r, Number(opt('wait', 2000))));
  const actions = JSON.parse(opt('actions', '[]'));
  for (const a of actions) {
    const [type, ...p] = a;
    if (type === 'wait') await new Promise((r) => setTimeout(r, p[0]));
    else if (type === 'key') await page.keyboard.press(p[0]);
    else if (type === 'down') await page.keyboard.down(p[0]);
    else if (type === 'up') await page.keyboard.up(p[0]);
    else if (type === 'click') await page.mouse.click(p[0], p[1]);
    else if (type === 'tap') await page.click(p[0]);
    else if (type === 'eval') { const v = await page.evaluate(p[0]); console.log(`[eval] ${p[0]} => ${JSON.stringify(v)}`); }
    else if (type === 'shot') { await page.screenshot({ path: p[0] }); console.log(`[shot] ${p[0]}`); }
  }
  const out = opt('out', null);
  if (out) { await page.screenshot({ path: out }); console.log(`[shot] ${out}`); }
} finally {
  await browser.close();
}
console.log(`[done] page errors/console errors: ${errors}`);
if (flag('fail-on-error') && errors > 0) process.exit(2);

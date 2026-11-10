/** Offline participant-flow regression. The former 15-second holds were
 * removed at the owner's request on 2026-11-10. Checks immediate transitions,
 * selected group ideas on the survey, and aligned header controls.
 * PW may point to a Playwright module; CHROMIUM may specify its browser binary.
 */
const PW = process.env.PW || '/opt/node22/lib/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The site repo root (…/_ideasearchlab-src/tools/ → two levels up), so the
// server below serves the BUILT bundle in lab/ideasearchlab/ from anywhere.
const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json' };
const srv = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/simulation/')) { res.writeHead(200, {'content-type':'text/javascript'}); res.end(''); return; }
  let f = join(ROOT, decodeURIComponent(u.pathname).replace('/lab/ideasearchlab/', ''));
  if (u.pathname.endsWith('/')) f = join(f, 'index.html');
  try { const b = await readFile(f); res.writeHead(200,{'content-type':T[extname(f)]||'application/octet-stream'}); res.end(b); }
  catch { const b = await readFile(join(ROOT,'index.html')); res.writeHead(200,{'content-type':'text/html'}); res.end(b); }
});
await new Promise(r => srv.listen(0, r));
const B = `http://localhost:${srv.address().port}/lab/ideasearchlab/`;

// Screenshots land in the OS temp dir — this is a check, not an artefact build.
const SHOT = n => join(process.env.TMPDIR || process.env.TEMP || '/tmp', `isl-phase-hold-${n}.png`);

let fails = 0;
const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c || !d ? '' : ' — ' + d)); if (!c) fails++; };
const br = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {channel: 'chrome'});
const p = await br.newPage({ viewport: { width: 1320, height: 950 } });
p.on('pageerror', e => { console.log('  [pageerror]', e.message); fails++; });
await p.addInitScript(() => {
  localStorage.setItem('ideasearchlab-preview-config', JSON.stringify({
    phaseConfig: { individualPhaseActive:true, groupPhaseActive:true, phaseOrder:'individual_first',
      maxIdeasIndividual:10, ideasCarriedToGroup:2, groupSize:1,
      individualGenerationDuration:300, individualSelectionDuration:300,
      groupIdeationDuration:300, groupVotingDuration:300 },
    aiConfig: { individualAI:false, groupAI:false },
  }));
});
const btn = t => p.getByRole('button', { name: t }).first();
const clickIf = async (t, ms=500) => { const b = btn(t); if (await b.count() && await b.isVisible().catch(()=>false)) { await b.click(); await p.waitForTimeout(ms); return true; } return false; };
// Right edge of the header controls, and how far it sits from the viewport's
// right edge — the number that must not change from screen to screen.
const controlsRight = () => p.evaluate(() => {
  const el = document.querySelector('[class*="_controls_"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { right: Math.round(r.right), gap: Math.round(window.innerWidth - r.right), top: Math.round(r.top) };
});
const seenControls = [];
const noteControls = async where => {
  const c = await controlsRight();
  if (c) seenControls.push({ where, ...c });
  return c;
};

const headerClock = () => p.evaluate(() => {
  const h = document.querySelector('header') || document.body;
  const m = (h.innerText || '').match(/\b\d{1,2}:\d{2}\b/); return m ? m[0] : null;
});

try {
  await p.goto(B + 'session/PREVIEW/welcome?preview=1&key=stouras', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  await noteControls('welcome');
  await clickIf(/agree|continue/i, 1200);
  await clickIf(/skip/i, 900);
  await noteControls('registration');
  await clickIf(/continue|submit|join|start/i, 1600);
  console.log('\n=== INDIVIDUAL PHASE ===', p.url().split('/').pop());
  await noteControls('individual instructions');
  await clickIf(/^start$/i, 1200);
  await noteControls('individual workspace');

  // Write 3 ideas
  for (const [t, d] of [['Alpha jacket','turns blue at 37C'],['Beta shirt','heat map panels'],['Gamma cap','colour shift brim']]) {
    await p.getByPlaceholder('Idea title').first().fill(t);
    await p.getByPlaceholder(/^Description/).first().fill(d);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(500);
  }
  await clickIf(/Proceed to Selection/i, 900);
  await noteControls('individual selection');
  const clockDuringSelection = await headerClock();
  console.log('  (selection stage header clock:', clockDuringSelection + ')');

  // Select 2 ideas by double-click
  const cards = p.locator('h3', { hasText: /Alpha jacket|Beta shirt/ });
  for (let i = 0; i < 2; i++) { await cards.nth(i).dblclick(); await p.waitForTimeout(400); }
  await clickIf(/Finish & Submit/i, 2500);

  await p.waitForURL('**/group');
  check('individual submission advances without a forced hold', /\/group/.test(p.url()));
  await noteControls('group instructions');
  await clickIf(/^start$/i, 1500);
  await noteControls('group ideation');
  await clickIf(/Proceed to Voting/i, 1500);
  await clickIf(/Got it/i, 800);   // "Reach consensus" modal
  await noteControls('group voting');
  await p.screenshot({ path: SHOT('voting') });

  // Vote for the required number of ideas, then submit
  // Vote on the PILL (the dblclick handler is on the card, not the title).
  const pills = p.locator('[class*="ideaPillClickable"]');
  const n = await pills.count();
  console.log('  (votable pills:', n + ')');
  for (let i = 0; i < n; i++) { await pills.nth(i).dblclick(); await p.waitForTimeout(450); }
  await clickIf(/Submit Votes/i, 3000);

  await p.waitForURL('**/survey');
  await noteControls('survey');
  check('survey opens immediately with group results', await p.getByRole('heading', { name: "Your group's selected ideas" }).count() === 1);
  console.log('\n--- Header controls (theme + account) across the flow ---');
  for (const c of seenControls) console.log(`      ${c.where.padEnd(26)} right=${String(c.right).padStart(5)}  gap=${c.gap}`);
  const gaps = [...new Set(seenControls.map(c => c.gap))];
  check(`the controls stay hard right on all ${seenControls.length} screens`,
    seenControls.length >= 7 && gaps.length === 1,
    `distinct right-edge gaps: ${gaps.join(', ')} — they move between steps`);
  const offscreenish = seenControls.filter(c => c.gap > 120);
  check('they are never left stranded beside the wordmark', offscreenish.length === 0,
    offscreenish.map(c => `${c.where} gap=${c.gap}`).join('; '));
} catch (e) {
  console.log('  [error]', e.message); fails++;
  await p.screenshot({ path: SHOT('error') }).catch(()=>{});
}
await br.close(); srv.close();
console.log(fails ? `\n${fails} check(s) FAILED` : '\nPHASE-HOLD GUARD OK — phases advance immediately with results on the survey.');
process.exit(fails ? 1 : 0);

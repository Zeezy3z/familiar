// Hosted browser smoke of built Glass, using only the synthetic preview bridge.
// No Electron, game, saved sessions, agent calls, or native DOM clicks.
// CI installs Playwright separately so production dependencies/lockfile stay untouched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rendererUpdateJourney } from './renderer-update-journey.mjs';
import { glassRound3Journey } from './glass-round3-journey.mjs';
import { controlRound4Journey } from './control-round4-journey.mjs';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Run this browser smoke on GitHub Actions only.');
if (!process.env.FAMILIAR_QA_MODULE) throw new Error('FAMILIAR_QA_MODULE must point to the pinned Playwright installation.');
const { chromium } = await import(pathToFileURL(process.env.FAMILIAR_QA_MODULE).href);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'preview-evidence');
mkdirSync(output, { recursive: true });
const report = { build: JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8')), checks: [], screenshots: [], interactions: [], errors: [] };
const server = spawn(process.execPath, ['scripts/preview.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', chunk => serverLog += chunk);
server.stderr.on('data', chunk => serverLog += chunk);
let browser, context, page;
const origin = 'http://127.0.0.1:47812';
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const wheel = async d => { await page.evaluate(d => window.preview.emit('input', { t: 'wheel', r: 'detail', d }), d); await settle(); };
const snapshot = async name => {
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
};
const check = (name, condition) => { assert.ok(condition, name); report.checks.push(name); console.log(`PASS ${name}`); };
// Find a visible control, normalize its point to its region (the detail pane unless told otherwise), then invoke
// the exact incoming-addon path. elementFromPoint in overlay.ts still decides which action is hit.
async function point(selector, region = 'detail') {
  return page.locator(selector).evaluate((el, region) => {
    const r = document.getElementById(region).getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom || document.elementFromPoint(x, y)?.closest('[data-act]') !== el)
      throw new Error(`Control is clipped or covered: ${el.textContent}`);
    return { t: 'click', r: region, x: (x - r.left) / r.width, y: (y - r.top) / r.height, b: 'L' };
  }, region);
}
async function click(selector, count = 1, region = 'detail') {
  const event = await point(selector, region);
  const hits = await page.evaluate(({ event, count }) => {
    const hits = [];
    for (let i = 0; i < count; i++) {
      const r = document.getElementById(event.r).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + event.x * r.width, r.top + event.y * r.height);
      const before = window.preview.calls.length;
      window.preview.emit('input', event);
      hits.push({ hitText: hit?.textContent, hitAction: hit?.closest('[data-act]')?.dataset.act,
        actions: window.preview.calls.slice(before), approval: window.preview.model.detail.entries?.find(e => e.kind === 'approval')?.approval });
    }
    return hits;
  }, { event, count });
  report.interactions.push({ url: page.url(), selector, event, hits });
  await settle();
}
const action = type => `[data-act*='"type":"${type}"']`;
async function open(scenario, narrow = false) {
  await page.goto(`${origin}/overlay.html?scenario=${scenario}`);
  await page.waitForFunction(() => window.preview && !document.body.classList.contains('hidden'));
  await page.evaluate(() => document.fonts.ready);
  if (narrow) await page.evaluate(() => {
    const p = window.preview;
    // Fresh model object makes the real renderer observe the font setting change.
    p.model.fontScale = 1.45;
    p.emit('model', { ...p.model });
    p.emit('layout', { scr: [1280, 800], px: 1.25, panel: true, drag: false, combat: false, ui: true,
      rowH: 24, list: [30, 100, 250, 620], detail: [300, 100, 380, 620], status: [30, 735, 940, 28] });
  });
  await settle();
}
async function anchor() {
  return page.evaluate(() => {
    const scroll = document.getElementById('detail-scroll');
    const header = document.querySelector('.qhead');
    const viewTop = scroll.scrollTop + header.offsetHeight;
    const entry = [...document.querySelectorAll('.entry')].find(e => e.offsetTop + e.offsetHeight > viewTop);
    return entry && { text: entry.textContent, offset: entry.offsetTop - viewTop };
  });
}
async function sameAnchor(before, name, contentUnchanged = true) {
  const after = await anchor();
  const ok = !!before && !!after && (!contentUnchanged || before.text === after.text) && Math.abs(before.offset - after.offset) <= 2;
  // On failure, record what moved (entry start and offset only) for the CI log.
  if (!ok) console.log(`ANCHOR ${name}: before ${JSON.stringify(before && { text: before.text.slice(0, 40), offset: before.offset })} after ${JSON.stringify(after && { text: after.text.slice(0, 40), offset: after.offset })}`);
  check(name, ok);
}
// ---- The control panel: one fixed page that never moves between states (header · Requests waiting · the status line ·
// Play · Safety · Familiars · Projects · Troubleshooting, collapsed · footer), through the built control.html and the
// synthetic bridge. An action's answer is written beside the control that caused it (control.ts say()).
async function openControl(scenario, width, height = 640) {
  await page.setViewportSize({ width, height });
  await page.goto(`${origin}/control.html?scenario=${scenario}`);
  await page.waitForFunction(() => window.preview?.state && document.getElementById('journey-title')?.textContent);
}
const uiWrites = () => page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'uiSettings').map(c => c.args));
// The feedback line of the settings row, button group or card that holds `selector`.
const feedback = selector => page.locator(selector).evaluate(el => {
  const fb = el.closest('.set, .btns, #familiars, #status')?.querySelector(':scope > .fb');
  return { text: fb?.textContent ?? null, level: fb ? ['ok', 'warn', 'err'].find(c => fb.classList.contains(c)) ?? '' : null, role: fb?.getAttribute('role') ?? null };
});
const shown = selector => page.locator(selector).evaluate(el => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none');
const ONLY_HERE = 'No key set: requests can only be approved in this window until you set one.';

async function controlLayoutJourney(width) {
  const size = `control-${width}/layout`;
  await openControl('linked', width);
  const now = await page.evaluate(() => ({
    order: [...document.querySelectorAll('main > *')].map(e => e.id), hidden: [...document.querySelectorAll('main > *')].filter(e => e.hidden).map(e => e.id),
    stale: ['advanced', 'chat-agent', 'feedback', 'b-chosen', 'step-slot', 'essentials', 'journey', 'quests-card'].filter(id => document.getElementById(id)),
    strip: document.getElementById('journey-steps').hidden, title: document.getElementById('journey-title').textContent, trouble: document.getElementById('troubleshooting').open,
  }));
  check(`${size}: one fixed order: Requests waiting, the status line, Play, Safety, Familiars, Projects, Troubleshooting`,
    JSON.stringify(now.order) === JSON.stringify(['requests', 'status', 'play', 'safety', 'familiars', 'projects', 'troubleshooting']));
  check(`${size}: healthy: no request card, no step strip, All set, Troubleshooting closed`, JSON.stringify(now.hidden) === '["requests"]' && now.strip
    && now.title === 'All set — type /fam in WoW' && !now.trouble);
  check(`${size}: the old layout's elements are gone`, now.stale.length === 0);
  check(`${size}: with a key registered there is no how-to-bind line and no mode warning`, !await shown('#approve-key-how') && !await shown('#ui-mode-warn')
    && !await shown('#quest-warn') && await page.locator('#approve-key-line').textContent() === 'Registered: F9 — Familiar checks the real keyboard for it');
  await snapshot(`control-${width}-linked`);
  // First run: nothing signed in yet. The step strip shows, step 1 is current, and the line offers Review familiars.
  await openControl('setup', width);
  await page.evaluate(() => {
    const p = window.preview;
    for (const x of p.state.providers) if (x.id !== 'hermes') { x.signedIn = false; x.detail = 'Not signed in'; }
    p.state.backends = {};
    p.emit('status', p.state);
  });
  await page.waitForFunction(() => !document.getElementById('journey-steps').hidden);
  const setup = await page.evaluate(() => ({ current: document.querySelector('.steps li.cur b')?.textContent, done: document.querySelectorAll('.steps b.ok').length,
    action: document.getElementById('journey-action').hidden ? null : document.getElementById('journey-action').textContent,
    hints: [...document.querySelectorAll('.steps li .hint')].map(h => !!h.title && getComputedStyle(h).textOverflow === 'ellipsis') }));
  check(`${size}/setup: step 1 is current, each step hint is one line with its sentence as the title, and the line offers Review familiars`,
    setup.current?.startsWith('1 Agents') && setup.done === 0 && setup.action === 'Review familiars' && setup.hints.length === 3 && setup.hints.every(Boolean));
  await snapshot(`control-${width}-first-run`);
  await page.locator('#journey-action').click();
  check(`${size}/setup: Review familiars moves focus into the Familiars card`, await page.evaluate(() => document.getElementById('familiars').contains(document.activeElement)));
}
// The default, healthy page at the window's own size stays within about one and a half window heights.
async function controlHeightJourney() {
  await openControl('linked', 730, 603);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  report.interactions.push({ label: 'control-730x603-healthy-height', height });
  // 962 px (1.6 heights) with Windows fonts; the bound leaves room for the CI runner's fallback fonts.
  check(`control-730x603: the healthy page is about one and a half window heights (${height} px, at most 1.7)`, height <= 603 * 1.7);
  check('control-730x603: nothing spills sideways', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await snapshot('control-730x603-linked');
}
async function controlFailureJourney(width) {
  const size = `control-${width}/failure`;
  await openControl('action-error', width);
  await page.locator('#troubleshooting > summary').click();
  await page.locator('#b-config').click();
  await page.waitForFunction(() => document.querySelector('.btns:has(#b-config) > .fb')?.textContent.includes('Synthetic file-open failure'));
  check(`${size}: a failed action says why beside its button, as an error, in a live region`, JSON.stringify(await feedback('#b-config'))
    === JSON.stringify({ text: "Couldn't do that: Synthetic file-open failure", level: 'err', role: 'status' })
    && await page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'openConfig').length) === 1);
  check(`${size}: focus stays on the button that failed`, await page.locator('#b-config').evaluate(el => document.activeElement === el));
  await snapshot(`control-${width}-action-failure`);
  await page.evaluate(() => window.preview.emit('status', window.preview.state));
  check(`${size}: a status refresh keeps the error`, (await feedback('#b-config')).text === "Couldn't do that: Synthetic file-open failure");
  await page.locator('#b-refresh').click();
  await page.waitForFunction(() => document.querySelector('.btns:has(#b-config) > .fb')?.textContent === 'Desktop quests rescanned');
  check(`${size}: the next action in the group replaces the error with its own answer`, (await feedback('#b-config')).level === 'ok');
}
const layoutFor = (width, focus) => ({ scr: [1280, 800], px: 1, fpx: 1, panel: true,
    drag: false, combat: false, ui: true, focus, rowH: 16,
    win: focus ? [336, 140, width - 236, 400] : [100, 100, width, 440],
    detail: [355, 159, width - 274, 260],
    ...(focus ? {} : { list: [119, 159, 220, 336], status: [250, 504, 100, 22] }) });
async function controlStorageJourney(width) {
  await openControl('linked', width);
  const calls = await page.evaluate(() => window.preview.calls.length);
  for (const [level, text] of [
    ['error', 'Saved quests could not be safely read or preserved. Saving is paused to protect the original file. Keep Familiar open and ask for recovery help.'],
    ['warn', "Saved quests could not be fully loaded: 2 valid records recovered; 1 invalid or ambiguous records skipped. Original bytes are preserved privately in Familiar's data folder."],
  ]) {
    await page.evaluate(storage => { const p = window.preview; p.state.storage = storage; p.emit('status', p.state); }, { level, text });
    await page.waitForFunction(text => document.getElementById('journey-text').textContent === text, text);
    check(`control-${width}/storage-${level}: persistent guidance is visible on the status line`, await page.locator('#journey-text').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
    }) && await page.locator('#journey-title').textContent() === 'Saved quests need attention'
      && await page.locator('#journey-title').getAttribute('class') === (level === 'error' ? 'err' : 'warn'));
    await page.evaluate(() => window.preview.emit('status', window.preview.state));
    check(`control-${width}/storage-${level}: refresh retains guidance without action`, await page.locator('#journey-text').textContent() === text
      && await page.evaluate(() => window.preview.calls.length) === calls);
    await snapshot(`control-${width}-storage-${level}`);
  }
  await page.evaluate(() => { const p = window.preview; delete p.state.storage; p.emit('status', p.state); });
  check(`control-${width}/storage: healthy status restores normal guidance`, await page.locator('#journey-title').textContent() === 'All set — type /fam in WoW');
}
async function controlRequestsJourney(width) {
  const size = `control-${width}/requests`;
  await openControl('linked', width);
  check(`${size}: no card without a pending request`, !await page.locator('#requests').isVisible());
  const full = Array.from({ length: 90 }, (_, i) => `echo "step ${i}: far too long for the in-game card"`).join('\n') + '\nrm -rf D:\\vault\\private';
  await page.evaluate(full => {
    const p = window.preview, api = window.familiar, real = api.invoke;
    p.decisions = [];
    p.answer = { ok: true };
    // Preview infrastructure only: stand in for main's "decide" command and record what the panel sends.
    api.invoke = async (cmd, args) => cmd === 'decide' ? (p.decisions.push(args), p.answer) : real(cmd, args);
    // Every pending request is listed (status.requests[], the hub's PendingRequest: the agent's label and its id): a cut
    // one carries its whole text in `full`, a short one only the card's own `detail`. A cut one without `full` is not listed.
    p.state.requests = [
      { thread: 't1', questTitle: 'Tidy the logs', project: 'Preview project', agent: 'Claude', agentId: 'claude', requestId: 'r1', title: 'Run a long shell command', detail: full.slice(0, 600) + '\n… (omitted)', full, cut: true, canAlways: true, at: Date.now() - 65000 },
      { thread: 't2', questTitle: 'Chat about fonts', project: 'Other project', agent: 'Codex', agentId: 'codex', requestId: 'r2', title: 'Edit 3 files', detail: 'diff --git a/x b/x\n+ small change', cut: false, canAlways: false, at: Date.now() - 20000 },
      { thread: 't3', questTitle: 'No whole text', project: 'Other project', agent: 'Codex', agentId: 'codex', requestId: 'r3', title: 'Cut, but without its full text', detail: 'only a preview', cut: true, canAlways: false, at: Date.now() - 10000 },
    ];
    p.emit('status', p.state);
  }, full);
  const card = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#requests .req')];
    return { rows: rows.length, textFirst: rows.every(r => !!(r.querySelector('pre').compareDocumentPosition(r.querySelector('button')) & Node.DOCUMENT_POSITION_FOLLOWING)),
      above: !!(document.getElementById('requests').compareDocumentPosition(document.getElementById('status')) & Node.DOCUMENT_POSITION_FOLLOWING),
      text: rows[0].querySelector('pre').textContent, shortText: rows[1].querySelector('pre').textContent,
      badges: rows.map(r => { const b = r.querySelector('.badge'); return !b.hidden && getComputedStyle(b).display !== 'none' ? b.textContent : null; }),
      labels: rows.map(r => [...r.querySelectorAll('button')].filter(b => !b.hidden).map(b => b.textContent)),
      title: document.getElementById('requests-title').textContent, live: document.getElementById('requests-live').textContent,
      hint: document.getElementById('requests-hint').textContent,
      decide: rows.map(r => [...r.querySelectorAll('button[data-decide]')].map(b => `${b.dataset.decide}:${b.className}`)),
      greens: [...document.querySelectorAll('button.ok')].map(b => b.matches('#requests .req button[data-decide="allow"]')),
      colours: { approve: getComputedStyle(rows[0].querySelector('[data-decide="allow"]')).backgroundImage, deny: getComputedStyle(rows[0].querySelector('[data-decide="deny"]')).backgroundImage },
      maxHeight: getComputedStyle(rows[0].querySelector('.req-full')).maxHeight, statusTitle: document.getElementById('journey-title').textContent };
  });
  check(`${size}: the card sits above the status line, shows each request whole and puts the text before its buttons`, card.rows === 2 && card.above && card.textFirst
    && card.text === full && card.shortText === 'diff --git a/x b/x\n+ small change' && card.title === 'Requests waiting' && card.live === '2 requests waiting');
  check(`${size}: a cut request carries the badge, a short one does not, and a cut one with no full text is not listed`,
    JSON.stringify(card.badges) === JSON.stringify(['Too long for the in-game card', null]));
  check(`${size}: the hint says where to decide, that Always is given here only, and that names show here`, card.hint
    === 'Approve or Deny here or in the game; Always is given here only. Nothing happens until you click. Names show here even with privacy on: this window is on your PC.');
  check(`${size}: Approve is the one green button; Deny is the red primary, never quiet; Always is the dashed ghost`,
    JSON.stringify(card.decide) === JSON.stringify([['allow:ok', 'deny:primary', 'allowAlways:always'], ['allow:ok', 'deny:primary', 'allowAlways:always']])
    && card.greens.length === 2 && card.greens.every(Boolean) && card.colours.approve !== card.colours.deny && card.colours.deny.includes('linear-gradient'));
  check(`${size}: a long request scrolls inside 160 px, so the next one stays in view`, card.maxHeight === '160px');
  check(`${size}: Approve and Deny always, Always (this quest) for Claude only when the request allows it`,
    JSON.stringify(card.labels) === JSON.stringify([['Approve', 'Deny', 'Always (this quest)'], ['Approve', 'Deny']]));
  check(`${size}: with an Approve key registered the status line stays as it was`, card.statusTitle === 'All set — type /fam in WoW');
  await snapshot(`control-${width}-requests`);
  await page.evaluate(() => { document.querySelector('.req-full').scrollTop = 300; });
  await new Promise(resolve => setTimeout(resolve, 1300)); // two synthetic status ticks
  check(`${size}: nothing is sent by itself and a status update keeps the reader's place`, await page.evaluate(() => window.preview.decisions.length === 0
    && document.querySelector('.req-full').scrollTop === 300));
  // A script-made click is not a user click: it decides nothing.
  await page.waitForFunction(() => !document.querySelector('.req [data-decide="allow"]').disabled);
  await page.evaluate(() => document.querySelector('.req [data-decide="allow"]').click());
  check(`${size}: a click made by script sends nothing`, await page.evaluate(() => window.preview.decisions.length) === 0);
  await page.locator('.req[data-request="r1"] [data-decide="deny"]').click();
  await page.waitForFunction(() => window.preview.decisions.length === 1);
  check(`${size}: a real click sends one decide for that request and answers under its buttons`, JSON.stringify(await page.evaluate(() => window.preview.decisions))
    === JSON.stringify([{ thread: 't1', requestId: 'r1', decision: 'deny' }])
    && await page.locator('.req[data-request="r1"] .req-msg').textContent() === 'Denied.');
  await page.evaluate(() => { const p = window.preview; p.state.requests = p.state.requests.filter(r => r.requestId !== 'r1'); p.emit('status', p.state); });
  check(`${size}: an answered request leaves the card`, await page.locator('#requests .req').count() === 1);
  await page.evaluate(() => { window.preview.answer = { ok: false, why: 'no longer pending' }; });
  await page.locator('.req[data-request="r2"] [data-decide="allow"]').click();
  await page.waitForFunction(() => document.querySelector('.req[data-request="r2"] .req-msg').textContent);
  check(`${size}: a late click says Already answered and leaves the buttons usable`, await page.locator('.req[data-request="r2"] .req-msg').textContent() === 'Already answered.'
    && await page.locator('.req[data-request="r2"] button:not([hidden])').evaluateAll(els => els.every(el => !el.disabled)));
  await page.evaluate(() => { window.preview.answer = { ok: true }; });
  await page.locator('.req[data-request="r2"] [data-decide="allow"]').click();
  await page.waitForFunction(() => window.preview.decisions.length === 3);
  check(`${size}: Approve sends allow`, await page.evaluate(() => window.preview.decisions.at(-1).decision) === 'allow');
  await page.evaluate(() => {
    const p = window.preview;
    p.state.requests = [{ ...p.state.requests[0], requestId: 'partial', detail: 'Synthetic preview', full: 'Synthetic partial text', cut: true, incomplete: true, canAlways: true }];
    p.emit('status', p.state);
  });
  const partial = page.locator('.req[data-request="partial"]');
  check(`${size}: an incomplete desktop request offers only Deny`,
    await partial.locator('[data-decide="deny"]').isVisible() && !await partial.locator('[data-decide="allow"]').isVisible()
    && !await partial.locator('[data-decide="allowAlways"]').isVisible());
  await page.evaluate(() => { const p = window.preview; p.state.requests = []; p.emit('status', p.state); });
  check(`${size}: the card goes away with the last request`, !await page.locator('#requests').isVisible());
}
// Safety: the open quest's mode (set here only), the Approve key, and the two switches that are off by default.
async function controlSafetyJourney(width) {
  const size = `control-${width}/safety`;
  await openControl('linked', width);
  const quest = () => page.evaluate(() => ({ shown: !document.getElementById('quest-row').hidden, title: document.getElementById('quest-title').textContent,
    bold: !!document.querySelector('#quest-title b'), mode: document.getElementById('quest-mode').value, warn: !document.getElementById('quest-warn').hidden,
    warnText: document.getElementById('quest-warn').textContent }));
  let q = await quest();
  check(`${size}: the quest open in the game is named in Safety with its mode, Ask first, and no warning`, q.shown && q.title === 'Quest log' && q.mode === 'ask' && !q.warn);
  await page.locator('#quest-mode').selectOption('auto');
  await page.waitForFunction(() => window.preview.state.quest.mode === 'auto' && document.querySelector('#quest-row > .fb').textContent);
  q = await quest();
  check(`${size}: choosing Auto sends one questMode and shows the risk in the same words as for new quests`,
    JSON.stringify(await page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'questMode').map(c => c.args))) === '[{"mode":"auto","thread":"preview"}]'
    && q.mode === 'auto' && q.warn && q.warnText === await page.locator('#ui-mode-warn').textContent());
  check(`${size}: the answer is said beside the control`, JSON.stringify(await feedback('#quest-mode')) === JSON.stringify({ text: 'Next turn: Auto', level: 'ok', role: 'status' }));
  await snapshot(`control-${width}-quest-auto`);
  // A refusal says why beside the control and puts the shown mode back.
  await page.evaluate(() => {
    const api = window.familiar, real = api.invoke;
    api.invoke = async (cmd, args) => cmd === 'questMode' ? { ok: false, why: 'Chats have no permission modes: they can only search the web.' } : real(cmd, args);
  });
  await page.locator('#quest-mode').selectOption('plan');
  await page.waitForFunction(() => document.querySelector('#quest-row > .fb').classList.contains('err'));
  q = await quest();
  check(`${size}: a refused mode says why and the select shows the quest's mode again`, (await feedback('#quest-mode')).text
    === "Couldn't do that: Chats have no permission modes: they can only search the web." && q.mode === 'auto' && q.warn && await page.evaluate(() => window.preview.state.quest.mode) === 'auto');
  await page.evaluate(() => { const p = window.preview; p.state.quest = { id: 'raid', title: '<b>Raid</b> notes', mode: 'plan' }; p.emit('status', p.state); });
  q = await quest();
  check(`${size}: a title is shown as text, never as markup`, q.title === '<b>Raid</b> notes' && !q.bold && q.mode === 'plan' && !q.warn);
  await page.evaluate(() => { const p = window.preview; p.state.quest = null; p.emit('status', p.state); });
  check(`${size}: with no quest open in the game the row is not shown`, !(await quest()).shown);
  await openControl('quest-auto', width);
  q = await quest();
  check(`${size}/quest-auto: a quest opened in Auto shows its risk without a click`, q.shown && q.title === 'Tidy the raid macros' && q.mode === 'auto' && q.warn);
  // The two switches: off by default, worded with their risk, written through uiSettings under the names main reads.
  await openControl('linked', width);
  const switches = () => page.evaluate(() => ['ui-click', 'ui-inherit'].map(id => { const b = document.getElementById(id); return `${b.checked ? 'on' : 'off'}${b.disabled ? ' disabled' : ''}`; }).join());
  check(`${size}: both switches are off by default and can be changed`, await switches() === 'off,off');
  check(`${size}: the switches say what they risk, word for word`, await page.locator('label[for="ui-click"]').textContent() === 'Approve by mouse click'
    && await page.locator('#ui-click-sh').textContent() === 'Off by default: another addon could place a request where you are about to click. With this off, approve with your Approve key or here.'
    && await page.locator('label[for="ui-inherit"]').textContent() === 'Use my existing agent configuration'
    && await page.locator('#ui-inherit-sh').textContent() === 'Off by default: allow rules, hooks and MCP servers from your own Claude or Codex settings would apply to quests started in game. Project instructions (CLAUDE.md) are always read.');
  await page.locator('#ui-click').check();
  await page.waitForFunction(() => document.querySelector('.set:has(#ui-click) > .fb').textContent);
  await page.locator('#ui-inherit').check();
  await page.waitForFunction(() => document.querySelector('.set:has(#ui-inherit) > .fb').textContent);
  check(`${size}: each switch sends one preference by the name main reads, and stays on and usable`,
    JSON.stringify(await uiWrites()) === JSON.stringify([{ approveByClick: true }, { inheritAgentConfig: true }]) && await switches() === 'on,on'
    && (await feedback('#ui-click')).text === 'Clicking Approve on the in-game card now counts');
  await page.evaluate(() => { const p = window.preview; delete p.state.ui.approveByClick; p.emit('status', p.state); });
  check(`${size}: a main that does not report a switch shows it off and fixed`, await switches() === 'off disabled,on');
  await page.evaluate(() => { const p = window.preview; p.state.ui.approveByClick = false; p.emit('status', p.state); });
  check(`${size}: once reported again the switch can be changed again`, await switches() === 'off,on');
  await page.locator('#ui-inherit').uncheck();
  await page.waitForFunction(() => window.preview.calls.filter(c => c.cmd === 'uiSettings').length === 3);
  check(`${size}: switching off sends false`, JSON.stringify((await uiWrites()).at(-1)) === '{"inheritAgentConfig":false}' && await switches() === 'off,off');
}
// No Approve key and click approval off (the default until a key is set): requests can only be approved in this window.
async function controlNoKeyJourney(width) {
  const size = `control-${width}/no-key`;
  await openControl('no-key', width);
  check(`${size}: Safety says plainly that requests can only be approved here until a key is set, with Set key and how to bind it`,
    await page.locator('#approve-key-line').textContent() === ONLY_HERE && await page.locator('#approve-key-line').getAttribute('class') === 'warn'
    && await page.locator('#b-key-set').textContent() === 'Set key…' && await shown('#approve-key-how') && !await shown('#b-key-clear'));
  check(`${size}: with nothing waiting the status line stays All set`, await page.locator('#journey-title').textContent() === 'All set — type /fam in WoW');
  await snapshot(`control-${width}-no-key`);
  await openControl('request-waiting', width);
  const line = () => page.evaluate(() => ({ title: document.getElementById('journey-title').textContent, cls: document.getElementById('journey-title').className,
    text: document.getElementById('journey-text').textContent, textWarn: document.getElementById('journey-text').classList.contains('warn'),
    action: document.getElementById('journey-action').hidden ? null : document.getElementById('journey-action').textContent }));
  let l = await line();
  check(`${size}/waiting: the status line says the request can only be approved here, with Set key right there`, l.title === 'A request is waiting above' && l.cls === 'warn'
    && l.text === ONLY_HERE && l.textWarn && l.action === 'Set key…' && await page.locator('#requests').isVisible());
  await snapshot(`control-${width}-request-waiting-no-key`);
  await page.locator('#journey-action').click();
  check(`${size}/waiting: Set key goes straight to "Press a key…" on the Approve key row`, await page.locator('#b-key-set').evaluate(el => document.activeElement === el
    && el.getAttribute('aria-pressed') === 'true' && el.textContent === 'Press a key…') && await page.locator('#approve-key-line').textContent() === 'Press the key you bound in WoW. Escape cancels.');
  await page.keyboard.press('F9');
  await page.waitForFunction(() => document.getElementById('journey-title').textContent === 'All set — type /fam in WoW'); // the next status tick
  l = await line();
  check(`${size}/waiting: pressing F9 registers it, and the status line goes back to All set`, JSON.stringify(await uiWrites()) === '[{"approveKey":"F9"}]'
    && await page.locator('#approve-key-line').textContent() === 'Registered: F9 — Familiar checks the real keyboard for it' && !await shown('#approve-key-how') && l.action === null);
  await page.waitForTimeout(700); // a click within 600 ms of a captured key is that key's Space/Enter, not a new click
  await page.locator('#b-key-set').click();
  await page.keyboard.press('Escape');
  check(`${size}: Escape cancels without a write`, (await uiWrites()).length === 1 && await page.locator('#b-key-set').getAttribute('aria-pressed') === 'false');
  await page.locator('#b-key-set').click();
  await page.keyboard.press('w');
  await page.waitForFunction(() => window.preview.calls.filter(c => c.cmd === 'uiSettings').length === 2);
  check(`${size}: a bare letter is registered but warned about`, JSON.stringify((await uiWrites()).at(-1)) === '{"approveKey":"W"}'
    && await page.locator('#approve-key-warn').textContent() === 'That key is used for playing; pick an F-key or a Ctrl/Shift combination.');
  await page.evaluate(() => { const p = window.preview; p.state.ui.approveKey = ''; p.state.ui.approveByClick = true; p.emit('status', p.state); });
  check(`${size}: with click approval on, no key is not a warning and the status line stays as it was`, (await page.locator('#approve-key-line').textContent()).startsWith('None set: approve by clicking')
    && (await line()).title === 'All set — type /fam in WoW');
}
async function controlEssentialsJourney(width) {
  const size = `control-${width}/essentials`;
  await openControl('linked', width);
  check(`${size}: Text size says when the quest list follows`, await page.locator('#ui-font-sh').textContent() === 'Replies change at once; the quest list after /reload.');
  // Privacy: one control, one uiSettings { privacy } write per change (main moves both saved settings), its hint following the level.
  await page.locator('#ui-privacy').selectOption('blur');
  await page.waitForFunction(() => window.preview.state.ui.streamSafe === true);
  check(`${size}: Hide names and blur replies sends one privacy write and keeps approval cards readable by its hint`, JSON.stringify(await uiWrites()) === '[{"privacy":"blur"}]'
    && (await page.locator('#ui-privacy-sh').textContent()).includes('Approval cards are never blurred'));
  await page.locator('#ui-privacy').selectOption('names');
  await page.waitForFunction(() => window.preview.state.ui.privateMode === true && window.preview.state.ui.streamSafe === false);
  await page.waitForFunction(() => document.querySelector('.set:has(#ui-privacy) > .fb')?.textContent);
  check(`${size}: from blur to Hide names is one write too`, JSON.stringify((await uiWrites()).slice(1)) === '[{"privacy":"names"}]'
    && (await feedback('#ui-privacy')).text === 'Names hidden on the Glass');
  // The default mode: the warning and the header pill only for the modes that act without asking.
  const mode = () => page.evaluate(() => ({ warn: !document.getElementById('ui-mode-warn').hidden, badge: document.getElementById('modebadge').hidden ? null : document.getElementById('modebadge').textContent }));
  check(`${size}: the mode hint recommends Ask first and says modes are changed here`, await page.locator('#ui-mode-hint').textContent() === 'Ask first is recommended. Modes are changed here, not in the game.');
  await page.locator('#ui-mode').selectOption('auto');
  check(`${size}: an Auto default shows the warning and the header pill`, JSON.stringify(await mode()) === JSON.stringify({ warn: true, badge: 'New quests: Auto' }));
  await snapshot(`control-${width}-mode-auto-warning`);
  await page.locator('#ui-mode').selectOption('plan');
  check(`${size}: a Plan only default shows no warning; the pill names it`, JSON.stringify(await mode()) === JSON.stringify({ warn: false, badge: 'New quests: Plan only' }));
  await page.locator('#ui-mode').selectOption('ask');
  check(`${size}: an Ask first default shows neither`, JSON.stringify(await mode()) === JSON.stringify({ warn: false, badge: null }));
}
async function overlayStorageJourney() {
  await page.setViewportSize({ width: 1280, height: 800 });
  const text = 'Recent changes could not be saved. Keep Familiar open. New messages will not be sent until a save succeeds.';
  const details = `[data-act*='"what":"details"']`;
  for (const scenario of ['welcome', 'finished']) {
    await open(scenario);
    await page.evaluate(({ text, layout }) => { const p = window.preview; p.model.storage = { level: 'error', text };
      p.emit('model', { ...p.model }); if (layout) p.emit('layout', layout); }, { text, layout: scenario === 'finished' ? layoutFor(720, true) : null });
    await settle();
    const warning = page.locator('#content .notice[role="status"]');
    const expected = scenario === 'welcome' ? text : 'Saving needs attention';
    check(`${scenario}/storage: persistent guidance is visible with empty or focused conversation`, await warning.textContent() === expected && await warning.isVisible());
    check(`${scenario}/storage: warning does not start work`, await page.evaluate(() => window.preview.calls.length) === 0);
    await snapshot(`${scenario}-storage-warning`);
    await page.evaluate(() => { const p = window.preview; p.emit('model', { ...p.model }); });
    check(`${scenario}/storage: unchanged model keeps warning`, await warning.textContent() === expected);
  }

  // The same constrained external-history state as the healthy journey above. Exceptional
  // guidance uses the existing Details disclosure and normal scroll flow, never a tall sticky panel.
  await page.setViewportSize({ width: 1180, height: 757 });
  await open('history-earlier');
  await page.evaluate(l => { const p = window.preview; p.model.fontScale = 1.6; p.emit('model', { ...p.model }); p.emit('layout', l); }, layoutFor(560, true));
  await settle();
  await wheel(12);
  const beforeWarning = await anchor();
  await page.evaluate(text => { const p = window.preview; p.model.storage = { level: 'error', text }; p.emit('model', { ...p.model }); }, text);
  await settle();
  await sameAnchor(beforeWarning, 'storage narrow history: new failure preserves the wheel reading anchor');
  const geometry = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    const scroll = document.getElementById('detail-scroll'), header = document.querySelector('.qhead');
    return { header: rect(header), scroll: rect(scroll), latest: rect(document.getElementById('latest')),
      clearTranscript: scroll.getBoundingClientRect().bottom - header.getBoundingClientRect().bottom,
      lineHeight: parseFloat(getComputedStyle(document.getElementById('content')).lineHeight) };
  });
  report.interactions.push({ label: 'storage-external-history-560-160-at-1180', geometry });
  check('storage narrow history: exceptional summary leaves a complete transcript line', geometry.clearTranscript + 1 >= geometry.lineHeight);
  check('storage narrow history: Details is closed and desktop/history context stays visible', await page.locator(details).getAttribute('aria-expanded') === 'false'
    && (await page.locator('.qstate').textContent()).includes('Desktop conversation')
    && await page.locator(action('more')).count() === 1 && await page.locator('.storage-detail').count() === 0);
  await point(details);
  await point(action('more'));
  await point('#latest');
  check('storage narrow history: Latest stays outside the readable transcript', geometry.latest.top >= geometry.scroll.bottom - 1);
  await snapshot('storage-external-history-560-160');
  const beforeDetails = await anchor();
  await click(details);
  await sameAnchor(beforeDetails, 'storage narrow history: expanding guidance preserves reading anchor');
  check('storage narrow history: full guidance and context are outside the sticky header', await page.locator('.storage-detail .notice').textContent() === text
    && (await page.locator('.storage-detail').textContent()).includes('Ask first')
    && await page.locator('.qhead .notice').count() === 1
    && await page.locator('#content [role="status"]').count() === 1);
  await click(details);
  await sameAnchor(beforeDetails, 'storage narrow history: collapsing guidance preserves reading anchor');
  check('storage narrow history: existing Details closes the guidance without dispatch', await page.locator('.storage-detail').count() === 0
    && await page.evaluate(() => window.preview.calls.length) === 0);
  await click(details);
  await wheel(10000);
  const guidance = page.locator('.storage-detail .notice');
  check('storage narrow history: wheel reaches the start of the full recovery explanation', await guidance.evaluate(el => {
    const r = el.getBoundingClientRect(), h = document.querySelector('.qhead').getBoundingClientRect(), s = document.getElementById('detail-scroll').getBoundingClientRect();
    return r.top >= h.bottom - 1 && r.top < s.bottom;
  }));
  // Scroll its last line into the readable strip through the real incoming wheel handler.
  const steps = await guidance.evaluate(el => {
    const bottom = document.getElementById('detail-scroll').getBoundingClientRect().bottom;
    const step = 4 * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h'));
    return Math.max(0, (el.getBoundingClientRect().bottom - bottom) / step);
  });
  await wheel(-steps);
  check('storage narrow history: wheel reaches the end of the full recovery explanation', await guidance.evaluate(el => {
    const r = el.getBoundingClientRect(), h = document.querySelector('.qhead').getBoundingClientRect(), s = document.getElementById('detail-scroll').getBoundingClientRect();
    return r.bottom > h.bottom && r.bottom <= s.bottom + 1;
  }));
  await snapshot('storage-external-history-guidance-560-160');
  await point(details);
  await point('#latest');
  await click('#latest');
  check('storage narrow history: Latest reaches the end while the persistent warning remains', await page.locator('#detail-scroll').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    && await page.locator('.storage-summary').textContent() === 'Saving needs attention');
  await wheel(12);
  await click(details);
  const beforeClear = await anchor();
  await page.evaluate(() => { const p = window.preview; delete p.model.storage; p.emit('model', { ...p.model }); });
  await settle();
  await sameAnchor(beforeClear, 'storage narrow history: clearing a retryable warning preserves reading anchor');
  check('storage narrow history: clearing restores healthy space and does not dispatch', await page.locator('.storage-summary, .storage-detail').count() === 0
    && await page.evaluate(() => window.preview.calls.length) === 0);
  await page.setViewportSize({ width: 1280, height: 800 });
}
async function focusJourney() {
  const details = `[data-act*='"what":"details"']`;
  const review = `[data-act*='"what":"focusReview"']`;
  for (const width of [720, 560, 1100]) for (const font of [0.8, 1, 1.6]) {
    await open('handoff-long');
    await page.evaluate(({ font, l }) => {
      const p = window.preview;
      p.model.fontScale = font;
      p.model.detail.todos = [{ text: 'An explicit synthetic objective', status: 'in_progress' }];
      p.emit('model', { ...p.model });
      p.emit('layout', l);
    }, { font, l: layoutFor(width, false) });
    await settle();
    await wheel(12);
    const before = await anchor();
    await page.evaluate(l => window.preview.emit('layout', l), layoutFor(width, true));
    await settle();
    const label = `focus-${width}-${Math.round(font * 100)}`;
    await sameAnchor(before, `${label}: entry crop preserves reading anchor`);
    if (width === 720 && font === 1) {
      await page.evaluate(l => window.preview.emit('layout', { ...l, panel: false }), layoutFor(width, true));
      await settle();
      await page.evaluate(l => window.preview.emit('layout', l), layoutFor(width, true));
      await settle();
      await sameAnchor(before, `${label}: close and reopen keep focus reading place`);
    }
    const geometry = await page.locator('.qfocus-line').evaluate(el => {
      const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
      const title = el.querySelector('.qfocus-title'), name = el.querySelector('.qfocus-name'), actions = el.querySelector('.qfocus-actions');
      const controls = [...actions.children].map(rect);
      return { row: rect(el), title: rect(title), name: rect(name), actions: rect(actions), controls,
        provider: title.querySelector('.ag').textContent, overflow: el.scrollWidth > el.clientWidth + 1 };
    });
    report.interactions.push({ label, geometry });
    check(`${label}: title/provider and complete controls remain readable`, geometry.name.width >= 55
      && geometry.provider.includes('Claude') && !geometry.overflow
      && geometry.controls.every(c => c.width > 30 && c.x >= geometry.row.x - 1 && c.right <= geometry.row.right + 1));
    if (width >= 720) check(`${label}: title Continue and Details share one row`, Math.abs(geometry.title.y - geometry.actions.y) < 8);
    check(`${label}: hidden surroundings are absent and objectives await Details`, await page.locator('#list').evaluate(e => getComputedStyle(e).display === 'none')
      && await page.locator('#attention').evaluate(e => getComputedStyle(e).display === 'none') && await page.locator('.objectives').count() === 0);
    check(`${label}: handoff has full accessible destination`, await page.locator(action('openInApp')).getAttribute('aria-label') === 'Continue in Claude app');
    await click(details);
    check(`${label}: Details reveals full context and objectives without acting`, (await page.locator('.qhead').textContent()).includes('Continue opens this conversation in Claude app')
      && (await page.locator('.qhead').textContent()).includes('C:\\preview') && await page.locator('.objectives').count() === 1
      && await page.evaluate(() => window.preview.calls.length) === 0);
    await click(details);
    await sameAnchor(before, `${label}: Details roundtrip preserves anchor`);
    await snapshot(label);
    await page.evaluate(l => window.preview.emit('layout', l), layoutFor(width, false));
    await settle();
    await sameAnchor(before, `${label}: Full view restores reading anchor`);
    check(`${label}: Full view keeps the separate two-row header`, await page.locator('.qtitle').count() === 1 && await page.locator('.qbar').count() === 1);
  }
  await open('welcome');
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(720, true));
  await settle();
  check('focus without a thread: restores through native Full view instead of a hidden picker',
    (await page.locator('#content').textContent()).includes('Use Full view below') && await page.locator('#content [data-act]').count() === 0);
  await open('quiet');
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(720, true));
  await settle();
  const beforeReview = await page.evaluate(() => ({ selected: window.preview.model.detail.id, attention: JSON.stringify(window.preview.model.attention), calls: window.preview.calls.length }));
  check('focus review: other requests remain signalled', (await page.locator(review).textContent()).startsWith('Other quests: '));
  await click(review);
  check('focus review: disclosure gives native restore guidance', (await page.locator('#focus-review').textContent()).includes('Use Full view below'));
  check('focus review: expanded disclosure retains nonzero other-thread counts', (await page.locator(review).textContent()) === 'Other quests: 2 need you · 1 reply ready · Hide');
  check('focus review: disclosure neither navigates nor acknowledges', await page.evaluate(before => window.preview.model.detail.id === before.selected
    && JSON.stringify(window.preview.model.attention) === before.attention && window.preview.calls.length === before.calls, beforeReview));
  await snapshot('focus-other-review');
  await open('handoff-long');
  await page.evaluate(l => {
    const p = window.preview;
    p.model.fontScale = 1.6;
    p.model.attention = [{ thread: 'other', entry: 'other-request', title: 'Other conversation', pending: true, label: 'Needs you' }];
    p.emit('model', { ...p.model });
    p.emit('layout', l);
  }, layoutFor(560, true));
  await settle();
  await wheel(12);
  const beforeLongReview = await anchor();
  await click(review);
  check('focus long history: expanded review omits zero counts', (await page.locator(review).textContent()) === 'Other quests: 1 needs you · Hide');
  await sameAnchor(beforeLongReview, 'focus long history: opened other-thread review keeps anchor');
  await click(review);
  await sameAnchor(beforeLongReview, 'focus long history: closing other-thread review keeps anchor');
  await click(review);
  await page.evaluate(() => {
    const p = window.preview;
    p.model.detail.entries.push({ id: 'focus-appended-before-latest', kind: 'assistant', text: 'A new reply while older history is being read.' });
    p.emit('model', { ...p.model });
  });
  await settle();
  await sameAnchor(beforeLongReview, 'focus long history: a new reply does not pull an older reader to the end');
  const footerGeometry = await page.evaluate(() => {
    const latest = document.getElementById('latest').getBoundingClientRect();
    const footer = document.getElementById('focus-review').getBoundingClientRect();
    const scroll = document.getElementById('detail-scroll');
    const header = document.querySelector('.qhead');
    return { latestTop: latest.top, footerBottom: footer.bottom, readableHeight: scroll.clientHeight - header.offsetHeight,
      lineHeight: parseFloat(getComputedStyle(document.getElementById('content')).lineHeight) };
  });
  report.interactions.push({ label: 'focus-long-open-review', footerGeometry });
  check('focus long history: Latest is docked under the opened review line, outside the transcript', footerGeometry.latestTop >= footerGeometry.footerBottom - 1);
  check('focus long history: opened review leaves at least two transcript lines beneath the header', footerGeometry.readableHeight >= footerGeometry.lineHeight * 2);
  await point('#latest');
  await snapshot('focus-long-open-review');
  await click('#latest');
  check('focus long history: explicit Latest still reaches the newest message', await page.locator('#latest').evaluate(el => getComputedStyle(el).display === 'none')
    && await page.evaluate(() => window.preview.calls.length) === 0);
  await page.evaluate(() => {
    const p = window.preview;
    p.model.detail.entries.push({ id: 'focus-appended-after-latest', kind: 'assistant', text: 'Follow this reply only after the explicit Latest action.' });
    p.emit('model', { ...p.model });
  });
  await settle();
  check('focus long history: later replies follow after explicit Latest', await page.locator('#detail-scroll').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2));

  await open('approval-long');
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(560, true));
  await settle();
  check('focus approval: entire pending payload remains rendered', await page.locator('.approval-preview').textContent() === await page.evaluate(() => window.preview.model.detail.entries[0].text));
  await wheel(-10000);
  // approval-long is a cut request: Deny is its only decision in the game (UX round 3).
  check('focus approval: explicit request-bound decisions remain reachable', await page.locator(action('decide')).count() === 1
    && await page.locator(`${action('decide')}[data-act*='"decision":"deny"']`).count() === 1);
  await point(`${action('decide')}[data-act*='"decision":"deny"']`);
  await snapshot('focus-approval-bottom');
  // A new, complete request must still be read to the end in this short pane.
  await page.evaluate(() => {
    const p = window.preview;
    const previous = p.model.detail.entries[0];
    p.model.detail.entries = [{ ...previous, id: 'focus-complete', requestId: 'focus-complete', cut: false,
      text: Array.from({ length: 20 }, (_, i) => 'Review fixture line ' + i).join('\n') }];
    p.emit('model', { ...p.model });
  });
  await settle();
  const focusGrant = page.locator('#pinned .grant');
  check('focus approval: a fresh complete request keeps the grant hidden before its tail', await focusGrant.count() === 1 && !await focusGrant.isVisible());
  await point(`${action('decide')}[data-act*='"decision":"deny"']`);
  for (let i = 0; i < 80 && !await focusGrant.isVisible(); i++) await wheel(-1);
  check('focus approval: forwarded scrolling reveals the grant at the end', await focusGrant.isVisible()
    && await page.locator('#pinned .card-read').evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 2));
  await point('#pinned .grant');
  await open('running');
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(720, true));
  await settle();
  await click(action('stop'));
  check('focus working: Stop sends only the displayed thread identity', await page.evaluate(() => window.preview.calls.length === 1
    && window.preview.calls[0].type === 'stop' && window.preview.calls[0].thread === window.preview.model.detail.id));
  await snapshot('focus-working-stop');

  // Reproduce the external-history state at the observed viewport scale, not only k=1.
  await page.setViewportSize({ width: 1180, height: 757 });
  await open('history-earlier');
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(720, false));
  await settle();
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(560, false));
  await settle();
  await page.evaluate(() => {
    const p = window.preview;
    p.model.fontScale = 1.6;
    p.emit('model', { ...p.model });
  });
  await settle();
  await wheel(1);
  const beforeHistoryFocus = await anchor();
  await page.evaluate(l => window.preview.emit('layout', l), layoutFor(560, true));
  await settle();
  await sameAnchor(beforeHistoryFocus, 'focus external history: minimum-width entry preserves the wheel reading anchor');
  const historyGeometry = await page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const row = document.querySelector('.qfocus-line'), title = document.querySelector('.qfocus-title');
    const provider = title.querySelector('.ag'), name = title.querySelector('.qfocus-name');
    const actions = document.querySelector('.qfocus-actions'), scroll = document.getElementById('detail-scroll');
    const header = document.querySelector('.qhead');
    return { row: rect(row), title: rect(title), provider: rect(provider), name: rect(name), actions: rect(actions),
      providerText: provider.textContent, providerFits: provider.scrollWidth <= provider.clientWidth + 1,
      providerLineHeight: parseFloat(getComputedStyle(provider).lineHeight),
      header: rect(header), scroll: rect(scroll), latest: rect(document.getElementById('latest')),
      clearTranscript: scroll.getBoundingClientRect().bottom - header.getBoundingClientRect().bottom,
      lineHeight: parseFloat(getComputedStyle(document.getElementById('content')).lineHeight),
      overflow: row.scrollWidth > row.clientWidth + 1 };
  });
  report.interactions.push({ label: 'focus-external-history-560-160-at-1180', geometry: historyGeometry });
  check('focus external history: provider title and Details fit one readable row', !historyGeometry.overflow
    && Math.abs(historyGeometry.title.top - historyGeometry.actions.top) < 8 && historyGeometry.name.width >= 56
    && historyGeometry.providerText.includes('Claude') && historyGeometry.providerFits
    && historyGeometry.provider.height <= historyGeometry.providerLineHeight + 1
    && historyGeometry.provider.left >= historyGeometry.title.left - 1 && historyGeometry.provider.right <= historyGeometry.title.right + 1
    && historyGeometry.actions.right <= historyGeometry.row.right + 1);
  await point(details);
  check('focus external history: closed Details preserves desktop and history context', await page.locator(details).getAttribute('aria-expanded') === 'false'
    && await page.locator('#focus-review').evaluate(el => getComputedStyle(el).display === 'none')
    && (await page.locator('.qstate').textContent()).includes('Desktop conversation')
    && (await page.locator('.qstate').textContent()).includes('Asks before continuing here')
    && await page.locator(action('more')).count() === 1);
  await point(action('more'));
  // Rectangles and font metrics are fractional CSS pixels; permit at most one pixel of rounding.
  check('focus external history: two transcript lines fit within pixel rounding', historyGeometry.clearTranscript + 1 >= historyGeometry.lineHeight * 2);
  check('focus external history: Latest stays outside the readable transcript', historyGeometry.latest.top >= historyGeometry.scroll.bottom - 1);
  await point('#latest');
  await snapshot('focus-external-history-560-160');
  await click('#latest');
  check('focus external history: explicit Latest still reaches the end without provider actions', await page.locator('#detail-scroll').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
    && await page.locator('#latest').evaluate(el => getComputedStyle(el).display === 'none')
    && await page.evaluate(() => window.preview.calls.length) === 0);
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function compactHeaderJourney(narrow) {
  const size = narrow ? 'narrow-large-text' : 'standard';
  const details = `[data-act*='"what":"details"']`;
  await open('handoff-long', narrow);
  const geometry = () => page.locator('.qhead').evaluate(el => ({ height: el.getBoundingClientRect().height,
    contentHeight: document.getElementById('detail-scroll').clientHeight, children: [...el.children].map(e => e.className) }));
  const compact = await geometry();
  check(`${size}/header: ordinary handoff has only title and action rows`, compact.children.length === 2
    && compact.children[0] === 'qtitle' && compact.children[1] === 'qbar' && compact.height < compact.contentHeight / 3
    && await page.locator('.qhead .qmeta, .qhead .qstate').count() === 0);
  const chip = () => page.evaluate(() => {
    const el = document.querySelector('.qhead .qbar .qmode');
    return { count: document.querySelectorAll('.qhead .qbar .qmode').length, text: el?.textContent, hot: el?.classList.contains('hot'),
      color: el && getComputedStyle(el).color, firstInBar: document.querySelector('.qhead .qbar')?.firstElementChild === el };
  });
  const askFirst = await chip();
  check(`${size}/header: mode chip leads the action row`, askFirst.count === 1 && askFirst.text === 'Ask first' && !askFirst.hot && askFirst.firstInBar);
  await page.evaluate(() => { const p = window.preview; p.model.detail.mode = 'Accept edits'; p.emit('model', { ...p.model }); });
  const hot = await chip();
  check(`${size}/header: any mode other than Ask first is highlighted`, hot.count === 1 && hot.text === 'Accept edits' && hot.hot && hot.color !== askFirst.color
    && (await geometry()).children.join() === 'qtitle,qbar');
  // Only the modes that act without asking are orange; Plan only and Ask first stay gold.
  for (const [mode, hotCount] of [['Plan only', 0], ['Accept edits', 1], ['Auto', 1], ['Ask first', 0]]) {
    await page.evaluate(mode => { const p = window.preview; p.model.detail.mode = mode; p.emit('model', { ...p.model }); }, mode);
    check(`${size}/header: ${mode} chip is ${hotCount ? 'orange' : 'gold'}`, await page.locator('.qmode.hot').count() === hotCount
      && (await chip()).text === mode);
  }
  await page.evaluate(() => { const p = window.preview; p.model.detail.mode = 'Ask first'; p.emit('model', { ...p.model }); });
  check(`${size}/header: provider and handoff action remain visible`, (await page.locator('.qtitle').textContent()).includes('Claude')
    && (await page.locator(action('openInApp')).textContent()).includes('Continue in Claude app'));
  check(`${size}/header: long title stays on one readable line`, await page.locator('.qtitle').evaluate(el =>
    el.scrollWidth > el.clientWidth && el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1));
  await wheel(12);
  const before = await anchor();
  await click(details);
  await sameAnchor(before, `${size}/header: opening Details preserves reading anchor`);
  const context = await page.locator('.qmeta').textContent();
  check(`${size}/header: Details exposes project/model and current permissions without a provider action`, context.includes('Preview project')
    && context.includes('Ask first') && context.includes('haiku') && await page.evaluate(() => window.preview.calls.length) === 0);
  await page.evaluate(() => window.preview.emit('model', { ...window.preview.model }));
  check(`${size}/header: harmless model push keeps Details expanded`, await page.locator(details).getAttribute('aria-expanded') === 'true');
  await sameAnchor(before, `${size}/header: expanded status push keeps reading anchor`);
  const expanded = await geometry();
  await click(details);
  await sameAnchor(before, `${size}/header: closing Details preserves reading anchor`);
  check(`${size}/header: collapsing Details actually reclaims transcript space`, expanded.height > compact.height + 4
    && Math.abs((await geometry()).height - compact.height) <= 1);
  await click(details, 2);
  check(`${size}/header: repeated Details clicks stay inert and return compact`, await page.locator(details).getAttribute('aria-expanded') === 'false'
    && await page.evaluate(() => window.preview.calls.length) === 0);
  await click(details);
  await page.getByRole('button', { name: 'Other quest', exact: true }).click();
  check(`${size}/header: a different quest starts with compact Details`, await page.locator(details).getAttribute('aria-expanded') === 'false');
  await page.getByRole('button', { name: 'Long quest', exact: true }).click();
  await sameAnchor(before, `${size}/header: quest return restores reading position with compact height`);
  await snapshot(`${size}-compact-handoff-header`);
  await click(action('openInApp'));
  check(`${size}/header: handoff retains its existing action identity`, await page.evaluate(() => window.preview.calls.length === 1
    && window.preview.calls[0].type === 'openInApp'));
  await page.evaluate(() => { const p = window.preview; p.model.detail.status = 'error'; p.emit('model', p.model); });
  check(`${size}/header: error and handoff action remain reachable together`, (await page.locator('.qstate').textContent()).includes('Needs attention')
    && !!await point(action('openInApp')));
  for (const scenario of ['finished', 'running', 'interrupted', 'desktop', 'quiet', 'approval', 'approval-always', 'approval-long', 'approval-permissions',
    'approval-expired', 'approval-resolved', 'history-error', 'history-earlier', 'history-empty', 'history-loading']) {
    await open(scenario, narrow);
    const mode = await chip();
    const children = (await geometry()).children;
    check(`${size}/header-${scenario}: one mode chip in the action row shows the quest mode`, mode.count === 1 && mode.firstInBar
      && mode.text === await page.evaluate(() => window.preview.model.detail.mode));
    check(`${size}/header-${scenario}: chip adds no header row`, children[0] === 'qtitle' && children[1] === 'qbar'
      && !children.some(c => /\b(qmode|qmeta|qstate)\b/.test(c)));
  }
  for (const [scenario, label] of [['approval', 'Needs you'], ['interrupted', 'Interrupted'], ['history-error', 'History unavailable']]) {
    await open(scenario, narrow);
    check(`${size}/header-${scenario}: exceptional state stays visible without Details`, (await page.locator('.qstate').textContent()).includes(label)
      && await page.locator('.qstate').evaluate(el => {
        const r = el.getBoundingClientRect(), pane = document.getElementById('detail').getBoundingClientRect();
        return r.top >= pane.top && r.bottom <= pane.bottom && r.right <= pane.right;
      }) && await page.locator(details).getAttribute('aria-expanded') === 'false');
  }
}
try {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Preview server stopped: ${serverLog}`);
    try { if ((await fetch(`${origin}/overlay.html`)).ok) break; } catch {}
    if (i === 99) throw new Error('Preview server did not become ready');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    report.errors.push(`Unexpected external request: ${route.request().url()}`);
    return route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  for (const width of [760, 520]) {
    await controlLayoutJourney(width); await controlFailureJourney(width); await controlStorageJourney(width);
    await controlRequestsJourney(width); await controlSafetyJourney(width); await controlNoKeyJourney(width); await controlEssentialsJourney(width);
    for (const [name, passed] of Object.entries(await controlRound4Journey(page, origin, width, snapshot))) check(name, passed);
  }
  await controlHeightJourney();
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const narrow of [false, true]) await compactHeaderJourney(narrow);
  for (const narrow of [false, true]) {
    const size = narrow ? 'narrow-large-text' : 'standard';
    for (const scenario of ['welcome', 'welcome-unready']) {
      await open(scenario, narrow);
      const text = await page.locator('#content').textContent();
      const bar = await page.locator('#status').textContent();
      const initial = await page.evaluate(() => ({ chat: window.preview.model.detail.chat, calls: window.preview.calls, state: window.preview.state.chat }));
      check(`${size}/${scenario}: task-first choices appear in order`, text.indexOf('Ask a game question') < text.indexOf('Work on a project') && text.indexOf('Work on a project') < text.indexOf('Continue a conversation'));
      check(`${size}/${scenario}: starts at the first choice`, await page.locator('#detail-scroll').evaluate(el => el.scrollTop < 2));
      // Round 7 (deliberate): was "provider and model are visible before opening" (the welcome's own text named the Chat
      // provider, model and status). Now: the status bar names the Chat provider and its state before opening; the model is
      // named on the draft (checked below, "draft names its provider and model").
      check(`${size}/${scenario}: the Chat provider and its readiness are visible before opening (status bar)`, bar.includes(initial.chat.label)
        && (scenario === 'welcome' ? bar.includes(`${initial.chat.label} ✓`) : !bar.includes(`${initial.chat.label} ✓`)));
      check(`${size}/${scenario}: no automatic action`, initial.calls.length === 0);
      // Round 7 (deliberate): the unready branch was the welcome's own per-familiar lines ("switched off", "not ready: Sign in
      // required", "Hermes"); those moved to the status bar (Claude off · Codex ✗ · Hermes ✓), with the Chat row's own line.
      check(`${size}/${scenario}: link and readiness are truthful`, scenario === 'welcome'
        ? text.includes('Linked to Preview Rogue.') && bar.includes('Claude ✓') && bar.includes('Codex ✓')
        : text.includes('Waiting for the game link.') && bar.includes('Claude off') && bar.includes('Codex ✗') && bar.includes('Hermes ✓')
          && text.includes('Chat uses Claude or Codex'));
      if (scenario === 'welcome-unready') check(`${size}/${scenario}: Chat choices are distinct from project-ready providers`, text.includes('Chat uses Claude or Codex'));
      const projectText = await page.locator('.welcome-project').textContent();
      check(`${size}/${scenario}: project starters reflect ready providers`, scenario === 'welcome'
        ? projectText.includes('+ Claude') && projectText.includes('+ Codex')
        : projectText.includes('/fam hermes') && !projectText.includes('+ Claude') && !projectText.includes('+ Codex'));
      check(`${size}/${scenario}: no transcript-only Latest control`, await page.locator('#latest').evaluate(el => getComputedStyle(el).display === 'none'));
      await snapshot(`${size}-${scenario}`);
      // Round 7 (deliberate): with Chat not ready the welcome has no + Chat (§2.1); its draft is still reached the other
      // existing way, the Quest Log's Chats row ("Ask anything: + Chat or /fam ask"), through the same newIn action.
      check(`${size}/${scenario}: + Chat only while Chat is ready`, await page.locator('.welcome-chat .btn').count() === (scenario === 'welcome' ? 1 : 0));
      if (scenario === 'welcome') await click('.welcome-chat .btn');
      else await click(`#list ${action('newIn')}[data-act*='"key":"chats"']:not(.zone)`, 1, 'list');
      const draft = await page.evaluate(() => ({ detail: window.preview.model.detail, calls: window.preview.calls, state: window.preview.state.chat }));
      check(`${size}/${scenario}: Chat opens only the configured draft`, draft.detail.kind === 'draft' && draft.detail.agent === initial.chat.id && draft.detail.model === initial.chat.model && draft.detail.chat === true);
      check(`${size}/${scenario}: uses only the existing draft action`, draft.calls.length === 1 && draft.calls[0].type === 'newIn' && draft.calls[0].key === 'chats');
      check(`${size}/${scenario}: opening keeps chat defaults`, JSON.stringify(draft.state) === JSON.stringify(initial.state));
      check(`${size}/${scenario}: draft retains readiness and model guidance`, (await page.locator('#content').textContent()).includes(draft.detail.provider.status) && (await page.locator('#content').textContent()).includes('Model'));
      check(`${size}/${scenario}: draft names its provider and model`, (await page.locator('#content .sub').first().textContent()).startsWith(`${initial.chat.label} · ${initial.chat.model}`));
      if (scenario === 'welcome-unready') check(`${size}/${scenario}: unready draft names Chat choices`, (await page.locator('#content').textContent()).includes('Chat uses Claude or Codex'));
      check(`${size}/${scenario}: draft fits pane width`, await page.locator('#detail-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await snapshot(`${size}-${scenario}-chat-draft`);
    }
    await open('approval', narrow);
    check(`${size}/approval: uncut request has no cut warning`, await page.locator('.preview-cut').count() === 0
      && await page.locator('.approval-preview').textContent() === await page.evaluate(() => window.preview.model.detail.entries.find(e => e.kind === 'approval').text));
    // Always is given in the control panel only: a card that offers it still draws Approve and Deny alone in game.
    for (const [decision, selector] of [['allow', '.btn.ok'], ['deny', '.btn.no']]) {
      await open('approval-always', narrow);
      const buttons = await page.locator(action('decide')).evaluateAll(els => els.map(el => ({ text: el.textContent, decision: JSON.parse(el.dataset.act).decision })));
      check(`${size}/approval-always: Approve and Deny only, no Always in game`, JSON.stringify(buttons.map(b => b.text)) === JSON.stringify(['Approve', 'Deny'])
        && JSON.stringify(buttons.map(b => b.decision)) === JSON.stringify(['allow', 'deny']) && await page.locator('.btn.always').count() === 0);
      if (decision === 'allow') await snapshot(`${size}-approval-always`);
      await click(selector);
      const calls = await page.evaluate(() => window.preview.calls);
      check(`${size}/approval-always: ${selector} sends exactly one ${decision}`, calls.length === 1 && calls[0].type === 'decide' && calls[0].decision === decision
        && calls[0].requestId === 'preview');
    }
    // Click approval off (the default): no Approve button; the card says which key approves, and Deny stays a click.
    await open('approval-always&click=0', narrow);
    check(`${size}/approval-always, key only: the card names the Approve key instead of an Approve button`, (await page.locator('.entry.approval .approve-pc.grant').textContent()) === 'Press F9 to approve'
      && JSON.stringify(await page.locator(action('decide')).evaluateAll(els => els.map(el => JSON.parse(el.dataset.act).decision))) === '["deny"]');
    await snapshot(`${size}-approval-key-only`);
    // The pending card names the folder it acts in.
    await open('approval-always', narrow);
    const card = () => page.evaluate(() => ({ where: [...document.querySelectorAll('.card-where')].map(e => e.textContent), cwd: window.preview.model.detail.cwd }));
    let pendingCard = await card();
    check(`${size}/approval-always: pending card names its zone and folder`, pendingCard.cwd.length > 0 && pendingCard.where.length === 1
      && pendingCard.where[0] === `In Preview project · ${pendingCard.cwd}`);
    await page.evaluate(() => { const p = window.preview; p.model.detail.cwd = ''; p.emit('model', { ...p.model }); });
    pendingCard = await card();
    check(`${size}/approval-always: a hidden folder is not shown`, JSON.stringify(pendingCard.where) === '["In Preview project"]' && await page.locator(action('decide')).count() === 2);
    check(`${size}/approval-always: no automatic action`, await page.evaluate(() => window.preview.calls.length) === 0);
    // Outcome unknown is a whole sentence on its own line, never clipped by the tool line.
    await open('interrupted', narrow);
    const unknown = await page.locator('.outcome-unknown').evaluate(el => {
      const r = el.getBoundingClientRect(), pane = document.getElementById('detail').getBoundingClientRect();
      return { fits: el.scrollWidth <= el.clientWidth + 1, inside: r.bottom <= pane.bottom && r.right <= pane.right + 1, text: el.textContent.trim() };
    });
    check(`${size}/interrupted: Outcome unknown is fully visible on its own line`, unknown.fits && unknown.inside && unknown.text.endsWith('resending'));
    await snapshot(`${size}-interrupted`);
    // Pending approvals are never shortened: the whole provider preview sits above Approve/Deny.
    for (const scenario of ['approval-long', 'approval-permissions']) {
      await open(scenario, narrow);
      const full = await page.evaluate(() => window.preview.model.detail.entries[0].text);
      await wheel(10000);
      await snapshot(`${size}-${scenario}-pending-top`);
      check(`${size}/${scenario}: pending preview shows all available text`, await page.locator('.approval-preview').textContent() === full && full.includes('characters omitted from this preview'));
      check(`${size}/${scenario}: pending preview has no shorten toggle`, await page.locator('.preview-toggle').count() === 0);
      const cut = await page.evaluate(() => {
        const cuts = document.querySelectorAll('.preview-cut'), pre = document.querySelector('.approval-preview');
        return { count: cuts.length, text: cuts[0]?.textContent, above: !!cuts[0] && cuts[0].getBoundingClientRect().bottom <= pre.getBoundingClientRect().top,
          outside: !!cuts[0] && !pre.contains(cuts[0]), red: !!cuts[0] && getComputedStyle(cuts[0]).color !== getComputedStyle(document.querySelector('.preview-note')).color };
      });
      check(`${size}/${scenario}: cut request carries one red warning above the preview`, cut.count === 1 && cut.text.includes('not shown') && cut.above && cut.outside && cut.red);
      await wheel(-10000);
      await snapshot(`${size}-${scenario}-pending-bottom`);
      check(`${size}/${scenario}: preview fits pane width`, await page.locator('#detail-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      // A cut request can't be approved from the game: Deny is its only decision (UX round 3).
      check(`${size}/${scenario}: decision controls match state`, await page.locator(action('decide')).count() === 1
        && await page.locator(`${action('decide')}[data-act*='"decision":"deny"']`).count() === 1);
      check(`${size}/${scenario}: no automatic action`, await page.evaluate(() => window.preview.calls.length) === 0);
      check(`${size}/${scenario}: approval state unchanged`, await page.evaluate(() => window.preview.model.detail.entries[0].approval) === 'pending');
    }
    for (const scenario of ['approval-expired', 'approval-resolved']) {
      await open(scenario, narrow);
      await wheel(10000); // Reach top through the real forwarded wheel handler.
      const compact = await page.locator('.approval-preview').textContent();
      await snapshot(`${size}-${scenario}-compact`);
      const before = await anchor();
      await click('.preview-toggle');
      check(`${size}/${scenario}: expands`, await page.locator('.preview-toggle').getAttribute('aria-expanded') === 'true');
      await sameAnchor(before, `${size}/${scenario}: expansion keeps reading anchor`, false);
      const expanded = await page.locator('.approval-preview').textContent();
      check(`${size}/${scenario}: shows more available text and original omission`, expanded.length > compact.length && expanded.includes('characters omitted from this preview'));
      await snapshot(`${size}-${scenario}-expanded-top`);
      await wheel(-10000);
      await snapshot(`${size}-${scenario}-expanded-bottom`);
      check(`${size}/${scenario}: preview fits pane width`, await page.locator('#detail-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await wheel(10000);
      await click('.preview-toggle');
      check(`${size}/${scenario}: collapses`, await page.locator('.approval-preview').textContent() === compact);
      await click('.preview-toggle', 2);
      const calls = await page.evaluate(() => window.preview.calls);
      check(`${size}/${scenario}: toggles never approve`, calls.length === 4 && calls.every(c => c.type === 'approvalPreview'));
      check(`${size}/${scenario}: repeated toggle returns compact`, await page.locator('.preview-toggle').getAttribute('aria-expanded') === 'false' && await page.locator('.approval-preview').textContent() === compact);
      check(`${size}/${scenario}: decision controls match state`, await page.locator(action('decide')).count() === (scenario === 'approval-expired' || scenario === 'approval-resolved' ? 0 : 2));
      const expectedState = scenario === 'approval-expired' ? 'expired' : scenario === 'approval-resolved' ? 'denied' : 'pending';
      check(`${size}/${scenario}: approval state unchanged`, await page.evaluate(() => window.preview.model.detail.entries[0].approval) === expectedState);
      if (expectedState !== 'pending') check(`${size}/${scenario}: truthful status`, (await page.locator('.card-s').textContent()).includes(expectedState === 'expired' ? 'Request expired' : 'Denied'));
    }
    await open('history-error', narrow);
    await snapshot(`${size}-history-error`);
    await click(action('retryHistory'), 3);
    check(`${size}/history: repeated Retry starts one request`, await page.evaluate(() => window.preview.calls.filter(c => c.type === 'retryHistory').length) === 1);
    check(`${size}/history: loading feedback`, (await page.locator('#content').textContent()).includes('Loading history'));
    await page.waitForFunction(() => !window.preview.model.detail.loading);
    check(`${size}/history: retry recovers`, await page.locator('.entry').count() === 5 && await page.locator('.history-error').count() === 0);
    await snapshot(`${size}-history-recovered`);

    await open('history-earlier', narrow);
    await wheel(12); // Read partway up the long conversation, not at either endpoint.
    const before = await anchor();
    await click(action('more'));
    await sameAnchor(before, `${size}/earlier: loading keeps anchor`);
    await page.waitForFunction(() => !window.preview.model.detail.loading);
    await sameAnchor(before, `${size}/earlier: failure keeps anchor`);
    check(`${size}/earlier: failed load retains messages`, await page.locator('.entry').count() === 36);
    await snapshot(`${size}-earlier-failed`);
    await click(action('retryHistory'), 3);
    await page.waitForFunction(() => !window.preview.model.detail.loading);
    await sameAnchor(before, `${size}/earlier: recovered prepend keeps content anchor despite renumbered IDs`);
    check(`${size}/earlier: one retry and five prepended messages`, await page.locator('.entry').count() === 41 && await page.evaluate(() => window.preview.calls.filter(c => c.type === 'retryHistory').length) === 1);
    await snapshot(`${size}-earlier-recovered`);

    for (const scenario of ['history-empty', 'history-loading']) {
      await open(scenario, narrow);
      const text = await page.locator('#content').textContent();
      check(`${size}/${scenario}: distinct feedback`, text.includes(scenario === 'history-empty' ? 'No saved messages' : 'Loading history'));
      check(`${size}/${scenario}: no misleading retry`, await page.locator(action('retryHistory')).count() === 0);
      await snapshot(`${size}-${scenario}`);
    }
  }
  await open('quiet');
  await click(`[data-act*='"what":"notes"']`); // the waiting banner is one line until it is opened (local: no action)
  const quiet = await page.evaluate(() => {
    const warn = document.querySelector('.catch-title .warn');
    const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.t')?.textContent === 'Review a file edit');
    return { warn: warn && getComputedStyle(warn).color, body: getComputedStyle(document.body).color, label: warn?.textContent,
      meta: [...document.querySelectorAll('.catch-meta')].map(e => e.textContent).join('|'),
      rowText: row && getComputedStyle(row.querySelector('.t')).color, rowGlyph: row && getComputedStyle(row.querySelector('.st')).color };
  });
  check('quiet: Needs you stands out from body text', quiet.label === 'Needs you' && !!quiet.warn && quiet.warn !== quiet.body);
  check('quiet: only the approval glyph is coloured in the list row', !!quiet.rowGlyph && quiet.rowGlyph === quiet.warn && quiet.rowText !== quiet.warn);
  check('quiet: catch-up notes name agent, project, mode and folder', quiet.meta.length > 0
    && quiet.meta.split('|').every(m => m === 'Claude · Preview project · Ask first · C:\\preview'));
  const actions = await page.evaluate(() => ({ directions: [...document.querySelectorAll('.catch-actions')].map(e => getComputedStyle(e).flexDirection),
    buttons: document.querySelectorAll('.catch-actions .btn').length }));
  check('quiet: Open quest and Caught up sit side by side', actions.directions.length > 0 && actions.directions.every(d => d === 'row'));
  for (let i = 0; i < actions.buttons; i++) await point(`.catch-actions .btn >> nth=${i}`);
  check('quiet: every catch-up action is reachable', actions.buttons > 0 && await page.evaluate(() => window.preview.calls.length) === 0);
  // The hub blanks folders in Hide names; the fixture does the same here.
  const status = await page.evaluate(() => { const p = window.preview; p.model.private = true;
    p.model.attention = p.model.attention.map(item => ({ ...item, cwd: '' })); p.emit('model', { ...p.model });
    const el = document.getElementById('status'); return { text: el.textContent, dot: getComputedStyle(el, '::before').content,
      meta: [...document.querySelectorAll('.catch-meta')].map(e => e.textContent).join('|'),
      chip: [...el.querySelectorAll('.chip')].pop()?.textContent ?? '' }; });
  // Round 6: Hide names is announced as the last status chip, not a text suffix.
  check('status: level dot then text, and Hide names is announced', status.dot.includes('●') && status.chip === 'Hide names on');
  check('quiet: Hide names leaves the folder out of catch-up notes', status.meta.length > 0 && !status.meta.includes('C:\\preview'));
  const glyphs = await page.evaluate(() => { const p = window.preview, el = document.getElementById('status'), seen = {};
    for (const level of ['warn', 'off', 'ok']) { p.model.status = { ...p.model.status, level }; p.emit('model', { ...p.model }); seen[level] = getComputedStyle(el, '::before').content; }
    return seen; });
  check('status: each level has its own glyph', glyphs.ok.includes('●') && glyphs.warn.includes('▲') && glyphs.off.includes('○'));
  await snapshot('quiet-catch-up');
  await open('finished');
  for (const [name, passed] of Object.entries(await rendererUpdateJourney(page))) check(`entry updates: ${name}`, passed);
  await focusJourney();
  await overlayStorageJourney();
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [name, passed] of Object.entries(await glassRound3Journey(page, origin))) check(`glass round 3: ${name}`, passed);
  check('No renderer errors or external requests', report.errors.length === 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.stack || String(error);
  if (page) {
    report.failureState = await page.evaluate(() => ({ calls: window.preview?.calls, detail: window.preview?.model.detail })).catch(() => null);
    await snapshot('failure').catch(() => {});
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  if (context) await context.tracing.stop({ path: join(output, 'trace.zip') }).catch(error => report.errors.push(String(error)));
  if (browser) await browser.close();
  server.kill();
  writeFileSync(join(output, 'server.log'), serverLog);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
}

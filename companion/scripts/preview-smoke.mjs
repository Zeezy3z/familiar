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
// Find a visible control, normalize its point to the detail region, then invoke the exact
// incoming-addon path. elementFromPoint in overlay.ts still decides which action is hit.
async function point(selector) {
  return page.locator(selector).evaluate(el => {
    const r = document.getElementById('detail').getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (x < r.left || x >= r.right || y < r.top || y >= r.bottom || document.elementFromPoint(x, y)?.closest('[data-act]') !== el)
      throw new Error(`Control is clipped or covered: ${el.textContent}`);
    return { t: 'click', r: 'detail', x: (x - r.left) / r.width, y: (y - r.top) / r.height, b: 'L' };
  });
}
async function click(selector, count = 1) {
  const event = await point(selector);
  const hits = await page.evaluate(({ event, count }) => {
    const hits = [];
    for (let i = 0; i < count; i++) {
      const r = document.getElementById('detail').getBoundingClientRect();
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
    p.emit('layout', { scr: [1280, 800], px: 1.25, panel: true, native: false, drag: false, combat: false, ui: true,
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
// Everything but the three steps and the essentials lives in <details id="advanced">, collapsed by default;
// Playwright refuses to act inside a closed <details>, so open it the way a person would.
async function openAdvanced() {
  if (!await page.locator('#advanced').evaluate(el => el.open)) await page.locator('#advanced > summary').click();
}
async function controlChatJourney(width) {
  const size = `control-${width}`;
  await page.setViewportSize({ width, height: 640 });
  await page.goto(`${origin}/control.html?scenario=linked`);
  await page.waitForFunction(() => document.getElementById('chat-agent')?.value === 'claude');
  await openAdvanced();
  const values = () => page.evaluate(() => ({
    agent: document.getElementById('chat-agent').value,
    model: document.getElementById('chat-model').value,
    effort: document.getElementById('chat-effort').value,
    label: document.getElementById('chat-agent').selectedOptions[0]?.textContent,
    status: document.getElementById('chat-status')?.textContent,
    chat: { ...window.preview.state.chat },
    updates: window.preview.calls.filter(c => c.cmd === 'chatSettings'),
  }));
  const initial = await values();
  check(`${size}: configured provider/model and live readiness agree`, initial.agent === 'claude' && initial.model === 'haiku'
    && initial.effort === 'medium' && initial.status?.includes('Claude is ready for Chat'));
  const copy = await page.evaluate(() => ({
    mode: document.querySelector('#ui-mode + .hint')?.textContent,
    privateLabel: document.getElementById('ui-private').closest('label')?.textContent,
    approveKey: document.querySelector('#ui-approve-key + .hint')?.textContent.trim(),
    suggest: getComputedStyle(document.getElementById('suggest-text')).backgroundColor,
  }));
  check(`${size}: mode hint recommends Ask first`, copy.mode?.includes('Ask first is recommended'));
  check(`${size}: private setting is named Hide names`, copy.privateLabel?.includes('Hide names'));
  check(`${size}: Approve key hint starts with the WoW binding step`, copy.approveKey?.startsWith('1. In WoW'));
  check(`${size}: suggestion box is not a white field`, !['rgb(255, 255, 255)', 'rgba(255, 255, 255, 1)'].includes(copy.suggest));
  const claude = page.locator('[data-enable="claude"]');
  const codex = page.locator('[data-enable="codex"]');
  await claude.uncheck();
  await page.waitForFunction(() => document.getElementById('chat-status')?.textContent.includes('switched off'));
  let current = await values();
  check(`${size}: disabling retains the configured choice despite stale backend-ready flag`, current.agent === initial.agent
    && current.model === initial.model && current.effort === initial.effort && current.label.includes('switched off')
    && JSON.stringify(current.chat) === JSON.stringify(initial.chat) && current.updates.length === 0);
  await claude.focus();
  await page.evaluate(() => {
    window.preview.statusTicks = 0;
    window.familiar.on('status', () => window.preview.statusTicks++);
  });
  await page.waitForFunction(() => window.preview.statusTicks > 0);
  check(`${size}: unsolicited status tick keeps keyboard focus and does not change defaults`, await claude.evaluate(el => document.activeElement === el)
    && (await values()).updates.length === 0 && (await values()).agent === 'claude');
  await snapshot(`${size}-selected-provider-off`);
  check(`${size}: Chat controls fit available width`, await page.locator('#chatset').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await codex.uncheck();
  check(`${size}: disabling both never selects a replacement`, (await values()).agent === 'claude'
    && await page.locator('#chat-agent option:not(:disabled)').count() === 0 && (await values()).updates.length === 0);
  await claude.check();
  await codex.check();
  await page.waitForFunction(() => document.getElementById('chat-status')?.textContent.includes('Claude is ready for Chat'));
  current = await values();
  check(`${size}: restoring keeps provider/model/effort`, current.agent === initial.agent && current.model === initial.model
    && current.effort === initial.effort && JSON.stringify(current.chat) === JSON.stringify(initial.chat) && current.updates.length === 0);
  // Fault-injected status snapshots cover unavailable/unknown readiness without a real provider.
  const provider = await page.evaluate(() => {
    const p = window.preview, selected = p.state.providers.find(p => p.id === 'claude');
    p.state.providers = p.state.providers.filter(p => p.id !== 'claude');
    p.emit('status', p.state);
    return selected;
  });
  current = await values();
  check(`${size}: missing configured provider remains explicit`, current.agent === 'claude' && current.model === 'haiku'
    && current.label.includes('unavailable') && current.status.includes('unavailable for Chat') && current.updates.length === 0);
  await page.evaluate(provider => {
    const p = window.preview;
    p.state.providers.unshift(provider);
    p.state.backends.claude.ready = false;
    p.emit('status', p.state);
  }, provider);
  check(`${size}: saved sign-in is not live readiness`, (await values()).status.includes('sign-in found; live readiness is not yet confirmed'));
  await page.evaluate(() => {
    const p = window.preview;
    delete p.state.providers.find(p => p.id === 'claude').signedIn;
    p.emit('status', p.state);
  });
  check(`${size}: unknown readiness stays unverified`, (await values()).status.includes('readiness is not yet verified'));
  await page.evaluate(() => {
    const p = window.preview;
    p.state.providers.find(p => p.id === 'claude').signedIn = false;
    p.emit('status', p.state);
  });
  check(`${size}: selected Chat explains missing sign-in`, (await values()).status.includes('needs sign-in'));
  await page.evaluate(() => {
    const p = window.preview;
    p.state.backends.claude.error = 'Synthetic backend unavailable';
    p.emit('status', p.state);
  });
  check(`${size}: selected Chat exposes the backend error`, (await values()).status.includes('not ready: Synthetic backend unavailable'));
  await page.locator('#chat-agent').selectOption('codex');
  await page.waitForFunction(() => document.getElementById('chat-model').value === 'm2');
  current = await values();
  check(`${size}: only a deliberate provider choice updates the synthetic defaults`, current.agent === 'codex' && current.model === 'm2'
    && current.effort === 'medium' && current.chat.agent === 'codex' && current.chat.model === 'm2'
    && current.updates.length === 1 && JSON.stringify(current.updates[0].args) === JSON.stringify({ agent: 'codex' }));
  await snapshot(`${size}-explicit-provider-choice`);
  // The default-mode warning and header badge appear only for the modes that act without asking.
  const modeWarn = () => page.evaluate(() => ({ warn: !document.getElementById('ui-mode-warn').hidden
    && getComputedStyle(document.getElementById('ui-mode-warn')).display !== 'none',
    badge: document.getElementById('modebadge').hidden ? null : document.getElementById('modebadge').textContent }));
  await page.locator('#ui-mode').selectOption('auto');
  const auto = await modeWarn();
  check(`${size}: Auto default shows the warning and header badge`, auto.warn && auto.badge === 'Default: Auto');
  await snapshot(`${size}-mode-auto-warning`);
  await page.locator('#ui-mode').selectOption('ask');
  const ask = await modeWarn();
  check(`${size}: Ask first default hides the warning and badge`, !ask.warn && ask.badge === null);
  await page.locator('#ui-mode').selectOption('plan');
  const plan = await modeWarn();
  check(`${size}: Plan only default hides the warning and badge`, !plan.warn && plan.badge === null);
}
async function controlFailureJourney(width) {
  await page.setViewportSize({ width, height: 640 });
  await page.goto(`${origin}/control.html?scenario=action-error`);
  await openAdvanced();
  await page.locator('#b-config').click();
  const local = page.locator('[data-action-feedback]');
  await page.waitForFunction(() => document.querySelector('[data-action-feedback]')?.textContent.includes('Synthetic file-open failure'));
  check(`control-${width}: failed action has immediate visible local feedback`, (await local.textContent()).includes('Open config')
    && await local.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }));
  check(`control-${width}: failure preserves the visible action control`, await page.locator('#b-config').evaluate(el => {
    const r = el.getBoundingClientRect(); return document.activeElement === el && r.top >= 0 && r.bottom <= innerHeight;
  }));
  check(`control-${width}: local error does not duplicate the live announcement`, await local.getAttribute('role') === null
    && await page.locator('#feedback').getAttribute('role') === 'status'
    && (await page.locator('#feedback').textContent()).includes('Open config failed: Synthetic file-open failure')
    && await page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'openConfig').length) === 1);
  await snapshot(`control-${width}-action-failure`);
  await page.evaluate(() => window.preview.emit('status', window.preview.state));
  check(`control-${width}: status refresh retains the action failure`, (await local.textContent()).includes('Open config'));
  await page.locator('#b-refresh').click();
  await page.waitForFunction(() => document.getElementById('feedback').textContent.includes('rescanned'));
  check(`control-${width}: successful action in the group clears its old failure`, await local.textContent() === '');
}
const layoutFor = (width, focus) => ({ scr: [1280, 800], px: 1, fpx: 1, panel: true, native: false,
    drag: false, combat: false, ui: true, focus, rowH: 16,
    win: focus ? [336, 140, width - 236, 400] : [100, 100, width, 440],
    detail: [355, 159, width - 274, 260],
    ...(focus ? {} : { list: [119, 159, 220, 336], status: [250, 504, 100, 22] }) });
async function controlStorageJourney(width) {
  await page.setViewportSize({ width, height: 640 });
  await page.goto(`${origin}/control.html?scenario=linked`);
  await page.waitForFunction(() => window.preview?.state && document.getElementById('chat-agent')?.value === 'claude');
  const calls = await page.evaluate(() => window.preview.calls.length);
  for (const [level, text] of [
    ['error', 'Saved quests could not be safely read or preserved. Saving is paused to protect the original file. Keep Familiar open and ask for recovery help.'],
    ['warn', "Saved quests could not be fully loaded: 2 valid records recovered; 1 invalid or ambiguous records skipped. Original bytes are preserved privately in Familiar's data folder."],
  ]) {
    await page.evaluate(storage => { const p = window.preview; p.state.storage = storage; p.emit('status', p.state); }, { level, text });
    await page.waitForFunction(text => document.getElementById('journey-text').textContent === text, text);
    check(`control-${width}/storage-${level}: persistent guidance is visible without a selected quest`, await page.locator('#journey-text').evaluate(el => {
      const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
    }) && await page.locator('#journey-title').textContent() === 'Saved quests need attention');
    await page.evaluate(() => window.preview.emit('status', window.preview.state));
    check(`control-${width}/storage-${level}: refresh retains guidance without action`, await page.locator('#journey-text').textContent() === text
      && await page.evaluate(() => window.preview.calls.length) === calls);
    await snapshot(`control-${width}-storage-${level}`);
  }
  await page.evaluate(() => { const p = window.preview; delete p.state.storage; p.emit('status', p.state); });
  check(`control-${width}/storage: healthy status restores normal setup guidance`, await page.locator('#journey-title').textContent() !== 'Saved quests need attention');
}
// Three steps, the current step's content, essentials, and everything else under Advanced.
async function controlLayoutJourney(width) {
  const size = `control-${width}/layout`;
  const layout = () => page.evaluate(() => {
    const adv = document.getElementById('advanced'), fam = document.getElementById('familiars');
    return { steps: [...document.querySelectorAll('.steps b')].map(b => b.textContent), done: document.querySelectorAll('.steps b.ok').length,
      current: document.querySelector('.steps li.cur b')?.textContent ?? null, advancedOpen: adv.open, familiarsInAdvanced: adv.contains(fam),
      familiarsBeforeAdvanced: !!(fam.compareDocumentPosition(adv) & Node.DOCUMENT_POSITION_FOLLOWING),
      allSet: !document.getElementById('all-set').hidden && getComputedStyle(document.getElementById('all-set')).display !== 'none' };
  });
  await page.setViewportSize({ width, height: 640 });
  // First run: nothing is signed in yet (the fixture's own setup scenario has one agent signed in).
  await page.goto(`${origin}/control.html?scenario=setup`);
  await page.waitForFunction(() => document.getElementById('journey-title')?.textContent);
  await page.evaluate(() => {
    const p = window.preview;
    for (const x of p.state.providers) if (x.id !== 'hermes') { x.signedIn = false; x.detail = 'Not signed in'; }
    p.state.backends = {};
    p.emit('status', p.state);
  });
  let now = await layout();
  check(`${size}/setup: step 1 is current and the Familiars card sits above a collapsed Advanced`, now.current?.startsWith('1 Agents')
    && now.done === 0 && !now.advancedOpen && !now.familiarsInAdvanced && now.familiarsBeforeAdvanced && !now.allSet && await page.locator('#familiars').isVisible());
  await snapshot(`control-${width}-first-run`);
  // The shipped setup fixture: one agent is signed in, but the first-run choice is still open, so the card stays.
  await page.goto(`${origin}/control.html?scenario=setup`);
  await page.waitForFunction(() => document.getElementById('journey-title')?.textContent);
  now = await layout();
  check(`${size}/setup fixture: the Familiars card stays under the strip until the choice is kept`, !now.familiarsInAdvanced && now.familiarsBeforeAdvanced && !now.advancedOpen);
  await page.goto(`${origin}/control.html?scenario=linked`);
  await page.waitForFunction(() => document.getElementById('chat-agent')?.value === 'claude');
  now = await layout();
  check(`${size}/linked: Agents, WoW and Link are done; Familiars moved into a collapsed Advanced; one All set line`,
    JSON.stringify(now.steps) === JSON.stringify(['1 Agents ✓', '2 WoW ✓', '3 Link ✓']) && now.done === 3 && now.current === null
    && now.familiarsInAdvanced && !now.advancedOpen && now.allSet);
  check(`${size}/linked: the essentials stay visible without opening Advanced`, await page.locator('#ui-font').isVisible()
    && await page.locator('#ui-stream').isVisible() && await page.locator('#ui-sound').isVisible()
    && !await page.locator('#advanced').evaluate(el => el.open));
  await snapshot(`control-${width}-linked`);
  // A default that acts without asking opens Advanced by itself, so the warning box is never hidden.
  await page.evaluate(() => { const p = window.preview; p.state.ui.defaultMode = 'auto'; p.emit('status', p.state); });
  check(`${size}/auto default: Advanced opens and the warning box is visible`, (await layout()).advancedOpen
    && await page.locator('#ui-mode-warn').isVisible() && await page.locator('#modebadge').textContent() === 'Default: Auto');
  await page.locator('#advanced > summary').click();
  await page.evaluate(() => window.preview.emit('status', window.preview.state));
  check(`${size}/auto default: closing Advanced sticks across status updates`, !(await layout()).advancedOpen);
  // The journey link opens Advanced first when the Familiars card is inside it.
  await page.evaluate(() => { const p = window.preview; p.state.ui.defaultMode = 'ask'; p.state.backends.claude.ready = false; p.state.backends.codex.ready = false; p.emit('status', p.state); });
  await page.waitForFunction(() => !document.getElementById('journey-action').hidden);
  await page.locator('#journey-action').click();
  check(`${size}/journey link: opens Advanced and shows the Familiars card`, (await layout()).advancedOpen && await page.locator('#familiars').isVisible());
}
async function controlRequestsJourney(width) {
  const size = `control-${width}/requests`;
  await page.setViewportSize({ width, height: 640 });
  await page.goto(`${origin}/control.html?scenario=linked`);
  await page.waitForFunction(() => document.getElementById('chat-agent')?.value === 'claude');
  check(`${size}: no card without a cut request`, !await page.locator('#requests').isVisible());
  const full = Array.from({ length: 90 }, (_, i) => `echo "step ${i}: far too long for the in-game card"`).join('\n') + '\nrm -rf D:\\vault\\private';
  await page.evaluate(full => {
    const p = window.preview, api = window.familiar, real = api.invoke;
    p.decisions = [];
    p.answer = { ok: true };
    // Preview infrastructure only: stand in for main's "decide" command and record what the panel sends.
    api.invoke = async (cmd, args) => cmd === 'decide' ? (p.decisions.push(args), p.answer) : real(cmd, args);
    p.state.requests = [
      { thread: 't1', questTitle: 'Tidy the logs', project: 'Preview project', agent: 'Claude', requestId: 'r1', title: 'Run a long shell command', full, canAlways: true, at: Date.now() - 65000 },
      { thread: 't2', questTitle: 'Chat about fonts', project: 'Other project', agent: 'Codex', requestId: 'r2', title: 'Edit 3 files', full: 'diff --git a/x b/x\n+ small change', canAlways: false, at: Date.now() - 20000 },
    ];
    p.emit('status', p.state);
  }, full);
  const card = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#requests .req')];
    return { rows: rows.length, textFirst: rows.every(r => !!(r.querySelector('pre').compareDocumentPosition(r.querySelector('button')) & Node.DOCUMENT_POSITION_FOLLOWING)),
      above: !!(document.getElementById('requests').compareDocumentPosition(document.getElementById('journey')) & Node.DOCUMENT_POSITION_FOLLOWING),
      text: rows[0].querySelector('pre').textContent, labels: rows.map(r => [...r.querySelectorAll('button')].filter(b => !b.hidden).map(b => b.textContent)),
      title: document.getElementById('requests-title').textContent };
  });
  check(`${size}: the card sits above everything, shows each request whole and puts the text before its buttons`, card.rows === 2 && card.above && card.textFirst
    && card.text === full && card.title === 'Requests waiting on your PC');
  check(`${size}: Approve and Deny always, Always (this quest) only when the request allows it`,
    JSON.stringify(card.labels) === JSON.stringify([['Approve', 'Deny', 'Always (this quest)'], ['Approve', 'Deny']]));
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
  check(`${size}: a real click sends one decide for that request`, JSON.stringify(await page.evaluate(() => window.preview.decisions))
    === JSON.stringify([{ thread: 't1', requestId: 'r1', decision: 'deny' }])
    && (await page.locator('#feedback').textContent()).startsWith('Denied: Run a long shell command'));
  await page.evaluate(() => { const p = window.preview; p.state.requests = p.state.requests.filter(r => r.requestId !== 'r1'); p.emit('status', p.state); });
  check(`${size}: an answered request leaves the card`, await page.locator('#requests .req').count() === 1);
  await page.evaluate(() => { window.preview.answer = { ok: false, why: 'no longer pending' }; });
  await page.locator('.req[data-request="r2"] [data-decide="allow"]').click();
  check(`${size}: a late click says Already answered and leaves the buttons usable`, await page.locator('.req-msg').textContent() === 'Already answered.'
    && await page.locator('.req[data-request="r2"] button:not([hidden])').evaluateAll(els => els.every(el => !el.disabled)));
  await page.evaluate(() => { window.preview.answer = { ok: true }; });
  await page.locator('.req[data-request="r2"] [data-decide="allow"]').click();
  check(`${size}: Approve sends allow`, await page.evaluate(() => window.preview.decisions.at(-1).decision) === 'allow');
  await page.evaluate(() => { const p = window.preview; p.state.requests = []; p.emit('status', p.state); });
  check(`${size}: the card goes away with the last request`, !await page.locator('#requests').isVisible());
}
async function controlEssentialsJourney(width) {
  const size = `control-${width}/essentials`;
  await page.setViewportSize({ width, height: 640 });
  await page.goto(`${origin}/control.html?scenario=linked`);
  await page.waitForFunction(() => document.getElementById('chat-agent')?.value === 'claude');
  const updates = () => page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'uiSettings').map(c => c.args));
  check(`${size}: Text size explains when the quest list follows`, (await page.locator('#ui-font-hint').textContent()).includes('The quest list follows after /reload'));
  await page.locator('#ui-stream').check();
  check(`${size}: Stream-safe sends one preference, and approvals stay readable by its own hint`, JSON.stringify(await updates()) === JSON.stringify([{ streamSafe: true }])
    && (await page.locator('#ui-stream-hint').textContent()).includes('Approval cards stay readable'));
  await openAdvanced();
  const line = () => page.locator('#approve-key-status').evaluate(el => el.textContent.replace(/\s+/g, ' ').trim());
  const key = async value => { await page.locator('#ui-approve-key').fill(value); await page.locator('#ui-approve-key').press('Tab'); };
  await key('F9');
  check(`${size}: Approve key F9 is shown as registered, without a warning`, await line() === 'Registered: F9 — Familiar checks the real keyboard for it');
  await key('W');
  check(`${size}: a bare letter is registered but warned about`, await line() === 'Registered: W — Familiar checks the real keyboard for it That key is used for playing; pick an F-key or a Ctrl/Shift combination.');
  await page.locator('#ui-approve-key').fill('CTRL-W');
  check(`${size}: while typing, the line says it is not saved yet`, (await line()).startsWith('Not saved yet'));
  await key('');
  check(`${size}: no key registered says what to do instead`, await line() === 'None registered — click the card or Approve button instead');
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
  check('focus review: other requests remain signalled', (await page.locator(review).textContent()).includes('Review'));
  await click(review);
  check('focus review: disclosure gives native restore guidance', (await page.locator('#focus-review').textContent()).includes('Use Full view below'));
  check('focus review: expanded disclosure retains nonzero other-thread counts', (await page.locator(review).textContent()) === 'Other: 1 approval, 1 alert, 1 reply · Hide');
  check('focus review: disclosure neither navigates nor acknowledges', await page.evaluate(before => window.preview.model.detail.id === before.selected
    && JSON.stringify(window.preview.model.attention) === before.attention && window.preview.calls.length === before.calls, beforeReview));
  await snapshot('focus-other-review');
  await open('handoff-long');
  await page.evaluate(l => {
    const p = window.preview;
    p.model.fontScale = 1.6;
    p.model.attention = [{ thread: 'other', entry: 'other-request', title: 'Other conversation', pending: true, label: 'Needs approval' }];
    p.emit('model', { ...p.model });
    p.emit('layout', l);
  }, layoutFor(560, true));
  await settle();
  await wheel(12);
  const beforeLongReview = await anchor();
  await click(review);
  check('focus long history: expanded review omits zero counts', (await page.locator(review).textContent()) === 'Other: 1 approval · Hide');
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
    return { latestBottom: latest.bottom, footerTop: footer.top, readableHeight: scroll.clientHeight - header.offsetHeight,
      lineHeight: parseFloat(getComputedStyle(document.getElementById('content')).lineHeight) };
  });
  report.interactions.push({ label: 'focus-long-open-review', footerGeometry });
  check('focus long history: Latest stays above the opened review footer', footerGeometry.latestBottom <= footerGeometry.footerTop + 1);
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
  for (const [scenario, label] of [['approval', 'Needs your approval'], ['interrupted', 'Interrupted'], ['history-error', 'History unavailable']]) {
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
    await controlChatJourney(width); await controlFailureJourney(width); await controlStorageJourney(width);
    await controlLayoutJourney(width); await controlRequestsJourney(width); await controlEssentialsJourney(width);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const narrow of [false, true]) await compactHeaderJourney(narrow);
  for (const narrow of [false, true]) {
    const size = narrow ? 'narrow-large-text' : 'standard';
    for (const scenario of ['welcome', 'welcome-unready']) {
      await open(scenario, narrow);
      const text = await page.locator('#content').textContent();
      const initial = await page.evaluate(() => ({ chat: window.preview.model.detail.chat, calls: window.preview.calls, state: window.preview.state.chat }));
      check(`${size}/${scenario}: task-first choices appear in order`, text.indexOf('Ask a game question') < text.indexOf('Work on a project') && text.indexOf('Work on a project') < text.indexOf('Continue a conversation'));
      check(`${size}/${scenario}: starts at the first choice`, await page.locator('#detail-scroll').evaluate(el => el.scrollTop < 2));
      check(`${size}/${scenario}: provider and model are visible before opening`, text.includes(initial.chat.label) && text.includes(initial.chat.model) && text.includes(initial.chat.status));
      check(`${size}/${scenario}: no automatic action`, initial.calls.length === 0);
      check(`${size}/${scenario}: link and readiness are truthful`, scenario === 'welcome'
        ? text.includes('Linked to Preview Rogue.')
        : text.includes('Waiting for the game link.') && text.includes('switched off') && text.includes('not ready: Sign in required') && text.includes('Hermes'));
      if (scenario === 'welcome-unready') check(`${size}/${scenario}: Chat choices are distinct from project-ready providers`, text.includes('Chat uses Claude or Codex'));
      const projectText = await page.locator('.welcome-project').textContent();
      check(`${size}/${scenario}: project starters reflect ready providers`, scenario === 'welcome'
        ? projectText.includes('+ Claude') && projectText.includes('+ Codex')
        : projectText.includes('/fam hermes') && !projectText.includes('+ Claude') && !projectText.includes('+ Codex'));
      check(`${size}/${scenario}: no transcript-only Latest control`, await page.locator('#latest').evaluate(el => getComputedStyle(el).display === 'none'));
      await snapshot(`${size}-${scenario}`);
      await click('.welcome-chat .btn');
      const draft = await page.evaluate(() => ({ detail: window.preview.model.detail, calls: window.preview.calls, state: window.preview.state.chat }));
      check(`${size}/${scenario}: Chat opens only the configured draft`, draft.detail.kind === 'draft' && draft.detail.agent === initial.chat.id && draft.detail.model === initial.chat.model && draft.detail.chat === true);
      check(`${size}/${scenario}: uses only the existing draft action`, draft.calls.length === 1 && draft.calls[0].type === 'newIn' && draft.calls[0].key === 'chats');
      check(`${size}/${scenario}: opening keeps chat defaults`, JSON.stringify(draft.state) === JSON.stringify(initial.state));
      check(`${size}/${scenario}: draft retains readiness and model guidance`, (await page.locator('#content').textContent()).includes(draft.detail.provider.status) && (await page.locator('#content').textContent()).includes('Model'));
      if (scenario === 'welcome-unready') check(`${size}/${scenario}: unready draft names Chat choices`, (await page.locator('#content').textContent()).includes('Chat uses Claude or Codex'));
      check(`${size}/${scenario}: draft fits pane width`, await page.locator('#detail-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await snapshot(`${size}-${scenario}-chat-draft`);
    }
    await open('approval', narrow);
    check(`${size}/approval: uncut request has no cut warning`, await page.locator('.preview-cut').count() === 0
      && await page.locator('.approval-preview').textContent() === await page.evaluate(() => window.preview.model.detail.entries.find(e => e.kind === 'approval').text));
    for (const [decision, selector] of [['allow', '.btn.ok'], ['deny', '.btn.no'], ['allowAlways', '.btn.always']]) {
      await open('approval-always', narrow);
      const buttons = await page.locator(action('decide')).evaluateAll(els => els.map(el => ({ text: el.textContent, decision: JSON.parse(el.dataset.act).decision })));
      check(`${size}/approval-always: Approve, Deny, then Always (this quest)`, JSON.stringify(buttons.map(b => b.text)) === JSON.stringify(['Approve', 'Deny', 'Always (this quest)'])
        && JSON.stringify(buttons.map(b => b.decision)) === JSON.stringify(['allow', 'deny', 'allowAlways']));
      check(`${size}/approval-always: three decision controls`, await page.locator(action('decide')).count() === 3);
      await point('.btn.always');
      if (decision === 'allow') await snapshot(`${size}-approval-always`);
      await click(selector);
      const calls = await page.evaluate(() => window.preview.calls);
      check(`${size}/approval-always: ${selector} sends exactly one ${decision}`, calls.length === 1 && calls[0].type === 'decide' && calls[0].decision === decision
        && calls[0].requestId === 'preview');
    }
    // The pending card names the folder it acts in, and Always says how long it lasts per provider.
    await open('approval-always', narrow);
    const card = () => page.evaluate(() => ({ where: [...document.querySelectorAll('.card-where')].map(e => e.textContent),
      always: document.querySelector('.btn.always')?.textContent, cwd: window.preview.model.detail.cwd }));
    let pendingCard = await card();
    check(`${size}/approval-always: pending card names its folder`, pendingCard.cwd.length > 0 && pendingCard.where.length === 1
      && pendingCard.where[0] === `in ${pendingCard.cwd}`);
    check(`${size}/approval-always: Claude's Always lasts this quest`, pendingCard.always === 'Always (this quest)');
    await page.evaluate(() => { const p = window.preview; p.model.detail.agent = 'hermes'; p.emit('model', { ...p.model }); });
    check(`${size}/approval-always: an ACP agent's Always says the agent decides`, (await card()).always === 'Always (agent decides how long)');
    await page.evaluate(() => { const p = window.preview; p.model.detail.cwd = ''; p.emit('model', { ...p.model }); });
    pendingCard = await card();
    check(`${size}/approval-always: a hidden folder is not shown`, pendingCard.where.length === 0 && await page.locator(action('decide')).count() === 3);
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
  const quiet = await page.evaluate(() => {
    const warn = document.querySelector('.catch-title .warn');
    const row = [...document.querySelectorAll('.row')].find(r => r.querySelector('.t')?.textContent === 'Review a file edit');
    return { warn: warn && getComputedStyle(warn).color, body: getComputedStyle(document.body).color, label: warn?.textContent,
      meta: [...document.querySelectorAll('.catch-meta')].map(e => e.textContent).join('|'),
      rowText: row && getComputedStyle(row.querySelector('.t')).color, rowGlyph: row && getComputedStyle(row.querySelector('.st')).color };
  });
  check('quiet: Needs approval stands out from body text', quiet.label === 'Needs approval' && !!quiet.warn && quiet.warn !== quiet.body);
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
      meta: [...document.querySelectorAll('.catch-meta')].map(e => e.textContent).join('|') }; });
  check('status: level dot then text, and Hide names is announced', status.dot.includes('●') && status.text.endsWith(' · Hide names on'));
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

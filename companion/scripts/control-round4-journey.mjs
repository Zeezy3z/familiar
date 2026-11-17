// Round 4 control-panel journeys: the built control.html through the synthetic preview bridge, on the fixed page
// (header · Requests waiting · the status line · Play · Safety · Familiars · Projects · Troubleshooting · footer).
// Commands that main serves (captureSnapshot, openSnapshot, projectAdd, projectRemove, claudeRetry, checkUpdate, openUrl)
// are stood in for here and recorded in window.preview.sent; nothing leaves the page. Returns { checkName: passed }
// like glass-round3-journey.mjs, so the smoke can report each one.
export async function controlRound4Journey(page, origin, width, snapshot = async () => {}) {
  const results = {};
  const check = (name, passed) => { results[`control-${width}/${name}`] = !!passed; };
  const open = async () => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`${origin}/control.html?scenario=linked`);
    await page.waitForFunction(() => window.preview?.state && document.getElementById('journey-title')?.textContent);
    // Preview infrastructure only: what main answers, and what the panel sent.
    await page.evaluate(() => {
      const p = window.preview, api = window.familiar, real = api.invoke;
      p.sent = [];
      p.add = { ok: true, path: 'C:\\work\\one' };
      p.answer = {};
      api.invoke = async (cmd, args) => {
        if (cmd === 'projectAdd') { p.sent.push({ cmd, args }); if (p.add.ok) p.state.projects[args.kind === 'root' ? 'roots' : 'explicit'].push(p.add.path); return p.add; }
        if (cmd === 'projectRemove') {
          p.sent.push({ cmd, args });
          const had = [...p.state.projects.explicit, ...p.state.projects.roots].includes(args.path);
          p.state.projects.explicit = p.state.projects.explicit.filter(x => x !== args.path);
          p.state.projects.roots = p.state.projects.roots.filter(x => x !== args.path);
          return { ok: had };
        }
        if (cmd === 'checkUpdate') { p.sent.push({ cmd, args }); p.state.update = { app: '0.2.0', addon: '0.2.0', mismatch: false, ...p.state.update, last: p.answer.checkUpdate }; return p.answer.checkUpdate; }
        if (['captureSnapshot', 'openSnapshot', 'claudeRetry', 'openUrl'].includes(cmd)) { p.sent.push({ cmd, args }); return p.answer[cmd]; }
        return real(cmd, args);
      };
    });
  };
  // Change the fixture status and push it. Keys may be dotted paths ("addon.addon"); null deletes the key.
  const status = patch => page.evaluate(patch => {
    const p = window.preview;
    for (const [path, value] of Object.entries(patch)) {
      const keys = path.split('.'), last = keys.pop();
      const target = keys.reduce((o, k) => o[k], p.state);
      if (value === null) delete target[last]; else target[last] = value;
    }
    p.emit('status', p.state);
  }, patch);
  const sent = () => page.evaluate(() => JSON.stringify(window.preview.sent));
  const openTroubleshooting = () => page.evaluate(() => { document.getElementById('troubleshooting').open = true; });
  // The answer written beside a control (control.ts say(): its settings row, button group or card).
  const said = selector => page.locator(selector).evaluate(el => el.closest('.set, .btns, #familiars, #status')?.querySelector(':scope > .fb')?.textContent ?? '');

  // ---- The familiar's portrait in the header follows the journey ----
  const portrait = () => page.evaluate(() => {
    const img = document.getElementById('portrait'), h1 = document.querySelector('header h1');
    return { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, alt: img.getAttribute('alt'), w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height,
      radius: getComputedStyle(img).borderRadius, ring: getComputedStyle(img).boxShadow !== 'none', beforeTitle: img.parentElement === h1.parentElement && !!(img.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  const face = async () => (await portrait()).src.replace('assets/', '');
  await open();
  let now = await portrait();
  check('portrait: linked shows the idle familiar, round with a hairline ring, before the title and decorative', now.src === 'assets/idle-192.png' && now.loaded && now.alt === ''
    && now.w === 40 && now.h === 40 && now.radius === '50%' && now.ring && now.beforeTitle);
  const title = () => page.locator('#journey-title').textContent();
  await status({ 'work.working': 2 });
  check('portrait: a quest running on a finished journey makes it work', await face() === 'working-192.png');
  await status({ 'work.working': 0 });
  check('portrait: back to idle when nothing is running', await face() === 'idle-192.png');
  await status({ game: null });
  check('portrait: waiting for WoW is still idle, in the familiar\'s voice', await face() === 'idle-192.png' && await title() === "I'm waiting for WoW.");
  // A request waiting on a finished journey makes it ask (assets/asking-192.png). A build without that picture falls
  // back to idle, once, and never shows a broken image.
  await open();
  const asking = await page.evaluate(() => fetch('assets/asking-192.png').then(r => r.ok, () => false));
  await status({ 'work.approvals': 1, 'work.working': 1 });
  await page.waitForFunction(() => { const i = document.getElementById('portrait'); return i.complete && i.naturalWidth > 0; });
  now = await portrait();
  check(`portrait: a waiting request makes it ask${asking ? '' : ' (no asking picture in this build: idle, loaded)'}`, (asking ? now.src === 'assets/asking-192.png' : now.src === 'assets/idle-192.png') && now.loaded);
  await status({ 'work.approvals': 0 });
  await page.waitForFunction(() => document.getElementById('portrait').getAttribute('src') === 'assets/working-192.png');
  check('portrait: answered, it goes back to work', await face() === 'working-192.png');

  // ---- Link Doctor and "Save what Familiar sees" ----
  await open();
  const doctor = 'Familiar sees the game but no coloured strip in its top-left corner. In game: is Familiar ticked in AddOns? Type /fam strip — it should say TOPLEFT.';
  await status({ linked: false, layout: null, doctor: { step: 'strip', level: 'warn', text: doctor } });
  const link = () => page.locator('.steps li').nth(2).evaluate(li => { const h = li.querySelector('.hint'); return { text: h.textContent, title: h.title, warn: h.classList.contains('warn'), done: !!li.querySelector('b.ok') }; });
  const body = () => page.locator('#journey-text').evaluate(el => ({ text: el.textContent, warn: el.classList.contains('warn') }));
  now = await link();
  check('portrait: the Link step undone makes it puzzled, and the title says so above the doctor\'s sentence', await face() === 'puzzled-192.png' && await title() === "I can't see the game yet.");
  check('doctor: the Link step says Not linked yet; the journey text says why, in the doctor\'s words and warn colour', now.text === 'Not linked yet' && now.title === doctor && !now.warn && !now.done
    && JSON.stringify(await body()) === JSON.stringify({ text: doctor, warn: true }));
  await openTroubleshooting();
  check('doctor: Troubleshooting repeats the sentence under Runestrip link', (await page.locator('#link').textContent()).includes('Link doctor') && (await page.locator('#link').textContent()).includes('no coloured strip'));
  check('doctor: Save what Familiar sees sits under the link details and nothing is saved by itself', await page.locator('#b-snapshot').isVisible() && await sent() === '[]');
  await snapshot(`control-${width}-doctor-strip`);
  await page.evaluate(() => { window.preview.answer.captureSnapshot = { ok: true, file: 'C:\\Users\\player\\AppData\\Roaming\\Familiar\\strip-20261103-153012.png' }; });
  await page.locator('#b-snapshot').click();
  await page.waitForFunction(() => document.getElementById('snapshot-result').textContent);
  const saved = await page.locator('#snapshot-result').textContent();
  check('snapshot: one request; the result names the file and the 320×32 crop, without the full path', await sent() === '[{"cmd":"captureSnapshot"}]'
    && saved.includes('strip-20261103-153012.png') && saved.includes('320×32') && saved.includes('look at it before attaching') && !saved.includes('player')
    && saved.endsWith('Open folder'));
  await page.locator('#b-open-snapshot').click();
  await page.waitForFunction(() => window.preview.sent.length >= 2);
  check('snapshot: Open folder asks main to show the saved picture, with no path from the page', await sent() === '[{"cmd":"captureSnapshot"},{"cmd":"openSnapshot"}]');
  await page.evaluate(() => { window.preview.answer.captureSnapshot = { ok: false, why: 'Familiar has no picture of the game yet.' }; });
  await page.locator('#b-snapshot').click();
  await page.waitForFunction(() => !document.getElementById('snapshot-result').textContent);
  await page.waitForFunction(() => document.querySelector('.btns:has(#b-snapshot) > .fb')?.textContent);
  check('snapshot: a refusal clears the old result and says why beside the button', (await said('#b-snapshot')).includes('Familiar has no picture of the game yet.'));
  await status({ doctor: null });
  now = await link();
  check('doctor: without a doctor the Link step keeps its own wording (as its title) and the journey text its own', now.text === 'Not linked yet' && now.title.startsWith('Restart WoW, tick Familiar and Familiar Sync')
    && (await body()).text.startsWith('The coloured dots top-left') && !(await body()).warn);
  await status({ linked: true, layout: { panel: true }, doctor: { step: 'ok', level: 'ok', text: 'Game link working.' } });
  check('doctor: once linked the strip goes and the line says All set', await page.locator('#journey-steps').isHidden() && await title() === 'All set — type /fam in WoW');

  // ---- Claude Code download on the Familiars card (always in place: the page never moves) ----
  await open();
  const claude = () => page.locator('#providers .prov').first().evaluate(row => ({ text: row.querySelector('.d').textContent, bar: row.querySelector('progress')?.getAttribute('value') ?? null, button: row.querySelector('[data-retry]')?.textContent ?? null, markup: !!row.querySelector('.d img') }));
  await status({ 'providers.0.installed': false, 'providers.0.enabled': false, 'providers.0.signedIn': null, 'providers.0.detail': 'Not downloaded yet', claude: { state: 'downloading', pct: 43, mb: 112 } });
  let row = await claude();
  check('portrait: while Claude Code downloads it works', await face() === 'working-192.png');
  check('claude: the row shows progress, with a bar and nothing to click', row.text === '◌ Downloading Claude Code · 43 % of 112 MB' && row.bar === '43' && row.button === null);
  await snapshot(`control-${width}-claude-downloading`);
  await status({ claude: { state: 'failed', error: '<img src=x onerror="window.__pwned=1">' } });
  row = await claude();
  check('claude: a failure names the reason as plain text and offers Retry', row.text.includes('couldn\'t be downloaded (<img src=x') && row.text.endsWith('Other agents still work.') && row.button === 'Retry' && !row.markup
    && await page.evaluate(() => window.__pwned) === undefined && await page.locator('#providers [data-retry]').isVisible());
  await page.evaluate(() => { window.preview.answer.claudeRetry = { state: 'downloading', pct: 0 }; });
  await page.locator('#providers [data-retry]').click();
  await page.waitForFunction(() => window.preview.sent.length >= 1 && document.getElementById('providers-fb').textContent);
  check('claude: Retry sends one claudeRetry and says so under the Familiars card', await sent() === '[{"cmd":"claudeRetry"}]' && await page.locator('#providers-fb').textContent() === 'Claude Code is downloading.');
  await status({ claude: { state: 'missing' } });
  check('claude: missing offers Retry', (await claude()).button === 'Retry');
  await status({ 'providers.0.installed': true, 'providers.0.enabled': true, 'providers.0.signedIn': true, 'providers.0.detail': 'Signed in', claude: { state: 'present' } });
  row = await claude();
  check('claude: once on disk the row is the ordinary one', row.text === '✓ Ready' && row.bar === null && row.button === null);

  // ---- Projects ----
  await open();
  const place = () => page.evaluate(() => {
    const card = document.getElementById('projects');
    return { visible: !card.hidden && getComputedStyle(card).display !== 'none',
      afterFamiliars: !!(document.getElementById('familiars').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforeTroubleshooting: !!(card.compareDocumentPosition(document.getElementById('troubleshooting')) & Node.DOCUMENT_POSITION_FOLLOWING),
      rows: [...card.querySelectorAll('#project-rows .prov')].map(r => [r.querySelector('.n').textContent, r.querySelector('.d').textContent]),
      buttons: [...card.querySelectorAll('.btns button')].map(b => b.textContent) };
  });
  check('projects: with folders set the card is collapsed to one line that counts them', await page.evaluate(() => !document.getElementById('projects').open)
    && await page.locator('#project-count').textContent() === '1 folder');
  await status({ projects: 3 }); // an older main reports a plain count
  check('projects: an older status (a plain count) shows no card', !(await place()).visible);
  await status({ projects: { explicit: [], roots: [], history: 3 } });
  await page.locator('#projects > summary').click(); // the player opens it (it opens by itself only on a first run with no folder)
  let where = await place();
  check('projects: the card sits between Familiars and Troubleshooting, with its two buttons and no rows yet', where.visible && where.afterFamiliars && where.beforeTroubleshooting
    && JSON.stringify(where.buttons) === JSON.stringify(['Add a project folder…', 'Add a folder of projects…']) && where.rows.length === 0);
  const lead = () => page.locator('#projects .hint').first().textContent();
  check('projects: with no folder the hint starts in the familiar\'s voice and keeps today\'s sentence', (await lead()).startsWith("Give me a folder and I'll have somewhere to go. Zones in your Quest Log are project folders."));
  await snapshot(`control-${width}-projects-empty`);
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-rows .prov').length === 1);
  where = await place();
  check('projects: once a folder is added the lead sentence goes', (await lead()).startsWith('Zones in your Quest Log'));
  check('projects: Add a project folder asks main for a project, lists the answer and names it beside the buttons', await sent() === '[{"cmd":"projectAdd","args":{"kind":"project"}}]'
    && JSON.stringify(where.rows) === JSON.stringify([['Project', 'C:\\work\\one']]) && where.visible && (await said('#b-project-add')).includes('C:\\work\\one'));
  await page.evaluate(() => { window.preview.add = { ok: true, path: 'D:\\code' }; });
  await page.locator('#b-root-add').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-rows .prov').length === 2);
  check('projects: Add a folder of projects sends kind root and lists it as Projects in', (await sent()).endsWith('{"cmd":"projectAdd","args":{"kind":"root"}}]')
    && JSON.stringify((await place()).rows) === JSON.stringify([['Project', 'C:\\work\\one'], ['Projects in', 'D:\\code']]));
  await snapshot(`control-${width}-projects-some`);
  await page.evaluate(() => { window.preview.add = { ok: false, why: 'That folder is excluded by your config.' }; });
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => document.querySelector('.btns:has(#b-project-add) > .fb')?.classList.contains('err'));
  check('projects: a refused folder says why beside the buttons and is not listed', (await said('#b-project-add')).includes('That folder is excluded by your config.')
    && (await place()).rows.length === 2);
  await page.evaluate(() => { window.preview.add = { ok: false }; });
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => !document.getElementById('b-project-add').disabled);
  check('projects: cancelling the dialog says nothing, neither a result nor an error', await said('#b-project-add') === '' && (await place()).rows.length === 2);
  await page.evaluate(() => { window.preview.add = { ok: true, path: 'C:\\x\\<b>bold</b>' }; });
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-rows .prov').length === 3);
  check('projects: a path is shown as text, never as markup', await page.locator('#project-rows .prov').evaluateAll(rows => rows.some(r => r.querySelector('.d').textContent === 'C:\\x\\<b>bold</b>') && !rows.some(r => r.querySelector('.d b'))));
  await page.evaluate(() => { window.preview.sent = []; });
  await page.locator('#project-rows [data-remove]').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#project-rows .prov').length === 2);
  check('projects: the cross removes exactly that folder', await sent() === '[{"cmd":"projectRemove","args":{"path":"C:\\\\work\\\\one"}}]');
  while ((await place()).rows.length) {
    const before = (await place()).rows.length;
    await page.locator('#project-rows [data-remove]').first().click();
    await page.waitForFunction(n => document.querySelectorAll('#project-rows .prov').length < n, before);
  }
  where = await place();
  check('projects: with the last folder gone the card stays in its place, empty', where.visible && where.afterFamiliars && where.beforeTroubleshooting && where.rows.length === 0);

  // ---- Versions and "Check for updates" ----
  await open();
  const header = () => page.locator('#vermismatch').evaluate(el => ({ shown: !el.hidden && getComputedStyle(el).display !== 'none', text: el.textContent }));
  await status({ update: null });
  check('versions: without status.update there is no mismatch line', !(await header()).shown);
  const update = (addon, mismatch = true) => status({ update: { app: '0.2.0', addon, mismatch } });
  await update('0.1.1');
  let h = await header();
  check('versions: addon behind app shows one line in the header, next to the version', h.shown && h.text === 'Addon 0.1.1 is behind app 0.2.0. Update it with WowUp or the release zip.');
  await snapshot(`control-${width}-version-mismatch`);
  await update('0.3.0');
  check('versions: app behind addon says so', (await header()).text === 'App 0.2.0 is behind addon 0.3.0. Update the app from the Releases page.');
  await update('0.1.1', false);
  check('versions: the panel never decides that they differ: mismatch false shows nothing', !(await header()).shown);
  for (const odd of ['dev', '<img src=x onerror="window.__pwned=1">'])
    { await update(odd); check(`versions: addon "${odd.slice(0, 12)}" shows nothing`, !(await header()).shown && await page.evaluate(() => window.__pwned) === undefined); }
  await new Promise(resolve => setTimeout(resolve, 1200)); // a synthetic status tick or two
  check('updates: nothing is checked by itself', await sent() === '[]');
  const url = 'https://github.com/Zeezy3z/familiar/releases/tag/v0.3.0';
  const line = () => page.locator('#update-result').evaluate(el => ({ text: el.textContent, open: !!el.querySelector('#b-open-release') }));
  await page.evaluate(url => { window.preview.answer.checkUpdate = { current: '0.2.0', latest: '0.3.0', newer: true, url, prerelease: false }; }, url);
  await page.locator('#b-update').click();
  await page.waitForFunction(() => document.getElementById('update-result').textContent);
  let u = await line();
  check('updates: one click sends one checkUpdate and shows "0.3.0 is out" with the download link, which is not opened', await sent() === '[{"cmd":"checkUpdate"}]'
    && u.text === '0.3.0 is out · Open the download page' && u.open);
  await page.evaluate(() => { document.getElementById('b-open-release').dataset.kept = '1'; });
  await new Promise(resolve => setTimeout(resolve, 1200)); // status now carries the answer as update.last
  check('updates: status.update.last does not redraw the line or its link', await page.evaluate(() => !!document.getElementById('b-open-release')?.dataset.kept));
  await snapshot(`control-${width}-update-available`);
  await page.evaluate(() => document.getElementById('b-open-release').click());
  check('updates: a click made by script opens nothing', await sent() === '[{"cmd":"checkUpdate"}]');
  await page.locator('#b-open-release').click();
  await page.waitForFunction(() => window.preview.sent.length >= 2);
  check('updates: the user\'s click opens exactly the URL main returned', await sent() === JSON.stringify([{ cmd: 'checkUpdate' }, { cmd: 'openUrl', args: { url } }]));
  await page.evaluate(() => { window.preview.answer.checkUpdate = { current: '0.2.0', latest: '0.2.0', newer: false, url: 'https://github.com/Zeezy3z/familiar/releases/tag/v0.2.0' }; });
  await page.locator('#b-update').click();
  await page.waitForFunction(() => document.getElementById('update-result').textContent.includes('the latest'));
  u = await line();
  check('updates: on the latest version it says so, with no link', u.text === 'You\'re on 0.2.0, the latest.' && !u.open);
  await page.evaluate(() => { window.preview.answer.checkUpdate = { current: '0.2.0', latest: '0.3.0-beta.1', newer: true, url: 'https://evil.example/releases', prerelease: true }; });
  await page.locator('#b-update').click();
  await page.waitForFunction(() => document.getElementById('update-result').textContent.includes('beta'));
  u = await line();
  check('updates: a prerelease is marked (beta) and a URL that is not a Familiar release page is not offered', u.text === '0.3.0-beta.1 is out (beta)' && !u.open);
  await page.evaluate(() => { window.preview.answer.checkUpdate = { current: '0.2.0', error: "couldn't reach GitHub" }; });
  await page.locator('#b-update').click();
  await page.waitForFunction(() => document.getElementById('update-result').textContent.includes('Couldn'));
  u = await line();
  check('updates: without a network it says it could not reach GitHub', u.text === 'Couldn\'t reach GitHub (no network?)' && !u.open);
  await page.evaluate(() => { window.preview.answer.checkUpdate = { current: '0.2.0', error: 'GitHub answered 403' }; });
  await page.locator('#b-update').click();
  await page.waitForFunction(() => document.getElementById('update-result').textContent.includes('403'));
  check('updates: any other failure is named in main\'s words', (await line()).text === 'Couldn\'t check for updates: GitHub answered 403.');
  // A panel opened after the click: the answer comes with the status.
  await open();
  await status({ update: { app: '0.2.0', addon: '0.2.0', mismatch: false, last: { current: '0.2.0', latest: '0.3.0', newer: true, url } } });
  u = await line();
  check('updates: status.update.last alone shows the line, and still nothing was sent', u.text === '0.3.0 is out · Open the download page' && u.open && await sent() === '[]');

  // ---- Windows notice setting ----
  await open();
  check('notices: the Windows notice box is on by default', await page.locator('#ui-tray').isChecked()
    && (await page.locator('label:has(#ui-tray)').textContent()).includes('Windows notice when a request is waiting'));
  await page.locator('#ui-tray').uncheck();
  await page.waitForFunction(() => window.preview.calls.some(c => c.cmd === 'uiSettings'));
  check('notices: unticking sends one trayNotices preference and the box stays off', JSON.stringify(await page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'uiSettings').map(c => c.args))) === '[{"trayNotices":false}]'
    && !await page.locator('#ui-tray').isChecked());

  // ---- The workshop header ----
  await open();
  const band = await page.evaluate(async () => {
    const h = document.querySelector('header'), r = h.getBoundingClientRect();
    const status = await fetch('assets/workshop-1600.jpg').then(res => res.status, () => 0);
    const img = await new Promise(done => { const i = new Image(); i.onload = () => done([i.naturalWidth, i.naturalHeight]); i.onerror = () => done([0, 0]); i.src = 'assets/workshop-1600.jpg'; });
    return { bg: getComputedStyle(h).backgroundImage, status, img, height: r.height,
      clipped: [...h.children].filter(c => c.getClientRects().length).some(c => { const b = c.getBoundingClientRect(); return b.right > r.right + 1 || b.left < r.left - 1; }),
      overflow: h.scrollWidth > h.clientWidth + 1 };
  });
  check('header: the painted desk sits behind the title, the image is served (200) and decodes at 1600×400', band.bg.includes('workshop-1600.jpg') && band.status === 200 && band.img[0] === 1600 && band.img[1] === 400);
  check('header: compact (56 to 100 px tall), and its badges wrap inside it at this width without clipping', band.height >= 56 && band.height <= 100 && !band.clipped && !band.overflow);
  await snapshot(`control-${width}-header`);

  // ---- Sounds ----
  await open();
  await page.evaluate(() => { // a counting stand-in for the Web Audio API: any node, any method; nothing is heard
    const audio = window.__audio = { contexts: 0, nodes: 0 };
    const node = () => { audio.nodes++; return new Proxy(function () {}, { get: (t, k) => k === 'then' ? undefined : k === 'length' ? 0 : node(), set: () => true, apply: () => node() }); };
    window.AudioContext = class { constructor() { audio.contexts++; this.currentTime = 0; this.sampleRate = 44100; this.state = 'running'; this.destination = node(); }
      resume() { return Promise.resolve(); } createBuffer() { return node(); } createOscillator() { return node(); } createGain() { return node(); } createBiquadFilter() { return node(); } createBufferSource() { return node(); } };
  });
  const audio = () => page.evaluate(() => ({ ...window.__audio }));
  const uiCalls = () => page.evaluate(() => JSON.stringify(window.preview.calls.filter(c => c.cmd === 'uiSettings').map(c => c.args)));
  const sample = () => page.locator('#sound-sample').textContent();
  check('sounds: the volume slider runs 0 to 100 in steps of 5 and reads 70 from the fixture', await page.locator('#ui-volume').evaluate(el => el.type === 'range' && el.min === '0' && el.max === '100' && el.step === '5' && el.value === '70')
    && await page.locator('#ui-volume-out').textContent() === '70');
  check('sounds: nothing is played, built or said until a click', (await audio()).contexts === 0 && await sample() === '');
  await page.evaluate(() => document.getElementById('b-sound-sample').click());
  check('sounds: a click made by script plays nothing', (await audio()).contexts === 0 && await sample() === '');
  await page.locator('#ui-volume').evaluate(el => { el.value = '35'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  check('sounds: dragging shows the number but sends nothing yet', await page.locator('#ui-volume-out').textContent() === '35' && await uiCalls() === '[]');
  await page.locator('#ui-volume').fill('40');
  await page.waitForFunction(() => window.preview.calls.some(c => c.cmd === 'uiSettings'));
  await page.waitForFunction(() => document.querySelector('.set:has(#ui-volume) > .fb')?.textContent);
  check('sounds: releasing the slider sends one soundVolume preference, the panel keeps it and says so beside it', await uiCalls() === '[{"soundVolume":40}]'
    && await page.locator('#ui-volume').inputValue() === '40' && await page.locator('#ui-volume-out').textContent() === '40' && await said('#ui-volume') === 'Sound volume 40%');
  await page.locator('#b-sound-sample').click();
  const first = await sample();
  await page.locator('#b-sound-sample').click();
  const second = await sample();
  const built = await audio();
  check('sounds: Play a sample names the cues in order, one per click, with one AudioContext, whether or not Sounds is ticked', first === 'Played: Quest started' && second === 'Played: Needs your approval'
    && built.contexts === 1 && built.nodes > 0 && !await page.locator('#ui-sound').isChecked());
  for (let i = 0; i < 5; i++) await page.locator('#b-sound-sample').click();
  check('sounds: after six samples the cycle starts again at Quest started', await sample() === 'Played: Quest started' && (await audio()).contexts === 1);
  check('sounds: the switch says what the cues are for, as its tooltip', await page.locator('#ui-sound').getAttribute('title') === 'Short cues for what happened; silent while a quest works');
  await snapshot(`control-${width}-sounds`);

  // ---- A settings page: label · control · one hint; two button styles ----
  await open();
  const rows = await page.evaluate(() => [...document.querySelectorAll('.set')].map(set => ({ id: set.closest('section')?.id, label: !!set.querySelector(':scope > .sl'), control: !!set.querySelector(':scope > .sc') })));
  check('settings: Play has four rows and Safety five (the open quest, new quests, the Approve key and the two switches), each a label and a control',
    rows.filter(r => r.id === 'play').length === 4 && rows.filter(r => r.id === 'safety').length === 5 && rows.every(r => r.label && r.control));
  const buttons = await page.evaluate(() => ({ ok: document.querySelectorAll('button.ok').length,
    plain: ['b-pause', 'b-config', 'b-reload', 'b-logs', 'b-diag', 'b-refresh', 'b-snapshot', 'b-toast', 'b-update', 'b-install', 'b-sound-sample', 'b-project-add', 'b-key-set']
      .filter(id => { const b = document.getElementById(id); return b && !b.classList.contains('primary') && !b.classList.contains('ok'); }).length }));
  check('buttons: everything on a healthy page is the quiet style, and nothing is green without a request', buttons.ok === 0 && buttons.plain === 13);
  const surface = await page.evaluate(() => ({ image: getComputedStyle(document.getElementById('status')).backgroundImage, top: getComputedStyle(document.getElementById('status')).borderTopWidth }));
  check('status line: a flat card with a 2 px rule on top', surface.image === 'none' && surface.top === '2px');
  check('version: the header shows the running version from the status', /^v\d+\.\d+\.\d+/.test(await page.locator('#ver').textContent()));
  return results;
}

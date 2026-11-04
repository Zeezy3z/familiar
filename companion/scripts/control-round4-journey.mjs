// Round 4 control-panel journeys: the built control.html through the synthetic preview bridge. Commands that
// main serves (captureSnapshot, openSnapshot, projectAdd, projectRemove, claudeRetry, checkUpdate, openUrl) are stood in for
// here and recorded in window.preview.sent; nothing leaves the page. Returns { checkName: passed } like
// glass-round3-journey.mjs, so the smoke can report each one.
export async function controlRound4Journey(page, origin, width, snapshot = async () => {}) {
  const results = {};
  const check = (name, passed) => { results[`control-${width}/${name}`] = !!passed; };
  const open = async () => {
    await page.setViewportSize({ width, height: 640 });
    await page.goto(`${origin}/control.html?scenario=linked`);
    await page.waitForFunction(() => document.getElementById('chat-agent')?.value === 'claude');
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
  const openAdvanced = () => page.evaluate(() => { document.getElementById('advanced').open = true; });
  const openLink = () => page.evaluate(() => { document.getElementById('advanced').open = true; document.querySelector('.diagnostics').open = true; });
  const localError = group => page.locator(group).evaluate(el => el.previousElementSibling?.matches('[data-action-feedback]') ? el.previousElementSibling.textContent : '');

  // ---- Link Doctor and "Save what Familiar sees" ----
  await open();
  const doctor = 'Familiar sees the game but no coloured strip in its top-left corner. In game: is Familiar ticked in AddOns? Type /fam strip — it should say TOPLEFT.';
  await status({ linked: false, layout: null, doctor: { step: 'strip', level: 'warn', text: doctor } });
  const link = () => page.locator('.steps li').nth(2).evaluate(li => { const h = li.querySelector('.hint'); return { text: h.textContent, warn: h.classList.contains('warn'), done: !!li.querySelector('b.ok') }; });
  let now = await link();
  check('doctor: the Link step says why the link is not up, in the doctor\'s words and warn colour', now.text === doctor && now.warn && !now.done);
  await openLink();
  check('doctor: Link details repeat the sentence', (await page.locator('#link').textContent()).includes('Link doctor') && (await page.locator('#link').textContent()).includes('no coloured strip'));
  check('doctor: Save what Familiar sees sits under Link details and nothing is saved by itself', await page.locator('#b-snapshot').isVisible() && await sent() === '[]');
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
  check('snapshot: a refusal clears the old result and says why beside the button', (await localError('.btns:has(#b-snapshot)')).includes('Familiar has no picture of the game yet.'));
  await status({ doctor: null });
  check('doctor: without a doctor the Link step keeps its own wording', (await link()).text.startsWith('Restart WoW, tick Familiar and Familiar Sync'));
  await status({ linked: true, layout: { panel: true }, doctor: { step: 'ok', level: 'ok', text: 'Game link working.' } });
  now = await link();
  check('doctor: once linked the step says Game link working', now.text === 'Game link working' && now.done);

  // ---- Claude Code download on the Familiars card ----
  await open();
  await openAdvanced();
  const claude = () => page.locator('#providers .prov').first().evaluate(row => ({ text: row.querySelector('.d').textContent, bar: row.querySelector('progress')?.getAttribute('value') ?? null, button: row.querySelector('[data-retry]')?.textContent ?? null, markup: !!row.querySelector('.d img') }));
  await status({ 'providers.0.installed': false, 'providers.0.enabled': false, 'providers.0.signedIn': null, 'providers.0.detail': 'Not downloaded yet', claude: { state: 'downloading', pct: 43, mb: 112 } });
  let row = await claude();
  check('claude: the row shows progress, with a bar and nothing to click', row.text === 'Downloading Claude Code · 43 % of 112 MB' && row.bar === '43' && row.button === null);
  const cardUp = () => page.evaluate(() => !document.getElementById('advanced').contains(document.getElementById('familiars')));
  check('claude: while it downloads the card sits above Advanced, though another agent is ready', await cardUp());
  await snapshot(`control-${width}-claude-downloading`);
  await status({ claude: { state: 'failed', error: '<img src=x onerror="window.__pwned=1">' } });
  row = await claude();
  check('claude: a failure names the reason as plain text and offers Retry, in view without opening Advanced', row.text.includes('couldn\'t be downloaded (<img src=x') && row.text.endsWith('Other agents still work.') && row.button === 'Retry' && !row.markup
    && await page.evaluate(() => window.__pwned) === undefined && await cardUp() && await page.locator('#providers [data-retry]').isVisible());
  await page.evaluate(() => { window.preview.answer.claudeRetry = { state: 'downloading', pct: 0 }; });
  await page.locator('#providers [data-retry]').click();
  await page.waitForFunction(() => window.preview.sent.length >= 1);
  check('claude: Retry sends one claudeRetry and says where to watch', await sent() === '[{"cmd":"claudeRetry"}]' && (await page.locator('#feedback').textContent()).includes('Progress is on the Familiars card'));
  await status({ claude: { state: 'missing' } });
  check('claude: missing offers Retry, as the quest page and the Familiars card tell the player', (await claude()).button === 'Retry' && await cardUp());
  await status({ 'providers.0.installed': true, 'providers.0.enabled': true, 'providers.0.signedIn': true, 'providers.0.detail': 'Signed in', claude: { state: 'present' } });
  row = await claude();
  check('claude: once on disk the row is the ordinary one and the card goes back under Advanced', row.text === 'Signed in' && row.bar === null && row.button === null && !await cardUp());

  // ---- Projects ----
  await open();
  const place = () => page.evaluate(() => {
    const card = document.getElementById('projects');
    return { visible: !card.hidden && getComputedStyle(card).display !== 'none', inAdvanced: document.getElementById('advanced').contains(card),
      above: !!(card.compareDocumentPosition(document.getElementById('essentials')) & Node.DOCUMENT_POSITION_FOLLOWING),
      below: !!(document.getElementById('journey').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
      rows: [...card.querySelectorAll('#project-rows .prov')].map(r => [r.querySelector('.n').textContent, r.querySelector('.d').textContent]),
      buttons: [...card.querySelectorAll('.btns button')].map(b => b.textContent) };
  });
  check('projects: an older status (a plain count) shows no card', !(await place()).visible);
  await status({ projects: { explicit: [], roots: [], history: 3 } });
  let where = await place();
  check('projects: with no folder yet the card sits between the steps and the essentials, outside Advanced', where.visible && !where.inAdvanced && where.above && where.below
    && JSON.stringify(where.buttons) === JSON.stringify(['Add a project folder…', 'Add a folder of projects…']) && where.rows.length === 0);
  await snapshot(`control-${width}-projects-empty`);
  await openAdvanced();
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-rows .prov').length === 1);
  where = await place();
  check('projects: Add a project folder asks main for a project and lists the answer; the card moves into Advanced', await sent() === '[{"cmd":"projectAdd","args":{"kind":"project"}}]'
    && JSON.stringify(where.rows) === JSON.stringify([['Project', 'C:\\work\\one']]) && where.inAdvanced
    && (await page.locator('#project-result').textContent()).includes('C:\\work\\one'));
  await page.evaluate(() => { window.preview.add = { ok: true, path: 'D:\\code' }; });
  await page.locator('#b-root-add').click();
  await page.waitForFunction(() => document.querySelectorAll('#project-rows .prov').length === 2);
  check('projects: Add a folder of projects sends kind root and lists it as Projects in', (await sent()).endsWith('{"cmd":"projectAdd","args":{"kind":"root"}}]')
    && JSON.stringify((await place()).rows) === JSON.stringify([['Project', 'C:\\work\\one'], ['Projects in', 'D:\\code']]));
  await snapshot(`control-${width}-projects-some`);
  await page.evaluate(() => { window.preview.add = { ok: false, why: 'That folder is excluded by your config.' }; });
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => document.querySelector('.btns:has(#b-project-add)').previousElementSibling?.matches('[data-action-feedback]'));
  check('projects: a refused folder says why beside the buttons and is not listed', (await localError('.btns:has(#b-project-add)')).includes('That folder is excluded by your config.')
    && (await place()).rows.length === 2);
  await page.evaluate(() => { window.preview.add = { ok: false }; });
  await page.locator('#b-project-add').click();
  await page.waitForFunction(() => !document.getElementById('b-project-add').disabled);
  check('projects: cancelling the dialog says nothing, neither a result nor an error', await localError('.btns:has(#b-project-add)') === ''
    && await page.locator('#project-result').textContent() === '' && await page.locator('#feedback').textContent() === '' && (await place()).rows.length === 2);
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
  check('projects: with the last folder gone the card returns above the essentials', where.visible && !where.inAdvanced && where.above && where.below);

  // ---- Versions and "Check for updates" ----
  await open();
  const header = () => page.locator('#vermismatch').evaluate(el => ({ shown: !el.hidden && getComputedStyle(el).display !== 'none', text: el.textContent }));
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
  await openAdvanced();
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
  await openAdvanced();
  await status({ update: { app: '0.2.0', addon: '0.2.0', mismatch: false, last: { current: '0.2.0', latest: '0.3.0', newer: true, url } } });
  u = await line();
  check('updates: status.update.last alone shows the line, and still nothing was sent', u.text === '0.3.0 is out · Open the download page' && u.open && await sent() === '[]');

  // ---- Windows notice setting ----
  await open();
  await openAdvanced();
  check('notices: the Windows notice box is on by default', await page.locator('#ui-tray').isChecked()
    && (await page.locator('label:has(#ui-tray)').textContent()).includes('Windows notice when a request is waiting and WoW isn\'t in front'));
  await page.locator('#ui-tray').uncheck();
  await page.waitForFunction(() => window.preview.calls.some(c => c.cmd === 'uiSettings'));
  check('notices: unticking sends one trayNotices preference and the box stays off', JSON.stringify(await page.evaluate(() => window.preview.calls.filter(c => c.cmd === 'uiSettings').map(c => c.args))) === '[{"trayNotices":false}]'
    && !await page.locator('#ui-tray').isChecked());
  return results;
}

// UX round 3 Glass journeys: the actual built Glass through the synthetic preview bridge. Clicks and
// wheel go through the incoming-addon path (overlay.ts hit-tests them); no game, agents or decisions.
// Returns { checkName: passed } like renderer-update-journey.mjs.
export async function glassRound3Journey(page, origin) {
  const results = {};
  const check = (name, passed) => { results[name] = !!passed; };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const open = async scenario => {
    await page.goto(`${origin}/overlay.html?scenario=${scenario}`);
    await page.waitForFunction(() => window.preview && !document.body.classList.contains('hidden'));
    await page.evaluate(() => document.fonts.ready);
    await settle();
  };
  // Click the visible control matching selector, as the addon would forward it (detail region).
  const click = async selector => {
    const calls = await page.evaluate(selector => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`No control: ${selector}`);
      const r = document.getElementById('detail').getBoundingClientRect(), b = el.getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom || document.elementFromPoint(x, y)?.closest('[data-act]') !== el)
        throw new Error(`Control is clipped or covered: ${el.textContent}`);
      const before = window.preview.calls.length;
      window.preview.emit('input', { t: 'click', r: 'detail', x: (x - r.left) / r.width, y: (y - r.top) / r.height, b: 'L' });
      return window.preview.calls.slice(before);
    }, selector);
    await settle();
    return calls;
  };
  const decide = "[data-act*='\"type\":\"decide\"']";
  const decisions = () => page.locator(decide).evaluateAll(els => els.map(el => ({ text: el.textContent, decision: JSON.parse(el.dataset.act).decision })));
  // Change the synthetic model in the page (the overlay's CSP forbids eval), then push it.
  const push = async (patch = () => {}) => {
    await page.evaluate(patch);
    await page.evaluate(() => { const p = window.preview; p.emit('model', { ...p.model }); });
    await settle();
  };

  // ---- §3a cut request: Deny only, banner, "Approve on your PC"
  await open('approval-cut');
  const cut = await page.evaluate(() => {
    const banner = document.querySelector('.preview-cut'), pre = document.querySelector('.approval-preview');
    return { count: document.querySelectorAll('.preview-cut').length, text: banner?.textContent ?? '', above: !!banner && banner.getBoundingClientRect().bottom <= pre.getBoundingClientRect().top,
      pc: document.querySelector('.approve-pc')?.textContent, always: document.querySelectorAll('.btn.always').length, approve: document.querySelectorAll('.btn.ok').length };
  });
  check('cut: one banner above the preview sends you to the PC', cut.count === 1 && cut.above && cut.text.includes('not shown here') && cut.text.includes("Familiar's control panel on your PC"));
  const cutButtons = await decisions();
  check('cut: Deny is the only decision control', cutButtons.length === 1 && cutButtons[0].decision === 'deny' && cutButtons[0].text === 'Deny' && cut.approve === 0 && cut.always === 0);
  check('cut: a muted line stands where Approve would be', cut.pc === 'Approve on your PC');
  check('cut: pending preview shows all available text', await page.locator('.approval-preview').textContent() === await page.evaluate(() => window.preview.model.detail.entries[0].text));
  check('cut: no automatic action', await page.evaluate(() => window.preview.calls.length) === 0);
  const denyCalls = await click(`${decide}.no`);
  check('cut: Deny sends exactly one deny', denyCalls.length === 1 && denyCalls[0].type === 'decide' && denyCalls[0].decision === 'deny');
  check('cut: denied card leaves no controls', await page.locator(decide).count() === 0 && (await page.locator('.card-s').textContent()).includes('Denied'));
  // A model without the typed flag never draws the banner, whatever its text says (no substring sniff).
  await open('approval-cut');
  await push(() => { window.preview.model.detail.entries[0].cut = false; });
  check('cut: only the typed flag marks a request cut', await page.locator('.preview-cut').count() === 0 && (await decisions()).map(b => b.decision).join() === 'allow,deny');

  // ---- §3b refusal written on the card
  await open('approval-refused');
  const refused = await page.evaluate(() => {
    const line = document.querySelector('.card-refused'), btns = document.querySelector('.entry.approval .btns');
    return { text: line?.textContent ?? '', below: !!line && line.getBoundingClientRect().top >= btns.getBoundingClientRect().bottom,
      red: !!line && getComputedStyle(line).color !== getComputedStyle(document.querySelector('.preview-note')).color };
  });
  check('refused: the card says why, under the buttons, in red', /Click Approve again/.test(refused.text) && refused.text.startsWith('✗ ') && refused.below && refused.red);
  check('refused: Approve and Deny are still offered', (await decisions()).map(b => b.decision).join() === 'allow,deny');
  await click(`${decide}.ok`);
  check('refused: the line goes once the request is decided', await page.locator('.card-refused').count() === 0);

  // ---- §3c live mode over the native Mode button
  await open('approval');
  const plate = () => page.evaluate(() => {
    const el = document.getElementById('mode-label'), r = el.getBoundingClientRect();
    const keys = window.preview.model.keys, k = window.innerWidth / 1280, rect = [828, 74, 64, 22].map(v => v * k);
    return { shown: getComputedStyle(el).display !== 'none', text: el.textContent, hot: el.classList.contains('hot'), color: getComputedStyle(el).color,
      inside: r.left >= rect[0] - 0.5 && r.top >= rect[1] - 0.5 && r.right <= rect[0] + rect[2] + 0.5 && r.bottom <= rect[1] + rect[3] + 0.5 && r.width > rect[2] - 1,
      fits: el.firstElementChild ? el.firstElementChild.scrollWidth <= el.clientWidth + 1 : true, inert: getComputedStyle(el).pointerEvents === 'none', mode: keys.mode };
  });
  const ask = await plate();
  check('mode: the Mode button reads the quest mode, inside its rect', ask.shown && ask.text === 'Ask first' && ask.inside && ask.fits && !ask.hot && ask.inert);
  await push(() => { const m = window.preview.model; m.keys = { ...m.keys, mode: 'Accept edits', modeHot: true }; });
  const hot = await plate();
  check('mode: Accept edits is orange and still fits', hot.shown && hot.text === 'Accept edits' && hot.hot && hot.color !== ask.color && hot.fits && hot.inside);
  await push(() => { const m = window.preview.model; m.keys = { ...m.keys, mode: undefined, modeHot: undefined }; });
  check('mode: nothing selected shows the native label', !(await plate()).shown);
  await open('welcome');
  check('mode: welcome has no mode plate', !(await plate()).shown);

  // ---- §6 Quest Complete / Quest Failed
  await open('quest-complete');
  const toast = sel => page.evaluate(sel => { const el = document.querySelector(sel); return el && { text: el.textContent, before: getComputedStyle(el, '::before').content,
    after: getComputedStyle(el, '::after').content, font: getComputedStyle(el).fontFamily }; }, sel);
  const done = await toast('.toast.done');
  check('toast: Quest Complete banner with the ◆ ornament and rules', !!done && done.text.startsWith('Quest Complete') && done.before.includes('◆') && done.after !== 'none' && done.font.includes('Familiar Display'));
  await open('quest-failed');
  const failed = await toast('.toast.error');
  check('toast: Quest Failed banner in the same shape', !!failed && failed.text.startsWith('Quest Failed') && failed.after !== 'none' && failed.before.includes('✗'));
  await open('finished');
  await push(() => { window.preview.model.toasts = [{ kind: 'done', text: 'Quest Complete · Quest log', at: 1 }]; });
  const inwin = await toast('#toasts.inwin .toast.done');
  check('toast: in-window notice keeps the ornament on one line', !!inwin && inwin.text.startsWith('Quest Complete') && inwin.before.includes('◆'));

  // ---- §5 cost and usage
  await open('running');
  check('tracker: line meta reads project · progress · cost', (await page.locator('.tl-h .s').first().textContent()) === 'Preview project · 3/5 · $0.12'
    && (await page.locator('.tl-h .s').nth(1).textContent()) === 'Chats · 8.2k tokens');
  await click("[data-act*='\"what\":\"details\"']");
  check('details: usage follows project and mode', (await page.locator('.qmeta').textContent()).endsWith(' · 12.3k in · 4.1k out · $0.12'));

  // ---- §7 Stream-safe
  await open('stream-safe');
  const blur = () => page.evaluate(() => {
    const f = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el).filter : 'missing'; };
    return { body: document.body.classList.contains('blur'), reply: f('.entry.assistant .body'), you: f('.entry.user .body'), tool: f('.tool-line .tsum'), obj: f('.obj'),
      tracker: f('.tl-a'), preview: f('.approval-preview'), card: f('.entry.approval .card'), title: f('.qtitle'), status: document.getElementById('status').textContent };
  });
  const b = await blur();
  check('stream-safe: replies, your messages, tools, objectives and tracker are blurred', b.body && [b.reply, b.you, b.tool, b.obj, b.tracker].every(v => v.startsWith('blur(')));
  check('stream-safe: the approval card and titles stay readable', b.preview === 'none' && b.card === 'none' && b.title === 'none');
  check('stream-safe: status says Stream-safe on', b.status.endsWith(' · Stream-safe on') && !b.status.includes('Hide names on'));
  const revealCalls = await click('.entry.assistant .body');
  check('stream-safe: a click reveals that reply only, with no action', revealCalls.length === 0 && await page.evaluate(() =>
    getComputedStyle(document.querySelector('.entry.assistant .body')).filter === 'none' && getComputedStyle(document.querySelector('.entry.user .body')).filter.startsWith('blur(')));
  await push();
  check('stream-safe: a model push keeps the reveal', await page.locator('.entry.assistant.revealed').count() === 1);
  await page.waitForFunction(() => !document.querySelector('.entry.revealed'), null, { timeout: 10000 }).catch(() => {});
  check('stream-safe: the reply blurs again after a few seconds', await page.evaluate(() => getComputedStyle(document.querySelector('.entry.assistant .body')).filter.startsWith('blur(')));
  await push(() => { window.preview.model.blur = false; });
  check('stream-safe: off removes the blur and the reveal control', await page.evaluate(() => !document.body.classList.contains('blur')
    && getComputedStyle(document.querySelector('.entry.assistant .body')).filter === 'none' && !document.querySelector('.entry.assistant .body[data-act]'))
    && (await page.locator('#status').textContent()).endsWith(' · Hide names on'));

  // ---- §8 Jump to latest (wheel d:-9999 on detail)
  await open('long');
  const emitWheel = async d => { await page.evaluate(d => window.preview.emit('input', { t: 'wheel', r: 'detail', d }), d); await settle(); };
  const place = () => page.evaluate(() => { const s = document.getElementById('detail-scroll');
    return { bottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 2, top: s.scrollTop < 2, latest: getComputedStyle(document.getElementById('latest')).display !== 'none' }; });
  await emitWheel(12);
  const reading = await place();
  await emitWheel(-9999);
  const jumped = await place();
  check('latest: d -9999 jumps to the bottom and hides Latest', !reading.bottom && reading.latest && jumped.bottom && !jumped.latest);
  await push(() => { window.preview.model.detail.entries.push({ id: 'after-jump', kind: 'assistant', text: 'A new synthetic reply after the jump.' }); });
  check('latest: after the jump new replies are followed', (await place()).bottom);
  await emitWheel(10000);
  check('latest: a large upward wheel still reaches the top', (await place()).top);

  // ---- §1 the practice quest and the welcome link
  await open('tutorial');
  const row = await page.evaluate(() => { const r = document.querySelector('.row.ag-familiar'), g = r?.querySelector('.ag');
    return r && { glyph: g.textContent, color: getComputedStyle(g).color, text: r.querySelector('.t').textContent, unread: r.classList.contains('st-approval') }; });
  check('tutorial: the ◆ Familiar row is drawn in the familiar colour', !!row && row.glyph === '◆' && row.color === 'rgb(185, 163, 255)' && row.text === 'A Familiar Face');
  check('tutorial: the practice card has Approve and Deny only', (await decisions()).map(b => b.decision).join() === 'allow,deny' && await page.locator('.preview-cut').count() === 0);
  check('tutorial: header uses the familiar glyph and colour', await page.evaluate(() => { const g = document.querySelector('.qtitle .ag');
    return g.textContent.includes('◆ Familiar') && getComputedStyle(g).color === 'rgb(185, 163, 255)'; }));
  await open('welcome');
  const replayCalls = await click(".welcome-tutorial [data-act*='\"type\":\"tutorial\"']");
  check('welcome: Replay A Familiar Face sends only the tutorial action', replayCalls.length === 1 && replayCalls[0].type === 'tutorial'
    && (await page.locator('.welcome-tutorial').textContent()).includes('Replay A Familiar Face'));
  return results;
}

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

  // ---- round 5: the welcome page is the quest giver (a face, a greeting, the offers as quest rows)
  const head = async () => (await page.waitForFunction(() => { const i = document.querySelector('.welcome img.portrait'); return !i || i.complete; }), page.evaluate(() => { const w = document.querySelector('.welcome'), img = w?.querySelector('img.portrait');
    return w && { cls: w.className, src: img?.getAttribute('src'), alt: img?.getAttribute('alt'), loaded: !!img && img.complete && img.naturalWidth === 192,
      big: w.querySelector('.big')?.textContent, sub: w.querySelector('.sub')?.textContent, text: w.textContent }; }));
  await open('welcome');
  let w = await head();
  check('welcome: the idle quest giver greets with "Well met." and says who it is linked to', !!w && w.cls === 'welcome idle' && w.src === 'assets/idle-192.png' && w.alt === '' && w.loaded
    && w.big === 'Well met.' && w.sub === 'Linked to Preview Rogue.');
  await open('welcome-empty');
  w = await head();
  check('welcome: no quests yet, the familiar sleeps and says how to wake it', !!w && w.cls === 'welcome asleep' && w.src === 'assets/asleep-192.png' && w.loaded
    && w.big === 'No quests yet.' && w.sub === 'Wake me with + Claude or + Codex, or ask a question with + Chat.');
  await open('welcome-working');
  w = await head();
  check('welcome: a running quest shows the working face and the count', !!w && w.cls === 'welcome working' && w.src === 'assets/working-192.png' && w.loaded
    && w.big === 'Well met.' && w.sub === 'Linked to Preview Rogue · 1 working.');
  await open('welcome-unlinked');
  w = await head();
  check('welcome: no game link, the familiar is puzzled and points at the PC', !!w && w.cls === 'welcome puzzled' && w.src === 'assets/puzzled-192.png' && w.loaded
    && w.big === "I can't see the game yet." && w.sub === 'Waiting for the game link. Familiar on your PC says what it sees (tray → Open Familiar).');
  await open('welcome-unready');
  w = await head();
  check('welcome: unlinked and unready is puzzled, and the Chat explanation is still there', !!w && w.cls === 'welcome puzzled' && w.text.includes('Chat uses Claude or Codex'));
  await open('welcome');
  await push(() => { const d = window.preview.model.detail; d.backends = d.backends.map(b => ({ ...b, ready: false })); d.chat = { ...d.chat, ready: false }; });
  w = await head();
  check('welcome: linked with no familiar ready is puzzled, with its own line', !!w && w.cls === 'welcome puzzled' && w.big === 'Well met.'
    && w.sub === 'No familiar is ready yet. Open Familiar from the tray icon on your PC to sign in.' && w.text.includes('Chat uses Claude or Codex'));

  // Offers read as quest rows: a gold "!" in the display face; the practice-quest line keeps its own ◆. The sentences are unchanged.
  await open('welcome');
  const offers = await page.evaluate(() => [...document.querySelectorAll('.welcome .hint')].map(h => { const b = getComputedStyle(h, '::before');
    return { cls: h.className, bullet: b.content, color: b.color, font: b.fontFamily, bold: h.querySelector('b')?.textContent }; }));
  const offered = offers.filter(o => o.cls.includes('offer'));
  check('welcome: the three offers carry a gold "!" bullet in the display face',
    offered.map(o => o.cls.split(' ').pop()).join() === 'welcome-chat,welcome-project,welcome-continue'
    && offered.every(o => o.bullet === '"!"' && o.color === 'rgb(255, 209, 0)' && o.font.includes('Familiar Display'))
    && offered.map(o => o.bold).join() === 'Ask a game question,Work on a project,Continue a conversation');
  check('welcome: the practice-quest line and the familiars list get no "!"', offers.filter(o => !o.cls.includes('offer')).every(o => o.bullet === 'none' || o.bullet === 'normal')
    && (await page.locator('.welcome-tutorial .ag').textContent()) === '◆');

  // The portrait: a ring, sized from the row height, inert, inside the pane (so the opacity slider fades it), gone in a short pane.
  const face = () => page.evaluate(() => { const img = document.querySelector('.welcome img.portrait'), r = img.getBoundingClientRect(), cs = getComputedStyle(img),
    pane = getComputedStyle(document.getElementById('detail')), d = document.getElementById('detail').getBoundingClientRect();
    return { w: r.width, h: r.height, display: cs.display, radius: cs.borderRadius, ring: cs.boxShadow, bg: cs.backgroundColor, act: !!img.closest('[data-act]'),
      inside: r.left >= d.left && r.right <= d.right && r.top >= d.top && r.bottom <= d.bottom, paneBg: pane.backgroundColor, short: document.body.classList.contains('short-detail'),
      offers: document.querySelectorAll('.welcome .hint.offer').length, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
  const layout = (detail, over = {}) => ({ scr: [1280, 800], px: 1.25, panel: true, native: false, drag: false, combat: false, ui: true, rowH: 24,
    list: [30, 100, 250, 620], detail, status: [30, 735, 940, 28], ...over });
  const relayout = async l => { await page.evaluate(l => window.preview.emit('layout', l), l); await settle(); };
  let f = await face();
  check('welcome: the portrait is a round medallion with a hairline ring, sized from the row height (48-96 px)', f.w === f.h && f.w >= 48 && f.w <= 96 && f.radius === '50%'
    && f.ring.includes('0px 0px 0px 1px') && f.display !== 'none' && !f.short && f.inside);
  const before = await page.evaluate(() => window.preview.calls.length);
  await page.evaluate(({ x, y }) => { const r = document.getElementById('detail').getBoundingClientRect();
    window.preview.emit('input', { t: 'click', r: 'detail', x: (x - r.left) / r.width, y: (y - r.top) / r.height, b: 'L' }); }, { x: f.cx, y: f.cy });
  check('welcome: the portrait is not a control: no hit rect, no action', !f.act && await page.evaluate(() => window.preview.calls.length) === before);
  await relayout(layout([320, 100, 650, 100]));
  f = await face();
  check('welcome: in a detail pane under 200 px tall the portrait steps aside and the offers still render', f.short && f.display === 'none' && f.offers === 3
    && (await page.locator('.welcome-tutorial').count()) === 1);
  await relayout(layout([320, 100, 650, 500], { op: 40 }));
  f = await face();
  check('welcome: the portrait has no background of its own, so the opacity slider fades the pane with it', !f.short && f.bg === 'rgba(0, 0, 0, 0)' && f.inside
    && f.paneBg === 'rgba(9, 8, 11, 0.4)');
  await open('welcome-unlinked');
  await push(() => { window.preview.model.fontScale = 1.45; });
  await relayout(layout([300, 100, 380, 620]));
  const narrow = await page.evaluate(() => { const s = document.getElementById('detail-scroll'), img = document.querySelector('.welcome img.portrait').getBoundingClientRect();
    return { fits: s.scrollWidth <= s.clientWidth + 1, face: img.width, text: document.querySelector('.welcome .big').textContent }; });
  check('welcome: in a narrow pane at large text the face shrinks to 48 px and nothing spills sideways', narrow.fits && narrow.face === 48 && narrow.text === "I can't see the game yet.");
  return results;
}

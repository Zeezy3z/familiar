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

  // ---- §6 Quest Complete / Quest Failed: the painted seal replaces the ◆ / ✗ ornament (round 5), with the hub's rewards line under the title
  await open('quest-complete');
  const toast = sel => page.evaluate(sel => { const el = document.querySelector(sel), img = el?.querySelector('img.seal'), sub = el?.querySelector('.sub'); return el && {
    text: el.textContent, before: getComputedStyle(el, '::before').content, after: getComputedStyle(el, '::after').content, afterDisplay: getComputedStyle(el, '::after').display, font: getComputedStyle(el).fontFamily, color: getComputedStyle(el).color,
    src: img?.getAttribute('src'), alt: img?.getAttribute('alt'), loaded: !!img && img.complete && img.naturalWidth === 128, seals: el.querySelectorAll('img.seal').length,
    sealW: img?.getBoundingClientRect().width, fontPx: parseFloat(getComputedStyle(el).fontSize), anim: img && getComputedStyle(img).animationName, bannerAnim: getComputedStyle(el).animationName,
    title: el.querySelector('.t')?.textContent, sub: sub?.textContent, subDisplay: sub && getComputedStyle(sub).display, subBefore: sub && getComputedStyle(sub, '::before').content,
    subFont: sub && getComputedStyle(sub).fontFamily, subSize: sub && parseFloat(getComputedStyle(sub).fontSize) / parseFloat(getComputedStyle(el).fontSize), subColor: sub && getComputedStyle(sub).color,
    titleDisplay: el.querySelector('.t') && getComputedStyle(el.querySelector('.t')).display }; }, sel);
  await page.waitForFunction(() => { const i = document.querySelector('.toast img.seal'); return !i || i.complete; });
  const done = await toast('.toast.done');
  check('toast: Quest Complete banner with the seal, its rewards line and the closing rule', !!done && done.title === 'Quest Complete · Quest log' && done.src === 'assets/seal-128.png' && done.alt === '' && done.loaded
    && done.seals === 1 && done.before === 'none' && done.after !== 'none' && done.font.includes('Familiar Display'));
  // Round 7 §2.4: the sub is max(11px, 1.6vh) (it scales with the screen, like the banner), not 0.62em of the banner.
  const subPx = await page.evaluate(() => Math.max(11, innerHeight * 0.016));
  check('toast: the rewards line is the hub sub, small, in the plain face and the dim text colour', done.sub === '3/3 objectives · 2 edits · $0.21' && done.subFont.includes('Segoe UI')
    && Math.abs(done.subSize * done.fontPx - subPx) < 0.05 && done.subColor === 'rgb(191, 182, 164)');
  check('toast: the seal is 2.2em of the banner text', Math.abs(done.sealW - 2.2 * done.fontPx) < 1);
  await open('quest-failed');
  await page.waitForFunction(() => { const i = document.querySelector('.toast img.seal'); return !i || i.complete; });
  const failed = await toast('.toast.error');
  check('toast: Quest Failed banner in the same shape, with the cracked seal and the red text', !!failed && failed.title === 'Quest Failed · Quest log' && failed.src === 'assets/seal-cracked-128.png' && failed.loaded
    && failed.seals === 1 && failed.before === 'none' && failed.after !== 'none' && failed.color === 'rgb(255, 90, 79)' && failed.sub === undefined);
  // Motion (the journey runs with reduced motion on): the Complete seal stamps in, the Failed one only settles with the banner, and reduced motion stills both.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const moving = { done: await (async () => { await open('quest-complete'); return toast('.toast.done'); })(), failed: await (async () => { await open('quest-failed'); return toast('.toast.error'); })() };
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open('quest-complete');
  const still = await toast('.toast.done');
  check('toast: the Complete seal stamps in, the Failed seal makes no motion of its own, reduced motion stills the seal', moving.done.anim === 'stamp' && moving.done.bannerAnim === 'settle'
    && moving.failed.anim === 'none' && moving.failed.bannerAnim === 'settle' && still.anim === 'none');
  await open('finished');
  await push(() => { window.preview.model.toasts = [{ kind: 'done', text: 'Quest Complete · Quest log', sub: '3/3 objectives · 2 edits · $0.21', at: 1 }, { kind: 'error', text: 'Quest Failed · Quest log', sub: '<b>1</b>/3 objectives', at: 2 },
    { kind: 'done', text: 'Answer ready · A quick question', at: 3 }]; });
  await page.waitForFunction(() => [...document.querySelectorAll('.toast img.seal')].every(i => i.complete));
  const inwin = await toast('#toasts.inwin .toast.done');
  check('toast: in-window notice keeps the moment on one line: a 1em seal, the title, then the rewards after " · "', !!inwin && inwin.title === 'Quest Complete · Quest log' && inwin.src === 'assets/seal-128.png' && inwin.before === 'none'
    && Math.abs(inwin.sealW - inwin.fontPx) < 1 && inwin.titleDisplay === 'inline' && inwin.subDisplay === 'inline' && inwin.subBefore === '" · "' && inwin.sub === '3/3 objectives · 2 edits · $0.21'
    && inwin.afterDisplay === 'none');
  const stacked = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(t => ({ kind: t.className, sub: t.querySelector('.sub')?.textContent ?? null, html: t.querySelector('.sub b') !== null,
    oneLine: t.getBoundingClientRect().height < 2.4 * parseFloat(getComputedStyle(t).fontSize) * 1.6, src: t.querySelector('img.seal')?.getAttribute('src') })));
  check('toast: a chat answer has no rewards line, a failure carries its own, and a line is text, never markup', stacked.length === 3 && stacked[2].sub === null && stacked[1].sub === '<b>1</b>/3 objectives' && stacked.every(t => !t.html)
    && stacked[1].src === 'assets/seal-cracked-128.png' && stacked[2].src === 'assets/seal-128.png' && stacked.every(t => t.oneLine));

  // ---- round 7 §2.3 in-window notices take a row in the detail pane (first child), never painted over the quest header
  await open('quest-complete-inwin');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast img.seal')].every(i => i.complete));
  const strip = () => page.evaluate(() => { const t = document.getElementById('toasts'), toast = t.querySelector('.toast'), head = document.querySelector('.qhead'), s = document.getElementById('detail-scroll');
    const cs = toast && getComputedStyle(toast);
    return { parent: t.parentElement?.id || t.parentElement?.tagName, first: t.parentElement?.firstElementChild === t, inwin: t.classList.contains('inwin'), count: t.children.length,
      toastBottom: toast?.getBoundingClientRect().bottom, headTop: head?.getBoundingClientRect().top, scrollH: document.getElementById('content').scrollHeight, bar: cs && cs.borderLeftWidth, barColor: cs && cs.borderLeftColor,
      bg: cs && cs.backgroundColor, font: cs && parseFloat(cs.fontSize), small: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--small-font')),
      oneLine: !!toast && toast.getBoundingClientRect().height < 2 * parseFloat(cs.lineHeight || '0') + 1 || (!!toast && toast.getBoundingClientRect().height < parseFloat(cs.fontSize) * 2.6),
      inside: !!toast && (() => { const r = toast.getBoundingClientRect(), d = document.getElementById('detail').getBoundingClientRect(); return r.left >= d.left - 0.5 && r.right <= d.right + 0.5 && r.top >= d.top - 0.5; })() }; });
  const inStrip = await strip();
  check('inwin: raid warnings off puts the notices in the detail pane, as its first child', inStrip.parent === 'detail' && inStrip.first && inStrip.inwin && inStrip.count === 1);
  check('inwin: the notice takes a row above the quest header (no overlap), inside the pane', inStrip.headTop >= inStrip.toastBottom - 0.5 && inStrip.inside);
  check('inwin: the strip is one small line with a 3 px gold bar on a near-opaque ground', inStrip.oneLine && inStrip.bar === '3px' && inStrip.barColor === 'rgb(255, 209, 0)'
    && inStrip.bg === 'rgba(24, 19, 8, 0.96)' && Math.abs(inStrip.font - inStrip.small) < 0.05);
  await push(() => { window.preview.model.toasts = []; });
  const gone = await strip();
  check('inwin: when the notice expires the transcript keeps its height and the header returns to the top', gone.count === 0 && gone.scrollH === inStrip.scrollH && gone.parent === 'detail');
  await open('approval-always-inwin');
  const appr = await strip();
  check('inwin: a request notice is marked by the warn bar', appr.parent === 'detail' && appr.barColor === 'rgb(255, 128, 64)' && appr.headTop >= appr.toastBottom - 0.5);
  await push(() => { window.preview.model.raidWarnings = true; });
  check('inwin: raid warnings on moves the notices back to the page, as a banner', await page.evaluate(() => { const t = document.getElementById('toasts');
    return t.parentElement === document.body && !t.classList.contains('inwin') && getComputedStyle(t).position === 'absolute'; }));
  await open('quest-complete');
  check('inwin: quest-complete (raid warnings on) keeps the raid banner on the page', await page.evaluate(() => document.getElementById('toasts').parentElement === document.body));

  // ---- round 7 §2.3 the quest header: the mode and the state are chips; no helper sentence; Details carries a chevron
  await open('approval-always');
  const chips = () => page.evaluate(() => [...document.querySelectorAll('.qbar .chip')].map(c => { const cs = getComputedStyle(c);
    return { text: c.textContent, border: cs.borderTopColor, color: cs.color, font: cs.fontFamily, size: parseFloat(cs.fontSize), radius: parseFloat(cs.borderTopLeftRadius) }; }));
  let hc = await chips();
  const small = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--small-font')));
  check('header: Ask first and ! Needs your approval are two chips in the display face at the small size', hc.length === 2 && hc[0].text === 'Ask first' && hc[1].text === '! Needs your approval'
    && hc.every(c => c.font.includes('Familiar Display') && Math.abs(c.size - small) < 0.05 && c.radius > 0));
  check('header: the state chip takes the warn colour on its border and text', hc[1].border === 'rgb(255, 128, 64)' && hc[1].color === 'rgb(255, 128, 64)');
  check('header: the helper sentence is gone from the header', await page.locator('.qstate span').count() === 0
    && !(await page.locator('.qhead').textContent()).includes('Review the request below'));
  check('header: Details carries a chevron that turns when open', (await page.locator(".qbar [data-act*='\"what\":\"details\"']").textContent()) === 'Details ▾'
    && (await click(".qbar [data-act*='\"what\":\"details\"']")).length === 0 && (await page.locator(".qbar [data-act*='\"what\":\"details\"']").textContent()) === 'Details ▴');
  await open('running');
  hc = await chips();
  check('header: a working quest shows ◌ Working in the info colour', hc.length === 2 && hc[1].text === '◌ Working' && hc[1].border === 'rgb(113, 213, 255)');
  await open('interrupted');
  hc = await chips();
  check('header: an interrupted quest shows ! Interrupted in warn, without its hint', hc[1]?.text === '! Interrupted' && hc[1].border === 'rgb(255, 128, 64)'
    && !(await page.locator('.qhead').textContent()).includes('Send a message'));
  await open('finished');
  check('header: a routine state shows the mode chip alone', (await chips()).map(c => c.text).join() === 'Ask first');

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
      tracker: f('.tl-a'), preview: f('.approval-preview'), card: f('.entry.approval .card'), title: f('.qtitle'), status: document.getElementById('status').textContent,
      words: document.querySelector('#status .st-text')?.textContent, chips: [...document.querySelectorAll('#status .chip')].map(c => c.textContent) };
  });
  const b = await blur();
  check('stream-safe: replies, your messages, tools, objectives and tracker are blurred', b.body && [b.reply, b.you, b.tool, b.obj, b.tracker].every(v => v.startsWith('blur(')));
  check('stream-safe: the approval card and titles stay readable', b.preview === 'none' && b.card === 'none' && b.title === 'none');
  check('stream-safe: status says Stream-safe on, as a chip after the words (round 6: it was a " · Stream-safe on" suffix)', b.chips.join() === 'Stream-safe on' && b.words === 'Linked · Claude ready · Codex ready' && !b.status.includes('Hide names on')
    && await page.evaluate(() => { const c = document.querySelector('#status .chip').getBoundingClientRect(), s = document.getElementById('status').getBoundingClientRect(); return c.left >= s.left && c.right <= s.right; }));
  // Round 6 §2.3: a violet gauze with a gold edge over the blurred text. The veil is the entry's own ::after, outside the filtered text.
  const veil = sel => page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el, '::after');
    return { content: cs.content, opacity: cs.opacity, border: cs.borderTopWidth, edge: cs.borderTopColor, pos: cs.position, events: cs.pointerEvents, bg: cs.backgroundImage, w: parseFloat(cs.width), h: parseFloat(cs.height),
      entryW: el.clientWidth, entryH: el.clientHeight, ownFilter: getComputedStyle(el).filter }; }, sel);
  let v = await veil('.entry.assistant');
  check("curtain: the reply's veil is on the entry: opaque, a 1 px gold edge, the whole entry, inert, and not itself blurred", v.content === '""' && v.opacity === '1' && v.border === '1px' && v.edge === 'rgba(201, 162, 39, 0.4)'
    && v.pos === 'absolute' && v.events === 'none' && v.bg.startsWith('linear-gradient(') && v.bg.includes('rgba(44, 26, 70, 0.55)') && Math.abs(v.w - v.entryW) < 1.5 && Math.abs(v.h - v.entryH) < 1.5 && v.ownFilter === 'none');
  check('curtain: your message and the objectives carry the veil too', (await veil('.entry.user')).opacity === '1' && (await veil('.entry.user')).content === '""' && (await veil('.objectives')).content === '""' && (await veil('.objectives')).opacity === '1');
  const approvalVeil = await veil('.entry.approval');
  check('curtain: nothing is drawn over the approval card, which stays unblurred', approvalVeil.content === 'none' && b.preview === 'none' && b.card === 'none');
  const revealCalls = await click('.entry.assistant .body');
  check('stream-safe: a click reveals that reply only, with no action', revealCalls.length === 0 && await page.evaluate(() =>
    getComputedStyle(document.querySelector('.entry.assistant .body')).filter === 'none' && getComputedStyle(document.querySelector('.entry.user .body')).filter.startsWith('blur(')));
  check("curtain: a reveal lifts that reply's veil and no other", (await veil('.entry.assistant')).opacity === '0' && (await veil('.entry.user')).opacity === '1' && (await veil('.objectives')).opacity === '1');
  await push();
  check('stream-safe: a model push keeps the reveal', await page.locator('.entry.assistant.revealed').count() === 1);
  await page.waitForFunction(() => !document.querySelector('.entry.revealed'), null, { timeout: 10000 }).catch(() => {});
  check('stream-safe: the reply blurs again after a few seconds', await page.evaluate(() => getComputedStyle(document.querySelector('.entry.assistant .body')).filter.startsWith('blur(')));
  await push(() => { window.preview.model.blur = false; });
  check('stream-safe: off removes the blur and the reveal control', await page.evaluate(() => !document.body.classList.contains('blur')
    && getComputedStyle(document.querySelector('.entry.assistant .body')).filter === 'none' && !document.querySelector('.entry.assistant .body[data-act]'))
    && (await blur()).chips.join() === 'Hide names on'); // round 6: a chip, it was a " · Hide names on" suffix
  v = await veil('.entry.assistant');
  check('curtain: with Stream-safe off there is no veil and no Stream-safe chip (Hide names alone is a chip, not a curtain)', v.content === 'none' && (await veil('.objectives')).content === 'none'
    && !(await blur()).chips.includes('Stream-safe on'));
  await push(() => { window.preview.model.private = false; window.preview.model.quiet = true; });
  check('chips: Alerts muted is a chip with its hint, and nothing else is', (await blur()).chips.join() === 'Alerts muted (/fam quiet off)');
  await push(() => { window.preview.model.blur = true; window.preview.model.private = true; });
  check('chips: Alerts muted and Stream-safe on side by side, in that order, and Hide names does not repeat itself', (await blur()).chips.join('|') === 'Alerts muted (/fam quiet off)|Stream-safe on');
  await push(() => { window.preview.model.quiet = false; window.preview.model.private = false; window.preview.model.blur = false; });
  check('chips: with everything off the status is the words alone', (await blur()).chips.length === 0 && (await blur()).words === 'Linked · Claude ready · Codex ready');
  // A reasoning block and an expanded tool output are blurred too, and their veils are crisp (outside what is filtered).
  await push(() => { const m = window.preview.model; m.blur = true; m.private = true; m.detail.entries.push({ id: 'think', kind: 'reasoning', text: 'Thinking about the pull timer.' });
    const tool = m.detail.entries.find(e => e.kind === 'tool'); tool.expanded = true; tool.output = '+ /pull 10\n- /pull 8'; });
  const extra = await page.evaluate(() => ({ body: getComputedStyle(document.querySelector('.entry.reasoning .body')).filter, entry: getComputedStyle(document.querySelector('.entry.reasoning')).filter,
    out: getComputedStyle(document.querySelector('.tout')).filter, outWrap: getComputedStyle(document.querySelector('.tout-veil')).filter }));
  check('curtain: reasoning and tool output are blurred, behind veils that are not', extra.body.startsWith('blur(') && extra.entry === 'none' && extra.out.startsWith('blur(') && extra.outWrap === 'none'
    && (await veil('.entry.reasoning')).content === '""' && (await veil('.tout-veil')).content === '""' && (await veil('.tout-veil')).border === '1px');
  check('curtain: the blur is 7px, with the colour drawn down', await page.evaluate(() => getComputedStyle(document.querySelector('.entry.assistant .body')).filter === 'blur(7px) saturate(0.5)'));
  await push(() => { const m = window.preview.model; m.detail.entries = m.detail.entries.filter(e => e.id !== 'think'); delete m.detail.entries.find(e => e.kind === 'tool').expanded; m.blur = false; m.private = false; });
  // With motion on the curtain lifts in --m-fast: gone within 200 ms of the click.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open('stream-safe');
  await click('.entry.assistant .body');
  const lifted = await page.waitForFunction(() => getComputedStyle(document.querySelector('.entry.assistant'), '::after').opacity === '0', null, { timeout: 200 }).then(() => true, () => false);
  check('curtain: a reveal lifts the veil within 200 ms (motion on), and the text is clear', lifted && await page.evaluate(() => getComputedStyle(document.querySelector('.entry.assistant .body')).filter === 'none'));
  await page.emulateMedia({ reducedMotion: 'reduce' });

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

  // Round 7 §2.1: the offers are four quest rows: a gold "!" glyph in the display face, the name over one dim line, the
  // actions on the right (siblings of the text, never inside a sentence); the practice quest is one line with its own ◆.
  await open('welcome');
  const rows = () => page.evaluate(() => [...document.querySelectorAll('.welcome .offers > *')].map(r => { const ob = r.querySelector('.ob'), cs = ob && getComputedStyle(ob), os = r.querySelector('.os');
    return { cls: r.className, glyph: ob?.textContent, color: cs?.color, font: cs?.fontFamily, name: r.querySelector('.on')?.textContent, sub: os?.textContent,
      subLines: os ? Math.round(os.getBoundingClientRect().height / parseFloat(getComputedStyle(os).lineHeight)) : 0,
      actions: [...r.querySelectorAll('.oa > *')].map(a => a.textContent), line: r.querySelector('.ot')?.textContent, text: r.textContent.replace(/\s+/g, ' ').trim(), flex: getComputedStyle(r).display }; }));
  let offerRows = await rows();
  check('welcome: four rows, three offers and the practice quest, in order', offerRows.map(r => r.cls).join() === 'offer welcome-chat,offer welcome-project,offer welcome-continue,welcome-tutorial'
    && offerRows.every(r => r.flex === 'flex'));
  check('welcome: each offer carries a gold "!" in the display face, its name and one dim line', offerRows.slice(0, 3).every(r => r.glyph === '!' && r.color === 'rgb(255, 209, 0)' && r.font.includes('Familiar Display') && r.subLines === 1)
    && offerRows.slice(0, 3).map(r => r.name).join() === 'Ask a game question,Work on a project,Continue a conversation');
  check("welcome: the designer's copy, ready state", offerRows[0].sub === 'Web search only; no files, no commands.' && offerRows[0].actions.join() === '+ Chat'
    && offerRows[1].sub === 'Pick a folder. I work while you play and ask before I change anything.' && offerRows[1].actions.join() === '+ Claude,+ Codex'
    && offerRows[2].sub === 'Pick a quest on the left, desktop threads too.' && offerRows[2].actions.length === 0
    && offerRows[3].line === 'Replay A Familiar Face · the practice quest');
  check('welcome: the practice-quest row keeps its own ◆ in the familiar colour, no "!"', offerRows[3].glyph === '◆' && offerRows[3].color === 'rgb(185, 163, 255)'
    && (await page.locator('.welcome-tutorial .ag').textContent()) === '◆');
  check('welcome: no button sits inside a text line; the only controls are an offer\'s actions and the practice-quest link', await page.evaluate(() => [...document.querySelectorAll('.welcome .btn, .welcome [data-act]')]
    .every(b => b.closest('.oa') || (b.classList.contains('link') && b.closest('.welcome-tutorial'))) && !document.querySelector('.welcome .ot .btn, .welcome .os [data-act]')));
  check('welcome: + Claude / + Codex are buttons that open the folder picker', await page.evaluate(() => { const keys = [...document.querySelectorAll('.welcome-project .oa .btn')];
    return keys.length === 2 && keys.map(k => JSON.parse(k.dataset.act).agent).join() === 'claude,codex' && keys.every(k => JSON.parse(k.dataset.act).type === 'start'); }));
  check('welcome: the old paragraphs, the familiars list and the counts line are gone', await page.evaluate(() => !document.querySelector('.welcome .hint, .welcome .kv')
    && !/Your familiars|awaiting approval|Opens a draft/.test(document.querySelector('.welcome').textContent)));
  const chatCalls = await click('.welcome-chat .btn');
  check('welcome: + Chat sends only the chat draft action', chatCalls.length === 1 && chatCalls[0].type === 'newIn' && chatCalls[0].key === 'chats');
  await open('welcome');
  const tline = await page.evaluate(() => { const t = document.getElementById('target'); return { text: t.textContent, warn: t.classList.contains('warn'), color: getComputedStyle(t).color }; });
  check('welcome: the target line is muted, not a warning, with the new words', tline.text === 'Messages go to: Nothing selected · pick a quest, or start one above.' && !tline.warn && tline.color === 'rgb(156, 147, 132)');
  // Every row fits the pane at the fixture geometry (row height 24) and in the default 720 x 440 window at 1080p (the audit's 1x).
  const fit = () => page.evaluate(() => { const s = document.getElementById('detail-scroll'), d = s.getBoundingClientRect();
    const bottoms = [...document.querySelectorAll('.welcome .offers > *')].map(r => r.getBoundingClientRect().bottom);
    return { third: bottoms[2] <= d.bottom + 0.5, all: bottoms.every(b => b <= d.bottom + 0.5), scroll: s.scrollHeight <= s.clientHeight + 1, wide: s.scrollWidth <= s.clientWidth + 1 }; });
  let fits = await fit();
  check('welcome: all four rows fit the pane at the fixture geometry', fits.third && fits.all && fits.scroll && fits.wide);
  await page.evaluate(() => { const p = window.preview; p.emit('layout', { ...p.layout, px: 1.0476, rowH: 16, list: [44, 105, 230, 345], detail: [281, 105, 455, 268],
    status: [179, 455, 210, 22], tracker: [773, 91, 239, 149], keys: {}, mini: [980, 5, 36, 36] }); });
  await settle();
  fits = await fit();
  check('welcome: at the default window (a 455 x 268 pane, row height 16) the third row and the practice quest are inside the pane, with no scroll', fits.third && fits.all && fits.scroll && fits.wide);
  check('welcome: at the default text size the face and the two-line greeting stay', await page.evaluate(() => !/(tight|faceless)/.test(document.querySelector('.welcome').className)
    && getComputedStyle(document.querySelector('.welcome img.portrait')).display !== 'none'));
  await push(() => { window.preview.model.fontScale = 1.3; });
  fits = await fit();
  check('welcome: at Text 130 % in the default window the face steps aside, the greeting takes one line, and the rows still fit', fits.all && fits.scroll && fits.wide
    && await page.evaluate(() => document.querySelector('.welcome').classList.contains('tight') && getComputedStyle(document.querySelector('.welcome img.portrait')).display === 'none'));
  await open('welcome-unready');
  offerRows = await rows();
  check('welcome-unready: with no chat provider the chat row says so and offers no + Chat; another ready familiar starts with /fam',
    offerRows[0].sub === 'Chat uses Claude or Codex. Sign in from the tray on your PC.' && offerRows[0].actions.length === 0 && offerRows[1].actions.join() === '/fam hermes'
    && (await page.locator('.welcome').textContent()).includes('Chat uses Claude or Codex'));
  await open('welcome-noprojects');
  offerRows = await rows();
  check('welcome-noprojects: the project row says where to add a folder, in gold-dim', offerRows[1].sub === 'No project folders yet. Add one in Familiar on your PC (tray → Open Familiar → Projects).'
    && offerRows[1].actions.join() === '+ Claude,+ Codex'
    && await page.evaluate(() => { const n = document.querySelector('.welcome-project .welcome-noprojects'); return !!n && getComputedStyle(n).color === 'rgb(201, 162, 39)'; }));
  await open('welcome');
  await push(() => { const d = window.preview.model.detail; d.backends = d.backends.map(b => ({ ...b, ready: false })); d.chat = { ...d.chat, ready: false }; });
  offerRows = await rows();
  check('welcome: with no familiar ready the project row says so and offers no starter', offerRows[1].sub === 'No familiar is ready yet. Sign in from the tray on your PC.' && offerRows[1].actions.length === 0);
  // Round 7 §2.6: a request waiting on you outranks a running quest: the asking face (idle until its file ships).
  await open('welcome-asking');
  w = await head();
  const askingShipped = await page.evaluate(() => fetch('assets/asking-192.png').then(r => r.ok, () => false));
  check('welcome: a request waiting on you shows the asking face and the count, ahead of working', !!w && w.cls === 'welcome asking' && w.big === 'Well met.'
    && w.sub === 'Linked to Preview Rogue · 1 waiting on you.' && w.loaded && w.src === (askingShipped ? 'assets/asking-192.png' : 'assets/idle-192.png'));
  await push();
  w = await head();
  check('welcome: a missing asking face falls back once and stays on the fallback across model pushes', !!w && w.loaded && w.src === (askingShipped ? 'assets/asking-192.png' : 'assets/idle-192.png'));

  // The portrait: a ring, sized from the row height, inert, inside the pane (so the opacity slider fades it), gone in a short pane.
  const face = () => page.evaluate(() => { const img = document.querySelector('.welcome img.portrait'), r = img.getBoundingClientRect(), cs = getComputedStyle(img),
    pane = getComputedStyle(document.getElementById('detail')), d = document.getElementById('detail').getBoundingClientRect();
    return { w: r.width, h: r.height, display: cs.display, radius: cs.borderRadius, ring: cs.boxShadow, bg: cs.backgroundColor, act: !!img.closest('[data-act]'),
      inside: r.left >= d.left && r.right <= d.right && r.top >= d.top && r.bottom <= d.bottom, paneBg: pane.backgroundColor, short: document.body.classList.contains('short-detail'),
      offers: document.querySelectorAll('.welcome .offer').length, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
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

  // ---- round 7 §2.4 the list rhythm and the four sizes
  await open('running');
  const list = () => page.evaluate(() => { const fs = el => parseFloat(getComputedStyle(el).fontSize), root = getComputedStyle(document.documentElement), v = n => parseFloat(root.getPropertyValue(n));
    const zone = document.querySelector('.row.zone'), sel = document.querySelector('.row.sel'), title = document.getElementById('list-title'), cnt = zone.querySelector('.s');
    return { tw: [...document.querySelectorAll('.row.zone .tw')].map(t => t.textContent), twFont: getComputedStyle(zone.querySelector('.tw')).fontFamily, selImg: getComputedStyle(sel).backgroundImage,
      selBg: getComputedStyle(sel).backgroundColor, selBar: getComputedStyle(sel).boxShadow, cnt: { size: fs(cnt), num: getComputedStyle(cnt).fontVariantNumeric, color: getComputedStyle(cnt).color },
      rowH: v('--row-h'), rowFont: v('--row-font'), small: v('--small-font'), body: v('--body-font'), rows: [...document.querySelectorAll('.row')].map(r => r.getBoundingClientRect().height),
      rowText: fs(sel), title: { h: title.getBoundingClientRect().height, size: fs(title), weight: getComputedStyle(title).fontWeight },
      ag: [...document.querySelectorAll('.row .ag')].map(a => fs(a) === fs(a.parentElement) && getComputedStyle(a).fontFamily.includes('Familiar Display')),
      st: [...document.querySelectorAll('.row .st')].map(s => fs(s) === fs(s.parentElement)),
      tracker: [...document.querySelectorAll('.tl-a, .tl-h .s')].map(fs), tout: null, qtitleAg: fs(document.querySelector('.qtitle .ag')), content: fs(document.getElementById('content')) }; });
  let L = await list();
  check('rows: twisties are ▾ when open, in the display face', L.tw.every(t => t === '▾') && L.tw.length === 2 && L.twFont.includes('Familiar Display'));
  check('rows: the selected row is a solid tint with a gold left bar, no gradient', L.selImg === 'none' && L.selBg === 'rgba(255, 209, 0, 0.12)' && L.selBar.includes('rgb(255, 209, 0)') && L.selBar.includes('inset'));
  check('rows: counts are small, tabular and muted', Math.abs(L.cnt.size - L.small) < 0.05 && L.cnt.num.includes('tabular-nums') && L.cnt.color === 'rgb(156, 147, 132)');
  check('rows: every row is --row-h tall and the pane title is too, in the row font at weight 700', L.rows.every(h => Math.abs(h - L.rowH) < 0.5) && Math.abs(L.title.h - L.rowH) < 1.5
    && Math.abs(L.title.size - L.rowFont) < 0.05 && L.title.weight === '700');
  check('rows: agent and status glyphs are the row size (one weight, one box)', L.ag.length > 0 && L.ag.every(Boolean) && L.st.every(Boolean));
  check('type: the tracker and the header glyph use the small size; the transcript the body size', L.tracker.length > 0 && L.tracker.every(px => Math.abs(px - L.small) < 0.05)
    && Math.abs(L.qtitleAg - L.small) < 0.05 && Math.abs(L.content - L.body) < 0.05);
  await push(() => { window.preview.model.list.rows[0].collapsed = true; });
  check('rows: a collapsed zone shows ▸', (await list()).tw[0] === '▸');
  await page.evaluate(() => { const p = window.preview; p.emit('layout', { ...p.layout, rowH: 16, px: 1 }); });
  await settle();
  L = await list();
  check('rows: at the 16 px row floor the row text is at least 10 px and rows stay --row-h', L.rowH === 16 && L.rowText >= 10 && L.rows.every(h => Math.abs(h - 16) < 0.5));

  // ---- round 6 §2.1 the cues: the Glass plays shared/cues.ts through one AudioContext of its own (a counting stub stands in for WebAudio)
  await open('finished');
  await page.evaluate(() => {
    const made = window.cuesMade = { contexts: 0, oscillators: 0, buffers: 0, started: 0, stopped: 0, peaks: [] };
    const param = peaks => ({ setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime(v) { peaks?.push(v); } });
    window.AudioContext = class {
      constructor() { made.contexts++; this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.destination = {}; }
      source(extra) { return { ...extra, connect() {}, start() { made.started++; }, stop() { made.stopped++; } }; }
      createOscillator() { made.oscillators++; return this.source({ frequency: param() }); }
      createBufferSource() { made.buffers++; return this.source({}); }
      createBuffer(c, n) { return { getChannelData: () => new Float32Array(n) }; }
      createBiquadFilter() { return { frequency: param(), Q: param(), connect() {} }; }
      createGain() { const first = []; made.peaks.push(first); return { gain: param(first), connect() {} }; }
    };
  });
  const cues = () => page.evaluate(() => ({ ...window.cuesMade, peaks: window.cuesMade.peaks.map(p => p[0]) }));
  const emitCue = payload => page.evaluate(payload => window.preview.emit('sound', payload), payload);
  await emitCue({ kind: 'approval', volume: 0.7 });
  let heard = await cues();
  check('cues: a sound event builds one context and plays the bell: four oscillators, each started and stopped', heard.contexts === 1 && heard.oscillators === 4 && heard.buffers === 0
    && heard.started === 4 && heard.stopped === 4);
  check('cues: the volume sent scales every voice (0.7 of 0.14, 0.05, 0.12, 0.04)', [0.098, 0.035, 0.084, 0.028].every((v, i) => Math.abs(heard.peaks[i] - v) < 1e-9));
  await emitCue({ kind: 'approval', volume: 0.7 });
  heard = await cues();
  check('cues: a second cue reuses the context', heard.contexts === 1 && heard.oscillators === 8);
  await emitCue('done');
  heard = await cues();
  check('cues: a bare cue name from an older main still plays, at the default volume', heard.contexts === 1 && heard.oscillators === 8 + 7
    && Math.abs(heard.peaks[8] - 0.09 * 0.7) < 1e-9);
  await emitCue({ kind: 'approved', volume: 1 });
  heard = await cues();
  check('cues: the stamp is a noise tap and a thump', heard.oscillators === 8 + 7 + 1 && heard.buffers === 1);
  const silent = await cues();
  await emitCue({ kind: 'reply', volume: 0 });
  await emitCue({ kind: 'nope', volume: 1 });
  await emitCue({ volume: 1 });
  await emitCue(null);
  await emitCue(42);
  heard = await cues();
  check('cues: volume 0, an unknown cue and a malformed event play nothing and break nothing', heard.contexts === 1 && heard.oscillators === silent.oscillators && heard.buffers === silent.buffers
    && heard.started === silent.started && heard.peaks.length === silent.peaks.length);

  // ---- round 6 §2.4 one motion vocabulary: the durations come from --m-fast / --m-arrive / --m-settle (motion on, as a player has it)
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open('quest-complete');
  await push(() => { window.preview.model.toasts.push({ kind: 'approval', text: 'Needs approval · Quest log', at: 2 }); });
  const motion = await page.evaluate(() => { const cs = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo), root = getComputedStyle(document.documentElement);
    return { tokens: ['--m-fast', '--m-arrive', '--m-settle'].map(n => root.getPropertyValue(n).trim()), arrive: cs('.toast.approval').animationDuration, settle: cs('.toast.done').animationDuration,
      seal: cs('.toast.done .seal').animationDuration }; });
  check('motion: the tokens are 150 / 350 / 600 ms', motion.tokens.join() === '150ms,350ms,600ms');
  check('motion: a banner arrives in --m-arrive, Quest Complete settles in --m-settle, and its seal stamps in --m-arrive', motion.arrive === '0.35s' && motion.settle === '0.6s' && motion.seal === '0.35s');
  await open('stream-safe');
  check('motion: the Stream-safe blur changes state in --m-fast', await page.evaluate(() => getComputedStyle(document.querySelector('.entry.assistant .body')).transitionDuration) === '0.15s');
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // ---- round 6 §2.2 the familiar calls from the minimap: "!" while a request waits, "?" while a reply waits, painted on the rect the addon reports (layout.mini; no rect, no badge)
  const miniLayout = async over => { await page.evaluate(over => { const p = window.preview; p.emit('layout', { ...p.layout, ...over }); }, over); await settle(); };
  const badge = () => page.evaluate(() => { const el = document.getElementById('mini-badge'), cs = getComputedStyle(el), r = el.getBoundingClientRect(), after = getComputedStyle(el, '::after');
    return { shown: cs.display !== 'none', glyph: el.dataset.glyph, content: after.content, color: after.color, box: [r.left, r.top, r.width, r.height], inert: cs.pointerEvents === 'none', pos: cs.position,
      act: el.hasAttribute('data-act') || !!el.querySelector('[data-act]'), text: el.textContent, aria: el.getAttribute('aria-hidden'), clip: cs.clipPath, mini: cs.getPropertyValue('--mini').trim(),
      markW: parseFloat(after.width), filter: after.filter }; });
  const near = (box, rect) => box.every((v, i) => Math.abs(v - rect[i]) <= 1);
  const MINI = [1180, 40, 31, 31];
  await open('approval');
  check('minimap: with no attention nothing is painted', !(await badge()).shown);
  await push(() => { window.preview.model.attention = [{ thread: 'preview', entry: 'p1', revision: 'fixture:p1', title: 'Quest log', project: 'Preview project', cwd: 'C:\\preview', agent: 'claude',
    mode: 'Ask first', label: 'Needs approval', excerpt: '+ Clearer spacing for the preview', pending: true, at: 1 }]; });
  let mini = await badge();
  check('minimap: a waiting request paints "!" on the minimap button\'s rect, in the card\'s orange', mini.shown && mini.glyph === '!' && mini.content === '"!"' && near(mini.box, MINI) && mini.color === 'rgb(255, 128, 64)');
  check('minimap: the mark is sized from the button (42%, 12 px at least) and is a picture only: no hit rect, no action, no text', mini.pos === 'absolute' && mini.inert && !mini.act && mini.text === '' && mini.aria === 'true'
    && mini.mini === '31px' && mini.markW >= 12 && Math.abs(mini.markW - 31 * 0.42) < 1);
  await push(() => { window.preview.model.attention = [{ thread: 'preview', entry: 'a1', revision: 'fixture:a1', title: 'Quest log', project: 'Preview project', cwd: 'C:\\preview', agent: 'claude',
    mode: 'Ask first', label: 'Reply waiting', excerpt: 'A reply', pending: false, at: 1 }]; });
  mini = await badge();
  check('minimap: only replies waiting paint "?" in gold', mini.shown && mini.glyph === '?' && mini.content === '"?"' && mini.color === 'rgb(255, 209, 0)');
  await push(() => { window.preview.model.attention.push({ thread: 'other', entry: 'p2', revision: 'fixture:p2', title: 'Another quest', project: 'Preview project', cwd: 'C:\\preview', agent: 'claude',
    mode: 'Ask first', label: 'Needs approval', excerpt: 'Another request', pending: true, at: 2 }); });
  check('minimap: a request outranks a reply', (await badge()).glyph === '!');
  await push(() => { window.preview.model.attention = []; });
  check('minimap: nothing waiting, nothing painted', !(await badge()).shown && (await badge()).glyph === '');
  await push(() => { window.preview.model.attention = [{ thread: 'preview', entry: 'p1', revision: 'fixture:p1', title: 'T', project: 'P', cwd: '', agent: 'claude', mode: 'Ask first', label: 'Needs approval', excerpt: 'x', pending: true, at: 1 }]; });
  await push(() => { window.preview.model.attention = undefined; });
  check('minimap: a model without attention (an older hub) paints nothing', !(await badge()).shown);
  await open('stream-safe');
  await push(() => { window.preview.model.attention = [{ thread: 'preview', entry: 'p-s', revision: 'fixture:p-s', title: 'Quest #1', project: 'Project 1', cwd: '', agent: 'claude', mode: 'Ask first',
    label: 'Needs approval', excerpt: 'Edit Macros.lua', pending: true, at: 1 }]; });
  mini = await badge();
  check('minimap: Stream-safe and Hide names keep the mark (a glyph, no names), unblurred', mini.shown && mini.glyph === '!' && mini.text === '' && mini.filter === 'none' && await page.evaluate(() => document.body.classList.contains('blur')));
  await open('waiting');
  mini = await badge();
  check('minimap: the waiting scenario (an idle quest, one reply waiting) paints "?"', mini.shown && mini.glyph === '?' && near(mini.box, MINI));
  await miniLayout({ mini: undefined });
  check('minimap: a layout without the rect (an older addon, or the button hidden) paints nothing', !(await badge()).shown);
  await miniLayout({});
  check('minimap: the rect coming back brings the mark back', (await badge()).shown);
  await miniLayout({ drag: true });
  check('minimap: hidden while the window is being dragged', !(await badge()).shown);
  await miniLayout({ drag: false, ui: false });
  check('minimap: hidden while the game UI is hidden', !(await badge()).shown);
  await miniLayout({ ui: true, panel: false });
  check('minimap: shown with the Familiar window closed (the button is always there)', (await badge()).shown && near((await badge()).box, MINI));
  await miniLayout({ panel: true, mini: [1100, 60, 31, 31] });
  check('minimap: the mark follows the button when it moves', near((await badge()).box, [1100, 60, 31, 31]));
  await miniLayout({ mini: [1100, 60, 46, 46] });
  mini = await badge();
  check('minimap: a scaled minimap scales the mark', near(mini.box, [1100, 60, 46, 46]) && mini.mini === '46px' && Math.abs(mini.markW - 46 * 0.42) < 1);
  await miniLayout({ mini: MINI, occ: [[1170, 30, 60, 60]] });
  mini = await badge();
  check('minimap: a game frame opened over the button cuts the mark like the tracker (an even-odd clip with the frame as the hole)', mini.clip.startsWith('path(') && mini.clip.includes('evenodd'));
  await miniLayout({ occ: undefined });
  check('minimap: with nothing over it the mark is not clipped', (await badge()).clip === 'none');
  check('minimap: it has no hit rect: the page never hit-tests it', await page.evaluate(() => { const el = document.getElementById('mini-badge'); return document.elementFromPoint(1180 + 31 * 0.9, 40 + 31 * 0.1) !== el && getComputedStyle(el).pointerEvents === 'none'; }));
  // The mark arrives like a toast, once, when it changes (motion on); reduced motion makes none.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open('approval');
  const pop = () => page.evaluate(() => { const el = document.getElementById('mini-badge'); return { pop: el.classList.contains('pop'), anim: getComputedStyle(el, '::after').animationName, dur: getComputedStyle(el, '::after').animationDuration }; });
  await push(() => { window.preview.model.attention = [{ thread: 'preview', entry: 'p1', revision: 'fixture:p1', title: 'T', project: 'P', cwd: '', agent: 'claude', mode: 'Ask first', label: 'Needs approval', excerpt: 'x', pending: true, at: 1 }]; });
  const arriving = await pop();
  await page.waitForFunction(() => !document.getElementById('mini-badge').classList.contains('pop'), null, { timeout: 3000 }).catch(() => {});
  const settled = await pop();
  await push();
  const same = await pop();
  await push(() => { window.preview.model.attention[0].pending = false; });
  const changed = await pop();
  check('minimap: a new mark arrives with toastIn in --m-arrive, once; the same mark again is quiet; a changed mark arrives again', arriving.pop && arriving.anim === 'toastIn' && arriving.dur === '0.35s'
    && !settled.pop && settled.anim === 'none' && !same.pop && changed.pop && changed.anim === 'toastIn');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open('approval');
  await push(() => { window.preview.model.attention = [{ thread: 'preview', entry: 'p1', revision: 'fixture:p1', title: 'T', project: 'P', cwd: '', agent: 'claude', mode: 'Ask first', label: 'Needs approval', excerpt: 'x', pending: true, at: 1 }]; });
  check('minimap: reduced motion makes no motion', (await pop()).anim === 'none');
  return results;
}

// Browser-only synthetic bridge. Every action stays in memory; no external requests.
(() => {
  const scenario = new URLSearchParams(location.search).get("scenario") || "waiting";
  const glass = location.pathname.includes("overlay");
  const externalLong = scenario === "external-long" || scenario === "history-earlier";
  const long = scenario === "long" || scenario === "handoff-long" || externalLong;
  const approval = scenario.startsWith("approval");
  const history = scenario.startsWith("history-");
  // welcome: linked, quests that are idle (the quest giver's idle face); -empty: no quests (asleep);
  // -working: one running (working); -unlinked / -unready: puzzled; -noprojects: a fresh install with no folders yet.
  const welcome = ["welcome", "welcome-unready", "welcome-noprojects", "welcome-empty", "welcome-unlinked", "welcome-working"].includes(scenario);
  // Round 4 control-panel scenarios (the status fields are the ones the hub serves; the panel renders them).
  const doctorStrip = scenario === "doctor-strip";
  const updateAvailable = scenario === "update-available";
  const claudeDownloading = scenario === "claude-downloading";
  // Round 3: a cut request (Deny only here), a refused click, the practice quest, Stream-safe, and
  // the Quest Complete / Quest Failed moments (raid-warning toasts).
  const tutorial = scenario === "tutorial";
  const streamSafe = scenario === "stream-safe";
  const moment = scenario === "quest-complete" || scenario === "quest-failed";
  const handlers = {};
  const calls = [];
  const linked = ["welcome", "welcome-noprojects", "welcome-empty", "welcome-working", "projects-empty", "projects-some", "update-available", "linked", "paused", "running", "approval", "finished", "interrupted", "desktop", "tutorial", "stream-safe", "quest-complete", "quest-failed"].includes(scenario);
  const state = {
    build: scenario === "build-unavailable" ? { commit: null, dirty: null } : scenario === "build-dirty" ? { ...window.previewBuild, dirty: true } : window.previewBuild,
    work: { working: scenario === "running" || scenario === "build-running" ? 1 : 0,
      approvals: scenario === "approval" || scenario === "build-approval" ? 2 : 0, confirmation: scenario === "build-handoff" },
    version: updateAvailable ? "0.2.0 · synthetic preview" : "0.1.0 · synthetic preview", linked, providersChosen: scenario !== "setup",
    game: linked || doctorStrip || scenario === "searching" ? { exe: "Synthetic WoW", foreground: true, client: { width: 1280, height: 800, x: 0, y: 0 } } : null,
    install: scenario === "setup" ? null : { dir: "C:\\Games\\WoW", flavor: "_classic_beta_" }, installNotes: [],
    // doctor-strip: frames flow but no coloured strip is found (fps > 0, nothing decoded, no lock).
    capture: { fps: linked || doctorStrip ? 30 : 0, frameW: 1280, frameH: 800, decoded: linked ? 100 : 0, msgs: linked ? 4 : 0, ...(doctorStrip ? { crc: 0, locked: false } : {}) },
    overlay: { shown: linked, paused: scenario === "paused" }, addon: linked ? { char: "Preview Rogue", realm: "Forever", addon: updateAvailable ? "0.3.0" : "Familiar", build: "synthetic", iface: 16001 } : {},
    layout: linked ? { panel: true } : null, threads: linked ? 2 : 0, launchAtLogin: false,
    // projects-empty: no explicit folder or root yet; every other scenario has one explicit folder (the card then sits in Advanced).
    projects: scenario === "projects-empty" ? { explicit: [], roots: [], history: 0 }
      : scenario === "projects-some" ? { explicit: ["C:\\preview\\sample-project", "C:\\preview\\notes"], roots: ["C:\\preview\\projects"], history: 4 }
      : { explicit: ["C:\\preview\\sample-project"], roots: [], history: 3 },
    // first run: Claude Code is still being fetched (state: present | missing | downloading | failed).
    claude: claudeDownloading ? { state: "downloading", pct: 43, mb: 112 } : { state: "present" },
    // update-available: the addon in game is newer than this app, so the header shows the mismatch line.
    update: updateAvailable ? { app: "0.2.0", addon: "0.3.0", mismatch: true } : { app: "0.2.0", addon: "0.2.0", mismatch: false },
    ...(doctorStrip ? { doctor: { step: "strip", level: "warn", text: "Familiar sees the game but no coloured strip in its top-left corner. In game: is Familiar ticked in AddOns? Type /fam strip — it should say TOPLEFT. If something covers that corner, /fam strip tr." } }
      : linked ? { doctor: { step: "ok", level: "ok", text: "Game link working." } } : {}),
    ui: { fontScale: 1, sound: false, soundVolume: 70, raidWarnings: false, quiet: scenario === "quiet", trayNotices: true }, chat: { agent: "claude", model: "haiku", effort: "medium" },
    providers: [
      { id: "claude", label: "Claude", glyph: "✦", installed: true, signedIn: scenario !== "setup", enabled: true, detail: scenario === "setup" ? "Not signed in" : "Sign-in found", canLogin: true },
      { id: "codex", label: "Codex", glyph: "◇", installed: true, signedIn: true, enabled: true, detail: "Sign-in found", canLogin: true },
      { id: "hermes", label: "Hermes", glyph: "☿", installed: false, enabled: false, detail: "Not installed", canLogin: false, installUrl: "https://example.invalid" },
    ], backends: {
      claude: { ready: linked, models: [{ id: "haiku", label: "haiku" }] },
      codex: { ready: linked, models: [{ id: "m2", label: "Synthetic Codex model" }] },
    },
  };
  if (scenario.startsWith("build-")) state.version = "0.1.0-beta";
  if (scenario === "build-unknown-activity") state.work = null;
  const entries = [
    { id: "u1", kind: "user", text: "Help make the quest log easier to read." },
    { id: "a1", kind: "assistant", text: "I checked the spacing and the message target.\n\n- Keep the current quest visible.\n- Give approvals a clear label.\n- Preserve the conversation when you return.", streaming: scenario === "running" },
  ];
  // approval-always: the same short request from a provider that offers a per-quest Always.
  // approval-refused: the hub refused a click on it (written on the card until the next decision).
  const shortApproval = scenario === "approval" || scenario === "approval-always" || scenario === "approval-refused";
  if (approval) entries.push({ id: "p1", kind: "approval", title: "Edit the synthetic quest log", text: "+ Clearer spacing for the preview", approval: "pending", requestId: "preview", canAlways: scenario === "approval-always",
    refused: scenario === "approval-refused" ? "That click wasn't confirmed as yours. Click Approve again." : undefined });
  if (scenario === "interrupted") entries.push({ id: "t1", kind: "tool", name: "+ 2 steps", text: "Read, Bash (1 outcome unknown)", status: "unknown" }, { id: "n1", kind: "notice", text: "Interrupted: Familiar was closed or restarted during this turn. Send a message to continue.", level: "error" });
  const model = {
    seq: 1, target: { text: "Claude · Quest log · Preview project" },
    list: { title: "Quest Log", rows: [
      { kind: "zone", key: "chats", text: "Chats", count: 1 },
      { kind: "thread", key: "chat", text: "A quick question", agent: "codex", status: "idle" },
      { kind: "zone", key: "project", text: "Preview project", count: 1 },
      { kind: "thread", key: "preview", text: "Quest log", agent: "claude", status: approval ? "approval" : scenario === "running" ? "running" : "idle", selected: true },
    ] },
    detail: { kind: "thread", id: "preview", external: scenario === "desktop", source: scenario === "desktop" ? "from desktop app · recent" : undefined, title: "Quest log", agent: "claude", project: "Preview project", cwd: "C:\\preview", status: approval ? "approval" : scenario === "running" ? "running" : "idle", mode: "Ask first", todos: [], entries },
    status: { text: "Linked · Claude ready · Codex ready", level: "ok" }, keys: { approve: approval, stop: scenario === "running" || approval, mode: "Ask first" }, tracker: [], toasts: [], native: false, fontScale: 1, raidWarnings: false,
    providers: { claude: { label: "Claude", glyph: "✦" }, codex: { label: "Codex", glyph: "◇" } },
  };
  if (scenario === "running") {
    model.detail.usage = "12.3k in · 4.1k out · $0.12";
    model.tracker = [{ id: "preview", agent: "claude", title: "Quest log", project: "Preview project", status: "running", activity: "Reading overlay.css", progress: "3/5", cost: "$0.12" },
      { id: "chat", agent: "codex", title: "A quick question", project: "Chats", status: "idle", activity: "Finished — reply ready", cost: "8.2k tokens" }];
  }
  if (tutorial) {
    // Mirrors the hub-scripted practice quest at its practice card (no backend; nothing runs).
    model.providers.familiar = { label: "Familiar", glyph: "◆" };
    model.list.rows = [{ kind: "zone", key: "tutorial", text: "Familiar", count: 1 },
      { kind: "thread", key: "tutorial", text: "A Familiar Face", agent: "familiar", status: "approval", selected: true },
      ...model.list.rows];
    model.list.rows.find(r => r.key === "preview").selected = false;
    model.target = { text: "Familiar · A Familiar Face" };
    model.keys = { approve: true, stop: false, mode: "Ask first" };
    model.detail = { kind: "thread", id: "tutorial", external: false, title: "A Familiar Face", agent: "familiar", project: "Familiar", cwd: "", status: "approval", mode: "Ask first",
      todos: [{ text: "Speak to your familiar", status: "completed" }, { text: "Answer a practice request", status: "in_progress" }, { text: "Set out on a real quest", status: "pending" }],
      entries: [
        { id: "t0", kind: "assistant", text: "Well met, Preview Rogue. I'm your familiar — the imp on your minimap. Work you give me shows up here as a quest.\n\nMarks to know in the Quest Log:\n**?** a reply is waiting for you, like a turn-in.\n**!** I need your say-so before I go on.\n**◌** I'm working.\n\nType anything in the box below and press Enter. (Shift+Enter adds a line. `/fam` opens and closes this window.)" },
        { id: "t1", kind: "user", text: "hi" },
        { id: "t2", kind: "assistant", text: "Heard. Now the part that matters. Before I change a file or run a command, I stop and ask with a card like the one below. Nothing happens until you click **Approve** — and Familiar checks that it was your mouse that clicked, not an addon. **Deny** is always free. This one is practice: nothing runs." },
        { id: "t3", kind: "approval", title: "Practice: light the hearth", text: "echo \"The hearth is lit\"\n\n(practice — this command will not run)", approval: "pending", requestId: "practice", canAlways: false },
      ] };
  }
  if (streamSafe) {
    // What the hub sends with Stream-safe on: aliased names, blur on, the pending card readable.
    model.private = true;
    model.blur = true;
    model.list.rows = [{ kind: "zone", key: "p1", text: "Project 1", count: 1 }, { kind: "thread", key: "preview", text: "Quest #1", agent: "claude", status: "approval", selected: true }];
    model.target = { text: "Claude · Quest #1 · Project 1" };
    model.keys = { approve: true, stop: true, mode: "Ask first" };
    Object.assign(model.detail, { title: "Quest #1", project: "Project 1", cwd: "", status: "approval",
      todos: [{ text: "Read the raid notes", status: "completed" }, { text: "Draft the pull timer macro", status: "in_progress" }] });
    entries.push({ id: "tool-s", kind: "tool", name: "Read", text: "notes/raid-night.md", status: "ok" },
      { id: "p-s", kind: "approval", title: "Edit Macros.lua", text: "+ /pull 10\n- /pull 8", approval: "pending", requestId: "stream", canAlways: true });
    model.tracker = [{ id: "preview", agent: "claude", title: "Quest #1", project: "Project 1", status: "approval", activity: "Waiting: Edit Macros.lua", progress: "1/2", cost: "$0.03" }];
  }
  if (moment) {
    model.raidWarnings = true;
    // The hub's rewards line (hub/rewards.ts) rides on the done toast; a failure here has none.
    model.toasts = [scenario === "quest-complete" ? { kind: "done", text: "Quest Complete · Quest log", sub: "3/3 objectives · 2 edits · $0.21", at: 1 } : { kind: "error", text: "Quest Failed · Quest log", at: 1 }];
  }
  if (welcome) {
    const unready = scenario === "welcome-unready";
    state.chat = { agent: unready ? "claude" : "codex", model: unready ? "haiku" : "m2", effort: "medium" };
    state.threads = 0;
    state.providers[0].enabled = !unready;
    state.providers[1].signedIn = !unready;
    state.providers[1].detail = unready ? "Not signed in" : "Sign-in found";
    state.providers[2].installed = state.providers[2].enabled = unready;
    if (unready) state.providers[2].detail = "Synthetic ready ACP provider";
    state.backends = { claude: { ready: true }, codex: { ready: !unready }, ...(unready ? { hermes: { ready: true } } : {}) };
    const backends = [
      { id: "claude", label: "Claude", enabled: !unready, ready: !unready, status: unready ? "switched off" : "ready" },
      { id: "codex", label: "Codex", enabled: true, ready: !unready, status: unready ? "not ready: Sign in required" : "ready" },
      ...(unready ? [{ id: "hermes", label: "Hermes", enabled: true, ready: true, status: "ready" }] : []),
    ];
    model.detail = { kind: "welcome", linked, linkedChar: linked ? "Preview Rogue" : undefined, backends,
      chat: { ...backends.find(b => b.id === state.chat.agent), model: state.chat.model, act: { type: "newIn", key: "chats" } },
      counts: { total: scenario === "welcome-empty" || scenario === "welcome-noprojects" ? 0 : 2, running: scenario === "welcome-working" ? 1 : 0, approval: 0 },
      zones: scenario === "welcome-noprojects" ? 0 : 2 };
    model.target = { text: "Nothing selected — pick a quest, or + Chat / + Claude.", warn: true };
    model.keys.mode = undefined;
    model.list.rows = [{ kind: "zone", key: "chats", text: "Chats" },
      { kind: "hint", key: "chat-hint", text: "Ask anything: + Chat or /fam ask", act: { type: "newIn", key: "chats" } }];
    model.status = { text: unready ? "Searching for the Runestrip… · Claude off · Codex ✗ · Hermes ✓" : "Linked · Claude ✓ · Codex ✓", level: linked ? "ok" : "off" };
    if (unready) model.providers.hermes = { label: "Hermes", glyph: "☿" };
  }
  if (long) {
    model.detail.title = "Long quest";
    model.target.text = "Claude · Long quest · Preview project";
    model.list.rows.at(-1).text = "Long quest";
    model.detail.entries = Array.from({ length: 36 }, (_, i) => ({ id: `long-${i}`, kind: "assistant", text: `**Reply ${i + 1}**\n\nA synthetic paragraph for inspecting reading continuity. Return to this quest after checking another one; your reading position should still be here.` }));
    if (externalLong) {
      model.detail.id = "ext:claude:preview";
      model.detail.external = true;
      model.detail.entries.forEach((entry, i) => entry.id = `${model.detail.id}:h${i}`);
    }
  }
  if (scenario === "handoff-long") {
    model.detail.handOff = { app: "Claude" };
    model.detail.model = "haiku";
    model.detail.title = "A long synthetic question about the current quest and its next steps that keeps the active conversation identifiable when space is limited";
    model.target.text = `Claude · ${model.detail.title} · Preview project`;
    model.list.rows.at(-1).text = model.detail.title;
  }
  if (approval && !shortApproval) { // approval-long, approval-permissions, approval-cut, approval-expired, approval-resolved
    const status = scenario === "approval-expired" ? "expired" : scenario === "approval-resolved" ? "denied" : "pending";
    const text = scenario === "approval-permissions"
      ? "Synthetic permission scope: " + "read fixture directory; ".repeat(40)
      : Array.from({ length: 85 }, (_, i) => `Step ${i + 1}: Review the synthetic change and its effect before approving.`).join("\n");
    const cap = scenario === "approval-permissions" ? 600 : 4000;
    entries.splice(0, entries.length, { id: "p-long", kind: "approval", title: "Review synthetic approval preview", text: text.slice(0, cap) + `\n… (${text.length - cap} characters omitted from this preview)`, approval: status, requestId: "preview-long", canAlways: false, cut: true });
    model.detail.status = status === "pending" ? "approval" : "idle";
    model.keys.approve = model.keys.stop = status === "pending";
  }
  if (history) {
    model.detail.id = "ext:claude:preview";
    model.detail.external = true;
    model.detail.source = "from desktop app · synthetic fixture";
    model.detail.loading = scenario === "history-loading";
    model.detail.historyEmpty = scenario === "history-empty";
    model.detail.historyError = scenario === "history-error" ? "Couldn't load this conversation's history." : undefined;
    if (scenario !== "history-earlier") model.detail.entries = [];
    model.detail.more = scenario === "history-earlier";
  }
  let historyAttempt = 0;
  const quietDetails = {};
  if (scenario === "quiet") {
    model.quiet = true;
    model.attention = [["r1", "Quest log spacing", "Reply waiting", "A spacing suggestion is ready for you."], ["r2", "Returning to work", "Reply waiting", "The saved session is available to continue."], ["p", "Review a file edit", "Needs approval", "Edit a synthetic fixture file"], ["expired", "An earlier request", "Request expired", "This synthetic request has expired; it cannot be approved."]].map(([id, title, label, excerpt]) => {
      const entry = id === "p" || id === "expired" ? { id: `a:${id}`, kind: "approval", title: excerpt, text: "Synthetic preview only", approval: id === "p" ? "pending" : "expired", requestId: id, canAlways: false } : { id: `reply:${id}`, kind: "assistant", text: excerpt };
      quietDetails[id] = { ...model.detail, id, title, entries: [entry], status: id === "p" ? "approval" : "idle" };
      return { thread: id, entry: entry.id, revision: `fixture:${entry.id}`, title, project: "Preview project", cwd: "C:\\preview", agent: "claude", mode: "Ask first", label, excerpt, pending: id === "p", at: 1 };
    });
    model.detail = quietDetails.r1;
    model.attention.sort((a, b) => Number(b.pending) - Number(a.pending) || b.at - a.at);
    model.target.text = "Claude · Quest log spacing · Preview project";
    model.list.rows = [{ kind: "zone", key: "preview", text: "Preview project", count: 4 }, ...Object.values(quietDetails).map(d => ({ kind: "thread", key: d.id, text: d.title, agent: d.agent, status: d.status, selected: d.id === "r1", act: { type: "select", id: d.id } }))];
    model.tracker = [{ id: "r1", agent: "claude", title: "4 waiting for you", project: "Quiet play", status: "idle", activity: "/fam opens your saved catch-up notes" }];
  }
  // waiting: the quest is idle and a reply waits for you (the Glass paints "?" on the minimap button, fixtureLayout.mini).
  if (scenario === "waiting") model.attention = [{ thread: "preview", entry: "a1", revision: "fixture:a1", title: "Quest log", project: "Preview project", cwd: "C:\\preview", agent: "claude",
    mode: "Ask first", label: "Reply waiting", excerpt: "I checked the spacing and the message target.", pending: false, at: 1 }];
  window.familiar = {
    on: (channel, cb) => { (handlers[channel] ||= []).push(cb); }, send: () => {}, action: a => {
      calls.push(a);
      if (welcome && a.type === "newIn" && a.key === "chats" && model.detail.kind === "welcome") {
        const chat = model.detail.chat;
        model.detail = { kind: "draft", agent: chat.id, project: "Chats", cwd: "C:\\preview-chats", mode: "Chat (web search only)",
          model: chat.model, chat: true, provider: { id: chat.id, label: chat.label, enabled: chat.enabled, ready: chat.ready, status: chat.status } };
        model.target = { text: `New chat with ${chat.label} (${chat.model})` };
      }
      if (a.type === "approvalPreview" && a.thread === model.detail.id) {
        const entry = model.detail.entries.find(e => e.id === a.id && e.kind === "approval");
        if (entry) entry.expanded = !entry.expanded;
      }
      if (a.type === "decide" && a.thread === model.detail.id) {
        const entry = model.detail.entries.find(e => e.requestId === a.requestId && e.approval === "pending");
        if (entry?.cut && a.decision !== "deny") entry.refused = "Part of this request is hidden here. Approve it in full from Familiar's control panel on your PC, or Deny.";
        else if (entry) {
          entry.refused = undefined;
          entry.approval = a.decision === "deny" ? "denied" : a.decision === "allowAlways" ? "always" : "approved";
          model.detail.status = "idle";
          model.keys.approve = model.keys.stop = false;
        }
      }
      if (history && ["more", "retryHistory"].includes(a.type) && a.id === model.detail.id && !model.detail.loading) {
        const detail = model.detail;
        const attempt = ++historyAttempt;
        detail.loading = true;
        detail.historyError = undefined;
        window.preview.emit("model", model);
        setTimeout(() => {
          if (model.detail !== detail) { detail.loading = false; return; }
          detail.loading = false;
          if (scenario === "history-earlier" && attempt === 1) detail.historyError = "Couldn't load earlier messages. Your loaded messages are still here.";
          else {
            const added = Array.from({ length: 5 }, (_, i) => ({ id: `earlier-${attempt}-${i}`, kind: "assistant", text: `**Earlier synthetic reply ${i + 1}**\n\nThe retry loaded this saved message.` }));
            detail.entries.unshift(...added);
            detail.entries.forEach((entry, i) => entry.id = `${detail.id}:h${i}`);
            detail.more = false;
            detail.historyEmpty = false;
          }
          window.preview.emit("model", model);
        }, 900);
        return;
      }
      if (scenario !== "quiet") { window.preview.emit("model", model); return; }
      if (a.type === "quiet") model.quiet = state.ui.quiet = a.on;
      if (a.type === "caughtUp") model.attention = model.attention.filter(item => item.thread !== a.thread || item.entry !== a.entry || item.revision !== a.revision || item.pending);
      if (a.type === "select" && quietDetails[a.id]) {
        model.detail = quietDetails[a.id];
        model.target.text = `Claude · ${model.detail.title} · Preview project`;
      }
      window.preview.emit("model", model);
    }, log: () => {},
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "status") return state;
      if (cmd === "logs") return ["Synthetic fixture: no agents, credentials, saved sessions, or game process are used."];
      if (scenario === "action-error" && cmd === "openConfig") return "Synthetic file-open failure";
      if (cmd === "openConfig" || cmd === "openLogs") return "";
      if (cmd === "pause") { state.overlay.paused = !!args; return state.overlay.paused; }
      if (cmd === "providersChosen") state.providersChosen = true;
      if (cmd === "uiSettings") Object.assign(state.ui, args);
      // Round 4 commands, in memory only. Nothing here opens a dialog, a file, a browser or the network.
      if (cmd === "checkUpdate") return updateAvailable
        ? { current: "0.2.0", latest: "0.3.0", url: "https://github.com/Zeezy3z/familiar/releases/tag/v0.3.0", prerelease: false, newer: true }
        : { current: "0.2.0", latest: "0.2.0", url: "https://github.com/Zeezy3z/familiar/releases/tag/v0.2.0", prerelease: false, newer: false };
      if (cmd === "openUrl") return;
      if (cmd === "captureSnapshot") return { ok: true, file: "C:\\preview\\Familiar\\strip-20260101-120000.png" };
      if (cmd === "claudeRetry") { state.claude = { state: "downloading", pct: 0, mb: 112 }; window.preview.emit("status", state); return state.claude; }
      // A test may set window.preview.projectAddResult (e.g. { ok: false, why: "That folder is excluded by your config" }) to rehearse a refusal.
      if (cmd === "projectAdd") {
        if (window.preview.projectAddResult) return window.preview.projectAddResult;
        const path = args?.kind === "root" ? "C:\\preview\\more-projects" : "C:\\preview\\added-project";
        (args?.kind === "root" ? state.projects.roots : state.projects.explicit).push(path);
        window.preview.emit("status", state);
        return { ok: true, path };
      }
      if (cmd === "projectRemove") {
        state.projects.explicit = state.projects.explicit.filter(p => p !== args?.path);
        state.projects.roots = state.projects.roots.filter(p => p !== args?.path);
        window.preview.emit("status", state);
        return { ok: true };
      }
      if (cmd === "providerEnable") state.providers.find(p => p.id === args.id).enabled = args.on;
      // Preview infrastructure only: mirror main.ts's chatSettings contract in memory.
      if (cmd === "chatSettings") {
        const { agent, model, effort } = args;
        if (agent && agent !== state.chat.agent) {
          state.chat.agent = agent;
          state.chat.model = model ?? state.backends[agent]?.models?.find(m => m.id !== "default")?.id ?? "";
        } else if (model) state.chat.model = model;
        if (effort) state.chat.effort = effort;
        window.preview.emit("status", state);
        return { ...state.chat };
      }
      return state.ui;
    },
  };
  window.preview = { state, model, calls, emit: (channel, data) => (handlers[channel] || []).forEach(cb => cb(data)) };
  // Synthetic status ticks exercise keyboard focus during asynchronous updates.
  if (!glass) setInterval(() => { window.preview.emit("status", state); }, 1000);
  if (glass) window.addEventListener("DOMContentLoaded", () => {
    const fixtureLayout = { scr: [1280, 800], px: 1.25, panel: true, native: false, drag: false, combat: false, ui: true, rowH: 24, list: [30, 100, 280, 500], detail: [320, 100, 650, 500], status: [30, 610, 940, 28],
      keys: { mode: [828, 74, 64, 22] }, tracker: [990, 100, 270, 140],
      mini: [1180, 40, 31, 31] }; // the familiar's minimap button (round 6): the Glass paints its "!" / "?" mark from this rect
    window.preview.layout = fixtureLayout;
    document.body.style.background = "#201c24";
    const label = document.createElement("p");
    label.textContent = "Synthetic Glass preview · no WoW process or agent calls";
    label.style.cssText = "position:absolute;top:14px;left:30px;color:#cfc6b5;font:14px Segoe UI";
    document.body.appendChild(label);
    // Browser actions go through the real Glass hit-test path, as synthetic addon events.
    {
      document.getElementById("detail").addEventListener("click", e => {
        const r = document.getElementById("detail").getBoundingClientRect();
        window.preview.emit("input", { t: "click", r: "detail", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, b: "L" });
      });
    }
    if (long) {
      const controls = document.createElement("div");
      controls.style.cssText = "position:absolute;top:50px;left:30px;display:flex;gap:8px";
      const original = model.detail;
      let current = original;
      const show = detail => {
        current = model.detail = detail;
        model.target = { text: `Claude · ${detail.title} · Preview project` };
        if (externalLong) original.entries.forEach((entry, i) => entry.id = `${original.id}:h${i}`);
        window.preview.emit("model", model);
      };
      for (const [name, detail] of [["Long quest", original], ["Other quest", { ...original, id: "other", title: "Other quest", entries: [{ id: "other-a", kind: "assistant", text: "A short synthetic reply in another quest." }] }], ["Loading quest", { ...original, entries: [], loading: true }]]) {
        const button = document.createElement("button");
        button.textContent = name;
        button.addEventListener("click", () => show(detail));
        controls.appendChild(button);
      }
      const append = document.createElement("button");
      append.textContent = "Append reply";
      append.addEventListener("click", () => {
        original.entries.push({ id: `appended-${original.entries.length}`, kind: "assistant", text: "A new synthetic reply arrived while you were reading." });
        show(current);
      });
      controls.appendChild(append);
      const prepend = document.createElement("button");
      prepend.textContent = "Prepend history";
      let earlier = 0;
      prepend.addEventListener("click", () => {
        original.entries.unshift(...Array.from({ length: 5 }, () => ({ id: `earlier-${++earlier}`, kind: "assistant", text: `**Earlier reply ${earlier}**\n\nSynthetic older history loaded above your reading place.` })));
        show(current);
      });
      controls.appendChild(prepend);
      const toggle = document.createElement("button");
      toggle.textContent = "Toggle panel";
      toggle.addEventListener("click", () => {
        fixtureLayout.panel = !fixtureLayout.panel;
        window.preview.emit("layout", { ...fixtureLayout });
      });
      controls.appendChild(toggle);
      document.body.appendChild(controls);
    }
    // Browser wheel -> synthetic addon event -> real Glass handler. No bridge or game input.
    document.getElementById("detail").addEventListener("wheel", e => {
      e.preventDefault();
      window.preview.emit("input", { t: "wheel", r: "detail", d: e.deltaY < 0 ? 1 : -1 });
    }, { passive: false });
    document.getElementById("latest").addEventListener("click", () => {
      const r = document.getElementById("detail").getBoundingClientRect();
      const l = document.getElementById("latest").getBoundingClientRect();
      window.preview.emit("input", { t: "click", r: "detail", x: (l.left + l.width / 2 - r.left) / r.width, y: (l.top + l.height / 2 - r.top) / r.height, b: "L" });
    });
    window.preview.emit("layout", fixtureLayout);
    window.preview.emit("model", model);
    window.preview.emit("vis", { visible: true, devInput: true });
  });
})();

// "A Familiar Face": the tutorial quest. A thread the hub answers itself (agent "familiar", no
// backend, no files, no shell: nothing ever runs). It teaches the Quest Log's marks and the approval
// path with one practice card that goes through the real corroboration checks. This module is the
// script; the hub plays its events through the same path as an agent's (Hub.onAgent), so the
// toasts, chimes, markers and the Approve glow are exactly those of a real request.
import type { AgentEvent, TodoItem } from "../agents/types";
import type { Thread } from "./hub";

export const TUTORIAL_AGENT = "familiar";
export const TUTORIAL_TITLE = "A Familiar Face";
export const TUTORIAL_NO_MODE = "The practice quest has no mode or model. Those are for real quests.";

type Uid = (prefix: string) => string;
const OBJECTIVES = [
  { id: "speak", text: "Speak to your familiar" },
  { id: "answer", text: "Answer a practice request" },
  { id: "setOut", text: "Set out on a real quest" },
] as const;
type Objective = (typeof OBJECTIVES)[number]["id"];

const welcome = (char: string) => `Well met, ${char}. I'm your familiar — the owl on your minimap. Work you give me shows up here as a quest.

Marks to know in the Quest Log:
**?** a reply is waiting for you, like a turn-in.
**!** I need your say-so before I go on.
**◌** I'm working.

Type anything in the box below and press Enter. (Shift+Enter adds a line. \`/fam\` opens and closes this window.)`;

const HEARD = "Heard. Now the part that matters. Before I change a file or run a command, I stop and ask with a card like the one below. Nothing happens until you click **Approve** — and Familiar checks that it was your mouse that clicked, not an addon. **Deny** is always free. This one is practice: nothing runs.";
const WAITING = "The practice request is waiting below: **Approve** it or **Deny** it.";
const AGAIN = "Here is the practice request again. Nothing runs, whatever you choose.";
const ONWARD = "From here: **+ Claude** or **+ Codex** starts a quest in one of your project folders. **+ Chat** asks a game question with no files involved. **Mode** switches a quest between Ask first and Plan only. Your familiar awaits.";
const APPROVED = `The hearth is lit — and you've just done every part of a real quest.\n\n${ONWARD}`;
const DENIED = `Denied — also a fine answer, and the right one whenever you're unsure. Deny never needs a click check.\n\n${ONWARD}`;
const DONE = "Nothing more to teach. Start a quest with + Claude or + Codex, or right-click this one to archive it.";
export const SET_OUT_NOTE = "Set out on a real quest ✓";

/** The quest as seeded: the welcome, three open objectives, a gold `?` in the log. */
export function tutorialThread(id: string, cwd: string, char: string, uid: Uid): Thread {
  const now = Date.now();
  return {
    id,
    agent: TUTORIAL_AGENT,
    kind: "tutorial",
    cwd, // Familiar's own data folder: never offered as a zone
    projectKey: "tutorial",
    title: TUTORIAL_TITLE,
    status: "idle",
    mode: "ask",
    entries: [{ id: uid("a:"), kind: "assistant", text: welcome(char), at: now }],
    todos: OBJECTIVES.map((o) => ({ ...o, status: "pending" as const })),
    createdAt: now,
    updatedAt: now,
    unread: true,
    attentionSeen: null,
    origin: "familiar",
  };
}

const open = (t: Thread, o: Objective) => t.todos.some((x) => x.id === o && x.status !== "completed");
const tick = (t: Thread, o: Objective): AgentEvent => ({
  type: "todo",
  threadId: t.id,
  items: t.todos.map((x): TodoItem => (x.id === o ? { ...x, status: "completed" } : x)),
});
const say = (t: Thread, text: string, uid: Uid): AgentEvent => ({ type: "message", threadId: t.id, itemId: uid("tutorial"), text });
const practice = (t: Thread, uid: Uid): AgentEvent => ({
  type: "approval",
  threadId: t.id,
  requestId: uid("practice:"),
  kind: "command",
  title: "Practice: light the hearth",
  detail: 'echo "The hearth is lit"\n\n(practice — this command will not run)',
  canAlways: false,
});

/** The player wrote in the tutorial: the first message raises the practice card. */
export function tutorialReply(t: Thread, uid: Uid): AgentEvent[] {
  if (open(t, "speak")) return [tick(t, "speak"), say(t, HEARD, uid), practice(t, uid)];
  if (open(t, "answer")) {
    const waiting = t.entries.some((e) => e.kind === "approval" && e.approval === "pending");
    return waiting ? [say(t, WAITING, uid)] : [say(t, AGAIN, uid), practice(t, uid)]; // expired by a restart
  }
  return [say(t, DONE, uid)];
}

/** The practice card was decided (after the hub's usual checks): the quest completes like a real turn. */
export function tutorialDecide(t: Thread, allowed: boolean, uid: Uid): AgentEvent[] {
  return [
    ...(open(t, "answer") ? [tick(t, "answer")] : []),
    say(t, allowed ? APPROVED : DENIED, uid),
    { type: "done", threadId: t.id, status: "completed" },
  ];
}

/** The player's first real quest was created. */
export function tutorialSetOut(t: Thread): AgentEvent[] {
  return open(t, "setOut") ? [tick(t, "setOut"), { type: "notice", threadId: t.id, message: SET_OUT_NOTE }] : [];
}

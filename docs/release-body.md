<!-- The top of every release's notes, above the changelog: release.yml (addon job) fills {{MEDIA}} (docs/media/familiar.gif, else approval.png, at the tag; nothing if neither exists), {{TAG}}, {{VERSION}} and {{REPO}}. Comment lines like this one are dropped. -->
{{MEDIA}}

## Familiar in one minute

**What it is:** a quest log for your coding agents, inside WoW: Forever.

**How you use it:** open it with `/fam` or the minimap owl. Your first run puts a short tutorial quest, "A Familiar Face", in the log. Pick a project (a "zone"), type what you want, press Enter. The agent works while you play. A **?** means it replied. A **!** means it wants to do something and needs your OK: you'll see exactly what, and nothing happens until you click Approve.

**What you need:** Windows 11, WoW: Forever in windowed mode, and Claude Code or Codex already signed in on your PC.

**What it never does:** press keys or click in the game, read game memory, talk to Blizzard's servers, or send anything to me.

## Downloads

* `FamiliarApp-{{TAG}}-windows.zip`: the app, prebuilt (no Node.js needed). Extract it to `C:\Familiar` and run `Run Familiar.cmd`; the first run downloads Claude Code from npm.
* `Familiar-Setup-{{VERSION}}.exe`, when this release lists it: the signed installer, instead of the zip.
* `Familiar-{{TAG}}-forever.zip`: the addon only, for addon managers. It still needs the app.
* `SHA256SUMS.txt`: SHA-256 hashes of the files above.

Install steps and troubleshooting: [README](https://github.com/{{REPO}}/blob/{{TAG}}/README.md). Not affiliated with or endorsed by Blizzard Entertainment, Anthropic or OpenAI.

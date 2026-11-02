## What and why

## How verified
- [ ] `npm run typecheck`, `npm test`, `npm run build` from `companion/` (Node 24)
- [ ] In-game check on WoW: Forever (client version): …  / not applicable because …
- [ ] If `Link.lua` or `codec.ts` changed: both changed, `codec.test.ts` green
- [ ] If addon API usage changed: `addon.test.ts` conformance green

## Deliberate test changes
(old → new expectation, or "none")

## Boundaries
- [ ] No input automation, memory reading, or Blizzard-server traffic added
- [ ] No new bypass or auto-approve path from the game or the control panel; approval cards still complete
- [ ] No telemetry, no credential handling

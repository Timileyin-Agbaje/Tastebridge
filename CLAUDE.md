# TasteBridge

Hackathon build with a hard deadline (Fri Oct 30, 11:45 PM ET). Spec: `TASTEBRIDGE_BUILD.md`. Follow its Build order.

## Commands
- Run: `node server.js` (needs `QLOO_API_KEY` in env)
- Smoke check: `curl localhost:3000/api/resolve?q=...` and `curl -X POST localhost:3000/api/recommend -d @demo-group.json -H 'Content-Type: application/json'`

## Code
- Smallest change that works. No speculative features, no abstractions for single-use code, no config for things that never change.
- Plain Node + Express and one vanilla `index.html`. No build step, no framework, no new dependency without asking me.
- Readable over clever: small named functions, clear variable names, early returns. Comments only where the *why* isn't obvious.
- Handle real failure points (Qloo calls, bad user input). Don't add error handling for impossible cases.
- Never invent a Qloo endpoint or param. Check docs.qloo.com or the OpenAPI spec in github.com/qloo/docs-public first. If unsure, stop and ask.
- Touch only what the task needs. Don't refactor or restyle code you weren't asked to change.

## Testing — keep it light
- Do NOT write unit tests, test files, or add a test framework unless I ask.
- Verify each Build-order step with one real smoke check (curl or loading the page), then move on.
- If a check fails, fix the cause, re-run that one check. Don't build a test harness.
- Say "done" only after the smoke check passes. If you skipped anything, say so.

## Design
Design matters as much as function. Before any UI work, use the installed skills:
- `emil-design-eng` for polish, spacing, motion decisions
- `mobile-native` because judges may open this on a phone
- `break-ui` once results render: try long names, 5 members, empty results
Keep motion purposeful: ease-out entrances, no animation on things used constantly, respect `prefers-reduced-motion`.

## Workflow
- Before each Build-order step, list the files you'll touch in one line, then do it.
- After each step: one-line summary of what works, what's next. Commit with a short message.

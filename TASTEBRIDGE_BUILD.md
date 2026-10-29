# TasteBridge — Build Spec (from zero, ~1 day)

**Pitch:** Find a place a whole group will genuinely enjoy. Qloo merges everyone's cultural tastes into one shortlist, then scores every pick against every member so nobody gets left out.

**Deadline:** Fri Oct 30, 11:45 PM ET (Sat 4:45 AM Lagos). Target submit: Fri ~8 PM Lagos.
**Demo city:** New York.

## Hard requirements (Qloo rules)
- Live, publicly hosted web app judges can use end-to-end.
- Public GitHub repo, all code, setup steps in README, MIT `LICENSE` file.
- Written description of the agent and why it needs Qloo.

## Stack (keep it boring)
- Node 20 + Express. One `server.js`, one `public/index.html` (vanilla JS, no build step).
- Server proxies all Qloo calls so the key never reaches the browser. Key in env var `QLOO_API_KEY`.
- Base URL: `https://hackathon.api.qloo.com` (hackathon key). Header: `X-Api-Key`.
- All `/v2/insights` calls are **GET with query params**, never POST.
- **Verify every endpoint and param against https://docs.qloo.com and the OpenAPI file at github.com/qloo/docs-public before relying on it.**

## Agent flow (this is the whole product)
1. **Collect:** 2–5 members, each with a name and 2–4 likes (free text: artists, movies, books, places, brands). One category picker: Restaurants / Bars / Things to do.
2. **Resolve:** turn each like into a Qloo entity ID via Qloo's search/lookup endpoint. Drop likes that don't resolve and show that in the UI.
3. **Combine:** one `/v2/insights` call with
   `filter.type=urn:entity:place`, `filter.location.query=New York`,
   `signal.interests.entities=<all members' IDs>`, a category filter via `filter.tags` (look up the right place tags with Qloo's tags endpoint), `take=20`.
4. **Score per member:** for each member, one `/v2/insights` call with only that member's entity IDs as the signal and `filter.results.entities=<the 20 candidate IDs>`, to get each member's affinity for each candidate.
5. **Rank (least-misery):** sort candidates by their *lowest* member affinity, ties broken by average. Return the top 5.
6. **Explain:** for each pick, show one line per member: their affinity as a simple bar, plus the shared tags between the place and that member's likes. Template text is fine; no LLM needed.

## Proof panel ("Why group taste?")
On the results page, a toggle shows two comparison lists, scored the same way per member:
- **Organizer only:** shortlist built from member 1's likes alone.
- **Popular:** same location and category with no taste signal.
Display the worst-off member's score for each list next to TasteBridge's. That number *is* the core claim.

## UI
- Mobile-first single page: member cards (add/remove), category picker, "Find our spot" button.
- Results: 5 place cards with name, address, the per-member bars, and a short "why".
- Loading state for each step (resolving → combining → scoring) so the agent's work is visible.
- Pre-filled "Try a demo group" button with 3 clashing members so judges get results in one tap.

## Errors
- Wrap every Qloo call; on failure show a friendly message, never a blank page.
- Cache responses in memory by URL for 10 minutes to protect rate limits during judging.

## Deploy
- Render free Web Service from the GitHub repo (start command `node server.js`, env var `QLOO_API_KEY`). Fall back to the Azure VM if Render is slow.
- Confirm the live URL works in a fresh browser before submitting.

## Build order (stop and test after each)
1. `server.js` with `/api/resolve` and a curl test resolving 3 likes.
2. `/api/recommend` doing steps 3–5; test with the demo group in curl.
3. `index.html` wired to it.
4. Proof panel.
5. README (what, how to run, how it uses Qloo, the worst-off-member result), MIT LICENSE, push, deploy.

## Cut list if behind
Drop the proof panel's "Popular" list first, then category picker (restaurants only). Never cut per-member scoring; it's what makes this need Qloo.

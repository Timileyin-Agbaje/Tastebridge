const express = require('express');

const QLOO_BASE = 'https://hackathon.api.qloo.com';
const QLOO_API_KEY = process.env.QLOO_API_KEY;
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_LIKE_LENGTH = 100;

// Qloo's taste entity types. Leaving out localities stops "Patagonia" resolving to the region.
const LIKE_TYPES = [
  'artist', 'book', 'brand', 'destination', 'movie',
  'person', 'place', 'podcast', 'tv_show', 'videogame',
].map((type) => `urn:entity:${type}`).join(',');

if (!QLOO_API_KEY) {
  console.error('QLOO_API_KEY is not set. Run with: node --env-file=.env server.js');
  process.exit(1);
}

class QlooError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Cached by URL so repeated demo runs during judging don't burn the rate limit.
const cache = new Map();

async function qlooGet(path, params) {
  const url = `${QLOO_BASE}${path}?${new URLSearchParams(params)}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  let res;
  try {
    res = await fetch(url, { headers: { 'X-Api-Key': QLOO_API_KEY } });
  } catch (err) {
    throw new QlooError(502, `Could not reach Qloo: ${err.message}`);
  }
  // Qloo answers "no results" with a 404; treat that as an empty list, not a failure.
  if (res.status === 404) return { results: [] };
  if (!res.ok) throw new QlooError(res.status, `Qloo returned ${res.status} for ${path}`);

  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

function toEntity(result) {
  return {
    id: result.entity_id,
    name: result.name,
    type: result.types?.[0] ?? null,
    tags: (result.tags ?? []).map((tag) => ({ id: tag.tag_id, name: tag.name })),
  };
}

// Turns one free-text like ("Radiohead", "Dune") into its best-matching Qloo entity, or null.
async function resolveLike(query) {
  const data = await qlooGet('/search', { query, types: LIKE_TYPES, take: 1 });
  const top = data.results?.[0];
  return top ? toEntity(top) : null;
}

const app = express();
app.use(express.json());

app.get('/api/resolve', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.status(400).json({ error: 'Type something you like first.' });
  if (query.length > MAX_LIKE_LENGTH) {
    return res.status(400).json({ error: `Keep each like under ${MAX_LIKE_LENGTH} characters.` });
  }

  try {
    res.json({ query, entity: await resolveLike(query) });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "We couldn't reach our taste engine. Try again in a moment." });
  }
});

app.listen(PORT, () => console.log(`TasteBridge listening on http://localhost:${PORT}`));

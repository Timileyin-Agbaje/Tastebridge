const express = require('express');

const QLOO_BASE = 'https://hackathon.api.qloo.com';
const QLOO_API_KEY = process.env.QLOO_API_KEY;
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_LIKE_LENGTH = 100;
const CITY = 'New York City'; // "New York" alone matches New York State
const CANDIDATE_COUNT = 20;
const PICK_COUNT = 5;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 5;
const MAX_LIKES_PER_MEMBER = 4;

// Tag IDs looked up via Qloo's /v2/tags. Hotels carry restaurant and bar tags, so they're excluded.
const HOTEL_TAG = 'urn:tag:category:place:hotel';
const CATEGORIES = {
  restaurants: { tags: 'urn:tag:category:place:restaurant', excludeTags: HOTEL_TAG },
  bars: { tags: 'urn:tag:category:place:bar', excludeTags: HOTEL_TAG },
  things_to_do: { tags: 'urn:tag:category:place:tourist_attraction' },
};

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

// One insights call seeded with every member's likes: the shared shortlist.
async function findCandidates(entityIds, category) {
  const { tags, excludeTags } = CATEGORIES[category];
  const params = {
    'filter.type': 'urn:entity:place',
    'filter.location.query': CITY,
    'signal.interests.entities': entityIds.join(','),
    'filter.tags': tags,
    take: CANDIDATE_COUNT,
  };
  if (excludeTags) params['filter.exclude.tags'] = excludeTags;
  const data = await qlooGet('/v2/insights', params);
  return data.results?.entities ?? [];
}

// How much one member's likes alone predict they'd enjoy each candidate, keyed by place ID.
async function scoreForMember(member, candidateIds) {
  const data = await qlooGet('/v2/insights', {
    'filter.type': 'urn:entity:place',
    'signal.interests.entities': member.entityIds.join(','),
    'filter.results.entities': candidateIds.join(','),
    take: candidateIds.length,
  });
  const affinityById = new Map();
  for (const place of data.results?.entities ?? []) {
    affinityById.set(place.entity_id, place.query?.affinity ?? 0);
  }
  return affinityById;
}

function toPick(place, members, memberAffinities) {
  const scores = members.map((member, i) => ({
    member: member.name,
    affinity: memberAffinities[i].get(place.entity_id),
  }));
  const affinities = scores.map((score) => score.affinity);
  return {
    id: place.entity_id,
    name: place.name,
    address: place.properties?.address ?? null,
    tags: (place.tags ?? []).map((tag) => ({ id: tag.tag_id, name: tag.name })),
    scores,
    lowestAffinity: Math.min(...affinities),
    averageAffinity: affinities.reduce((sum, a) => sum + a, 0) / affinities.length,
  };
}

// Least misery: the best place is the one whose least-happy member is happiest.
function byLeastMisery(a, b) {
  return b.lowestAffinity - a.lowestAffinity || b.averageAffinity - a.averageAffinity;
}

async function recommend(members, category) {
  const candidates = await findCandidates(members.flatMap((m) => m.entityIds), category);
  if (candidates.length === 0) return [];

  const candidateIds = candidates.map((place) => place.entity_id);
  const memberAffinities = await Promise.all(
    members.map((member) => scoreForMember(member, candidateIds)),
  );

  return candidates
    .filter((place) => memberAffinities.every((scores) => scores.has(place.entity_id)))
    .map((place) => toPick(place, members, memberAffinities))
    .sort(byLeastMisery)
    .slice(0, PICK_COUNT);
}

// Returns an error message for the user, or null if the request is usable.
function validateRecommendRequest(body) {
  const { members, category } = body ?? {};
  if (!CATEGORIES[category]) return 'Pick restaurants, bars, or things to do.';
  if (!Array.isArray(members) || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    return `Add between ${MIN_MEMBERS} and ${MAX_MEMBERS} people.`;
  }
  for (const member of members) {
    const name = typeof member?.name === 'string' ? member.name.trim() : '';
    if (!name) return 'Every person needs a name.';
    const ids = member.entityIds;
    if (!Array.isArray(ids) || ids.length === 0) return `We couldn't recognise any of ${name}'s likes.`;
    if (ids.length > MAX_LIKES_PER_MEMBER) return `${name} has more than ${MAX_LIKES_PER_MEMBER} likes.`;
    if (!ids.every((id) => typeof id === 'string' && id)) return `${name} has an invalid like.`;
  }
  return null;
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

app.post('/api/recommend', async (req, res) => {
  const error = validateRecommendRequest(req.body);
  if (error) return res.status(400).json({ error });

  const members = req.body.members.map((m) => ({ name: m.name.trim(), entityIds: m.entityIds }));
  try {
    res.json({ picks: await recommend(members, req.body.category) });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "We couldn't reach our taste engine. Try again in a moment." });
  }
});

app.listen(PORT, () => console.log(`TasteBridge listening on http://localhost:${PORT}`));

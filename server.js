const path = require('path');
const express = require('express');

const QLOO_BASE = 'https://hackathon.api.qloo.com';
const QLOO_API_KEY = process.env.QLOO_API_KEY;
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const QLOO_TIMEOUT_MS = 10 * 1000;
const MAX_LIKE_LENGTH = 100;
const MAX_NAME_LENGTH = 40; // matches the name input's maxlength
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

// Qloo's taste entity types. Leaving out localities stops "Patagonia" resolving to the region;
// leaving out places stops "Nike" matching a shoe store in São Paulo.
const LIKE_TYPES = [
  'artist', 'book', 'brand', 'destination', 'movie',
  'person', 'podcast', 'tv_show', 'videogame',
].map((type) => `urn:entity:${type}`).join(',');
const SUGGESTION_COUNT = 5;

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

// Qloo occasionally drops a connection ("fetch failed") or hangs; one retry hides that from the user.
// The timeout keeps a hung call from holding the spinner until Vercel kills the function.
// Each attempt reads the whole body under its own timeout, so a body that stalls is retried too.
async function fetchWithRetry(url) {
  const request = async () => {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': QLOO_API_KEY },
      signal: AbortSignal.timeout(QLOO_TIMEOUT_MS),
    });
    return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null };
  };
  try {
    return await request();
  } catch (firstErr) {
    console.warn(`Retrying Qloo after network error: ${firstErr.cause?.code ?? firstErr.name}`);
    try {
      return await request();
    } catch (err) {
      throw new QlooError(502, `Could not reach Qloo: ${err.cause?.code ?? err.message}`);
    }
  }
}

async function qlooGet(path, params) {
  const url = `${QLOO_BASE}${path}?${new URLSearchParams(params)}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const { status, ok, data } = await fetchWithRetry(url);
  // Qloo answers "no results" with a 404; treat that as an empty list, not a failure.
  if (status === 404) return { results: [] };
  if (!ok) throw new QlooError(status, `Qloo returned ${status} for ${path}`);

  cache.set(url, { at: Date.now(), data });
  return data;
}

function toEntity(result) {
  return {
    id: result.entity_id,
    name: result.name,
    type: result.types?.[0] ?? null,
    image: result.properties?.image?.url ?? null,
    // Tells same-named entities apart: a film's year, a book's author, a person's birth date.
    disambiguation: result.disambiguation ?? null,
    description: result.properties?.short_description ?? null,
    tags: (result.tags ?? []).map((tag) => ({ id: tag.tag_id, name: tag.name })),
  };
}

// Qloo entities matching a free-text like, best first. Resolve and suggest both ask for the
// same `take`, so they share a cache entry: a like picked from suggestions resolves instantly.
async function searchLikes(query) {
  const data = await qlooGet('/search', { query, types: LIKE_TYPES, take: SUGGESTION_COUNT });
  return (data.results ?? []).map(toEntity);
}

// Returns the trimmed `q` param, or sends a 400 and returns null.
function readLikeQuery(req, res) {
  const query = String(req.query.q ?? '').trim();
  if (!query) {
    res.status(400).json({ error: 'Type something you like first.' });
    return null;
  }
  if (query.length > MAX_LIKE_LENGTH) {
    res.status(400).json({ error: `Keep each like under ${MAX_LIKE_LENGTH} characters.` });
    return null;
  }
  return query;
}

// The places Qloo picks for these likes. With no likes, Qloo ranks by popularity alone.
async function findCandidates(entityIds, category, take = CANDIDATE_COUNT) {
  const { tags, excludeTags } = CATEGORIES[category];
  const params = {
    'filter.type': 'urn:entity:place',
    'filter.location.query': CITY,
    'filter.tags': tags,
    take,
  };
  if (entityIds.length > 0) params['signal.interests.entities'] = entityIds.join(',');
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
  const props = place.properties ?? {};
  return {
    id: place.entity_id,
    name: place.name,
    address: props.address ?? null,
    neighborhood: props.neighborhood ?? null,
    description: props.short_description ?? null,
    image: props.images?.[0]?.url ?? props.image?.url ?? null,
    rating: props.business_rating ?? null,
    priceLevel: props.price_level ?? null, // 1–4
    website: props.website ?? null,
    hours: props.hours ?? null, // { monday: [{ opens: "T14:00:00", closes: "T01:00:00", closed }] }, local time
    // Insights tags use `id`; search results (see toEntity) use `tag_id`.
    tags: (place.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name })),
    scores,
    lowestAffinity: Math.min(...affinities),
    averageAffinity: affinities.reduce((sum, a) => sum + a, 0) / affinities.length,
  };
}

// Least misery: the best place is the one whose least-happy member is happiest.
function byLeastMisery(a, b) {
  return b.lowestAffinity - a.lowestAffinity || b.averageAffinity - a.averageAffinity;
}

// Scores every place for every member, dropping places Qloo couldn't score for someone.
async function scoreList(places, members) {
  if (places.length === 0) return [];
  const placeIds = places.map((place) => place.entity_id);
  const memberAffinities = await Promise.all(
    members.map((member) => scoreForMember(member, placeIds)),
  );
  return places
    .filter((place) => memberAffinities.every((scores) => scores.has(place.entity_id)))
    .map((place) => toPick(place, members, memberAffinities));
}

async function recommend(members, category) {
  const candidates = await findCandidates(members.flatMap((m) => m.entityIds), category);
  const scored = await scoreList(candidates, members);
  return { candidateCount: candidates.length, picks: scored.sort(byLeastMisery).slice(0, PICK_COUNT) };
}

// The proof: what the group would get from the organizer's taste alone, or from popularity alone.
// Both lists keep Qloo's own order and are scored per member exactly like the TasteBridge picks.
async function compare(members, category) {
  const [organizerPlaces, popularPlaces] = await Promise.all([
    findCandidates(members[0].entityIds, category, PICK_COUNT),
    findCandidates([], category, PICK_COUNT),
  ]);
  const [organizer, popular] = await Promise.all([
    scoreList(organizerPlaces, members),
    scoreList(popularPlaces, members),
  ]);
  return { organizer, popular };
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
    if (name.length > MAX_NAME_LENGTH) return `Keep names under ${MAX_NAME_LENGTH} characters.`;
    const ids = member.entityIds;
    if (!Array.isArray(ids) || ids.length === 0) return `We couldn't recognise any of ${name}'s likes.`;
    if (ids.length > MAX_LIKES_PER_MEMBER) return `${name} has more than ${MAX_LIKES_PER_MEMBER} likes.`;
    if (!ids.every((id) => typeof id === 'string' && id)) return `${name} has an invalid like.`;
  }
  return null;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Turns one free-text like ("Radiohead", "Dune") into its best-matching Qloo entity, or null.
app.get('/api/resolve', async (req, res) => {
  const query = readLikeQuery(req, res);
  if (query === null) return;

  try {
    const [best] = await searchLikes(query);
    res.json({ query, entity: best ?? null });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "We couldn't reach our taste engine. Try again in a moment." });
  }
});

// Up to five matches for what someone is typing, so they can pick the right "Dune".
app.get('/api/suggest', async (req, res) => {
  const query = readLikeQuery(req, res);
  if (query === null) return;

  try {
    res.json({ query, suggestions: await searchLikes(query) });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "Suggestions aren't available right now." });
  }
});

app.post('/api/recommend', async (req, res) => {
  const error = validateRecommendRequest(req.body);
  if (error) return res.status(400).json({ error });

  const members = req.body.members.map((m) => ({ name: m.name.trim(), entityIds: m.entityIds }));
  try {
    res.json(await recommend(members, req.body.category));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "We couldn't reach our taste engine. Try again in a moment." });
  }
});

app.post('/api/compare', async (req, res) => {
  const error = validateRecommendRequest(req.body);
  if (error) return res.status(400).json({ error });

  const members = req.body.members.map((m) => ({ name: m.name.trim(), entityIds: m.entityIds }));
  try {
    res.json(await compare(members, req.body.category));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "We couldn't load the comparison. Try again in a moment." });
  }
});

app.listen(PORT, () => console.log(`TasteBridge listening on http://localhost:${PORT}`));

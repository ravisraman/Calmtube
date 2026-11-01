// Builds data/library.json, everything the site shows:
//   videos       recent long-form uploads and each channel's most-loved "classics"
//   courses      hand-picked lecture series and practice programmes (courses.json)
//   picks        videos the Hacker News community upvoted heavily, sorted into topics
//   suggestions  channels you might want to add
//
//   node scripts/build-library.mjs
//
// Works with no keys at all. Two optional environment variables make it better:
//   YT_API_KEY         exact durations, full course playlists, featured-channel discovery
//   ANTHROPIC_API_KEY  Claude reviews each new video and writes a one-line "why watch"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { channelFeeds, playlistFeed } from "./lib/rss.mjs";
import { BAIT, calmTitle, summarize, each, get, getJSON, ageDays, DAY } from "./lib/util.mjs";
import { dearrow, votes, due, hasYouTubeKey, ytVideoDetails, ytPlaylist, ytFeaturedChannels, ytChannels, ytChannelForHandle } from "./lib/enrich.mjs";
import { hasClaude, judgeVideos, classifyPicks, rateChannels } from "./lib/curate.mjs";

const ROOT = new URL("../", import.meta.url);
const read = async (p, fallback) => { try { return JSON.parse(await readFile(new URL(p, ROOT))); } catch { return fallback; } };
const log = (...a) => console.log(...a);

const RECENT_PER_CHANNEL = 60;
const AI_PER_RUN = +(process.env.CLAUDE_MAX_VIDEOS || 400);

const { topics } = await read("channels.json");
const { courses: courseDefs } = await read("courses.json", { courses: [] });
const prev = await read("data/library.json", null) ?? { videos: (await read("data/videos.json", { videos: [] })).videos };
const topicLabel = (k) => topics.find((t) => t.key === k)?.label ?? k;
const channels = topics.flatMap((t) => t.channels.map((c) => ({ ...c, topic: t.key })));
const channelById = new Map(channels.map((c) => [c.id, c]));
const rejected = new Set(prev.rejected ?? []);

log(`CalmTube library build: ${channels.length} channels, YouTube API ${hasYouTubeKey ? "on" : "off"}, Claude ${hasClaude ? "on" : "off"}`);

// ---------- 1. feeds ----------
const fresh = new Map();
let feedFailures = [];
const usable = (e) => e.title && !BAIT.some((r) => r.test(e.title)) && !e.href.includes("/shorts/") && e.views !== 0;
await each(channels, async (c) => {
  const [latest, popular, popShorts, popLive] = await Promise.all([
    channelFeeds.latest(c.id), channelFeeds.popular(c.id), channelFeeds.popularShorts(c.id), channelFeeds.popularLive(c.id),
  ]);
  if (!latest) feedFailures.push(c.name);
  const notClassic = new Set([...(popShorts?.entries ?? []), ...(popLive?.entries ?? [])].map((e) => e.id));
  const add = (e, classic) => {
    if (!usable(e) || rejected.has(e.id)) return;
    const prior = fresh.get(e.id);
    fresh.set(e.id, { ...prior, id: e.id, raw: e.title, published: e.published, channel: c.name, channelId: c.id, topic: c.topic,
      rawDescription: e.description, classic: prior?.classic || classic });
  };
  for (const e of latest?.entries ?? []) add(e, false);
  for (const e of popular?.entries ?? []) if (!notClassic.has(e.id)) add(e, true);
}, { concurrency: 8 });
log(`feeds: ${fresh.size} candidate videos${feedFailures.length ? `; failed: ${feedFailures.join(", ")}` : ""}`);

// ---------- 2. merge with what we already know ----------
const live = new Set(channels.map((c) => c.id));
const videos = new Map();
for (const v of prev.videos ?? []) if (live.has(v.channelId) && !rejected.has(v.id)) videos.set(v.id, v);
const newIds = [];
for (const f of fresh.values()) {
  const old = videos.get(f.id);
  if (!old) newIds.push(f.id);
  const c = channelById.get(f.channelId);
  videos.set(f.id, {
    ...old,
    id: f.id,
    yt: calmTitle(f.raw),
    published: f.published,
    channel: c.name,
    channelId: c.id,
    topic: c.topic,
    summary: summarize(f.rawDescription) || old?.summary || "",
    classic: !!(f.classic || old?.classic),
    _desc: f.rawDescription,
  });
}
// channels may have moved topic in channels.json
for (const v of videos.values()) { const c = channelById.get(v.channelId); v.topic = c.topic; v.channel = c.name; v.yt ??= v.title; }
for (const v of videos.values()) if (BAIT.some((r) => r.test(v.yt))) videos.delete(v.id);
for (const v of videos.values()) if (v.da?.includes(">")) v.chk.da = 0; // re-fetch titles saved before the ">" fix

// ---------- 3. embeddable? (new videos only; oEmbed answers 401 when embedding is off) ----------
async function embeddable(id) {
  const r = await get(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { tries: 2 });
  if (!r) return { ok: true };
  if (r.status === 401 || r.status === 403 || r.status === 404) return { ok: false };
  try { return { ok: true, meta: await r.json() }; } catch { return { ok: true }; }
}
if (!hasYouTubeKey) {
  let blocked = 0;
  await each(newIds, async (id) => { if (!(await embeddable(id)).ok) { videos.delete(id); blocked++; } }, { concurrency: 10 });
  if (blocked) log(`embedding disabled on ${blocked} videos; skipped`);
}

// ---------- 4. courses ----------
const courses = [];
await each(courseDefs, async (def) => {
  const items = hasYouTubeKey ? await ytPlaylist(def.playlist) : (await playlistFeed(def.playlist))?.entries;
  if (!items?.length) { log(`course unavailable: ${def.title}`); return; }
  const before = (prev.courses ?? []).find((c) => c.playlist === def.playlist);
  const known = new Map((before?.lessons ?? []).map((l) => [l.id, l]));
  courses.push({
    ...def,
    complete: hasYouTubeKey || items.length < 15, // RSS only shows a playlist's first 15 videos
    lessons: items.filter((e) => e.title && !/^(private|deleted) video$/i.test(e.title))
      .map((e) => ({ ...known.get(e.id), id: e.id, title: calmTitle(e.title) })),
  });
}, { concurrency: 4 });
courses.sort((a, b) => courseDefs.findIndex((d) => d.playlist === a.playlist) - courseDefs.findIndex((d) => d.playlist === b.playlist));
log(`courses: ${courses.length} (${courses.reduce((n, c) => n + c.lessons.length, 0)} lessons)`);

// ---------- 5. community picks from Hacker News ----------
const AI_WORDS = /\b(ai|a\.i\.|llms?|gpt|neural|machine learning|deep learning|transformer|backprop|karpathy|reinforcement learning|language model|diffusion|alphago|alphafold|agi)\b/i;
let picks = prev.picks ?? [];
if (!prev.picksAt || Date.now() - prev.picksAt > 3 * DAY) {
  const since = Math.floor(Date.now() / 1000) - 4 * 365 * 86400;
  const hits = [];
  for (const host of ["youtube.com", "youtu.be"]) {
    for (let page = 0; page < 3; page++) {
      const r = await getJSON(`https://hn.algolia.com/api/v1/search?query=${host}&restrictSearchableAttributes=url&tags=story&numericFilters=points%3E%3D200,created_at_i%3E${since}&hitsPerPage=200&page=${page}`);
      hits.push(...(r?.hits ?? []));
      if (!r || page + 1 >= r.nbPages) break;
    }
  }
  const byVideo = new Map();
  for (const h of hits) {
    const id = h.url?.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/live\/)([\w-]{11})/)?.[1];
    if (id && (!byVideo.has(id) || byVideo.get(id).points < h.points)) byVideo.set(id, { id, points: h.points, hn: h.objectID, shared: h.created_at });
  }
  const known = new Map(picks.map((p) => [p.id, p]));
  const candidates = [];
  await each([...byVideo.values()], async (p) => {
    if (known.has(p.id)) return candidates.push({ ...known.get(p.id), points: p.points });
    const e = await embeddable(p.id);
    if (!e.ok || !e.meta?.title) return;
    candidates.push({ ...p, title: calmTitle(e.meta.title), channel: e.meta.author_name, channelUrl: e.meta.author_url });
  }, { concurrency: 8 });
  const unsorted = candidates.filter((p) => !p.topic || (hasClaude && !p.why));
  if (hasClaude && unsorted.length) {
    const sorted = await classifyPicks(unsorted, topics);
    for (const p of unsorted) { const s = sorted.get(p.id); p.topic = s?.topic ?? "none"; if (s?.why) p.why = s.why; }
  } else {
    for (const p of unsorted) p.topic = AI_WORDS.test(p.title) ? "ai" : "none";
  }
  picks = candidates.filter((p) => p.topic !== "none" && topics.some((t) => t.key === p.topic) && !BAIT.some((r) => r.test(p.title)))
    .sort((a, b) => b.points - a.points).slice(0, 80);
  prev.picksAt = Date.now();
  log(`community picks: ${picks.length} of ${byVideo.size} upvoted videos fit your topics`);
}

// ---------- 6. enrichment ----------
const all = [...videos.values()];
const lessons = courses.flatMap((c) => c.lessons);

if (hasYouTubeKey) {
  const ids = [...all.filter((v) => !v.duration || due(v.chk?.stats, v.published, { young: 1, old: 30 })).map((v) => v.id), ...lessons.filter((l) => !l.duration).map((l) => l.id)];
  const details = await ytVideoDetails(ids);
  for (const v of all) {
    const d = details.get(v.id);
    if (!d) continue;
    if (!d.embeddable) { videos.delete(v.id); continue; }
    Object.assign(v, { duration: d.duration, likes: d.likes, views: d.views });
    (v.chk ??= {}).stats = Date.now();
  }
  for (const l of lessons) if (details.get(l.id)) l.duration = details.get(l.id).duration;
  log(`youtube api: details for ${details.size} videos`);
} else {
  // Return YouTube Dislike is rate limited (~100/min), so we pace ourselves.
  const todo = all.filter((v) => due(v.chk?.stats, v.published, { young: 3, old: 90 }));
  todo.sort((a, b) => (a.chk?.stats ? 1 : 0) - (b.chk?.stats ? 1 : 0) || b.published.localeCompare(a.published));
  const limit = +(process.env.VOTES_PER_RUN || 1500);
  let n = 0;
  await each(todo.slice(0, limit), async (v) => {
    const r = await votes(v.id);
    if (r) { v.likes = r.likes; v.views = r.views; n++; }
    (v.chk ??= {}).stats = Date.now();
  }, { concurrency: 2, spacing: 650 });
  log(`like counts: ${n} updated (${Math.max(0, todo.length - limit)} left for later runs)`);
}

// DeArrow: community titles, real-frame thumbnails, and often the duration.
{
  const todo = [
    ...all.filter((v) => due(v.chk?.da, v.published, { young: 1, old: 45 })),
    ...lessons.filter((l) => l.duration == null && !l.daChecked),
  ];
  let titles = 0;
  await each(todo, async (v) => {
    const d = await dearrow(v.id);
    if (!d) return;
    if ("yt" in v) {
      v.da = d.title ? calmTitle(d.title) : undefined;
      if (v.da && v.da === v.yt) v.da = undefined;
      v.thumbT = d.thumbTime ?? undefined;
      v.duration ??= d.duration ?? undefined;
      (v.chk ??= {}).da = Date.now();
      if (v.da) titles++;
    } else {
      v.duration ??= d.duration ?? undefined;
      v.daChecked = true;
    }
  }, { concurrency: 4, spacing: 120 });
  log(`dearrow: checked ${todo.length}, ${titles} community titles found`);
}

// ---------- 7. Claude review ----------
if (hasClaude) {
  const todo = [...videos.values()].filter((v) => !v.ai).sort((a, b) => b.published.localeCompare(a.published));
  // Interleave newest and classics so a big backlog doesn't starve either.
  const ordered = [...todo.filter((v) => !v.classic).slice(0, AI_PER_RUN * 0.7), ...todo.filter((v) => v.classic)].slice(0, AI_PER_RUN);
  const verdicts = await judgeVideos(ordered.map((v) => ({ ...v, title: v.da || v.yt, ytTitle: v.da ? v.yt : undefined, rawDescription: v._desc })), { topicLabel, max: AI_PER_RUN });
  let dropped = 0;
  for (const [id, j] of verdicts) {
    const v = videos.get(id);
    v.ai = { depth: j.depth, calm: j.calm, bait: j.clickbait };
    v.why = j.why;
    if (!j.keep || j.clickbait >= 8 || j.calm <= 2) { videos.delete(id); rejected.add(id); dropped++; }
  }
  log(`claude: reviewed ${verdicts.size} videos, set aside ${dropped}; ${todo.length - verdicts.size} waiting`);
}

// ---------- 8. score ----------
// "Loved" = likes per view, compared with the same channel's typical ratio,
// so a small channel's devoted audience counts as much as a big one's.
const rate = (v) => (v.likes && v.views >= 500 ? v.likes / v.views : null);
const medians = new Map();
for (const c of channels) {
  const rs = [...videos.values()].filter((v) => v.channelId === c.id).map(rate).filter(Boolean).sort((a, b) => a - b);
  if (rs.length) medians.set(c.id, rs[Math.floor(rs.length / 2)]);
}
for (const v of videos.values()) {
  const r = rate(v), m = medians.get(v.channelId);
  const loved = r && m ? Math.min(1, Math.max(0, 0.5 + 0.35 * Math.log(r / m))) : 0.5;
  const judged = v.ai ? (v.ai.depth + v.ai.calm + (11 - v.ai.bait)) / 30 : null;
  v.score = +(judged == null ? loved : 0.6 * judged + 0.4 * loved).toFixed(3);
}

// ---------- 9. channel suggestions (weekly) ----------
let suggestions = prev.suggestions ?? [];
if (!prev.suggestionsAt || Date.now() - prev.suggestionsAt > 7 * DAY) {
  const names = new Set(channels.map((c) => c.name.toLowerCase()));
  const cands = new Map();
  if (hasYouTubeKey) {
    await each(channels, async (c) => {
      for (const id of await ytFeaturedChannels(c.id)) {
        if (live.has(id)) continue;
        const x = cands.get(id) ?? { id, featuredBy: [] };
        x.featuredBy.push(c.name);
        cands.set(id, x);
      }
    }, { concurrency: 6 });
  }
  // Channels behind several community picks are worth a look too.
  const hnCount = new Map();
  for (const p of picks) if (!names.has(p.channel?.toLowerCase())) hnCount.set(p.channelUrl, [...(hnCount.get(p.channelUrl) ?? []), p]);
  for (const [url, ps] of hnCount) {
    const handle = url?.match(/@([\w.-]+)/)?.[1];
    const resolved = hasYouTubeKey && handle ? await ytChannelForHandle(handle) : null;
    const id = resolved?.id ?? `hn:${url}`;
    if (live.has(id)) continue;
    const x = cands.get(id) ?? { id, featuredBy: [] };
    Object.assign(x, { url, hnPicks: ps.map((p) => p.id), name: x.name ?? ps[0].channel, topic: ps[0].topic });
    cands.set(id, x);
  }
  let list = [...cands.values()];
  if (hasYouTubeKey) {
    const info = new Map((await ytChannels(list.filter((c) => c.id.startsWith("UC")).map((c) => c.id))).map((c) => [c.id, c]));
    for (const c of list) Object.assign(c, info.get(c.id) ?? {});
  }
  // keep the most promising before spending effort on them
  list = list.filter((c) => c.name && (c.featuredBy.length >= 2 || c.hnPicks?.length >= (hasClaude ? 1 : 2) || (hasClaude && c.featuredBy.length)))
    .sort((a, b) => b.featuredBy.length + (b.hnPicks?.length ?? 0) - (a.featuredBy.length + (a.hnPicks?.length ?? 0))).slice(0, 60);
  await each(list.filter((c) => c.id.startsWith("UC")), async (c) => {
    const f = await channelFeeds.popular(c.id);
    c.titles = (f?.entries ?? []).slice(0, 6).map((e) => e.title);
    c.sample = f?.entries?.find((e) => usable(e))?.id;
  }, { concurrency: 6 });
  if (hasClaude && list.length) {
    const rated = await rateChannels(list.map((c) => ({ ...c, titles: c.titles ?? picks.filter((p) => c.hnPicks?.includes(p.id)).map((p) => p.title) })), topics);
    list = list.map((c) => ({ ...c, ...rated.get(c.id) })).filter((c) => c.fit >= 7).sort((a, b) => b.fit - a.fit);
  }
  const seenUrl = new Set();
  suggestions = list.map((c) => ({
    name: c.name,
    url: c.handle ? `https://www.youtube.com/@${c.handle}` : c.url ?? `https://www.youtube.com/channel/${c.id}`,
    handle: c.handle ?? c.url?.match(/@([\w.-]+)/)?.[1],
    topic: c.topic,
    why: c.why ?? (c.featuredBy.length ? `Recommended by ${c.featuredBy.slice(0, 3).join(", ")}.` : `Several of their videos were widely shared on Hacker News.`),
    sample: c.sample ?? c.hnPicks?.[0],
  })).filter((c) => !seenUrl.has(c.url) && seenUrl.add(c.url)).slice(0, 12);
  prev.suggestionsAt = Date.now();
  log(`suggestions: ${suggestions.length}`);
}

// ---------- 10. trim and write ----------
const perChannel = {};
const out = [...videos.values()]
  .sort((a, b) => b.published.localeCompare(a.published))
  .filter((v) => v.classic || (perChannel[v.channelId] = (perChannel[v.channelId] ?? 0) + 1) <= RECENT_PER_CHANNEL)
  .map(({ _desc, raw, title, ...v }) => v);

await mkdir(new URL("data/", ROOT), { recursive: true });
// One item per line keeps the daily git diffs small.
const lines = (obj) => "{\n" + Object.entries(obj).map(([k, v]) =>
  `${JSON.stringify(k)}: ${Array.isArray(v) && v.length ? `[\n${v.map((x) => JSON.stringify(x)).join(",\n")}\n]` : JSON.stringify(v)}`).join(",\n") + "\n}";
await writeFile(new URL("data/library.json", ROOT), lines({
  updated: new Date().toISOString(),
  sources: { youtubeApi: hasYouTubeKey, claude: hasClaude },
  videos: out,
  courses,
  picks,
  suggestions,
  picksAt: prev.picksAt,
  suggestionsAt: prev.suggestionsAt,
  rejected: [...rejected].slice(-5000),
}) + "\n");
await rm(new URL("data/videos.json", ROOT), { force: true });
log(`wrote ${out.length} videos (${out.filter((v) => v.classic).length} classics, ${out.filter((v) => v.duration).length} with durations, ${out.filter((v) => v.da).length} community titles)`);

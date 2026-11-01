// Extra facts about each video from public, community-run databases,
// plus the official YouTube Data API when a key is configured.
import { get, getJSON, each, isoDuration, DAY } from "./util.mjs";

// DeArrow (dearrow.ajay.app): viewer-written, non-clickbait titles and
// thumbnails chosen from real frames. Data licensed CC BY-NC-SA 4.0.
export async function dearrow(id) {
  const r = await get(`https://sponsor.ajay.app/api/branding?videoID=${id}`);
  if (!r) return null; // network trouble: try again next run
  if (r.status === 404) return { title: null, thumbTime: null, duration: null }; // nothing submitted yet
  const b = r.ok ? await r.json().catch(() => null) : null;
  if (!b) return null;
  const t = (b.titles || []).find((x) => x.locked || x.votes >= 0);
  const th = (b.thumbnails || []).find((x) => x.locked || x.votes >= 0);
  return {
    title: t && !t.original ? t.title.replace(/(^|\s)>(?=\S)/g, "$1").trim() : null,
    thumbTime: th && !th.original && typeof th.timestamp === "number" ? +th.timestamp.toFixed(2) : null,
    duration: b.videoDuration ? Math.round(b.videoDuration) : null,
  };
}

// Return YouTube Dislike (returnyoutubedislike.com): like and view counts
// without an API key. Rate limited, so callers space requests out.
export async function votes(id) {
  const v = await getJSON(`https://returnyoutubedislikeapi.com/votes?videoId=${id}`);
  if (!v || v.deleted) return null;
  return { likes: v.likes, views: v.viewCount };
}

// ---------- YouTube Data API v3 (optional; set YT_API_KEY) ----------
const API = process.env.YT_API_BASE || "https://www.googleapis.com/youtube/v3";
const KEY = process.env.YT_API_KEY;
export const hasYouTubeKey = !!KEY;
const yt = (path, params) => getJSON(`${API}/${path}?${new URLSearchParams({ ...params, key: KEY })}`);

/** Duration + official like/view counts for many videos (1 quota unit per 50). */
export async function ytVideoDetails(ids) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  await each(chunks, async (chunk) => {
    const r = await yt("videos", { part: "contentDetails,statistics,status", id: chunk.join(","), maxResults: 50 });
    for (const v of r?.items ?? []) {
      out.set(v.id, {
        duration: isoDuration(v.contentDetails?.duration),
        likes: v.statistics?.likeCount != null ? +v.statistics.likeCount : null,
        views: v.statistics?.viewCount != null ? +v.statistics.viewCount : null,
        embeddable: v.status?.embeddable !== false,
      });
    }
  }, { concurrency: 4 });
  return out;
}

/** Every item of a playlist, in order (1 unit per 50). */
export async function ytPlaylist(playlistId, limit = 200) {
  const items = [];
  let pageToken = "";
  do {
    const r = await yt("playlistItems", { part: "snippet,contentDetails", playlistId, maxResults: 50, ...(pageToken && { pageToken }) });
    if (!r) break;
    for (const it of r.items ?? []) {
      const s = it.snippet;
      if (!s || s.title === "Private video" || s.title === "Deleted video") continue;
      items.push({ id: it.contentDetails.videoId, title: s.title, published: it.contentDetails.videoPublishedAt || s.publishedAt,
        description: s.description || "", channel: s.videoOwnerChannelTitle, channelId: s.videoOwnerChannelId });
    }
    pageToken = r.nextPageToken;
  } while (pageToken && items.length < limit);
  return items;
}

/** Channels a creator recommends on their own channel page ("featured channels"). */
export async function ytFeaturedChannels(channelId) {
  const r = await yt("channelSections", { part: "contentDetails", channelId });
  return (r?.items ?? []).flatMap((s) => s.contentDetails?.channels ?? []);
}

export async function ytChannels(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await yt("channels", { part: "snippet,statistics", id: ids.slice(i, i + 50).join(",") });
    for (const c of r?.items ?? []) out.push({ id: c.id, name: c.snippet.title, handle: c.snippet.customUrl?.replace(/^@/, ""),
      description: c.snippet.description?.slice(0, 400) ?? "", videos: +c.statistics?.videoCount || 0, subs: +c.statistics?.subscriberCount || 0 });
  }
  return out;
}

export async function ytChannelForHandle(handle) {
  const r = await yt("channels", { part: "snippet", forHandle: handle });
  const c = r?.items?.[0];
  return c ? { id: c.id, name: c.snippet.title } : null;
}

// ---------- refresh policy ----------
// Facts about a video settle down after a couple of weeks, so we re-check
// young videos often and old ones rarely, which keeps daily runs quick.
export function due(lastChecked, published, { young = 1, old = 60 } = {}) {
  if (!lastChecked) return true;
  const since = (Date.now() - lastChecked) / DAY;
  const age = (Date.now() - Date.parse(published)) / DAY;
  return since >= (age < 30 ? young : old);
}

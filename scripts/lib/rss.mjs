// YouTube's public Atom feeds: one per channel, or per playlist. No key needed.
// Every channel also has automatic playlists we can read the same way:
//   UULF… long-form uploads (no Shorts)   UULP… most popular uploads
//   UUPS… most popular Shorts             UUPV… most popular live streams
import { get, decode } from "./util.mjs";

const FEED = "https://www.youtube.com/feeds/videos.xml";

export function parseFeed(xml) {
  const title = decode(xml.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
  const entries = [];
  for (const [, e] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = e.match(/<yt:videoId>([^<]+)/)?.[1];
    if (!id) continue;
    entries.push({
      id,
      title: decode(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""),
      href: e.match(/<link rel="alternate" href="([^"]+)"/)?.[1] ?? "",
      published: e.match(/<published>([^<]+)/)?.[1],
      channelId: e.match(/<yt:channelId>([^<]+)/)?.[1],
      channel: decode(e.match(/<author>\s*<name>([\s\S]*?)<\/name>/)?.[1] ?? ""),
      description: decode(e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? ""),
      views: +(e.match(/<media:statistics views="(\d+)"/)?.[1] ?? NaN),
    });
  }
  return { title, entries };
}

export async function feed(query) {
  const r = await get(`${FEED}?${query}`);
  if (!r?.ok) return null;
  return parseFeed(await r.text());
}

const tail = (channelId) => channelId.slice(2);
export const channelFeeds = {
  latest: (id) => feed(`playlist_id=UULF${tail(id)}`).then((f) => f ?? feed(`channel_id=${id}`)),
  popular: (id) => feed(`playlist_id=UULP${tail(id)}`),
  popularShorts: (id) => feed(`playlist_id=UUPS${tail(id)}`),
  popularLive: (id) => feed(`playlist_id=UUPV${tail(id)}`),
};
export const playlistFeed = (id) => feed(`playlist_id=${id}`);

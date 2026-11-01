// Pulls each curated channel's public RSS feed (no API key, no tracking) and
// writes data/videos.json. Shorts are dropped, clickbait titles are calmed
// down or filtered, and older videos are kept so the library grows over time.
//   node scripts/fetch-videos.mjs
import { readFile, writeFile, mkdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const { topics } = JSON.parse(await readFile(new URL("channels.json", ROOT)));
const OUT = new URL("data/videos.json", ROOT);
const MAX_PER_CHANNEL = 60;

// Titles containing these are skipped entirely.
const BLOCK = [
  /you won'?t believe/i, /\bshocking\b/i, /\bexposed\b/i, /\bdestroy(s|ed)\b/i,
  /\bgone wrong\b/i, /\bmeltdown\b/i, /\bcalls? out\b/i, /\breacts?\b/i, /\bdrama\b/i,
  /\bslams?\b/i, /\bowned\b/i, /\bfreaking out\b/i, /\b(?:last|final) warning\b/i, /\bgiveaway\b/i, /^\s*live\b/i, /\blive ?stream\b/i, /\bunboxing\b/i,
];

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// Make shouty titles readable: drop emoji, tame ALL-CAPS words and !!!/?!.
const ACRONYM = /^(AI|ML|LLM|LLMS|GPT|GPU|CPU|USA|UK|EU|UN|WW1|WW2|WWI|WWII|NYC|DNA|RNA|VO2|HRV|HIIT|BBC|NASA|MIT|II|III|IV|VI|VII|VIII|IX|XI|XII|BC|AD|CEO|5K|10K|PR|PB|FAQ|ADHD|CBT|TV|OK|US|AGI|RL|NLP|CNN|RNN|API|GTN|GCN|UTMB)$/;
function calmTitle(t) {
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");
  t = t.replace(/([!?])[!?]+/g, "$1").replace(/!/g, "");
  t = t.replace(/\b[A-Z][A-Z']{2,}\b/g, (w) => (ACRONYM.test(w) ? w : w[0] + w.slice(1).toLowerCase()));
  t = t.replace(/#\S+/g, "");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.:;?])/g, "$1").trim();
}

// First real paragraph of the description, minus links, hashtags and sponsor reads.
const PROMO = /sponsor|% off|discount|promo|coupon|\bcode\b|patreon|subscribe|merch|affiliate|use my link|sign up|free trial|thanks to .* for|brought to you|check out|follow (me|us)|instagram|twitter|tiktok|newsletter|enquir|inquir|business email|contact us|listen on|apple podcasts|spotify/i;
function summarize(desc) {
  for (const para of desc.split(/\n\s*\n/)) {
    const clean = para.split(/(?<=[.!?])\s+/).filter((s) => !PROMO.test(s)).join(" ")
      .replace(/https?:\/\/\S+/g, "").replace(/#\S+/g, "").replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "")
      .replace(/\s+/g, " ").trim();
    if (clean.length > 40) return clean.length > 280 ? clean.slice(0, 277).replace(/\s\S*$/, "") + "…" : clean;
  }
  return "";
}

function parse(xml, channel, topic) {
  const out = [];
  for (const [, e] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = e.match(/<yt:videoId>([^<]+)/)?.[1];
    const href = e.match(/<link rel="alternate" href="([^"]+)"/)?.[1] ?? "";
    if (!id || href.includes("/shorts/")) continue;
    const raw = decode(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    if (!raw || BLOCK.some((r) => r.test(raw))) continue;
    if (/#shorts?\b/i.test(raw)) continue;
    // views="0" means an upcoming premiere or scheduled stream: wait until it's real
    if (/<media:statistics views="0"/.test(e)) continue;
    const desc = decode(e.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? "");
    out.push({
      id,
      title: calmTitle(raw),
      published: e.match(/<published>([^<]+)/)?.[1],
      channel: channel.name,
      channelId: channel.id,
      topic,
      // first paragraph only: no link dumps, sponsor reads or hashtags
      summary: summarize(desc),
    });
  }
  return out;
}

async function fetchFeed(channel) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`);
      if (r.ok) return await r.text();
    } catch {}
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return null;
}

let previous = [];
try { previous = JSON.parse(await readFile(OUT)).videos; } catch {}

const fresh = [];
const failed = [];
const jobs = topics.flatMap((t) => t.channels.map((c) => ({ t, c })));
for (let i = 0; i < jobs.length; i += 8) {
  await Promise.all(jobs.slice(i, i + 8).map(async ({ t, c }) => {
    const xml = await fetchFeed(c);
    if (!xml) return failed.push(c.name);
    fresh.push(...parse(xml, c, t.key));
  }));
}

// New videos only: skip ones whose creators disabled embedding (oEmbed answers 401).
const known = new Set(previous.map((v) => v.id));
const unchecked = fresh.filter((v) => !known.has(v.id));
const notEmbeddable = new Set();
for (let i = 0; i < unchecked.length; i += 10) {
  await Promise.all(unchecked.slice(i, i + 10).map(async (v) => {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${v.id}`);
      if (r.status === 401 || r.status === 403 || r.status === 404) notEmbeddable.add(v.id);
    } catch {}
  }));
}
fresh.splice(0, fresh.length, ...fresh.filter((v) => !notEmbeddable.has(v.id)));

// Merge with the archive; only keep channels still in the curated list.
const live = new Set(jobs.map((j) => j.c.id));
const byId = new Map();
for (const v of [...previous, ...fresh]) if (live.has(v.channelId)) byId.set(v.id, v);
const perChannel = {};
const videos = [...byId.values()]
  .sort((a, b) => b.published.localeCompare(a.published))
  .filter((v) => (perChannel[v.channelId] = (perChannel[v.channelId] ?? 0) + 1) <= MAX_PER_CHANNEL);

await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), videos }) + "\n");
console.log(`${videos.length} videos (${fresh.length} from this run)` + (failed.length ? `; feeds failed: ${failed.join(", ")}` : ""));

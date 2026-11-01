// Resolves @handles in seed-channels.json to channel IDs and writes channels.json.
// Run occasionally when you edit the seed list:  node scripts/resolve-channels.mjs
import { readFile, writeFile } from "node:fs/promises";
import { ytChannelForHandle } from "./lib/enrich.mjs";

const seed = JSON.parse(await readFile(new URL("./seed-channels.json", import.meta.url)));
let existing = {};
try {
  const prev = JSON.parse(await readFile(new URL("../channels.json", import.meta.url)));
  for (const t of prev.topics) for (const c of t.channels) existing[c.handle.toLowerCase()] = c;
} catch {}

async function resolve(handle) {
  // With a YouTube Data API key, use the official lookup.
  if (process.env.YT_API_KEY) {
    const r = await ytChannelForHandle(handle);
    if (!r) throw new Error("not found");
    return { handle, ...r };
  }
  // Without a key, read the channel ID from the channel's public page.
  const res = await fetch(`https://www.youtube.com/@${handle}`, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const id = html.match(/"externalId":"(UC[\w-]{22})"/)?.[1];
  const name = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1];
  if (!id) throw new Error("no channel id found");
  return { handle, id, name: name?.replace(/&amp;/g, "&").replace(/&#39;/g, "'") ?? handle };
}

const topics = [];
const failed = [];
for (const [key, { label, handles }] of Object.entries(seed)) {
  const channels = [];
  for (const h of handles) {
    const cached = existing[h.toLowerCase()];
    if (cached) { channels.push(cached); continue; }
    try { channels.push(await resolve(h)); console.log(`ok   ${h}`); }
    catch (e) { failed.push(h); console.log(`FAIL ${h}: ${e.message}`); }
  }
  topics.push({ key, label, channels });
}
await writeFile(new URL("../channels.json", import.meta.url), JSON.stringify({ topics }, null, 2) + "\n");
console.log(failed.length ? `\nUnresolved: ${failed.join(", ")}` : "\nAll resolved.");

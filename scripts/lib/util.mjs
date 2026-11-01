// Small shared helpers for the library build.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DAY = 86400000;
export const ageDays = (iso) => (Date.now() - Date.parse(iso)) / DAY;

/** fetch with retries and exponential backoff. Returns the Response or null. */
export async function get(url, { tries = 3, headers } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 429)) return r;
    } catch {}
    await sleep(1000 * 2 ** i);
  }
  return null;
}

export async function getJSON(url, opts) {
  const r = await get(url, opts);
  if (!r?.ok) return null;
  try { return await r.json(); } catch { return null; }
}

/** Run fn over items with at most `concurrency` in flight and at least `spacing` ms between starts. */
export async function each(items, fn, { concurrency = 6, spacing = 0 } = {}) {
  let i = 0, last = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++];
      if (spacing) {
        const wait = last + spacing - Date.now();
        last = Math.max(Date.now(), last + spacing);
        if (wait > 0) await sleep(wait);
      }
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

export const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// Titles containing these are skipped entirely.
export const BAIT = [
  /you won'?t believe/i, /\bshocking\b/i, /\bexposed\b/i, /\bdestroy(s|ed)\b/i,
  /\bgone wrong\b/i, /\bmeltdown\b/i, /\bcalls? out\b/i, /\breacts?\b/i, /\bdrama\b/i,
  /\bslams?\b/i, /\bowned\b/i, /\bfreaking out\b/i, /\b(?:last|final) warning\b/i, /\bgiveaway\b/i,
  /^\s*live\b/i, /blown away/i, /mind[- ]?blow/i, /\binsane\b/i, /\bterrifying\b/i, /\bcrazy\b/i, /\bjaw[- ]?dropping\b/i, /\bunbelievable\b/i, /\blive ?stream\b/i, /\bunboxing\b/i, /#shorts?\b/i,
];

// Make shouty titles readable: drop emoji, tame ALL-CAPS words and !!!/?!.
const ACRONYM = /^(AI|ML|LLM|LLMS|GPT|GPU|GPUS|CPU|USA|UK|EU|UN|WW1|WW2|WWI|WWII|NYC|DNA|RNA|VO2|HRV|HIIT|BBC|NASA|MIT|II|III|IV|VI|VII|VIII|IX|XI|XII|BC|AD|BCE|CE|CEO|5K|10K|PR|PB|FAQ|ADHD|CBT|TV|OK|US|AGI|RL|NLP|CNN|RNN|API|GTN|GCN|UTMB|IMO|SVM|KL|MLP|CS|NBA|NFL|USSR|LA|HYROX|RPE|IQ|AMA|Q&A|COVID|PTSD|ROI)$/;
export function calmTitle(t) {
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");
  t = t.replace(/([!?])[!?]+/g, "$1").replace(/!/g, "");
  t = t.replace(/\b[A-Z][A-Z'&]{2,}\b/g, (w) => (ACRONYM.test(w) ? w : w[0] + w.slice(1).toLowerCase()));
  t = t.replace(/#\S+/g, "");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.:;?])/g, "$1").replace(/^[\s|\-–—:]+|[\s|\-–—:]+$/g, "").trim();
}

// First real paragraph of a description, minus links, hashtags and sponsor reads.
const PROMO = /sponsor|% off|discount|promo|coupon|\bcode\b|patreon|subscribe|merch|affiliate|use my link|sign up|free trial|thanks to .* for|brought to you|check out|follow (me|us)|instagram|twitter|tiktok|newsletter|enquir|inquir|business email|contact us|listen on|apple podcasts|spotify|timestamps|chapters:/i;
export function summarize(desc, max = 240) {
  for (const para of desc.split(/\n\s*\n/)) {
    if (/^\s*\d{1,2}:\d{2}/m.test(para)) continue; // chapter lists
    const clean = para.split(/(?<=[.!?])\s+/).filter((s) => !PROMO.test(s)).join(" ")
      .replace(/https?:\/\/\S+/g, "").replace(/#\S+/g, "").replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, "")
      .replace(/\s+/g, " ").trim();
    if (clean.length > 40) return clean.length > max ? clean.slice(0, max - 3).replace(/\s\S*$/, "") + "…" : clean;
  }
  return "";
}

/** Parses an ISO-8601 duration like PT1H2M3S into seconds. */
export function isoDuration(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || "");
  if (!m) return null;
  const [, d = 0, h = 0, mi = 0, se = 0] = m.map((x) => +x || 0);
  return d * 86400 + h * 3600 + mi * 60 + se;
}

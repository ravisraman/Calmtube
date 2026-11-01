// Optional: Claude reads each new video's title and description and judges it
// against what this library is for. Runs only when ANTHROPIC_API_KEY is set.
import Anthropic from "@anthropic-ai/sdk";

export const hasClaude = !!process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-opus-5-5";

const VIEWER = `The viewer is a curious adult who loves running, endurance sport and athletics; fitness and health science; learning, especially about AI; history; and Eastern religion and philosophy, particularly yoga, meditation and practices that bring more joy and less stress. They want YouTube to leave them calmer, wiser or inspired, never agitated or hooked. They dislike clickbait, outrage, hype, drama, gossip and shallow listicles.`;

const VIDEO_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["videos"],
  properties: {
    videos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "depth", "calm", "clickbait", "keep", "why"],
        properties: {
          id: { type: "string" },
          depth: { type: "integer", description: "1-10. How much real substance, insight or skill it offers." },
          calm: { type: "integer", description: "1-10. 10 = calm, warm, unhurried tone; 1 = frantic, alarmist or outrage-driven." },
          clickbait: { type: "integer", description: "1-10. 10 = title promises far more than it delivers, or manipulates curiosity or fear." },
          keep: { type: "boolean", description: "false for drama, gossip, outrage, ads, merch, channel admin, trailers, empty hype or anything that wastes this viewer's time." },
          why: { type: "string", description: "One plain sentence, at most 22 words, saying what the viewer will get from it. No hype, no exclamation marks, don't start with 'This video'." },
        },
      },
    },
  },
};

let client;
async function ask(system, user, schema) {
  client ??= new Anthropic();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
    console.warn(`  claude: stopped (${res.stop_reason}); skipping this batch`);
    return null;
  }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { console.warn("  claude: unreadable reply; skipping batch"); return null; }
}

/** Scores videos in batches. Returns Map id -> {depth, calm, clickbait, keep, why}. */
export async function judgeVideos(videos, { topicLabel, batch = 20, max = 400 } = {}) {
  const out = new Map();
  const todo = videos.slice(0, max);
  for (let i = 0; i < todo.length; i += batch) {
    const items = todo.slice(i, i + batch).map((v) => ({
      id: v.id,
      channel: v.channel,
      topic: topicLabel(v.topic),
      title: v.ytTitle || v.title,
      ...(v.ytTitle && { communityTitle: v.title }),
      minutes: v.duration ? Math.round(v.duration / 60) : undefined,
      description: (v.rawDescription || v.summary || "").slice(0, 700),
    }));
    try {
      const r = await ask(
        `${VIEWER}\n\nYou review videos for a calm, curated video library made for this viewer. Judge each video from its metadata alone, honestly and briefly. Most videos from these hand-picked channels are good; reserve keep=false for clear misses.`,
        `Review these ${items.length} videos. Return one entry per video, using the same ids.\n\n${JSON.stringify(items, null, 1)}`,
        VIDEO_SCHEMA,
      );
      for (const v of r?.videos ?? []) if (items.some((x) => x.id === v.id)) out.set(v.id, v);
    } catch (e) {
      console.warn(`  claude: ${e.status ?? ""} ${e.message}`);
      if (e.status === 401 || e.status === 403) break;
    }
  }
  return out;
}

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "topic", "why"],
        properties: {
          id: { type: "string" },
          topic: { type: "string", description: "One of the topic keys given, or 'none' if it doesn't fit this viewer." },
          why: { type: "string", description: "One plain sentence, at most 22 words, on what the viewer gets from it." },
        },
      },
    },
  },
};

/** Sorts candidate videos (e.g. from Hacker News) into topics, or 'none'. */
export async function classifyPicks(items, topics) {
  const keys = topics.map((t) => `${t.key} (${t.label})`).join(", ");
  const out = new Map();
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    try {
      const r = await ask(
        `${VIEWER}\n\nYou sort widely shared videos into this viewer's topics. Topic keys: ${keys}. Use 'none' for anything outside these interests, anything agitating, political or promotional.`,
        JSON.stringify(chunk.map(({ id, title, channel }) => ({ id, title, channel }))),
        PICK_SCHEMA,
      );
      for (const x of r?.items ?? []) out.set(x.id, x);
    } catch (e) { console.warn(`  claude: ${e.message}`); }
  }
  return out;
}

const CHANNEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: {
    channels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "fit", "topic", "why"],
        properties: {
          id: { type: "string" },
          fit: { type: "integer", description: "1-10. How well this channel suits the viewer: depth, calm tone, no clickbait." },
          topic: { type: "string" },
          why: { type: "string", description: "One plain sentence, at most 25 words, on why the viewer might enjoy it." },
        },
      },
    },
  },
};

/** Rates candidate channels for the "channels to consider" list. */
export async function rateChannels(candidates, topics) {
  const keys = topics.map((t) => t.key).join(", ");
  const out = new Map();
  for (let i = 0; i < candidates.length; i += 20) {
    const chunk = candidates.slice(i, i + 20);
    try {
      const r = await ask(
        `${VIEWER}\n\nYou suggest new YouTube channels for this viewer's calm library. Rate each candidate from its description and recent titles. Topic must be one of: ${keys}.`,
        JSON.stringify(chunk.map((c) => ({ id: c.id, name: c.name, description: c.description, recentTitles: c.titles }))),
        CHANNEL_SCHEMA,
      );
      for (const x of r?.channels ?? []) out.set(x.id, x);
    } catch (e) { console.warn(`  claude: ${e.message}`); }
  }
  return out;
}

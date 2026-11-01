// CalmTube — a quiet front door to a hand-picked set of YouTube channels.
// Everything personal (saved videos, notes, progress, settings) stays in this browser.

const MOODS = {
  learn: { label: "Learn something", topics: ["ai", "history", "wonder", "philosophy"] },
  move: { label: "Move my body", topics: ["running", "fitness", "yoga"] },
  unwind: { label: "Unwind", topics: ["mind", "yoga", "philosophy"] },
};
const LENGTHS = {
  any: { label: "Any length", test: () => true },
  short: { label: "Under 15 min", test: (d) => d && d < 15 * 60 },
  medium: { label: "15–45 min", test: (d) => d && d >= 15 * 60 && d <= 45 * 60 },
  long: { label: "45 min +", test: (d) => d && d > 45 * 60 },
};
const PAGE = 24;
const SPONSOR_CATEGORIES = ["sponsor", "selfpromo", "interaction"];

const DEFAULTS = {
  dailyCount: 12,
  thumbs: "soft", // soft | full | frames | off
  communityTitles: true,
  skipSponsors: true,
  premium: false, // use youtube.com embeds so a Premium login removes ads
  nudgeMinutes: 40,
  theme: "auto",
  topicsOff: [],
  hiddenChannels: [],
  hiddenVideos: [],
  dismissedSuggestions: [],
  saved: [],
  watched: {},
  progress: {},
  notes: [],
};

// ---------- storage ----------
const store = (() => {
  let state = { ...DEFAULTS };
  try { state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("calmtube") || "{}") }; } catch {}
  const save = () => { try { localStorage.setItem("calmtube", JSON.stringify(state)); } catch {} };
  return {
    get: (k) => state[k],
    set(k, v) { state[k] = v; save(); },
    all: () => state,
    replace(obj) { state = { ...DEFAULTS, ...obj }; save(); },
  };
})();

// ---------- data ----------
let topics = [];
let videos = [];
let courses = [];
let picks = [];
let suggestions = [];
let sources = {};
const byId = new Map();
const topicLabel = (k) => topics.find((t) => t.key === k)?.label ?? k;

async function load() {
  const [c, lib] = await Promise.all([
    fetch("channels.json").then((r) => r.json()),
    fetch("data/library.json", { cache: "no-cache" }).then((r) => r.json()),
  ]);
  topics = c.topics;
  videos = lib.videos;
  sources = lib.sources ?? {};
  picks = (lib.picks ?? []).map((p) => ({
    id: p.id, yt: p.title, channel: p.channel, channelUrl: p.channelUrl, topic: p.topic, published: p.shared,
    why: p.why, summary: "", community: true, points: p.points, hn: p.hn,
  }));
  courses = (lib.courses ?? []).map((co) => ({
    ...co,
    lessons: co.lessons.map((l, i) => ({ ...l, yt: l.title, channel: co.by, topic: co.topic, course: co.playlist, idx: i, summary: "" })),
  }));
  suggestions = lib.suggestions ?? [];
  for (const v of [...courses.flatMap((co) => co.lessons), ...picks, ...videos]) byId.set(v.id, v);
  const d = new Date(lib.updated);
  document.getElementById("updated").textContent = `Library refreshed ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`;
}

const title = (v) => (store.get("communityTitles") && v.da) || v.yt;

// Lessons are addressed as "lesson:<playlist>:<index>" so they keep their course
// context even when the same video also lives in the main library.
const playId = (v) => (v.course ? `lesson:${v.course}:${v.idx}` : v.id);
function lookup(ref) {
  if (ref?.startsWith("lesson:")) {
    const [, pl, i] = ref.split(":");
    return courses.find((c) => c.playlist === pl)?.lessons[+i];
  }
  return byId.get(ref);
}

function visible(list = videos) {
  const off = new Set(store.get("topicsOff"));
  const hc = new Set(store.get("hiddenChannels"));
  const hv = new Set(store.get("hiddenVideos"));
  return list.filter((v) => !off.has(v.topic) && !hc.has(v.channelId) && !hv.has(v.id));
}

// Durations come from the YouTube API or DeArrow; without them, hide length filters.
const durationCoverage = (list) => (list.length ? list.filter((v) => v.duration).length / list.length : 0);
const knownDuration = (v) => v.duration || store.get("progress")[v.id]?.d;

// Deterministic per-day randomness so "Today" is stable and finite.
function seeded(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const today = () => new Date().toLocaleDateString("en-CA");

// Weighted shuffle: better-loved videos tend to come first, but nothing is guaranteed.
const weightedOrder = (list, rand) => list
  .map((v) => ({ v, k: Math.pow(rand(), 1 / (0.15 + (v.score ?? 0.5) ** 2)) }))
  .sort((a, b) => b.k - a.k).map((x) => x.v);

function todaysPicks({ mood, length }) {
  const watched = store.get("watched");
  const rand = seeded(today() + (mood || "") + (length || ""));
  const want = mood ? new Set(MOODS[mood].topics) : null;
  const fits = LENGTHS[length] ?? LENGTHS.any;
  const pool = visible().filter((v) => !watched[v.id] && (!want || want.has(v.topic)) && (length === "any" || !length || fits.test(knownDuration(v))));
  const n = store.get("dailyCount");
  const fresh = pool.filter((v) => !v.classic && Date.now() - Date.parse(v.published) < 30 * 86400000);
  const classics = pool.filter((v) => v.classic);
  const others = pool.filter((v) => !fresh.includes(v) && !classics.includes(v));
  const nClassic = Math.round(n / 3);

  const picks = [];
  const usedChannels = new Set();
  const take = (list, count) => {
    const groups = {};
    for (const v of weightedOrder(list, rand)) (groups[v.topic] ??= []).push(v);
    const order = Object.keys(groups).sort(() => rand() - 0.5);
    let added = 0;
    while (added < count && order.some((k) => groups[k].length)) {
      for (const k of order) {
        if (added >= count) break;
        const g = groups[k];
        const i = g.findIndex((v) => !usedChannels.has(v.channelId) && !picks.includes(v));
        if (i === -1) { g.length = 0; continue; }
        const [v] = g.splice(i, 1);
        usedChannels.add(v.channelId);
        picks.push(v);
        added++;
      }
    }
  };
  take(fresh, n - nClassic);
  take(classics, n - picks.length);
  take(others, n - picks.length);
  // Interleave so classics aren't all at the end.
  return picks.map((v, i) => ({ v, k: seeded(v.id + today())() + i / n })).sort((a, b) => a.k - b.k).map((x) => x.v);
}

function continueWatching() {
  const prog = store.get("progress");
  const items = Object.entries(prog)
    .filter(([id, p]) => byId.has(id) && p.d && p.t / p.d > 0.03 && p.t / p.d < 0.92 && Date.now() - p.at < 21 * 86400000)
    .sort((a, b) => b[1].at - a[1].at).map(([id]) => byId.get(id));
  const nextLessons = courses.map(courseState).filter((s) => s.done > 0 && s.next).map((s) => s.next)
    .filter((l) => !items.includes(l));
  return [...items.slice(0, 3), ...nextLessons.slice(0, 2)];
}

function courseState(co) {
  const w = store.get("watched");
  const done = co.lessons.filter((l) => w[l.id]).length;
  const next = co.lessons.find((l) => !w[l.id]);
  const total = co.lessons.reduce((s, l) => s + (l.duration || 0), 0);
  return { done, next, total, all: co.lessons.every((l) => l.duration) };
}

// ---------- rendering helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return String(new Date(iso).getFullYear());
}
function dur(s) {
  if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m ? `${m} min` : ""}`.trim() : `${Math.max(1, m)} min`;
}
function thumbUrl(v) {
  if (store.get("thumbs") === "frames") {
    return v.thumbT != null
      ? `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${v.id}&time=${v.thumbT}`
      : `https://i.ytimg.com/vi/${v.id}/mq2.jpg`;
  }
  return `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
}

function card(v, { lesson } = {}) {
  const saved = store.get("saved").includes(v.id);
  const watched = !!store.get("watched")[v.id];
  const p = store.get("progress")[v.id];
  const pct = p?.d ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
  const d = knownDuration(v);
  const meta = v.community
    ? `${esc(v.channel)} · shared on Hacker News`
    : lesson ? `${esc(v.channel)} · lesson ${v.idx + 1}` : `${esc(v.channel)} · ${ago(v.published)}`;
  return `
  <article class="card${watched ? " is-watched" : ""}" data-id="${v.id}">
    <button class="thumb" data-play="${playId(v)}" aria-label="Play ${esc(title(v))}">
      <img loading="lazy" src="${thumbUrl(v)}" alt="" onerror="this.onerror=null;this.src='https://i.ytimg.com/vi/${v.id}/mqdefault.jpg'">
      ${watched ? '<span class="badge tl">Watched</span>' : v.classic ? '<span class="badge tl soft">Classic</span>' : ""}
      ${d ? `<span class="badge br">${dur(d)}</span>` : ""}
      ${pct > 2 && !watched ? `<span class="progress" style="width:${pct}%"></span>` : ""}
    </button>
    <div class="meta">
      <button class="title-btn" data-play="${playId(v)}"${v.da && title(v) !== v.yt ? ` title="Original title: ${esc(v.yt)}"` : ""}>${esc(title(v))}</button>
      ${v.why ? `<p class="why">${esc(v.why)}</p>` : ""}
      <div class="byline">
        <span>${meta}</span>
        <span class="tools">
          <button class="icon-btn" data-save="${v.id}" aria-pressed="${saved}" title="${saved ? "Remove from saved" : "Save for later"}" aria-label="Save for later">${saved ? "★" : "☆"}</button>
          ${lesson ? "" : `<button class="icon-btn" data-hide="${v.id}" title="Not for me" aria-label="Hide this video">⌀</button>`}
        </span>
      </div>
    </div>
  </article>`;
}
const grid = (list, opts) => (list.length ? `<div class="grid">${list.map((v) => card(v, opts)).join("")}</div>` : `<p class="empty">Nothing here yet.</p>`);
const chips = (name, options, current, label) => `
  <div class="chips${name === "length" ? " small" : ""}" role="group" aria-label="${label}">
    ${Object.entries(options).map(([k, l]) => `<button class="chip" data-${name}="${k}" aria-pressed="${current === k}">${esc(l)}</button>`).join("")}
  </div>`;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : "Good evening.";
}

// ---------- views ----------
const view = document.getElementById("view");
let explore = { topic: null, channel: null, q: "", shown: PAGE, sort: "new", length: "any" };
let todayState = { mood: "", length: "any" };

const views = {
  today() {
    const { mood, length } = todayState;
    const list = todaysPicks(todayState);
    const resume = continueWatching();
    const showLength = durationCoverage(visible()) > 0.5;
    view.innerHTML = `
      <section class="hero">
        <h1>${greeting()}</h1>
        <p>${list.length} things worth your time today: new work from channels chosen for depth, and a few classics. When you reach the end, that's it.</p>
        ${chips("mood", { "": "A bit of everything", ...Object.fromEntries(Object.entries(MOODS).map(([k, m]) => [k, m.label])) }, mood, "What are you in the mood for?")}
        ${showLength ? chips("length", Object.fromEntries(Object.entries(LENGTHS).map(([k, l]) => [k, l.label])), length, "How much time do you have?") : ""}
      </section>
      ${resume.length ? `<div class="section-head"><h2>Pick up where you left off</h2></div>${grid(resume)}<div class="section-head"><h2>Today</h2></div>` : ""}
      ${list.length ? grid(list) : `<p class="empty">Nothing matches that right now. Try another length or mood.</p>`}
      <div class="finish">
        <h3>That's today.</h3>
        <p>A fresh selection arrives tomorrow. Maybe go for a run, sit for a few minutes, or write down something you learned.</p>
        <a class="link" href="#courses">Or continue a course</a>
      </div>`;
  },

  explore(params) {
    if (params.has("topic")) explore = { ...explore, topic: params.get("topic") || null, channel: null, shown: PAGE };
    const { topic, channel, q, sort, length } = explore;
    let list = sort === "picks" ? visible(picks) : visible();
    if (topic) list = list.filter((v) => v.topic === topic);
    if (channel) list = list.filter((v) => v.channelId === channel);
    if (length !== "any") list = list.filter((v) => LENGTHS[length].test(knownDuration(v)));
    if (q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((v) => { const s = `${v.yt} ${v.da ?? ""} ${v.channel} ${v.summary} ${v.why ?? ""}`.toLowerCase(); return terms.every((t) => s.includes(t)); });
    }
    if (sort === "classics") list = list.filter((v) => v.classic).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    else if (sort === "loved") list = [...list].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    else if (sort === "new") list = [...list].sort((a, b) => b.published.localeCompare(a.published));
    const off = new Set(store.get("topicsOff"));
    const chans = topic && sort !== "picks" ? topics.find((t) => t.key === topic)?.channels.filter((c) => !store.get("hiddenChannels").includes(c.id)) ?? [] : [];
    const sorts = { new: "Newest", classics: "Classics", loved: "Most loved", ...(picks.length && { picks: "Community picks" }) };
    const sugg = suggestions.filter((s) => !store.get("dismissedSuggestions").includes(s.url));
    view.innerHTML = `
      <section class="hero">
        <h1>Explore</h1>
        <p>The whole library: ${videos.length} videos from ${topics.reduce((n, t) => n + t.channels.length, 0)} channels${picks.length ? `, plus ${picks.length} community picks` : ""}.</p>
      </section>
      <div class="toolbar">
        <input class="search" type="search" placeholder="Search titles, channels, ideas…" value="${esc(q)}" data-search aria-label="Search the library">
      </div>
      ${chips("sort", sorts, sort, "Show")}
      <div class="chips" role="group" aria-label="Topics">
        <button class="chip" data-topic="" aria-pressed="${!topic}">All topics</button>
        ${topics.filter((t) => !off.has(t.key)).map((t) => `<button class="chip" data-topic="${t.key}" aria-pressed="${topic === t.key}">${esc(t.label)}</button>`).join("")}
      </div>
      ${chans.length ? `<div class="chips small" role="group" aria-label="Channels">
        <button class="chip" data-channel="" aria-pressed="${!channel}">All channels</button>
        ${chans.map((c) => `<button class="chip" data-channel="${c.id}" aria-pressed="${channel === c.id}">${esc(c.name)}</button>`).join("")}
      </div>` : ""}
      ${durationCoverage(list) > 0.5 || length !== "any" ? chips("length", Object.fromEntries(Object.entries(LENGTHS).map(([k, l]) => [k, l.label])), length, "Length") : ""}
      <div class="section-head"><h2>${esc(sort === "picks" ? "Community picks" : topic ? topicLabel(topic) : q ? "Results" : sorts[sort])}</h2><span>${list.length} videos</span></div>
      ${sort === "picks" ? `<p class="note-line">Talks and lectures the Hacker News community upvoted most, from outside your channels.</p>` : ""}
      ${sort === "classics" ? `<p class="note-line">Each channel's most-watched videos, ranked by how much viewers liked them.</p>` : ""}
      ${grid(list.slice(0, explore.shown))}
      ${list.length > explore.shown ? `<div class="more"><button class="btn ghost" data-more>Show ${Math.min(PAGE, list.length - explore.shown)} more</button></div>` : ""}
      ${sugg.length && !q && !topic ? `
        <div class="section-head"><h2>Channels you might like</h2><span>${sugg.length}</span></div>
        <div class="suggestions">${sugg.map((s) => `
          <div class="suggestion">
            <div>
              <h3><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a></h3>
              <p>${esc(s.why)}${s.topic ? ` <span class="muted">· ${esc(topicLabel(s.topic))}</span>` : ""}</p>
            </div>
            <div class="suggestion-actions">
              ${s.sample ? `<button class="btn ghost" data-play-sample="${esc(s.sample)}" data-sample-channel="${esc(s.name)}">Watch a sample</button>` : ""}
              ${s.handle ? `<button class="btn ghost" data-copy="${esc(s.handle)}" title="Copy the handle to add it to scripts/seed-channels.json">Copy handle</button>` : ""}
              <button class="icon-btn" data-dismiss-suggestion="${esc(s.url)}" aria-label="Not interested" title="Not interested">✕</button>
            </div>
          </div>`).join("")}
        </div>
        <p class="note-line">To add one, put its handle in <code>scripts/seed-channels.json</code>. It joins the library on the next daily refresh.</p>` : ""}`;
  },

  courses(params) {
    const id = params.get("c");
    const co = courses.find((c) => c.playlist === id);
    if (co) {
      const s = courseState(co);
      view.innerHTML = `
        <a class="link back" href="#courses">← All courses</a>
        <section class="hero">
          <p class="eyebrow">${esc(topicLabel(co.topic))} · ${esc(co.by)}</p>
          <h1>${esc(co.title)}</h1>
          <p>${esc(co.note)}</p>
          <div class="course-meta">
            <span>${co.lessons.length}${co.complete ? "" : "+"} lessons${s.total ? ` · ${s.all ? "" : "at least "}${dur(s.total)}` : ""}</span>
            <span>${s.done} done</span>
          </div>
          <div class="bar"><span style="width:${Math.round((s.done / co.lessons.length) * 100)}%"></span></div>
          ${s.next ? `<button class="btn" data-play="${playId(s.next)}">${s.done ? "Continue with" : "Start with"} lesson ${s.next.idx + 1}</button>` : `<p>You've finished every lesson here. Well done.</p>`}
        </section>
        ${grid(co.lessons, { lesson: true })}
        ${co.complete ? "" : `<p class="note-line">The rest of this course is on <a href="https://www.youtube.com/playlist?list=${co.playlist}" target="_blank" rel="noopener">YouTube</a>. Adding a YouTube API key shows every lesson here.</p>`}`;
      return;
    }
    const off = new Set(store.get("topicsOff"));
    const list = courses.filter((c) => !off.has(c.topic));
    view.innerHTML = `
      <section class="hero">
        <h1>Courses</h1>
        <p>Lecture series and practice programmes worth following from start to finish. Your progress is remembered.</p>
      </section>
      <div class="courses">${list.map((c) => {
        const s = courseState(c);
        return `
        <a class="course" href="#courses?c=${c.playlist}">
          <img loading="lazy" src="https://i.ytimg.com/vi/${c.lessons[0].id}/mqdefault.jpg" alt="">
          <div>
            <p class="eyebrow">${esc(topicLabel(c.topic))} · ${esc(c.by)}</p>
            <h3>${esc(c.title)}</h3>
            <p>${esc(c.note)}</p>
            <p class="muted">${c.lessons.length}${c.complete ? "" : "+"} lessons${s.done ? ` · ${s.done} done` : ""}</p>
            ${s.done ? `<div class="bar"><span style="width:${Math.round((s.done / c.lessons.length) * 100)}%"></span></div>` : ""}
          </div>
        </a>`;
      }).join("")}</div>`;
  },

  saved() {
    const saved = store.get("saved").map((id) => byId.get(id)).filter(Boolean);
    const notes = [...store.get("notes")].reverse();
    view.innerHTML = `
      <section class="hero"><h1>Saved</h1><p>Videos you set aside, and the notes you kept.</p></section>
      ${saved.length ? grid(saved) : `<p class="empty">Tap ☆ on any video to keep it here.</p>`}
      <div class="section-head"><h2>Notes</h2><span>${notes.length}</span></div>
      ${notes.length ? `<div class="notes">${notes.map((n) => `
        <div class="note"><p>${esc(n.text)}</p><small>${byId.has(n.id) ? `<button class="link" data-play="${n.id}">${esc(n.title)}</button>` : esc(n.title)} · ${new Date(n.at).toLocaleDateString()}</small></div>`).join("")}</div>`
        : `<p class="empty">After a video ends you can jot down one thing worth remembering. It shows up here.</p>`}`;
  },

  settings() {
    const s = (k) => store.get(k);
    const opt = (k, pairs) => `<select data-set="${k}">${pairs.map(([v, l]) => `<option value="${v}" ${String(v) === String(s(k)) ? "selected" : ""}>${l}</option>`).join("")}</select>`;
    const check = (k, label) => `<label class="check"><input type="checkbox" data-set="${k}" ${s(k) ? "checked" : ""}> ${label}</label>`;
    const hidden = s("hiddenChannels").map((id) => topics.flatMap((t) => t.channels).find((c) => c.id === id)).filter(Boolean);
    view.innerHTML = `
      <section class="hero"><h1>Settings</h1><p>Stored only in this browser.</p></section>
      <div class="settings">
        <div class="setting">
          <h3>Daily selection</h3>
          <p>How many videos Today offers. Fewer is calmer.</p>
          ${opt("dailyCount", [6, 9, 12, 18, 24].map((n) => [n, n]))}
        </div>
        <div class="setting">
          <h3>Titles</h3>
          <p>DeArrow is a community project where viewers rewrite clickbait titles into plain, accurate ones. Hover a title to see the original.</p>
          ${check("communityTitles", "Use community-written titles when available")}
        </div>
        <div class="setting">
          <h3>Thumbnails</h3>
          <p>Thumbnails are where most clickbait lives. Soft mode mutes their colours until you hover. Video frames shows a still from the video itself instead of the designed thumbnail.</p>
          ${opt("thumbs", [["soft", "Soft"], ["frames", "Video frames"], ["full", "Full colour"], ["off", "Hidden (titles only)"]])}
        </div>
        <div class="setting">
          <h3>Sponsor segments</h3>
          <p>Uses SponsorBlock, where viewers mark the in-video sponsor reads and "like and subscribe" reminders. CalmTube skips them for you.</p>
          ${check("skipSponsors", "Skip sponsor reads and self-promotion")}
        </div>
        <div class="setting">
          <h3>Ads</h3>
          <p>Videos play in YouTube's privacy-enhanced player, which means creators' ads can still appear. If you have YouTube Premium, tick this and stay signed in to YouTube in this browser; Premium then removes them. Without Premium, an ad blocker such as uBlock Origin does the job.</p>
          ${check("premium", "I have YouTube Premium")}
        </div>
        <div class="setting">
          <h3>Gentle reminder</h3>
          <p>After this many minutes of watching in one visit, CalmTube suggests a break. 0 turns it off.</p>
          <input type="number" min="0" max="240" step="5" value="${s("nudgeMinutes")}" data-set="nudgeMinutes">
        </div>
        <div class="setting">
          <h3>Appearance</h3>
          ${opt("theme", [["auto", "Match my device"], ["light", "Light"], ["dark", "Dark"]])}
        </div>
        <div class="setting">
          <h3>Topics</h3>
          ${topics.map((t) => `<label class="check"><input type="checkbox" data-topic-toggle="${t.key}" ${s("topicsOff").includes(t.key) ? "" : "checked"}> ${esc(t.label)}</label>`).join("")}
        </div>
        <div class="setting">
          <h3>Hidden channels</h3>
          ${hidden.length ? `<div class="hidden-list">${hidden.map((c) => `<button class="chip" data-unhide-channel="${c.id}">${esc(c.name)} ✕</button>`).join("")}</div>` : `<p>None. Hide a channel from any video's "not for me" button.</p>`}
        </div>
        <div class="setting">
          <h3>Your data</h3>
          <p>Saved videos, notes, course progress and settings live in this browser. Export them to keep a copy or move to another device.</p>
          <div class="row">
            <button class="btn ghost" data-export>Export</button>
            <label class="btn ghost">Import<input type="file" accept="application/json" data-import hidden></label>
            <button class="btn ghost" data-reset>Clear watch history</button>
          </div>
        </div>
        <div class="setting">
          <h3>Where the library comes from</h3>
          <p>A hand-picked list of channels, refreshed daily from YouTube's public feeds. Each channel's most popular videos become Classics, ranked by how much viewers liked them (counts from Return YouTube Dislike${sources.youtubeApi ? " and the YouTube API" : ""}). Community picks come from Hacker News.</p>
          <p>${sources.claude ? "✓ Claude reviews each new video for depth, calm and clickbait, and writes the one-line summaries." : "Claude review is off. Add an Anthropic API key to the repository to have each new video reviewed and summarised."}</p>
          <p>${sources.youtubeApi ? "✓ The YouTube Data API supplies exact lengths and full course playlists." : "Exact video lengths and full course playlists need a YouTube Data API key, which is free."}</p>
          <p>To add a channel, put its @handle in <code>scripts/seed-channels.json</code>.</p>
        </div>
      </div>`;
  },
};

function route() {
  const [name, query] = (location.hash.slice(1) || "today").split("?");
  const v = views[name] ? name : "today";
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  views[v](new URLSearchParams(query));
}
const rerender = () => { const y = scrollY; route(); scrollTo(0, y); };

function applyPrefs() {
  document.body.classList.toggle("thumbs-soft", store.get("thumbs") === "soft");
  document.body.classList.toggle("thumbs-off", store.get("thumbs") === "off");
  const t = store.get("theme");
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = t;
}

// ---------- player ----------
const dialog = document.getElementById("player");
const endcard = dialog.querySelector(".endcard");
let player = null;
let current = null;
let ytReady = null;
let tick = null;
let segments = [];

function loadYT() {
  ytReady ??= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = resolve;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.append(s);
  });
  return ytReady;
}

function markWatched(id) {
  const w = store.get("watched");
  if (!w[id]) { w[id] = Date.now(); store.set("watched", w); }
}

function saveProgress() {
  if (!player?.getCurrentTime || !current) return;
  const t = player.getCurrentTime(), d = player.getDuration();
  if (!d) return;
  const p = store.get("progress");
  p[current.id] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
  // keep the most recent 300
  const keys = Object.keys(p);
  if (keys.length > 300) keys.sort((a, b) => p[a].at - p[b].at).slice(0, keys.length - 300).forEach((k) => delete p[k]);
  store.set("progress", p);
  if (d && t / d > 0.9) markWatched(current.id);
}

// SponsorBlock: ask by a 4-character hash prefix so the server never learns which video you watch.
async function loadSegments(id) {
  if (!store.get("skipSponsors")) return [];
  try {
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await fetch(`https://sponsor.ajay.app/api/skipSegments/${hash.slice(0, 4)}?categories=${encodeURIComponent(JSON.stringify(SPONSOR_CATEGORIES))}`);
    if (!r.ok) return [];
    const match = (await r.json()).find((x) => x.videoID === id);
    return (match?.segments ?? []).filter((s) => s.actionType === "skip" || !s.actionType).map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, done: false }));
  } catch { return []; }
}

function toast(msg) {
  const t = dialog.querySelector(".toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

async function play(ref) {
  const v = lookup(ref);
  if (!v) return;
  current = v;
  const co = v.course ? courses.find((c) => c.playlist === v.course) : null;
  dialog.querySelector(".player-title").textContent = title(v);
  dialog.querySelector(".player-channel").textContent = co ? `${co.title} · lesson ${v.idx + 1} of ${co.lessons.length}` : `${v.channel} · ${topicLabel(v.topic)}`;
  dialog.querySelector(".player-orig").textContent = title(v) !== v.yt ? `Original title: ${v.yt}` : "";
  dialog.querySelector(".player-why").textContent = v.why ?? "";
  dialog.querySelector(".player-summary").textContent = v.summary ?? "";
  dialog.querySelector("[data-open-yt]").href = `https://www.youtube.com/watch?v=${v.id}`;
  const next = co?.lessons[v.idx + 1];
  const nextBtn = dialog.querySelector("[data-next-lesson]");
  nextBtn.hidden = !next;
  if (next) nextBtn.dataset.nextLesson = playId(next);
  updateSaveBtn();
  endcard.hidden = true;
  document.getElementById("note").value = "";
  if (!dialog.open) dialog.showModal();
  startWatchClock();

  const [, segs] = await Promise.all([loadYT(), loadSegments(v.id)]);
  if (current !== v) return;
  segments = segs;
  if (player) { player.destroy(); player = null; }
  const host = document.createElement("div");
  host.id = "yt";
  dialog.querySelector("#yt").replaceWith(host);
  const resume = store.get("progress")[v.id];
  const start = resume && resume.t > 30 && resume.t < resume.d - 60 ? resume.t : 0;
  player = new YT.Player("yt", {
    host: store.get("premium") ? "https://www.youtube.com" : "https://www.youtube-nocookie.com",
    videoId: v.id,
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1, ...(start && { start }) },
    events: {
      onReady: () => { if (start) toast(`Resuming at ${Math.floor(start / 60)}:${String(start % 60).padStart(2, "0")}`); },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { markWatched(v.id); saveProgress(); endcard.hidden = false; }
      },
      onError: () => {
        dialog.querySelector(".player-summary").innerHTML =
          `This one won't play here. <a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">Watch it on YouTube</a> instead.`;
      },
    },
  });
  clearInterval(tick);
  let n = 0;
  tick = setInterval(() => {
    if (!player?.getCurrentTime) return;
    const t = player.getCurrentTime();
    for (const s of segments) {
      if (!s.done && t >= s.start && t < s.end - 1) {
        s.done = true;
        player.seekTo(s.end, true);
        toast(s.category === "sponsor" ? "Skipped a sponsor segment" : "Skipped a self-promotion segment");
      }
    }
    if (++n % 10 === 0) saveProgress();
  }, 500);
}

function closePlayer() {
  clearInterval(tick);
  if (player) {
    try { saveProgress(); } catch {}
    player.destroy();
    player = null;
  }
  stopWatchClock();
  if (dialog.open) dialog.close();
  current = null;
  rerender();
}
dialog.addEventListener("cancel", (e) => { e.preventDefault(); closePlayer(); });
dialog.addEventListener("click", (e) => { if (e.target === dialog) closePlayer(); });

function updateSaveBtn() {
  const saved = store.get("saved").includes(current.id);
  dialog.querySelector("[data-toggle-save]").textContent = saved ? "★ Saved" : "☆ Save for later";
}

function toggleSave(id) {
  const s = store.get("saved");
  store.set("saved", s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
}

function saveNote() {
  const text = document.getElementById("note").value.trim();
  if (text) store.set("notes", [...store.get("notes"), { id: current.id, title: title(current), text, at: Date.now() }]);
}

// ---------- gentle reminder ----------
let watchStart = null;
let watchedMs = 0;
let nudged = false;
function startWatchClock() { watchStart ??= Date.now(); }
function stopWatchClock() { if (watchStart) watchedMs += Date.now() - watchStart; watchStart = null; }
setInterval(() => {
  const limit = store.get("nudgeMinutes") * 60000;
  const total = watchedMs + (watchStart ? Date.now() - watchStart : 0);
  if (!limit || nudged || total < limit) return;
  nudged = true;
  const n = document.getElementById("nudge");
  n.querySelector("p").textContent = `You've been watching for about ${store.get("nudgeMinutes")} minutes. A good moment to stretch, drink some water, or step outside.`;
  n.hidden = false;
  if (dialog.open && player?.pauseVideo) player.pauseVideo();
  if (dialog.open) dialog.prepend(n);
}, 15000);

// ---------- events ----------
let searchTimer;
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  const d = t.dataset;
  if (d.play) return play(d.play);
  if (d.playSample) {
    if (!byId.has(d.playSample)) byId.set(d.playSample, { id: d.playSample, yt: `A video from ${d.sampleChannel}`, channel: d.sampleChannel, topic: "", summary: "" });
    return play(d.playSample);
  }
  if (d.save) { toggleSave(d.save); return rerender(); }
  if (d.hide) {
    const v = byId.get(d.hide);
    if (confirm(`Hide this video?\n\nPress OK to hide just this video, or Cancel to keep it.`)) {
      store.set("hiddenVideos", [...store.get("hiddenVideos"), d.hide]);
      if (v?.channelId && confirm(`Hide everything from ${v.channel} too?`)) store.set("hiddenChannels", [...store.get("hiddenChannels"), v.channelId]);
      rerender();
    }
    return;
  }
  if ("mood" in d) { todayState.mood = d.mood; return rerender(); }
  if ("length" in d) {
    if (location.hash.startsWith("#explore")) explore = { ...explore, length: d.length, shown: PAGE };
    else todayState.length = d.length;
    return rerender();
  }
  if ("sort" in d) { explore = { ...explore, sort: d.sort, channel: null, shown: PAGE }; return rerender(); }
  if ("topic" in d) { explore = { ...explore, topic: d.topic || null, channel: null, shown: PAGE }; return rerender(); }
  if ("channel" in d) { explore = { ...explore, channel: d.channel || null, shown: PAGE }; return rerender(); }
  if ("more" in d) { explore.shown += PAGE; return rerender(); }
  if ("close" in d) return closePlayer();
  if ("toggleSave" in d) { toggleSave(current.id); return updateSaveBtn(); }
  if ("saveNote" in d) { saveNote(); return closePlayer(); }
  if (d.nextLesson) { saveNote(); return play(d.nextLesson); }
  if (d.copy) {
    try { await navigator.clipboard.writeText(d.copy); t.textContent = "Copied"; } catch { prompt("Copy this handle:", d.copy); }
    return;
  }
  if (d.dismissSuggestion) { store.set("dismissedSuggestions", [...store.get("dismissedSuggestions"), d.dismissSuggestion]); return rerender(); }
  if ("unhideChannel" in d) { store.set("hiddenChannels", store.get("hiddenChannels").filter((x) => x !== d.unhideChannel)); return rerender(); }
  if ("export" in d) {
    const blob = new Blob([JSON.stringify(store.all(), null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `calmtube-${today()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  if ("reset" in d) { if (confirm("Clear watched history, progress and hidden videos? Saved videos and notes stay.")) { store.set("watched", {}); store.set("progress", {}); store.set("hiddenVideos", []); rerender(); } return; }
  if ("dismissNudge" in d) { document.getElementById("nudge").hidden = true; document.body.prepend(document.getElementById("nudge")); }
});

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-search]")) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      explore = { ...explore, q: e.target.value.trim(), shown: PAGE };
      rerender();
      const box = view.querySelector("[data-search]");
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 250);
  }
});

document.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.dataset.set) {
    const k = el.dataset.set;
    const val = el.type === "checkbox" ? el.checked : el.type === "number" || k === "dailyCount" ? Number(el.value) : el.value;
    store.set(k, val);
    applyPrefs();
  }
  if (el.dataset.topicToggle) {
    const key = el.dataset.topicToggle;
    const off = store.get("topicsOff").filter((x) => x !== key);
    store.set("topicsOff", el.checked ? off : [...off, key]);
  }
  if ("import" in el.dataset && el.files?.[0]) {
    try {
      const data = JSON.parse(await el.files[0].text());
      if (typeof data !== "object" || !data) throw new Error("not a CalmTube export");
      store.replace(data);
      applyPrefs();
      alert("Imported.");
      rerender();
    } catch (err) { alert(`Couldn't import that file (${err.message}).`); }
  }
});

window.addEventListener("hashchange", () => { route(); scrollTo(0, 0); });
window.addEventListener("pagehide", () => { try { saveProgress(); } catch {} });

applyPrefs();
load().then(route).catch((err) => {
  view.innerHTML = `<p class="empty">Couldn't load the library (${esc(err.message)}). If you opened index.html directly, serve the folder instead, for example with <code>npx serve</code>.</p>`;
});

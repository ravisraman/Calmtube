// CalmTube — a quiet front door to a hand-picked set of YouTube channels.
// Everything personal (saved videos, notes, settings) stays in this browser.

const MOODS = {
  learn: { label: "Learn something", topics: ["ai", "history", "wonder", "philosophy"] },
  move: { label: "Move my body", topics: ["running", "fitness", "yoga"] },
  unwind: { label: "Unwind", topics: ["mind", "yoga", "philosophy"] },
};
const PAGE = 24;

const DEFAULTS = {
  dailyCount: 12,
  thumbs: "soft", // soft | full | off
  premium: false, // use youtube.com embeds so a Premium login removes ads
  nudgeMinutes: 40,
  theme: "auto",
  topicsOff: [],
  hiddenChannels: [],
  hiddenVideos: [],
  saved: [],
  watched: {},
  notes: [],
};

// ---------- storage ----------
const store = (() => {
  let state = { ...DEFAULTS };
  try { state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("calmtube") || "{}") }; } catch {}
  return {
    get: (k) => state[k],
    set(k, v) {
      state[k] = v;
      try { localStorage.setItem("calmtube", JSON.stringify(state)); } catch {}
    },
  };
})();

// ---------- data ----------
let topics = [];
let videos = [];
let byId = new Map();
const topicLabel = (k) => topics.find((t) => t.key === k)?.label ?? k;

async function load() {
  const [c, v] = await Promise.all([
    fetch("channels.json").then((r) => r.json()),
    fetch("data/videos.json", { cache: "no-cache" }).then((r) => r.json()),
  ]);
  topics = c.topics;
  videos = v.videos;
  byId = new Map(videos.map((x) => [x.id, x]));
  const d = new Date(v.updated);
  document.getElementById("updated").textContent = `Library refreshed ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}.`;
}

function visible(list = videos) {
  const off = new Set(store.get("topicsOff"));
  const hc = new Set(store.get("hiddenChannels"));
  const hv = new Set(store.get("hiddenVideos"));
  return list.filter((v) => !off.has(v.topic) && !hc.has(v.channelId) && !hv.has(v.id));
}

// Deterministic per-day shuffle so "Today" is stable and finite.
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

function todaysPicks(mood) {
  const watched = store.get("watched");
  const rand = seeded(today() + (mood || ""));
  const want = mood ? new Set(MOODS[mood].topics) : null;
  let pool = visible().filter((v) => !watched[v.id] && (!want || want.has(v.topic)));
  const recent = pool.filter((v) => Date.now() - Date.parse(v.published) < 1000 * 60 * 60 * 24 * 30);
  if (recent.length >= store.get("dailyCount") * 2) pool = recent;

  // group by topic, then round-robin with at most one video per channel
  const groups = {};
  for (const v of pool) (groups[v.topic] ??= []).push(v);
  for (const g of Object.values(groups)) g.sort(() => rand() - 0.5);
  const order = Object.keys(groups).sort(() => rand() - 0.5);
  const picks = [];
  const usedChannels = new Set();
  const n = store.get("dailyCount");
  while (picks.length < n && order.some((k) => groups[k].length)) {
    for (const k of order) {
      if (picks.length >= n) break;
      const g = groups[k];
      const i = g.findIndex((v) => !usedChannels.has(v.channelId));
      if (i === -1) { g.length = 0; continue; }
      const [v] = g.splice(i, 1);
      usedChannels.add(v.channelId);
      picks.push(v);
    }
  }
  return picks;
}

// ---------- rendering helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ago(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function card(v) {
  const saved = store.get("saved").includes(v.id);
  const watched = !!store.get("watched")[v.id];
  return `
  <article class="card${watched ? " is-watched" : ""}" data-id="${v.id}">
    <button class="thumb" data-play="${v.id}" aria-label="Play ${esc(v.title)}">
      <img loading="lazy" src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="">
      ${watched ? '<span class="watched-badge">Watched</span>' : ""}
    </button>
    <div class="meta">
      <button class="title-btn" data-play="${v.id}">${esc(v.title)}</button>
      <div class="byline">
        <span>${esc(v.channel)} · ${ago(v.published)}</span>
        <span class="tools">
          <button class="icon-btn" data-save="${v.id}" aria-pressed="${saved}" title="${saved ? "Remove from saved" : "Save for later"}" aria-label="Save for later">${saved ? "★" : "☆"}</button>
          <button class="icon-btn" data-hide="${v.id}" title="Not for me" aria-label="Hide this video">⌀</button>
        </span>
      </div>
    </div>
  </article>`;
}
const grid = (list) => (list.length ? `<div class="grid">${list.map(card).join("")}</div>` : `<p class="empty">Nothing here yet.</p>`);

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning." : h < 17 ? "Good afternoon." : "Good evening.";
}

// ---------- views ----------
const view = document.getElementById("view");
let explore = { topic: null, channel: null, q: "", shown: PAGE };

const views = {
  today(params) {
    const mood = MOODS[params.get("mood")] ? params.get("mood") : null;
    const picks = todaysPicks(mood);
    view.innerHTML = `
      <section class="hero">
        <h1>${greeting()}</h1>
        <p>${picks.length} things worth your time today, picked from channels chosen for depth, not for clicks. When you reach the end, that's it.</p>
        <div class="chips" role="group" aria-label="What are you in the mood for?">
          <button class="chip" data-mood="" aria-pressed="${!mood}">A bit of everything</button>
          ${Object.entries(MOODS).map(([k, m]) => `<button class="chip" data-mood="${k}" aria-pressed="${mood === k}">${m.label}</button>`).join("")}
        </div>
      </section>
      ${grid(picks)}
      <div class="finish">
        <h3>That's today.</h3>
        <p>A fresh selection arrives tomorrow. Maybe go for a run, sit for a few minutes, or write down something you learned.</p>
        <a class="link" href="#explore">Or browse the library on purpose</a>
      </div>`;
  },

  explore(params) {
    if (params.has("topic")) explore = { ...explore, topic: params.get("topic") || null, channel: null, shown: PAGE };
    const { topic, channel, q } = explore;
    let list = visible();
    if (topic) list = list.filter((v) => v.topic === topic);
    if (channel) list = list.filter((v) => v.channelId === channel);
    if (q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      list = list.filter((v) => { const s = `${v.title} ${v.channel} ${v.summary}`.toLowerCase(); return terms.every((t) => s.includes(t)); });
    }
    const off = new Set(store.get("topicsOff"));
    const chans = topic ? topics.find((t) => t.key === topic)?.channels.filter((c) => !store.get("hiddenChannels").includes(c.id)) ?? [] : [];
    view.innerHTML = `
      <section class="hero">
        <h1>Explore</h1>
        <p>The whole library, newest first. ${videos.length} videos from ${topics.reduce((n, t) => n + t.channels.length, 0)} channels.</p>
      </section>
      <div class="toolbar">
        <input class="search" type="search" placeholder="Search titles, channels, ideas…" value="${esc(q)}" data-search aria-label="Search the library">
      </div>
      <div class="chips" role="group" aria-label="Topics">
        <button class="chip" data-topic="" aria-pressed="${!topic}">All</button>
        ${topics.filter((t) => !off.has(t.key)).map((t) => `<button class="chip" data-topic="${t.key}" aria-pressed="${topic === t.key}">${esc(t.label)}</button>`).join("")}
      </div>
      ${chans.length ? `<div class="chips small" role="group" aria-label="Channels">
        <button class="chip" data-channel="" aria-pressed="${!channel}">All channels</button>
        ${chans.map((c) => `<button class="chip" data-channel="${c.id}" aria-pressed="${channel === c.id}">${esc(c.name)}</button>`).join("")}
      </div>` : ""}
      <div class="section-head"><h2>${esc(topic ? topicLabel(topic) : q ? "Results" : "Everything")}</h2><span>${list.length} videos</span></div>
      ${grid(list.slice(0, explore.shown))}
      ${list.length > explore.shown ? `<div class="more"><button class="btn ghost" data-more>Show ${Math.min(PAGE, list.length - explore.shown)} more</button></div>` : ""}`;
  },

  saved() {
    const saved = store.get("saved").map((id) => byId.get(id)).filter(Boolean);
    const notes = [...store.get("notes")].reverse();
    view.innerHTML = `
      <section class="hero"><h1>Saved</h1><p>Videos you set aside, and the notes you kept.</p></section>
      ${grid(saved)}
      <div class="section-head"><h2>Notes</h2><span>${notes.length}</span></div>
      ${notes.length ? `<div class="notes">${notes.map((n) => `
        <div class="note"><p>${esc(n.text)}</p><small>${esc(n.title)} · ${new Date(n.at).toLocaleDateString()}</small></div>`).join("")}</div>`
        : `<p class="empty">After a video ends you can jot down one thing worth remembering. It shows up here.</p>`}`;
  },

  settings() {
    const s = (k) => store.get(k);
    const hidden = s("hiddenChannels").map((id) => topics.flatMap((t) => t.channels).find((c) => c.id === id)).filter(Boolean);
    view.innerHTML = `
      <section class="hero"><h1>Settings</h1><p>Stored only in this browser.</p></section>
      <div class="settings">
        <div class="setting">
          <h3>Daily selection</h3>
          <p>How many videos Today offers. Fewer is calmer.</p>
          <select data-set="dailyCount">${[6, 9, 12, 18, 24].map((n) => `<option ${n === s("dailyCount") ? "selected" : ""}>${n}</option>`).join("")}</select>
        </div>
        <div class="setting">
          <h3>Thumbnails</h3>
          <p>Thumbnails are where most clickbait lives. Soft mode mutes their colours until you hover.</p>
          <select data-set="thumbs">
            ${[["soft", "Soft"], ["full", "Full colour"], ["off", "Hidden (titles only)"]].map(([v, l]) => `<option value="${v}" ${v === s("thumbs") ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div class="setting">
          <h3>Ads</h3>
          <p>Videos play in YouTube's privacy-enhanced player, which means creators' ads can still appear. If you have YouTube Premium, tick this and stay signed in to YouTube in this browser; Premium then removes them. Without Premium, an ad blocker such as uBlock Origin does the job.</p>
          <label class="check"><input type="checkbox" data-set="premium" ${s("premium") ? "checked" : ""}> I have YouTube Premium</label>
        </div>
        <div class="setting">
          <h3>Gentle reminder</h3>
          <p>After this many minutes of watching in one visit, CalmTube suggests a break. 0 turns it off.</p>
          <input type="number" min="0" max="240" step="5" value="${s("nudgeMinutes")}" data-set="nudgeMinutes">
        </div>
        <div class="setting">
          <h3>Appearance</h3>
          <select data-set="theme">${[["auto", "Match my device"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `<option value="${v}" ${v === s("theme") ? "selected" : ""}>${l}</option>`).join("")}</select>
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
          <h3>Start fresh</h3>
          <p>Clears watched history and hidden videos. Saved videos and notes stay.</p>
          <button class="btn ghost" data-reset>Clear history</button>
        </div>
        <div class="setting">
          <h3>Adding channels</h3>
          <p>The channel list lives in <code>scripts/seed-channels.json</code> in the project. Add a YouTube @handle under any topic and the library picks it up on the next daily refresh.</p>
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

async function play(id) {
  const v = byId.get(id);
  if (!v) return;
  current = v;
  dialog.querySelector(".player-title").textContent = v.title;
  dialog.querySelector(".player-channel").textContent = `${v.channel} · ${topicLabel(v.topic)}`;
  dialog.querySelector(".player-summary").textContent = v.summary;
  dialog.querySelector("[data-open-yt]").href = `https://www.youtube.com/watch?v=${v.id}`;
  updateSaveBtn();
  endcard.hidden = true;
  document.getElementById("note").value = "";
  dialog.showModal();
  startWatchClock();

  await loadYT();
  if (player) { player.destroy(); player = null; }
  const host = document.createElement("div");
  host.id = "yt";
  dialog.querySelector("#yt").replaceWith(host);
  player = new YT.Player("yt", {
    host: store.get("premium") ? "https://www.youtube.com" : "https://www.youtube-nocookie.com",
    videoId: v.id,
    playerVars: { autoplay: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, playsinline: 1 },
    events: {
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { markWatched(v.id); endcard.hidden = false; }
      },
      onError: () => {
        dialog.querySelector(".player-summary").innerHTML =
          `This one won't play here. <a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">Watch it on YouTube</a> instead.`;
      },
    },
  });
}

function closePlayer() {
  if (player && current) {
    try {
      const t = player.getCurrentTime?.() ?? 0, d = player.getDuration?.() ?? 0;
      if (d && t / d > 0.6) markWatched(current.id);
    } catch {}
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

// ---------- gentle reminder ----------
let watchStart = null;
let watchedMs = 0;
let nudged = false;
function startWatchClock() { watchStart = Date.now(); }
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
document.addEventListener("click", (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  const d = t.dataset;
  if (d.play) return play(d.play);
  if (d.save) { toggleSave(d.save); return rerender(); }
  if (d.hide) {
    const v = byId.get(d.hide);
    if (confirm(`Hide this video?\n\nPress OK to hide just this video, or Cancel to keep it.`)) {
      store.set("hiddenVideos", [...store.get("hiddenVideos"), d.hide]);
      if (v && confirm(`Hide everything from ${v.channel} too?`)) store.set("hiddenChannels", [...store.get("hiddenChannels"), v.channelId]);
      rerender();
    }
    return;
  }
  if ("mood" in d) { location.hash = d.mood ? `today?mood=${d.mood}` : "today"; return; }
  if ("topic" in d) { explore = { ...explore, topic: d.topic || null, channel: null, shown: PAGE }; return rerender(); }
  if ("channel" in d) { explore = { ...explore, channel: d.channel || null, shown: PAGE }; return rerender(); }
  if ("more" in d) { explore.shown += PAGE; return rerender(); }
  if ("close" in d) return closePlayer();
  if ("toggleSave" in d) { toggleSave(current.id); return updateSaveBtn(); }
  if ("saveNote" in d) {
    const text = document.getElementById("note").value.trim();
    if (text) store.set("notes", [...store.get("notes"), { id: current.id, title: current.title, text, at: Date.now() }]);
    return closePlayer();
  }
  if ("unhideChannel" in d) { store.set("hiddenChannels", store.get("hiddenChannels").filter((x) => x !== d.unhideChannel)); return rerender(); }
  if ("reset" in d) { if (confirm("Clear watched history and hidden videos?")) { store.set("watched", {}); store.set("hiddenVideos", []); rerender(); } return; }
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

document.addEventListener("change", (e) => {
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
});

window.addEventListener("hashchange", () => { route(); scrollTo(0, 0); });

applyPrefs();
load().then(route).catch((err) => {
  view.innerHTML = `<p class="empty">Couldn't load the library (${esc(err.message)}). If you opened index.html directly, serve the folder instead, for example with <code>npx serve</code>.</p>`;
});

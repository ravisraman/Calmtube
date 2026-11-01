# CalmTube

A quiet way to watch YouTube. It shows a hand-picked set of channels on running and endurance, fitness, AI, history, yoga, meditation and Eastern philosophy, and science, without the parts of YouTube built to keep you scrolling.

## What's different

- **A finite Today page.** 12 videos a day (you can change the number): mostly new uploads, plus a few classics, with at most one per channel, spread across topics. The selection stays the same all day, and when you reach the end it says so. You can narrow it by mood (*Learn something*, *Move my body*, *Unwind*) and by how much time you have.
- **Classics.** Each channel's most popular videos, ranked by likes per view against that channel's usual ratio. This measures how much viewers valued a video, not how many clicked on it.
- **Courses.** Lecture series and practice programmes to follow in order: Karpathy's *Zero to Hero*, 3Blue1Brown, Stanford's CS229 and Sapolsky lectures, CrashCourse history, Yoga With Adriene's 30-day series and more. CalmTube remembers your progress and has a "next lesson" button.
- **Community picks.** Talks and lectures the Hacker News community upvoted most, sorted into your topics.
- **Channels you might like.** Suggestions from the channels your favourite creators recommend and from community picks. You add one by putting its handle in the channel list.
- **No autoplay and no "up next."** When a video ends you get a short breathing prompt and a box to note one thing worth remembering.
- **Less clickbait.** Shorts, livestreams, premieres and bait titles are filtered out. Titles are replaced with [DeArrow](https://dearrow.ajay.app)'s viewer-written plain titles where one exists (hover to see the original). Thumbnails start muted, and you can switch them to real frames from the video or hide them. View counts never appear.
- **Sponsor reads skipped automatically** using [SponsorBlock](https://sponsor.ajay.app). The lookup uses a hash prefix, so SponsorBlock never learns which video you're watching.
- **Resume where you left off**, and a **gentle break reminder** after 40 minutes (adjustable).
- **Private.** Saved videos, notes, progress and settings stay in your browser. You can export and import them in Settings.

## About ads

Videos play in YouTube's own player, so a creator's ads can still appear. Two ways to remove them:

1. **YouTube Premium.** Turn on "I have YouTube Premium" in Settings and stay signed in to YouTube in the same browser.
2. **An ad blocker** such as [uBlock Origin](https://ublockorigin.com/).

Sponsor reads inside the videos themselves are skipped either way.

## How the library is built

`scripts/build-library.mjs` runs daily in GitHub Actions and writes `data/library.json`. With no keys at all, it uses:

| Source | What it gives |
| --- | --- |
| YouTube's public RSS feeds | Each channel's latest long-form uploads, its 15 most popular videos, and course playlists (first 15 lessons) |
| [DeArrow](https://dearrow.ajay.app) | Viewer-written titles, real-frame thumbnails, some video lengths |
| [Return YouTube Dislike](https://returnyoutubedislike.com) | Like and view counts used to rank classics |
| [Hacker News search](https://hn.algolia.com/api) | Widely upvoted YouTube talks for Community picks |

Two optional keys make it better. Add them as repository secrets under **Settings → Secrets and variables → Actions → New repository secret**.

### `YT_API_KEY`: exact lengths, full courses, better suggestions (free)

Without this key, only some videos have a known length, so the "time I have" filter stays hidden until most videos do. The key also shows every lesson of long courses and finds the channels your creators recommend.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/), create a project (any name).
2. Open **APIs & Services → Library**, search for **YouTube Data API v3** and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → API key**. Under *API restrictions*, restrict it to YouTube Data API v3.
4. Add it as a repository secret named `YT_API_KEY`.

The daily build uses a few hundred of the free 10,000 daily quota units.

### `ANTHROPIC_API_KEY`: Claude reviews every video

Claude reads each new video's title and description and rates its depth, calm and clickbait against what this library is for. It sets aside the misses (drama, hype, channel admin) and writes a one-line "why watch" shown under each title. It also sorts community picks into topics and vets suggested channels.

1. Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Add it as a repository secret named `ANTHROPIC_API_KEY`.

Cost is roughly a third of a cent per video. The existing backlog of about 2,000 videos is reviewed 400 per day (about $6 in total), and after that roughly 40 new videos a day costs about $3–4 a month. You can lower the daily cap with a `CLAUDE_MAX_VIDEOS` variable.

## Running it yourself

It's a static site, so there's no build step for the page itself.

```bash
npm install
node scripts/build-library.mjs   # refresh data/library.json (the first run takes ~20 min)
python3 -m http.server 8000      # then open http://localhost:8000
```

### Hosting on GitHub Pages

1. In the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
2. The *Refresh library and deploy* workflow runs on every push and once a day.

## Changing what's in it

- **Channels:** `scripts/seed-channels.json`. Add a channel's `@handle` (without the `@`) under a topic, or add a topic. The next build resolves it and pulls in its videos.
- **Courses:** `courses.json`. Add a YouTube playlist ID with a title and one-line note.
- **Filters:** the bait-word list and title clean-up live in `scripts/lib/util.mjs`. What Claude looks for is described in `scripts/lib/curate.mjs`.

## Credits

Community titles, thumbnails and sponsor segments come from DeArrow and SponsorBlock by Ajay Ramachandran and contributors, licensed CC BY-NC-SA 4.0. Like counts come from Return YouTube Dislike. Community picks come from Hacker News via Algolia's search API.

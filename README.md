# CalmTube

A quiet way to watch YouTube. A hand-picked set of channels on running and endurance, fitness, AI, history, yoga, meditation and Eastern philosophy, and science, without the parts of YouTube built to keep you scrolling.

## What's different

- **A finite "Today" page.** A fixed number of videos a day (12 by default), at most one per channel, spread across topics. It's the same all day, and when you reach the end it says so.
- **No algorithm.** Only the channels in `scripts/seed-channels.json` appear. Nothing is ranked by engagement.
- **No autoplay and no "up next."** When a video ends you get a short breathing prompt and a place to note one thing worth remembering. You don't get more videos.
- **Less clickbait.** Shorts, livestreams, premieres and titles with bait words ("SHOCKING", "destroyed", "reacts"…) are filtered out. ALL-CAPS words, emoji and "!!!" are removed from titles. Thumbnails start muted (you can show them in full colour or hide them), and view counts never appear.
- **Gentle break reminder** after 40 minutes of watching. You can change the time or turn it off.
- **Private.** Saved videos, notes and settings stay in your browser. Videos play in YouTube's privacy-enhanced (`youtube-nocookie.com`) player.

## About ads

CalmTube plays videos with YouTube's own player, so a creator's ads can still show up. There are two ways to remove them:

1. **YouTube Premium.** In Settings, turn on "I have YouTube Premium" and stay signed in to YouTube in the same browser.
2. **An ad blocker** such as [uBlock Origin](https://ublockorigin.com/) (Firefox, or Chromium browsers that still support it).

## Running it

It's a static site, so there's no build step.

```bash
node scripts/fetch-videos.mjs   # pull the latest videos into data/videos.json
npx serve .                     # or: python3 -m http.server
```

### Hosting it free on GitHub Pages

1. Push this repo to GitHub.
2. In the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. The `Refresh library and deploy` workflow runs on every push and once a day. It fetches new videos, commits them, and publishes the site.

## Adding or removing channels

Edit `scripts/seed-channels.json`: add a channel's `@handle` (without the `@`) under a topic, or add a new topic. Then run:

```bash
node scripts/resolve-channels.mjs   # turns handles into channel IDs (channels.json)
node scripts/fetch-videos.mjs
```

The daily workflow also runs both steps, so pushing an edited seed file is enough.

Videos come from YouTube's public per-channel RSS feeds, so no API key is needed. Each feed only lists a channel's latest ~15 uploads, so the library keeps older videos between runs (up to 60 per channel) and grows over time.

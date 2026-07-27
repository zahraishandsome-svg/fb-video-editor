# Repost Studio

The portal for the editor. Runs on the PC that does the rendering; you drive it
from your phone over the same Wi-Fi.

## Start it

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Zahid\FBVideoEditor\portal\start.ps1
```

It prints two addresses - one for this PC, one for the phone. On the phone, open
the second one and use "Add to Home Screen"; it installs as a standalone app with
its own icon, no browser chrome.

Leave the window open while you use it. Ctrl+C stops the server.

## How it is put together

```
server.py     FastAPI - JSON API + serves the front end. Binds 0.0.0.0 so the
              phone can reach it.
worker.py     One background thread drains the render queue, so two jobs never
              fight over the GPU. Writes progress straight to the DB.
store.py      SQLite. One file, no migrations.
publisher.py  Facebook posting - DELIBERATE PLACEHOLDER, see below.
static/       The front end. No build step, no framework.
portal.db     Channels, jobs, settings.
renders/      Finished MP4s and their thumbnails.
```

The phone polls the API every 1.2s while something is rendering and every 6s when
idle. For a single-operator tool that beats the complexity of websockets.

## Channels

A channel is one TikTok creator paired with one Facebook page, plus the edit
preset used for its renders: speed, how much to randomise it, captions on or off,
and which encoder.

Speed is randomised per render around the channel's base value. That is
deliberate - an identical transform applied to every upload becomes a pattern of
its own, so each render draws fresh numbers. The full parameter set is stored on
the job and shown in the preview sheet.

## Facebook posting is not wired up

`publisher.py` defines the interface and raises `NotConfigured`. A finished render
lands in the queue as **ready** rather than being posted, so nothing goes out by
accident while the token side is unfinished.

The module documents the three-step Graph resumable upload and the two things
that matter when it gets wired: Reels cap at 90 seconds (longer renders need
`/videos` instead), and the same rendered file must never go to two pages -
re-render with a fresh seed, or the two uploads are byte-identical.

## Scheduling

Channels carry `per_day` and `post_times`, and the fields are stored, but the
scheduler itself is not running yet - renders are queued by hand from the app.
Automatic daily pickup needs the TikTok cookies set first, because listing a
creator's recent uploads is what gets rate-limited.

## Settings

- **TikTok cookies file** - path to a cookies.txt exported from a logged-in
  browser. TikTok throttles repeated anonymous downloads; without this, a busy
  day will start failing.
- **Output folder** - where renders and thumbnails are written.

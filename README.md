# fb-video-editor

Takes a TikTok URL, returns a Facebook-ready MP4: speed change, burned-in
CapCut-style captions, and a transform stack designed to keep legitimately
licensed reposts from tripping Facebook's duplicate-content matching.

CPU-only and cross-platform - identical output on Windows, a GitHub Actions
runner, or a VPS. No GPU required.

## Run it

**On GitHub:** Actions -> "Render video" -> Run workflow, paste the TikTok URL.
The MP4 and its parameter sidecar come back as a build artifact.

**Locally:**

```bash
python edit.py --url "https://www.tiktok.com/@user/video/123" --out final.mp4
```

| Flag | Default | Meaning |
|---|---|---|
| `--speed` | 1.1 | base playback speed |
| `--jitter` | 0.02 | randomise speed by +/- this; `0` pins it exactly |
| `--seed` | random | pin every random draw, for a reproducible render |
| `--preset` | medium | x264 preset. `medium`/crf20 is ~2x faster than `slow` and produces a *smaller* file |
| `--cookies` | - | cookies.txt, for rate-limited or age-gated sources |

Every run writes `<out>.params.json` with the exact values drawn, so any render
can be reproduced by passing its seed back in.

## What the edit does

**Download.** TikTok's `bytevc1` (h265) renditions advertise an audio track they
do not actually carry - downloading one gives a silent file. The format selector
forces h264, which also happens to be the watermark-free rendition.

**Captions.** faster-whisper `small` with word timestamps. Timestamps are divided
by the speed factor so captions stay in sync while the whole edit runs as a
single encode pass. Cues are grouped on pauses and sentence ends, orphan cues
("younger." alone for 0.4s) get absorbed into a neighbour, and lines are wrapped
balanced rather than greedily.

**Transform stack.** Facebook's duplicate matching is built on per-frame
perceptual hashes plus a temporal kernel over them, with a separate audio
fingerprint. What actually moves the needle, strongest first:

| Layer | Why it matters |
|---|---|
| Speed change | shifts the temporal kernel - the single biggest lever |
| Drifting crop window | two slow sine waves move the crop origin, so no two frames share a geometry and per-frame hashes never settle |
| Micro-rotation | 0.2-0.45 degrees, invisible, changes every frame hash |
| Sparse frame drop | one frame every ~150; the trailing `fps` filter refills the gap, so the frame sequence changes but duration and audio sync do not |
| 30 -> 29.97 fps | gentle temporal resample |
| Pitch + tempo split | `asetrate` shifts pitch, `atempo` puts tempo back, so net speed is exact but the audio fingerprint moves |
| EQ tilt + notch | narrow spectral changes below the audible threshold |
| Grade, sharpen, grain | small contributions; mostly they make the upscale look intentional |
| Metadata + encoder signature strip | `-map_metadata -1` plus bitexact flags remove the libx264/lavf strings |
| **Per-video randomisation** | the most underrated one - an identical transform applied to every upload *is itself* a detectable pattern |

Nothing here guarantees a video is never flagged; the goal is to cut the odds of
a false duplicate match.

## Notes

- Output is 1080x1920. Sources are usually 720p, so this is an upscale - it is
  the "HD" look, not real added detail.
- 4K export from a 1080p-or-lower source adds file size and nothing else.
- Reels cap at 90 seconds; longer renders post as regular video.

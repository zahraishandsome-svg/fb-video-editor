"""
Transcribe source audio and emit a CapCut-default-style .ass subtitle file.

Timestamps are divided by SPEED so the captions line up with the sped-up video,
which lets ffmpeg do speed + filter + caption burn-in in a single encode pass.
"""
import sys, os, math

SPEED = float(sys.argv[3]) if len(sys.argv) > 3 else 1.1
AUDIO = sys.argv[1]
OUT   = sys.argv[2]

# ---- canvas (must match the ffmpeg output size) ----
W, H = 1080, 1920

# ---- CapCut default caption look ----
# Open Sans Bold ships in fonts/ so Windows and Linux renders are identical.
# It is also what CapCut's default caption style actually uses.
FONT       = os.environ.get("CAPTION_FONT", "Open Sans")
FONT_SIZE  = 58
OUTLINE    = 3.0            # black stroke
SHADOW     = 1.2
MARGIN_V   = int(os.environ.get("CAPTION_MARGIN_V", 300))   # distance from bottom
MAX_CHARS  = 26             # per line before wrapping
MAX_LINES  = 2
MERGE_CAP  = 62             # looser cap used only when absorbing an orphan cue

print(f"loading model ... (speed={SPEED})")
from faster_whisper import WhisperModel

model = None
for dev, ct in (("cuda", "float16"), ("cpu", "int8")):
    try:
        model = WhisperModel("small", device=dev, compute_type=ct)
        print(f"  using {dev}/{ct}")
        break
    except Exception as e:
        print(f"  {dev} unavailable: {str(e)[:80]}")
if model is None:
    sys.exit("no whisper backend available")

segments, info = model.transcribe(
    AUDIO,
    language="en",
    word_timestamps=True,
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=350),
    beam_size=5,
)
print(f"  detected language: {info.language} (p={info.language_probability:.2f})")

# ---- collect words ----
words = []
for seg in segments:
    if not seg.words:
        continue
    for w in seg.words:
        t = w.word.strip()
        if t:
            words.append((w.start, w.end, t))
print(f"  {len(words)} words")

if not words:
    sys.exit("no speech detected")


def _pack(toks, width):
    lines, line = [], ""
    for t in toks:
        cand = (line + " " + t).strip()
        if len(cand) <= width or not line:
            line = cand
        else:
            lines.append(line)
            line = t
    if line:
        lines.append(line)
    return lines


def wrap(text):
    """Balanced wrap. Greedy packing leaves ragged tails ("...so" / "they're"),
    so squeeze the width down to the narrowest value that still fits in the
    minimum possible number of lines. No line may exceed MAX_CHARS."""
    toks = text.split()
    if len(text) <= MAX_CHARS or len(toks) == 1:
        return [text]

    fewest = len(_pack(toks, MAX_CHARS))
    for width in range(max(len(max(toks, key=len)), 8), MAX_CHARS + 1):
        lines = _pack(toks, width)
        if len(lines) <= fewest:
            return lines
    return _pack(toks, MAX_CHARS)


# ---- group words into caption cues, CapCut style ----
# break on: a real pause, sentence-ending punctuation, or when the cue gets long
cues = []
cur = []
GAP = 0.45          # a pause this long starts a new caption
MAX_CUE_CHARS = MAX_CHARS * MAX_LINES
MAX_CUE_SECS = 3.2

for i, (s, e, t) in enumerate(words):
    if cur:
        prev_end = cur[-1][1]
        text_len = len(" ".join(x[2] for x in cur)) + 1 + len(t)
        dur = e - cur[0][0]
        ends_sentence = cur[-1][2][-1] in ".!?"
        if (s - prev_end >= GAP) or ends_sentence or text_len > MAX_CUE_CHARS or dur > MAX_CUE_SECS:
            cues.append(cur)
            cur = []
    cur.append((s, e, t))
if cur:
    cues.append(cur)


def cue_text(c):
    return " ".join(x[2] for x in c)


# merge orphans ("younger." alone on screen for 0.4s) back into a neighbour
MIN_CUE_SECS, MIN_CUE_CHARS = 0.75, 14
merged, i = [], 0
while i < len(cues):
    c = cues[i]
    dur = c[-1][1] - c[0][0]
    if (dur < MIN_CUE_SECS or len(cue_text(c)) < MIN_CUE_CHARS) and (merged or i + 1 < len(cues)):
        prev_fits = merged and len(cue_text(merged[-1])) + 1 + len(cue_text(c)) <= MERGE_CAP
        next_fits = i + 1 < len(cues) and len(cue_text(cues[i + 1])) + 1 + len(cue_text(c)) <= MERGE_CAP
        if prev_fits and (not next_fits or len(cue_text(merged[-1])) <= len(cue_text(cues[i + 1]))):
            merged[-1] = merged[-1] + c
            i += 1
            continue
        if next_fits:
            cues[i + 1] = c + cues[i + 1]
            i += 1
            continue
    merged.append(c)
    i += 1
cues = merged

print(f"  {len(cues)} caption cues")


def ts(sec):
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = sec % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CapCut,{FONT},{FONT_SIZE},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0.4,0,1,{OUTLINE},{SHADOW},2,90,90,{MARGIN_V},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

lines = []
for idx, cue in enumerate(cues):
    start = cue[0][0] / SPEED
    end = cue[-1][1] / SPEED
    # hold the caption until the next one starts, so there is no flicker gap
    if idx + 1 < len(cues):
        nxt = cues[idx + 1][0][0] / SPEED
        end = min(nxt, end + 0.30)
    if end - start < 0.30:
        end = start + 0.30

    text = " ".join(w[2] for w in cue).strip()
    text = text.replace("{", "(").replace("}", ")")
    body = r"\N".join(wrap(text))
    # gentle CapCut-ish pop-in
    fx = r"{\fad(90,90)}"
    lines.append(f"Dialogue: 0,{ts(start)},{ts(end)},CapCut,,0,0,0,,{fx}{body}")

with open(OUT, "w", encoding="utf-8-sig") as f:
    f.write(header + "\n".join(lines) + "\n")

longest = max(len(l) for c in cues for l in wrap(" ".join(w[2] for w in c)))
shortest = min((c[-1][1] - c[0][0]) / SPEED for c in cues)
print(f"wrote {OUT}  ({len(lines)} cues, ends {ts(cues[-1][-1][1] / SPEED)})")
print(f"  longest line: {longest} chars | shortest cue: {shortest:.2f}s")

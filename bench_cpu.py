"""Measure faster-whisper on CPU only - proves the pipeline needs no GPU."""
import time, sys, os
from faster_whisper import WhisperModel

AUDIO = sys.argv[1]
SIZE  = sys.argv[2] if len(sys.argv) > 2 else "small"
THREADS = int(sys.argv[3]) if len(sys.argv) > 3 else 4   # match a typical VPS

t0 = time.time()
model = WhisperModel(SIZE, device="cpu", compute_type="int8", cpu_threads=THREADS)
load = time.time() - t0

t1 = time.time()
segs, info = model.transcribe(AUDIO, language="en", word_timestamps=True,
                              vad_filter=True, beam_size=5)
words = sum(len(s.words or []) for s in segs)
run = time.time() - t1

import subprocess, json
dur = float(subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration",
     "-of", "default=nw=1:nk=1", AUDIO],
    capture_output=True, text=True).stdout.strip())

print(f"model={SIZE} threads={THREADS}")
print(f"  audio length : {dur:.1f}s")
print(f"  model load   : {load:.1f}s  (one-time, cached after first run)")
print(f"  transcribe   : {run:.1f}s   -> {dur/run:.2f}x realtime")
print(f"  words        : {words}")

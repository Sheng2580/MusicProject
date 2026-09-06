# Audio melody refinement

`refine_vocal_melody.py` combines two independent note transcriptions from the
same separated vocal stem. The pYIN JSON is the primary monophonic contour;
Basic Pitch supplies onset/note-off confirmation and removes weak isolated
artefacts. A full-mix Basic Pitch CSV can optionally provide an instrumental
upper-voice intro before the first vocal entrance.

Example:

```sh
python3 scripts/refine_vocal_melody.py \
  --primary /tmp/song-vocals-pyin.json \
  --evidence /tmp/song-vocals-basic-pitch.csv \
  --intro-evidence /tmp/song-full-basic-pitch.csv \
  --intro-end 12.0 \
  --output /tmp/song-refined.json
```

The command prints coverage and duration diagnostics. Inputs and output must be
different files so a failed run cannot replace its own comparison source.

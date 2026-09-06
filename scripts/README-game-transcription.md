# GAME audio transcription

`transcribe_game_onnx.py` reproduces the browser melody pipeline for development
and regression testing. It runs the official OpenVPI GAME small ONNX release in
20-second chunks with four seconds of overlap, then keeps the central region of
each chunk. This bounds the transformer's memory usage and avoids false note
boundaries at chunk edges.

Use Python 3.11 or newer, then install the development-only inference dependencies:

```sh
python3 -m venv .venv-game
.venv-game/bin/pip install -r scripts/requirements-game.txt
```

Convert a source recording to 44.1 kHz PCM16 WAV with an audio tool already on
the machine, then transcribe it:

```sh
.venv-game/bin/python scripts/transcribe_game_onnx.py song-44100.wav \
  --language zh \
  --output song-melody.json
```

The player accepts MP3 directly and performs decoding and resampling locally.
This development-only Python utility deliberately accepts an explicit PCM WAV
instead, so its input samples are reproducible across machines.

GAME is trained for singing. For an instrumental intro or bridge, an official
Basic Pitch event CSV can be supplied as secondary evidence:

```sh
.venv-game/bin/python scripts/transcribe_game_onnx.py song-44100.wav \
  --language en \
  --basic-pitch-csv song_basic_pitch.csv \
  --output song-melody.json
```

Basic Pitch events are read only inside gaps of at least 2.2 seconds in the
GAME line. Simultaneous polyphonic events are reduced to the upper attacked
voice, but distinct onsets are not thinned on a fixed time grid.

For score-based development checks, compare the result without changing the
player workflow:

```sh
python3 scripts/score_to_melody.py compare score-oracle.json song-melody.json
```

Players never need to provide a score, MIDI file, or JSON file.

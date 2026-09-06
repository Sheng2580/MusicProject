# Instrument samples

`fluidr3-acoustic-guitar-nylon/*.mp3` contains the natural-note samples used by
the local melody instrument. They were extracted without audio modification
from `acoustic_guitar_nylon-mp3.js` in
[gleitz/midi-js-soundfonts](https://github.com/gleitz/midi-js-soundfonts), which
was generated from the FluidR3 GM soundfont.

The FluidR3 soundfont samples are distributed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/us/).
The MIDI.js soundfont packaging code is MIT licensed. No network request is
made while playing: the selected samples ship with this local project.

## Melody transcription model

`../models/basic-pitch/` contains Spotify Basic Pitch 1.0.1's TensorFlow.js
model files from the Apache-2.0 licensed `@spotify/basic-pitch` package. The
browser loads these files locally when a player imports audio; the recording is
not sent to Spotify or any other service.

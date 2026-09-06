# OpenVPI GAME small model

The ONNX files in this directory are the official `GAME-1.0.3-small-onnx`
release assets from [OpenVPI GAME v1.0.3](https://github.com/openvpi/GAME/releases/tag/v1.0.3).
GAME is a singing-specific audio-to-note model and is distributed under the
MIT license included in `LICENSE`.

- Release archive: `GAME-1.0.3-small-onnx.zip`
- Archive SHA-256: `00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8`
- Audio rate: 44,100 Hz
- Frame step: 10 ms
- Model variant: small, 128-dimensional embedding

The browser pipeline runs `encoder.onnx`, `segmenter.onnx`, `bd2dur.onnx`, and
`estimator.onnx`. `dur2bd.onnx` is intentionally omitted because player audio
does not provide known score boundaries.

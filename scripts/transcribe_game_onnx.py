#!/usr/bin/env python3
"""Transcribe a PCM WAV with OpenVPI GAME and write app melody JSON.

The browser uses the same model order, chunk geometry, thresholds, and gap
merge rules. An optional Basic Pitch CSV supplies instrument notes only inside
long regions where the singing model produced no voiced note.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Any, Iterable, Sequence

if sys.version_info < (3, 11):
    raise SystemExit("OpenVPI GAME transcription requires Python 3.11 or newer")

import numpy as np


SAMPLE_RATE = 44_100
CHUNK_SECONDS = 20.0
OVERLAP_SECONDS = 4.0
D3PM_STEPS = 8
BOUNDARY_THRESHOLD = 0.15
PRESENCE_THRESHOLD = 0.2
BOUNDARY_RADIUS = 2
MIN_NOTE_DURATION = 0.045
MIN_INSTRUMENTAL_LEAD_DURATION = 0.090
MIN_INSTRUMENTAL_LEAD_MIDI = 65
MIN_INSTRUMENTAL_STRENGTH = 0.35
INSTRUMENTAL_GAP_SECONDS = 2.2
LANGUAGE_IDS = {"universal": 0, "en": 1, "ja": 2, "yue": 3, "zh": 4}


Note = dict[str, float | int]
Range = tuple[float, float]


def read_pcm16_wave(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.getnframes()
        raw = handle.readframes(frames)
    if rate != SAMPLE_RATE:
        raise ValueError(f"{path}: expected {SAMPLE_RATE} Hz WAV, got {rate} Hz")
    if width != 2 or channels < 1:
        raise ValueError(f"{path}: expected mono/stereo PCM16 WAV")
    samples = np.frombuffer(raw, dtype="<i2")
    if samples.size != frames * channels:
        raise ValueError(f"{path}: truncated PCM data")
    return samples.reshape(-1, channels).astype(np.float32).mean(axis=1) / 32768.0


def _session(path: Path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def load_sessions(model_dir: Path) -> tuple[Any, Any, Any, Any]:
    required = ("encoder.onnx", "segmenter.onnx", "bd2dur.onnx", "estimator.onnx")
    missing = [name for name in required if not (model_dir / name).is_file()]
    if missing:
        raise ValueError(f"{model_dir}: missing {', '.join(missing)}")
    return tuple(_session(model_dir / name) for name in required)  # type: ignore[return-value]


def infer_chunk(
    sessions: tuple[Any, Any, Any, Any],
    waveform: np.ndarray,
    language_id: int,
    steps: int,
    boundary_threshold: float,
    presence_threshold: float,
) -> list[Note]:
    encoder, segmenter, boundary_to_duration, estimator = sessions
    duration = np.asarray([len(waveform) / SAMPLE_RATE], dtype=np.float32)
    x_seg, x_est, mask_t = encoder.run(None, {
        "waveform": waveform[None].astype(np.float32, copy=False),
        "duration": duration,
    })
    known = np.zeros_like(mask_t, dtype=np.bool_)
    boundaries = known.copy()
    for value in np.arange(steps, dtype=np.float32) / steps:
        boundaries, = segmenter.run(None, {
            "x_seg": x_seg,
            "language": np.asarray([language_id], dtype=np.int64),
            "known_boundaries": known,
            "prev_boundaries": boundaries,
            "t": np.asarray([value], dtype=np.float32),
            "maskT": mask_t,
            "threshold": np.asarray(boundary_threshold, dtype=np.float32),
            "radius": np.asarray(BOUNDARY_RADIUS, dtype=np.int64),
        })
    durations, mask_n = boundary_to_duration.run(None, {
        "boundaries": boundaries,
        "maskT": mask_t,
    })
    presence, scores = estimator.run(None, {
        "x_est": x_est,
        "boundaries": boundaries,
        "maskT": mask_t,
        "maskN": mask_n,
        "threshold": np.asarray(presence_threshold, dtype=np.float32),
    })
    notes: list[Note] = []
    onset = 0.0
    for note_duration, voiced, score, valid in zip(
        durations[0], presence[0], scores[0], mask_n[0], strict=True,
    ):
        value = float(note_duration)
        if valid and voiced and value >= MIN_NOTE_DURATION:
            notes.append({
                "start": round(onset, 3),
                "duration": round(value, 3),
                "midi": round(float(score)),
                "confidence": 0.9,
                "strength": 0.9,
            })
        onset += value
    return notes


def normalize_notes(notes: Iterable[Note], audio_duration: float) -> list[Note]:
    ordered: list[Note] = []
    for raw in notes:
        start = float(raw["start"])
        duration = min(float(raw["duration"]), audio_duration - start)
        midi = round(float(raw["midi"]))
        if (not math.isfinite(start) or not math.isfinite(duration)
                or start < 0 or start >= audio_duration or duration <= 0
                or midi < 0 or midi > 127):
            continue
        ordered.append({
            "start": round(start, 3),
            "duration": round(duration, 3),
            "midi": midi,
            "confidence": round(max(0.0, min(1.0, float(raw["confidence"]))), 3),
            "strength": round(max(0.0, min(1.0, float(raw["strength"]))), 3),
        })
    ordered.sort(key=lambda note: (float(note["start"]), -float(note["confidence"])))

    deduplicated: list[Note] = []
    for note in ordered:
        previous = deduplicated[-1] if deduplicated else None
        if previous and abs(float(note["start"]) - float(previous["start"])) < 0.005:
            if (float(note["confidence"]), float(note["duration"])) > (
                    float(previous["confidence"]), float(previous["duration"])):
                deduplicated[-1] = note
            continue
        deduplicated.append(note)

    result: list[Note] = []
    for note in deduplicated:
        previous = result[-1] if result else None
        if previous and float(previous["start"]) + float(previous["duration"]) > float(note["start"]):
            previous["duration"] = round(float(note["start"]) - float(previous["start"]), 3)
            if float(previous["duration"]) < MIN_NOTE_DURATION:
                result.pop()
        if float(note["duration"]) >= MIN_NOTE_DURATION:
            result.append(note)
    return result


def infer_chunked(
    sessions: tuple[Any, Any, Any, Any],
    waveform: np.ndarray,
    language_id: int,
    steps: int,
    boundary_threshold: float,
    presence_threshold: float,
    chunk_seconds: float = CHUNK_SECONDS,
    overlap_seconds: float = OVERLAP_SECONDS,
) -> list[Note]:
    chunk_samples = round(chunk_seconds * SAMPLE_RATE)
    overlap_samples = round(overlap_seconds * SAMPLE_RATE)
    stride_samples = chunk_samples - overlap_samples
    if chunk_samples <= 0 or stride_samples <= 0:
        raise ValueError("chunk duration must exceed overlap duration")
    starts = list(range(0, len(waveform), stride_samples))
    result: list[Note] = []
    for index, start in enumerate(starts):
        end = min(len(waveform), start + chunk_samples)
        chunk_notes = infer_chunk(
            sessions, waveform[start:end], language_id, steps,
            boundary_threshold, presence_threshold,
        )
        chunk_duration = (end - start) / SAMPLE_RATE
        left_margin = 0.0 if index == 0 else overlap_seconds / 2
        right_margin = chunk_duration if end == len(waveform) else chunk_seconds - overlap_seconds / 2
        offset = start / SAMPLE_RATE
        for note in chunk_notes:
            relative = float(note["start"])
            if left_margin <= relative < right_margin:
                note["start"] = round(relative + offset, 3)
                result.append(note)
        print(
            json.dumps({"chunk": index + 1, "chunks": len(starts), "notes": len(result)}),
            flush=True,
        )
        if end == len(waveform):
            break
    return normalize_notes(result, len(waveform) / SAMPLE_RATE)


def find_instrumental_gaps(notes: Sequence[Note], duration: float, minimum: float) -> list[Range]:
    gaps: list[Range] = []
    cursor = 0.0
    for note in normalize_notes(notes, duration):
        start = float(note["start"])
        if start - cursor >= minimum:
            gaps.append((cursor, start))
        cursor = max(cursor, start + float(note["duration"]))
    if duration - cursor >= minimum:
        gaps.append((cursor, duration))
    return gaps


def read_basic_pitch_csv(path: Path) -> list[dict[str, float | int]]:
    events: list[dict[str, float | int]] = []
    with path.open(encoding="utf-8", newline="") as handle:
        for line, row in enumerate(csv.DictReader(handle), start=2):
            try:
                start = float(row["start_time_s"])
                end = float(row["end_time_s"])
                midi = round(float(row["pitch_midi"]))
                velocity = float(row["velocity"])
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"{path}:{line}: invalid Basic Pitch row") from error
            amplitude = max(0.0, min(1.0, velocity / 127.0))
            if (start >= 0 and end - start >= MIN_INSTRUMENTAL_LEAD_DURATION
                    and MIN_INSTRUMENTAL_LEAD_MIDI <= midi <= 96
                    and amplitude >= MIN_INSTRUMENTAL_STRENGTH):
                events.append({"start": start, "end": end, "midi": midi, "velocity": velocity})
    return sorted(events, key=lambda note: (float(note["start"]), -int(note["midi"])))


def select_instrumental_lead(events: Sequence[dict[str, float | int]], gap: Range) -> list[Note]:
    start, end = gap
    candidates = [event for event in events
                  if float(event["start"]) >= start - 0.04
                  and float(event["start"]) < end
                  and float(event["end"]) > start]
    selected: list[dict[str, float | int]] = []
    index = 0
    while index < len(candidates):
        group_end = index + 1
        best = candidates[index]
        while (group_end < len(candidates)
               and float(candidates[group_end]["start"]) - float(candidates[index]["start"]) <= 0.065):
            candidate = candidates[group_end]
            if (int(candidate["midi"]), float(candidate["velocity"])) > (
                    int(best["midi"]), float(best["velocity"])):
                best = candidate
            group_end += 1
        selected.append(best)
        index = group_end

    coalesced: list[dict[str, float | int]] = []
    for event in selected:
        previous = coalesced[-1] if coalesced else None
        if (previous and int(previous["midi"]) == int(event["midi"])
                and float(event["start"]) <= float(previous["end"]) + 0.060):
            previous["end"] = max(float(previous["end"]), float(event["end"]))
            previous["velocity"] = max(float(previous["velocity"]), float(event["velocity"]))
        else:
            coalesced.append(dict(event))

    notes: list[Note] = []
    for event in coalesced:
        note_start = max(start, float(event["start"]))
        note_end = min(end, float(event["end"]))
        amplitude = max(0.0, min(1.0, float(event["velocity"]) / 127.0))
        notes.append({
            "start": note_start,
            "duration": note_end - note_start,
            "midi": int(event["midi"]),
            "confidence": 0.55 + amplitude * 0.45,
            "strength": amplitude,
        })
    return normalize_notes(notes, end)


def write_json_atomic(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.chmod(temporary_name, 0o644)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="44.1 kHz PCM16 WAV")
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument(
        "--model-dir", type=Path,
        default=Path(__file__).resolve().parents[1] / "public/models/game",
    )
    parser.add_argument("--language", choices=LANGUAGE_IDS, default="universal")
    parser.add_argument("--steps", type=int, default=D3PM_STEPS)
    parser.add_argument("--chunk", type=float, default=CHUNK_SECONDS)
    parser.add_argument("--overlap", type=float, default=OVERLAP_SECONDS)
    parser.add_argument("--boundary-threshold", type=float, default=BOUNDARY_THRESHOLD)
    parser.add_argument("--presence-threshold", type=float, default=PRESENCE_THRESHOLD)
    parser.add_argument("--basic-pitch-csv", type=Path)
    parser.add_argument("--gap-seconds", type=float, default=INSTRUMENTAL_GAP_SECONDS)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.steps < 1:
        raise ValueError("--steps must be at least 1")
    if not 0 < args.boundary_threshold < 1 or not 0 < args.presence_threshold < 1:
        raise ValueError("model thresholds must be between zero and one")
    if args.chunk <= 0 or args.overlap < 0 or args.overlap >= args.chunk:
        raise ValueError("--chunk must be positive and greater than --overlap")
    if args.gap_seconds <= 0:
        raise ValueError("--gap-seconds must be positive")
    if args.audio.resolve() == args.output.resolve():
        raise ValueError("input and output paths must be different")

    waveform = read_pcm16_wave(args.audio)
    duration = len(waveform) / SAMPLE_RATE
    started = time.monotonic()
    sessions = load_sessions(args.model_dir)
    game_notes = infer_chunked(
        sessions,
        waveform,
        LANGUAGE_IDS[args.language],
        args.steps,
        args.boundary_threshold,
        args.presence_threshold,
        args.chunk,
        args.overlap,
    )
    notes = list(game_notes)
    gap_notes: list[Note] = []
    if args.basic_pitch_csv:
        evidence = read_basic_pitch_csv(args.basic_pitch_csv)
        for gap in find_instrumental_gaps(game_notes, duration, args.gap_seconds):
            gap_notes.extend(select_instrumental_lead(evidence, gap))
        notes = normalize_notes([*game_notes, *gap_notes], duration)
    write_json_atomic(args.output, notes)

    starts = [float(note["start"]) for note in notes]
    intervals = [right - left for left, right in zip(starts, starts[1:])]
    gaps = [
        float(right["start"]) - float(left["start"]) - float(left["duration"])
        for left, right in zip(notes, notes[1:])
    ]
    print(json.dumps({
        "output": str(args.output.resolve()),
        "game_notes": len(game_notes),
        "instrumental_gap_notes": len(gap_notes),
        "notes": len(notes),
        "under_100ms_intervals": sum(interval < 0.1 for interval in intervals),
        "maximum_gap": round(max(gaps, default=duration), 3),
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ModuleNotFoundError as error:
        raise SystemExit(
            f"missing Python package {error.name!r}; install scripts/requirements-game.txt"
        ) from error
    except (ValueError, OSError) as error:
        raise SystemExit(f"error: {error}") from error

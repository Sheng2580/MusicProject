#!/usr/bin/env python3
"""Convert a symbolic score into the melody JSON used by the web app.

The score is authoritative for pitch and note order. When an audio file is
provided, audio features are used only to warp the score timeline.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np


MIDI_SUFFIXES = {".mid", ".midi"}
SCORE_SUFFIXES = {".musicxml", ".xml", ".mxl", ".mei", ".krn"}
APP_MIN_MIDI = 24
APP_MAX_MIDI = 108
POSITIVE_NAME_HINTS = {
    "vocal": 8.0,
    "vocals": 8.0,
    "voice": 7.0,
    "melody": 7.0,
    "lead": 5.0,
    "singer": 5.0,
    "solo": 2.0,
    "right hand": 1.5,
    "rh": 1.0,
}
NEGATIVE_NAME_HINTS = {
    "drum": -12.0,
    "percussion": -12.0,
    "bass": -5.0,
    "left hand": -4.0,
    "lh": -2.0,
    "accompan": -4.0,
    "harmony": -3.0,
    "chord": -3.0,
}


@dataclass(frozen=True)
class ScoreNote:
    start: float
    duration: float
    midi: int
    velocity: int
    part_index: int
    part_id: str
    part_name: str
    voice: int = 0
    staff: int = 0
    is_drum: bool = False

    @property
    def end(self) -> float:
        return self.start + self.duration

    @property
    def stream_key(self) -> tuple[int, int, int]:
        return (self.part_index, self.voice, self.staff)


@dataclass(frozen=True)
class LoadedScore:
    notes: list[ScoreNote]
    source_format: str
    nominal_bpm: float


@dataclass(frozen=True)
class StreamSummary:
    part_index: int
    part_id: str
    part_name: str
    voice: int
    staff: int
    notes: int
    start: float
    end: float
    median_midi: float
    pitch_low: int
    pitch_high: int
    monophony: float
    density: float
    score: float


@dataclass(frozen=True)
class AlignmentResult:
    score_times: np.ndarray
    audio_times: np.ndarray
    audio_chroma: np.ndarray
    feature_rate: float
    pitch_shift: int
    normalized_cost: float
    score_duration: float
    audio_duration: float
    aligner: str


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _finite_float(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{label} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{label} must be a finite number")
    return result


def _reject_nonfinite_json_constant(constant: str) -> None:
    raise ValueError(f"Melody JSON contains non-finite value {constant}")


def _validate_score_notes(notes: Sequence[ScoreNote]) -> None:
    for index, note in enumerate(notes):
        start = _finite_float(note.start, f"Score note {index} start")
        duration = _finite_float(note.duration, f"Score note {index} duration")
        midi = _finite_float(note.midi, f"Score note {index} MIDI")
        _finite_float(note.velocity, f"Score note {index} velocity")
        if start < 0 or duration <= 0 or not 0 <= midi <= 127 or not midi.is_integer():
            raise ValueError(f"Score note {index} is outside valid time or MIDI ranges")


def _safe_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return fallback


def _parse_transpose(value: Any) -> int | None:
    if value == "auto":
        return None
    try:
        numeric_shift = _finite_float(value, "Transpose")
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("--transpose must be 'auto' or an integer from -24 to 24") from exc
    if not numeric_shift.is_integer():
        raise ValueError("--transpose must be 'auto' or an integer from -24 to 24")
    shift = int(numeric_shift)
    if not -24 <= shift <= 24:
        raise ValueError("--transpose must be 'auto' or an integer from -24 to 24")
    return shift


def _fit_midi_to_app_range(midi: int) -> tuple[int, int]:
    """Fold a pitch by octaves into the range accepted by the web audio engine."""
    numeric_midi = _finite_float(midi, "MIDI note")
    if not numeric_midi.is_integer():
        raise ValueError(f"MIDI note must be an integer, got {midi!r}")
    fitted = int(numeric_midi)
    if fitted < APP_MIN_MIDI:
        fitted += 12 * math.ceil((APP_MIN_MIDI - fitted) / 12)
    if fitted > APP_MAX_MIDI:
        fitted -= 12 * math.ceil((fitted - APP_MAX_MIDI) / 12)
    if not APP_MIN_MIDI <= fitted <= APP_MAX_MIDI:  # pragma: no cover - range spans all pitch classes
        raise ValueError(
            f"MIDI note {midi} cannot be folded into app range {APP_MIN_MIDI}..{APP_MAX_MIDI}"
        )
    return fitted, fitted - int(numeric_midi)


def _require_file(path: Path) -> Path:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"File does not exist: {path}")
    return path


def _quarter_to_seconds(
    quarter_positions: Sequence[float],
    tempo_changes: Sequence[tuple[float, float]],
    default_bpm: float,
) -> np.ndarray:
    """Integrate a quarter-note tempo map at arbitrary score positions."""
    positions = np.asarray(quarter_positions, dtype=float)
    default_bpm = _finite_float(default_bpm, "Default BPM")
    if default_bpm <= 0:
        raise ValueError("Default BPM must be greater than zero")
    if positions.size == 0:
        return positions
    if not np.all(np.isfinite(positions)):
        raise ValueError("Score positions must contain only finite numbers")

    changes_by_position: dict[float, float] = {}
    for index, (position, bpm) in enumerate(tempo_changes):
        position = _finite_float(position, f"Tempo change {index} position")
        bpm = _finite_float(bpm, f"Tempo change {index} BPM")
        if bpm <= 0:
            raise ValueError(f"Tempo change {index} BPM must be greater than zero")
        changes_by_position[position] = bpm
    changes = sorted(changes_by_position.items())
    if not changes or changes[0][0] > 0:
        changes.insert(0, (0.0, default_bpm))

    change_positions = np.asarray([item[0] for item in changes], dtype=float)
    bpms = np.asarray([item[1] for item in changes], dtype=float)
    cumulative = np.zeros(len(changes), dtype=float)
    for index in range(1, len(changes)):
        quarter_delta = change_positions[index] - change_positions[index - 1]
        cumulative[index] = cumulative[index - 1] + quarter_delta * 60.0 / bpms[index - 1]

    result = np.empty_like(positions, dtype=float)
    for flat_index, position in enumerate(positions.flat):
        tempo_index = int(np.searchsorted(change_positions, position, side="right") - 1)
        if tempo_index < 0:
            seconds = position * 60.0 / bpms[0]
        else:
            seconds = cumulative[tempo_index] + (
                position - change_positions[tempo_index]
            ) * 60.0 / bpms[tempo_index]
        result.flat[flat_index] = seconds
    return result


def _load_midi(path: Path) -> LoadedScore:
    import pretty_midi

    midi = pretty_midi.PrettyMIDI(str(path))
    notes: list[ScoreNote] = []
    for part_index, instrument in enumerate(midi.instruments):
        try:
            program_name = pretty_midi.program_to_instrument_name(instrument.program)
        except ValueError:
            program_name = f"Program {instrument.program}"
        part_name = instrument.name.strip() or program_name
        for note in instrument.notes:
            if note.end <= note.start:
                continue
            notes.append(
                ScoreNote(
                    start=float(note.start),
                    duration=float(note.end - note.start),
                    midi=int(note.pitch),
                    velocity=int(note.velocity),
                    part_index=part_index,
                    part_id=f"track-{part_index}",
                    part_name=part_name,
                    is_drum=bool(instrument.is_drum),
                )
            )

    tempo_times, tempi = midi.get_tempo_changes()
    nominal_bpm = float(tempi[0]) if len(tempi) else 120.0
    return LoadedScore(
        notes=sorted(notes, key=lambda note: (note.start, note.midi)),
        source_format="midi",
        nominal_bpm=nominal_bpm,
    )


def _load_notated_score(path: Path, default_bpm: float, unfold: bool) -> LoadedScore:
    import partitura as pt

    # Partitura 1.9 advertises PathLike support, but its URL check still
    # assumes a string on some Python versions.
    score = pt.load_score(str(path))
    if unfold:
        try:
            score = pt.score.unfold_part_maximal(score)
        except Exception as exc:  # pragma: no cover - depends on malformed repeat graphs
            print(f"Warning: repeat unfolding failed ({exc}); using written order.", file=sys.stderr)

    tempo_changes: list[tuple[float, float]] = []
    for part in score.parts:
        for tempo in part.iter_all(pt.score.Tempo):
            if tempo.start is None:
                continue
            quarter = float(part.quarter_map(tempo.start.t))
            qpm = 60_000_000.0 / float(tempo.microseconds_per_quarter)
            tempo_changes.append((quarter, qpm))

    notes: list[ScoreNote] = []
    for part_index, part in enumerate(score.parts):
        array = part.note_array(include_staff=True)
        if not len(array):
            continue
        onset_quarters = np.asarray(array["onset_quarter"], dtype=float)
        end_quarters = onset_quarters + np.asarray(array["duration_quarter"], dtype=float)
        onset_seconds = _quarter_to_seconds(onset_quarters, tempo_changes, default_bpm)
        end_seconds = _quarter_to_seconds(end_quarters, tempo_changes, default_bpm)
        part_name = str(getattr(part, "part_name", "") or getattr(part, "name", "") or part.id)
        for row_index, row in enumerate(array):
            duration = float(end_seconds[row_index] - onset_seconds[row_index])
            if duration <= 0:
                continue
            notes.append(
                ScoreNote(
                    start=float(onset_seconds[row_index]),
                    duration=duration,
                    midi=int(row["pitch"]),
                    velocity=80,
                    part_index=part_index,
                    part_id=str(part.id),
                    part_name=part_name,
                    voice=_safe_int(row["voice"]),
                    staff=_safe_int(row["staff"]),
                )
            )

    nominal_bpm = tempo_changes[0][1] if tempo_changes else default_bpm
    return LoadedScore(
        notes=sorted(notes, key=lambda note: (note.start, note.midi)),
        source_format=path.suffix.lower().lstrip("."),
        nominal_bpm=float(nominal_bpm),
    )


def load_score(path: Path, default_bpm: float = 120.0, unfold: bool = True) -> LoadedScore:
    default_bpm = _finite_float(default_bpm, "Default BPM")
    if default_bpm <= 0:
        raise ValueError("Default BPM must be greater than zero")
    path = _require_file(path)
    suffix = path.suffix.lower()
    if suffix in MIDI_SUFFIXES:
        loaded = _load_midi(path)
    elif suffix in SCORE_SUFFIXES:
        loaded = _load_notated_score(path, default_bpm=default_bpm, unfold=unfold)
    else:
        supported = ", ".join(sorted(MIDI_SUFFIXES | SCORE_SUFFIXES))
        raise ValueError(f"Unsupported score extension {suffix!r}; expected one of: {supported}")
    if not loaded.notes:
        raise ValueError(f"No pitched notes found in {path}")
    if not math.isfinite(loaded.nominal_bpm) or loaded.nominal_bpm <= 0:
        raise ValueError(f"Score has an invalid nominal tempo: {loaded.nominal_bpm!r}")
    _validate_score_notes(loaded.notes)
    return loaded


def _onset_groups(notes: Sequence[ScoreNote], window: float = 0.025) -> list[list[ScoreNote]]:
    if not notes:
        return []
    ordered = sorted(notes, key=lambda note: (note.start, note.midi))
    groups: list[list[ScoreNote]] = [[ordered[0]]]
    group_start = ordered[0].start
    for note in ordered[1:]:
        if note.start - group_start <= window:
            groups[-1].append(note)
        else:
            groups.append([note])
            group_start = note.start
    return groups


def _monophony_ratio(notes: Sequence[ScoreNote]) -> float:
    groups = _onset_groups(notes)
    if not groups:
        return 0.0
    return sum(1 for group in groups if len(group) == 1) / len(groups)


def _name_score(name: str) -> float:
    lowered = name.casefold()
    score = sum(weight for hint, weight in POSITIVE_NAME_HINTS.items() if hint in lowered)
    score += sum(weight for hint, weight in NEGATIVE_NAME_HINTS.items() if hint in lowered)
    return score


def summarize_streams(notes: Sequence[ScoreNote]) -> list[StreamSummary]:
    grouped: dict[tuple[int, int, int], list[ScoreNote]] = defaultdict(list)
    for note in notes:
        grouped[note.stream_key].append(note)

    summaries: list[StreamSummary] = []
    global_end = max((note.end for note in notes), default=1.0)
    for key, stream_notes in grouped.items():
        first = stream_notes[0]
        start = min(note.start for note in stream_notes)
        end = max(note.end for note in stream_notes)
        span = max(0.001, end - start)
        pitches = [note.midi for note in stream_notes]
        median_pitch = float(statistics.median(pitches))
        monophony = _monophony_ratio(stream_notes)
        density = len(stream_notes) / span
        coverage = span / max(global_end, 0.001)
        register_score = _clamp((median_pitch - 45.0) / 35.0, 0.0, 1.0)
        density_score = min(1.0, density)
        staff_score = 0.7 if first.staff == 1 else -0.7 if first.staff > 1 else 0.0
        score = (
            _name_score(first.part_name)
            + 1.5 * monophony
            + 1.4 * register_score
            + 0.8 * density_score
            + 0.8 * min(1.0, coverage)
            + min(2.0, math.log2(len(stream_notes) + 1) / 2.0)
            + staff_score
            - (12.0 if first.is_drum else 0.0)
        )
        summaries.append(
            StreamSummary(
                part_index=key[0],
                part_id=first.part_id,
                part_name=first.part_name,
                voice=key[1],
                staff=key[2],
                notes=len(stream_notes),
                start=start,
                end=end,
                median_midi=median_pitch,
                pitch_low=min(pitches),
                pitch_high=max(pitches),
                monophony=monophony,
                density=density,
                score=score,
            )
        )
    return sorted(summaries, key=lambda item: (-item.score, item.part_index, item.voice, item.staff))


def _selector_matches(note: ScoreNote, selector: str) -> bool:
    selector = selector.strip()
    if not selector:
        return False
    if selector.isdigit() and int(selector) == note.part_index:
        return True
    lowered = selector.casefold()
    return lowered == note.part_id.casefold() or lowered in note.part_name.casefold()


def select_stream(
    notes: Sequence[ScoreNote],
    selectors: Sequence[str] | None = None,
    voice: int | None = None,
    staff: int | None = None,
) -> tuple[list[ScoreNote], StreamSummary | None]:
    candidates = [note for note in notes if not note.is_drum]
    if selectors:
        candidates = [note for note in candidates if any(_selector_matches(note, value) for value in selectors)]
        if not candidates:
            raise ValueError(f"No part or track matched: {', '.join(selectors)}")
    if voice is not None:
        candidates = [note for note in candidates if note.voice == voice]
        if not candidates:
            raise ValueError(f"No notes found in voice {voice}")
    if staff is not None:
        candidates = [note for note in candidates if note.staff == staff]
        if not candidates:
            raise ValueError(f"No notes found on staff {staff}")

    if selectors or voice is not None or staff is not None:
        summaries = summarize_streams(candidates)
        return sorted(candidates, key=lambda note: (note.start, note.midi)), summaries[0] if summaries else None

    summaries = summarize_streams(candidates)
    if not summaries:
        raise ValueError("No non-drum score stream is available")
    selected = summaries[0]
    stream_notes = [
        note
        for note in candidates
        if note.stream_key == (selected.part_index, selected.voice, selected.staff)
    ]
    return sorted(stream_notes, key=lambda note: (note.start, note.midi)), selected


def extract_skyline(
    notes: Sequence[ScoreNote],
    onset_window: float = 0.025,
    min_midi: int = 36,
    max_midi: int = 96,
    min_duration: float = 0.035,
) -> list[ScoreNote]:
    """Reduce a possibly polyphonic stream to one playable melodic line."""
    _validate_score_notes(notes)
    onset_window = _finite_float(onset_window, "Onset window")
    min_duration = _finite_float(min_duration, "Minimum duration")
    if onset_window < 0:
        raise ValueError("Onset window must not be negative")
    if min_duration <= 0:
        raise ValueError("Minimum duration must be greater than zero")
    if min_midi > max_midi:
        raise ValueError("Minimum MIDI note must not exceed maximum MIDI note")
    filtered = [
        note
        for note in notes
        if min_midi <= note.midi <= max_midi and note.duration >= min_duration and not note.is_drum
    ]
    groups = _onset_groups(filtered, window=onset_window)
    melody: list[ScoreNote] = []
    for group in groups:
        onset = min(note.start for note in group)
        active = melody[-1] if melody else None
        highest = max(group, key=lambda note: (note.midi, note.velocity, note.duration))
        if active is not None and highest.midi < active.midi:
            overlap = active.end - onset
            # Notation commonly leaves a short legato overlap before a descending
            # melody note. Only suppress a lower onset under a meaningfully active note.
            overlap_grace = max(onset_window, min(0.1, active.duration * 0.2))
            if overlap > overlap_grace:
                continue

        if melody:
            previous = melody[-1]
            def candidate_score(note: ScoreNote) -> tuple[float, int, float]:
                leap = abs(note.midi - previous.midi)
                continuity = -0.045 * leap - (0.5 if leap > 12 else 0.0)
                top_bonus = 1.2 * (note.midi - min(item.midi for item in group)) / max(
                    1, max(item.midi for item in group) - min(item.midi for item in group)
                )
                return (top_bonus + continuity + note.velocity / 254.0, note.midi, note.duration)
            chosen = max(group, key=candidate_score)
        else:
            chosen = highest
        melody.append(chosen)

    deduplicated: list[ScoreNote] = []
    for note in melody:
        if deduplicated and abs(deduplicated[-1].start - note.start) < 0.005 and deduplicated[-1].midi == note.midi:
            if note.duration > deduplicated[-1].duration:
                deduplicated[-1] = note
            continue
        deduplicated.append(note)
    return deduplicated


def _normalize_columns(features: np.ndarray) -> np.ndarray:
    if not np.all(np.isfinite(features)):
        raise ValueError("Feature matrix contains non-finite values")
    norms = np.linalg.norm(features, axis=0, keepdims=True)
    return features / np.maximum(norms, 1e-8)


def score_features(notes: Sequence[ScoreNote], feature_rate: float, duration: float | None = None) -> np.ndarray:
    from scipy.ndimage import gaussian_filter1d

    if not notes:
        raise ValueError("Cannot build score features without notes")
    _validate_score_notes(notes)
    feature_rate = _finite_float(feature_rate, "Feature rate")
    if feature_rate <= 0:
        raise ValueError("Feature rate must be greater than zero")
    if duration is None:
        duration = max(note.end for note in notes)
    duration = _finite_float(duration, "Feature duration")
    if duration <= 0:
        raise ValueError("Feature duration must be greater than zero")
    frames = max(2, int(math.ceil(duration * feature_rate)) + 1)
    chroma = np.zeros((12, frames), dtype=np.float32)
    onset_chroma = np.zeros((12, frames), dtype=np.float32)
    onset = np.zeros(frames, dtype=np.float32)
    for note in notes:
        start_frame = max(0, min(frames - 1, int(round(note.start * feature_rate))))
        end_frame = max(start_frame + 1, min(frames, int(math.ceil(note.end * feature_rate))))
        weight = 0.35 + 0.65 * _clamp(note.velocity / 127.0, 0.0, 1.0)
        chroma[note.midi % 12, start_frame:end_frame] += weight
        onset_chroma[note.midi % 12, start_frame] += weight
        onset[start_frame] += weight
    chroma = gaussian_filter1d(chroma, sigma=0.65, axis=1)
    onset_chroma = gaussian_filter1d(onset_chroma, sigma=0.8, axis=1)
    onset = gaussian_filter1d(onset, sigma=0.8)
    onset /= max(float(np.max(onset)), 1e-8)
    return _normalize_columns(np.vstack([chroma, 0.55 * onset_chroma, 0.3 * onset[None, :]]))


def audio_features(path: Path, requested_rate: float) -> tuple[np.ndarray, np.ndarray, float, float]:
    import librosa
    from scipy.ndimage import gaussian_filter1d

    requested_rate = _finite_float(requested_rate, "Feature rate")
    if requested_rate <= 0:
        raise ValueError("Feature rate must be greater than zero")
    y, sample_rate = librosa.load(str(_require_file(path)), sr=22050, mono=True)
    if not len(y):
        raise ValueError(f"Audio contains no samples: {path}")
    hop_length = max(256, int(round(sample_rate / requested_rate / 256.0)) * 256)
    actual_rate = sample_rate / hop_length
    harmonic = librosa.effects.harmonic(y, margin=2.0)
    chroma = librosa.feature.chroma_cqt(
        y=harmonic,
        sr=sample_rate,
        hop_length=hop_length,
        bins_per_octave=36,
    ).astype(np.float32)
    onset_chroma = np.maximum(0.0, np.diff(chroma, axis=1, prepend=chroma[:, :1]))
    onset_chroma = gaussian_filter1d(onset_chroma, sigma=0.8, axis=1)
    onset = librosa.onset.onset_strength(y=y, sr=sample_rate, hop_length=hop_length).astype(np.float32)
    if onset.shape[0] < chroma.shape[1]:
        onset = np.pad(onset, (0, chroma.shape[1] - onset.shape[0]))
    onset = onset[: chroma.shape[1]]
    onset /= max(float(np.max(onset)), 1e-8)
    features = _normalize_columns(np.vstack([chroma, 0.55 * onset_chroma, 0.3 * onset[None, :]]))
    return features, chroma, actual_rate, len(y) / sample_rate


def _roll_score_features(features: np.ndarray, semitones: int) -> np.ndarray:
    rolled = features.copy()
    rolled[:12] = np.roll(features[:12], semitones, axis=0)
    rolled[12:24] = np.roll(features[12:24], semitones, axis=0)
    return rolled


def estimate_pitch_shift(score_feature_matrix: np.ndarray, audio_feature_matrix: np.ndarray) -> int:
    score_profile = np.mean(score_feature_matrix[:12], axis=1)
    audio_profile = np.mean(audio_feature_matrix[:12], axis=1)
    score_norm = max(float(np.linalg.norm(score_profile)), 1e-8)
    audio_norm = max(float(np.linalg.norm(audio_profile)), 1e-8)
    scores: list[tuple[float, int]] = []
    for signed_shift in range(-6, 6):
        shifted = np.roll(score_profile, signed_shift)
        similarity = float(np.dot(shifted, audio_profile) / (score_norm * audio_norm))
        scores.append((similarity, signed_shift))
    return max(scores, key=lambda item: (item[0], -abs(item[1])))[1]


def _collapse_warping_path(path: np.ndarray, feature_rate: float) -> tuple[np.ndarray, np.ndarray]:
    feature_rate = _finite_float(feature_rate, "Feature rate")
    if feature_rate <= 0:
        raise ValueError("Feature rate must be greater than zero")
    if path.ndim != 2 or path.shape[1] != 2 or not len(path):
        raise ValueError("DTW returned an invalid warping path")
    if not np.all(np.isfinite(path)):
        raise ValueError("DTW returned a non-finite warping path")
    ordered = path[::-1] if path[0, 0] > path[-1, 0] else path
    by_score_frame: dict[int, list[int]] = defaultdict(list)
    for score_frame, audio_frame in ordered:
        by_score_frame[int(score_frame)].append(int(audio_frame))
    score_frames = np.asarray(sorted(by_score_frame), dtype=float)
    audio_frames = np.asarray(
        [statistics.median(by_score_frame[int(frame)]) for frame in score_frames],
        dtype=float,
    )
    audio_frames = np.maximum.accumulate(audio_frames)
    return score_frames / feature_rate, audio_frames / feature_rate


def align_score_to_audio_librosa(
    notes: Sequence[ScoreNote],
    audio_path: Path,
    requested_rate: float = 10.0,
    transpose: str = "auto",
) -> AlignmentResult:
    import librosa

    audio_feature_matrix, chroma, feature_rate, audio_duration = audio_features(
        audio_path, requested_rate=requested_rate
    )
    score_duration = max(note.end for note in notes)
    score_feature_matrix = score_features(notes, feature_rate=feature_rate, duration=score_duration)
    if transpose == "auto":
        pitch_shift = estimate_pitch_shift(score_feature_matrix, audio_feature_matrix)
    else:
        pitch_shift = _parse_transpose(transpose)
        assert pitch_shift is not None
    shifted_score_features = _roll_score_features(score_feature_matrix, pitch_shift)

    accumulated_cost, warping_path = librosa.sequence.dtw(
        X=shifted_score_features,
        Y=audio_feature_matrix,
        metric="euclidean",
        subseq=True,
        backtrack=True,
    )
    score_times, aligned_audio_times = _collapse_warping_path(warping_path, feature_rate)
    endpoint_audio_frame = min(accumulated_cost.shape[1] - 1, int(round(aligned_audio_times[-1] * feature_rate)))
    normalized_cost = float(accumulated_cost[-1, endpoint_audio_frame] / max(1, len(warping_path)))
    return AlignmentResult(
        score_times=score_times,
        audio_times=aligned_audio_times,
        audio_chroma=chroma,
        feature_rate=feature_rate,
        pitch_shift=pitch_shift,
        normalized_cost=normalized_cost,
        score_duration=score_duration,
        audio_duration=audio_duration,
        aligner="librosa-dtw",
    )


def align_score_to_audio_synctoolbox(
    notes: Sequence[ScoreNote],
    audio_path: Path,
    feature_rate: int = 50,
    transpose: str = "auto",
) -> AlignmentResult:
    import librosa
    import pandas as pd
    from synctoolbox.dtw.mrmsdtw import sync_via_mrmsdtw
    from synctoolbox.dtw.utils import (
        compute_optimal_chroma_shift,
        make_path_strictly_monotonic,
        shift_chroma_vectors,
    )
    from synctoolbox.feature.chroma import pitch_to_chroma, quantize_chroma, quantized_chroma_to_CENS
    from synctoolbox.feature.csv_tools import df_to_pitch_features, df_to_pitch_onset_features
    from synctoolbox.feature.dlnco import pitch_onset_features_to_DLNCO
    from synctoolbox.feature.pitch import audio_to_pitch_features
    from synctoolbox.feature.pitch_onset import audio_to_pitch_onset_features
    from synctoolbox.feature.utils import estimate_tuning

    if feature_rate != 50:
        raise ValueError("Synctoolbox alignment requires --feature-rate 50")
    pitched_notes = [note for note in notes if not note.is_drum]
    if not pitched_notes:
        raise ValueError("Cannot align a score without pitched notes")

    audio_path = _require_file(audio_path)
    audio, sample_rate = librosa.load(str(audio_path), sr=22050, mono=True)
    if not len(audio):
        raise ValueError(f"Audio contains no samples: {audio_path}")
    audio_duration = len(audio) / sample_rate
    tuning_offset = estimate_tuning(audio, sample_rate)

    audio_pitch = audio_to_pitch_features(
        f_audio=audio,
        Fs=sample_rate,
        tuning_offset=tuning_offset,
        feature_rate=feature_rate,
        verbose=False,
    )
    audio_chroma = quantize_chroma(pitch_to_chroma(audio_pitch))
    audio_peaks = audio_to_pitch_onset_features(
        f_audio=audio,
        Fs=sample_rate,
        tuning_offset=tuning_offset,
        verbose=False,
    )
    audio_dlnco = pitch_onset_features_to_DLNCO(
        f_peaks=audio_peaks,
        feature_rate=feature_rate,
        feature_sequence_length=audio_chroma.shape[1],
        visualize=False,
    )

    annotation = pd.DataFrame(
        {
            "start": [note.start for note in pitched_notes],
            "duration": [note.duration for note in pitched_notes],
            "pitch": [note.midi for note in pitched_notes],
            "velocity": [note.velocity for note in pitched_notes],
            "instrument": [note.part_name or "pitched" for note in pitched_notes],
        }
    )
    score_pitch = df_to_pitch_features(
        annotation,
        feature_rate=feature_rate,
        ignore_percussion=True,
        visualize=False,
    )
    score_chroma = quantize_chroma(pitch_to_chroma(score_pitch))
    score_peaks = df_to_pitch_onset_features(
        annotation,
        ignore_percussion=True,
        visualize=False,
    )
    score_dlnco = pitch_onset_features_to_DLNCO(
        f_peaks=score_peaks,
        feature_rate=feature_rate,
        feature_sequence_length=score_chroma.shape[1],
        visualize=False,
    )

    if transpose == "auto":
        audio_cens = quantized_chroma_to_CENS(audio_chroma, 201, 50, feature_rate)[0]
        score_cens = quantized_chroma_to_CENS(score_chroma, 201, 50, feature_rate)[0]
        raw_shift = int(compute_optimal_chroma_shift(audio_cens, score_cens))
        pitch_shift = raw_shift if raw_shift <= 6 else raw_shift - 12
    else:
        pitch_shift = _parse_transpose(transpose)
        assert pitch_shift is not None

    score_chroma = shift_chroma_vectors(score_chroma, pitch_shift % 12)
    score_dlnco = shift_chroma_vectors(score_dlnco, pitch_shift % 12)
    warping_path = sync_via_mrmsdtw(
        f_chroma1=audio_chroma,
        f_onset1=audio_dlnco,
        f_chroma2=score_chroma,
        f_onset2=score_dlnco,
        input_feature_rate=feature_rate,
        step_weights=np.asarray([1.5, 1.5, 2.0]),
        threshold_rec=10**6,
        verbose=False,
    )
    warping_path = make_path_strictly_monotonic(warping_path)
    path_pairs = np.column_stack([warping_path[1], warping_path[0]])
    score_times, aligned_audio_times = _collapse_warping_path(path_pairs, feature_rate)

    audio_indices = np.clip(warping_path[0].astype(int), 0, audio_chroma.shape[1] - 1)
    score_indices = np.clip(warping_path[1].astype(int), 0, score_chroma.shape[1] - 1)
    path_costs = np.linalg.norm(audio_chroma[:, audio_indices] - score_chroma[:, score_indices], axis=0)
    return AlignmentResult(
        score_times=score_times,
        audio_times=aligned_audio_times,
        audio_chroma=audio_chroma,
        feature_rate=float(feature_rate),
        pitch_shift=pitch_shift,
        normalized_cost=float(np.mean(path_costs)),
        score_duration=max(note.end for note in pitched_notes),
        audio_duration=audio_duration,
        aligner="synctoolbox-mrmsdtw",
    )


def align_score_to_audio(
    notes: Sequence[ScoreNote],
    audio_path: Path,
    requested_rate: float = 50.0,
    transpose: str = "auto",
    aligner: str = "sync",
) -> AlignmentResult:
    requested_rate = _finite_float(requested_rate, "Feature rate")
    if requested_rate <= 0:
        raise ValueError("Feature rate must be greater than zero")
    if aligner == "sync":
        return align_score_to_audio_synctoolbox(
            notes,
            audio_path,
            feature_rate=int(requested_rate),
            transpose=transpose,
        )
    if aligner == "librosa":
        return align_score_to_audio_librosa(
            [note for note in notes if not note.is_drum],
            audio_path,
            requested_rate=requested_rate,
            transpose=transpose,
        )
    raise ValueError(f"Unknown aligner: {aligner}")


def _map_time(value: float, alignment: AlignmentResult) -> float:
    return float(
        np.interp(
            value,
            alignment.score_times,
            alignment.audio_times,
            left=alignment.audio_times[0] + value - alignment.score_times[0],
            right=alignment.audio_times[-1] + value - alignment.score_times[-1],
        )
    )


def notes_to_app_json(
    notes: Sequence[ScoreNote],
    alignment: AlignmentResult | None = None,
    offset: float = 0.0,
    time_scale: float = 1.0,
    transpose: int = 0,
) -> list[dict[str, float | int]]:
    _validate_score_notes(notes)
    offset = _finite_float(offset, "Offset")
    time_scale = _finite_float(time_scale, "Time scale")
    if time_scale <= 0:
        raise ValueError("Time scale must be greater than zero")
    output: list[dict[str, float | int]] = []
    if alignment is not None:
        pitch_shift = _parse_transpose(alignment.pitch_shift)
        assert pitch_shift is not None
        feature_rate = _finite_float(alignment.feature_rate, "Alignment feature rate")
        if feature_rate <= 0:
            raise ValueError("Alignment feature rate must be greater than zero")
        if (
            alignment.score_times.ndim != 1
            or alignment.audio_times.ndim != 1
            or not len(alignment.score_times)
            or len(alignment.score_times) != len(alignment.audio_times)
            or not np.all(np.isfinite(alignment.score_times))
            or not np.all(np.isfinite(alignment.audio_times))
        ):
            raise ValueError("Alignment contains an invalid or non-finite time map")
        if (
            alignment.audio_chroma.ndim != 2
            or alignment.audio_chroma.shape[0] < 12
            or alignment.audio_chroma.shape[1] == 0
            or not np.all(np.isfinite(alignment.audio_chroma))
        ):
            raise ValueError("Alignment contains invalid or non-finite chroma features")
        _finite_float(alignment.normalized_cost, "Alignment cost")
        _finite_float(alignment.score_duration, "Alignment score duration")
        _finite_float(alignment.audio_duration, "Alignment audio duration")
    else:
        pitch_shift = _parse_transpose(transpose)
        if pitch_shift is None:
            pitch_shift = 0
    for index, note in enumerate(sorted(notes, key=lambda item: (item.start, item.midi))):
        output_midi, _ = _fit_midi_to_app_range(note.midi + pitch_shift)
        mapped_start = _map_time(note.start, alignment) if alignment else note.start
        mapped_end = _map_time(note.end, alignment) if alignment else note.end
        mapped_start = mapped_start * time_scale + offset
        mapped_end = mapped_end * time_scale + offset
        if not math.isfinite(mapped_start) or not math.isfinite(mapped_end):
            raise ValueError(f"Score note {index} mapped to non-finite timing")
        if mapped_end <= 0:
            continue
        start = max(0.0, mapped_start)
        duration = max(0.04, mapped_end - start)
        confidence = 0.98
        if alignment is not None:
            frame = max(0, min(alignment.audio_chroma.shape[1] - 1, int(round(mapped_start * alignment.feature_rate))))
            column = alignment.audio_chroma[:, frame]
            peak = max(float(np.max(column)), 1e-8)
            pitch_presence = float(column[output_midi % 12] / peak)
            if not math.isfinite(pitch_presence):
                raise ValueError(f"Score note {index} produced non-finite alignment confidence")
            confidence = 0.72 + 0.27 * _clamp(pitch_presence, 0.0, 1.0)
        output.append(
            {
                "start": round(start, 3),
                "duration": round(duration, 3),
                "midi": output_midi,
                "confidence": round(confidence, 3),
                "strength": round(_clamp(note.velocity / 127.0, 0.25, 1.0), 3),
            }
        )
    return output


def load_melody_json(path: Path) -> list[dict[str, float | int]]:
    with _require_file(path).open("r", encoding="utf-8") as handle:
        value = json.load(handle, parse_constant=_reject_nonfinite_json_constant)
    if isinstance(value, dict):
        analysis = value.get("analysis")
        if "melody" not in value and isinstance(analysis, dict):
            value = analysis
        value = value.get("melody")
    if not isinstance(value, list):
        raise ValueError(
            f"Expected a melody array, melody object, or exported analysis object: {path}"
        )
    notes: list[dict[str, float | int]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"Melody item {index} is not an object")
        try:
            start = _finite_float(item["start"], f"Melody item {index} start")
            duration = _finite_float(item["duration"], f"Melody item {index} duration")
            midi_value = _finite_float(item["midi"], f"Melody item {index} MIDI")
            midi = int(round(midi_value))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Melody item {index} has invalid start/duration/midi") from exc
        if start < 0 or duration <= 0 or not 0 <= midi <= 127:
            raise ValueError(f"Melody item {index} is outside valid time or MIDI ranges")
        notes.append({"start": start, "duration": duration, "midi": midi})
    return sorted(notes, key=lambda item: (float(item["start"]), int(item["midi"])))


def compare_melodies(
    reference: Sequence[dict[str, float | int]],
    candidate: Sequence[dict[str, float | int]],
    tolerance: float = 0.25,
) -> dict[str, Any]:
    tolerance = _finite_float(tolerance, "Comparison tolerance")
    if tolerance <= 0:
        raise ValueError("Comparison tolerance must be greater than zero")
    for label, melody in (("Reference", reference), ("Candidate", candidate)):
        for index, item in enumerate(melody):
            if not isinstance(item, dict):
                raise ValueError(f"{label} melody item {index} is not an object")
            for field in ("start", "duration", "midi"):
                try:
                    _finite_float(item[field], f"{label} melody item {index} {field}")
                except KeyError as exc:
                    raise ValueError(f"{label} melody item {index} is missing {field}") from exc

    reference_count = len(reference)
    candidate_count = len(candidate)
    match_counts = [[0] * (candidate_count + 1) for _ in range(reference_count + 1)]
    onset_costs = [[0.0] * (candidate_count + 1) for _ in range(reference_count + 1)]
    actions = [bytearray(candidate_count) for _ in range(reference_count)]

    # Preserve chronology while maximizing onset coverage, then minimize total error.
    for reference_index in range(reference_count - 1, -1, -1):
        reference_start = float(reference[reference_index]["start"])
        for candidate_index in range(candidate_count - 1, -1, -1):
            candidate_start = float(candidate[candidate_index]["start"])
            delta = abs(reference_start - candidate_start)
            skip_reference = (
                match_counts[reference_index + 1][candidate_index],
                onset_costs[reference_index + 1][candidate_index],
                1 if reference_start <= candidate_start else 0,
                1,
            )
            skip_candidate = (
                match_counts[reference_index][candidate_index + 1],
                onset_costs[reference_index][candidate_index + 1],
                1 if candidate_start < reference_start else 0,
                2,
            )
            options = [skip_reference, skip_candidate]
            if delta <= tolerance:
                options.append(
                    (
                        1 + match_counts[reference_index + 1][candidate_index + 1],
                        delta + onset_costs[reference_index + 1][candidate_index + 1],
                        2,
                        3,
                    )
                )
            best = max(options, key=lambda item: (item[0], -item[1], item[2]))
            match_counts[reference_index][candidate_index] = best[0]
            onset_costs[reference_index][candidate_index] = best[1]
            actions[reference_index][candidate_index] = best[3]

    matched_pairs: list[tuple[int, int]] = []
    reference_index = 0
    candidate_index = 0
    while reference_index < reference_count and candidate_index < candidate_count:
        action = actions[reference_index][candidate_index]
        if action == 3:
            matched_pairs.append((reference_index, candidate_index))
            reference_index += 1
            candidate_index += 1
        elif action == 1:
            reference_index += 1
        else:
            candidate_index += 1

    matched_reference = {pair[0] for pair in matched_pairs}
    matched_candidate = {pair[1] for pair in matched_pairs}
    matches: list[dict[str, Any]] = []
    for reference_index, candidate_index in matched_pairs:
        ref = reference[reference_index]
        cand = candidate[candidate_index]
        pitch_delta = int(cand["midi"]) - int(ref["midi"])
        matches.append(
            {
                "referenceIndex": reference_index,
                "candidateIndex": candidate_index,
                "referenceStart": round(float(ref["start"]), 4),
                "candidateStart": round(float(cand["start"]), 4),
                "onsetDelta": round(float(cand["start"]) - float(ref["start"]), 4),
                "referenceMidi": int(ref["midi"]),
                "candidateMidi": int(cand["midi"]),
                "pitchDelta": pitch_delta,
                "classification": (
                    "exact"
                    if pitch_delta == 0
                    else "octave"
                    if pitch_delta % 12 == 0
                    else "wrong-pitch"
                ),
            }
        )

    onset_errors = [abs(float(item["onsetDelta"])) for item in matches]
    duration_errors = [
        abs(
            float(candidate[int(item["candidateIndex"])]["duration"])
            - float(reference[int(item["referenceIndex"])]["duration"])
        )
        for item in matches
    ]
    exact = sum(item["classification"] == "exact" for item in matches)
    octave = sum(item["classification"] == "octave" for item in matches)
    wrong_pitch = sum(item["classification"] == "wrong-pitch" for item in matches)
    matched_count = len(matches)
    return {
        "referenceNotes": reference_count,
        "candidateNotes": candidate_count,
        "matchedOnsets": matched_count,
        "coverage": round(matched_count / reference_count, 4) if reference_count else 0.0,
        "precision": round(matched_count / candidate_count, 4) if candidate_count else 0.0,
        "exactPitch": exact,
        "exactPitchRate": round(exact / matched_count, 4) if matched_count else 0.0,
        "octaveErrors": octave,
        "wrongPitch": wrong_pitch,
        "onsetMae": round(float(np.mean(onset_errors)), 4) if onset_errors else None,
        "onsetP95": round(float(np.percentile(onset_errors, 95)), 4) if onset_errors else None,
        "durationMae": round(float(np.mean(duration_errors)), 4) if duration_errors else None,
        "unmatchedReference": [index for index in range(reference_count) if index not in matched_reference],
        "unmatchedCandidate": [index for index in range(candidate_count) if index not in matched_candidate],
        "matches": matches,
    }


def _write_json(path: Path, value: Any) -> None:
    path = path.expanduser().resolve()
    serialized = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        handle.write(serialized)


def _reject_path_conflicts(**paths: Path | None) -> None:
    resolved: dict[Path, str] = {}
    for role, path in paths.items():
        if path is None:
            continue
        canonical = path.expanduser().resolve()
        previous_role = resolved.get(canonical)
        if previous_role is not None:
            raise ValueError(
                f"Path conflict: {previous_role} and {role} resolve to the same file: {canonical}"
            )
        resolved[canonical] = role


def _display_name(summary: StreamSummary) -> str:
    return f"{summary.part_index}:{summary.part_name} / voice {summary.voice} / staff {summary.staff}"


def command_inspect(args: argparse.Namespace) -> int:
    loaded = load_score(args.score, default_bpm=args.default_bpm, unfold=not args.no_unfold)
    summaries = summarize_streams(loaded.notes)
    if args.json:
        print(json.dumps([asdict(item) for item in summaries], ensure_ascii=False, indent=2))
        return 0
    print(f"Format: {loaded.source_format}; nominal tempo: {loaded.nominal_bpm:.2f} BPM")
    print("idx  voice staff notes  range   mono  notes/s  score  name")
    for item in summaries:
        print(
            f"{item.part_index:>3}  {item.voice:>5} {item.staff:>5} {item.notes:>5}  "
            f"{item.pitch_low:>3}-{item.pitch_high:<3} {item.monophony:>5.2f}  "
            f"{item.density:>7.2f} {item.score:>6.2f}  {item.part_name}"
        )
    if summaries:
        print(f"Auto selection: {_display_name(summaries[0])}")
    return 0


def _comparison_summary(report: dict[str, Any]) -> str:
    onset_mae = report["onsetMae"]
    onset_text = "n/a" if onset_mae is None else f"{onset_mae:.3f}s"
    return (
        f"coverage={report['coverage']:.1%}, precision={report['precision']:.1%}, "
        f"exact-pitch={report['exactPitchRate']:.1%}, octave-errors={report['octaveErrors']}, "
        f"onset-MAE={onset_text}"
    )


def command_convert(args: argparse.Namespace) -> int:
    _reject_path_conflicts(
        score=args.score,
        audio=args.audio,
        output=args.output,
        compare=args.compare,
        report=args.report,
    )
    loaded = load_score(args.score, default_bpm=args.default_bpm, unfold=not args.no_unfold)
    selectors = list(args.part or []) + list(args.track or [])
    stream_notes, selected = select_stream(
        loaded.notes,
        selectors=selectors,
        voice=args.voice,
        staff=args.staff,
    )
    melody_notes = extract_skyline(
        stream_notes,
        onset_window=args.onset_window,
        min_midi=args.min_midi,
        max_midi=args.max_midi,
        min_duration=args.min_duration,
    )
    if not melody_notes:
        raise ValueError("The selected stream produced no melody notes")

    alignment = None
    manual_transpose = 0
    if args.audio:
        alignment = align_score_to_audio(
            loaded.notes,
            args.audio,
            requested_rate=args.feature_rate,
            transpose=args.transpose,
            aligner=args.aligner,
        )
    elif args.transpose == "auto":
        manual_transpose = 0
    else:
        manual_transpose = _parse_transpose(args.transpose) or 0

    output = notes_to_app_json(
        melody_notes,
        alignment=alignment,
        offset=args.offset,
        time_scale=args.time_scale,
        transpose=manual_transpose,
    )
    pitch_shift = alignment.pitch_shift if alignment else manual_transpose
    octave_folded_notes = sum(
        _fit_midi_to_app_range(note.midi + pitch_shift)[1] != 0 for note in melody_notes
    )
    _write_json(args.output, output)

    report: dict[str, Any] = {
        "score": str(args.score.resolve()),
        "audio": str(args.audio.resolve()) if args.audio else None,
        "sourceFormat": loaded.source_format,
        "selectedStream": asdict(selected) if selected else None,
        "inputNotes": len(loaded.notes),
        "selectedNotes": len(stream_notes),
        "outputNotes": len(output),
        "octaveFoldedNotes": octave_folded_notes,
        "output": str(args.output.resolve()),
        "alignment": (
            {
                "pitchShift": alignment.pitch_shift,
                "aligner": alignment.aligner,
                "normalizedCost": round(alignment.normalized_cost, 5),
                "featureRate": round(alignment.feature_rate, 5),
                "scoreDuration": round(alignment.score_duration, 3),
                "audioDuration": round(alignment.audio_duration, 3),
                "mappedStart": round(float(alignment.audio_times[0]), 3),
                "mappedEnd": round(float(alignment.audio_times[-1]), 3),
            }
            if alignment
            else None
        ),
    }
    if args.compare:
        candidate = load_melody_json(args.compare)
        comparison = compare_melodies(output, candidate, tolerance=args.tolerance)
        report["comparison"] = comparison
        print(f"Comparison: {_comparison_summary(comparison)}")
    if args.report:
        _write_json(args.report, report)

    selected_text = _display_name(selected) if selected else "explicit combined selection"
    print(f"Selected {selected_text}")
    print(f"Wrote {len(output)} melody notes to {args.output.resolve()}")
    if octave_folded_notes:
        print(
            f"Folded {octave_folded_notes} transposed notes by octaves into app MIDI range "
            f"{APP_MIN_MIDI}..{APP_MAX_MIDI}"
        )
    if alignment:
        print(
            f"Aligned to audio at {alignment.feature_rate:.2f} fps; "
            f"pitch shift {alignment.pitch_shift:+d}; normalized cost {alignment.normalized_cost:.4f}"
        )
    return 0


def command_compare(args: argparse.Namespace) -> int:
    _reject_path_conflicts(
        reference=args.reference,
        candidate=args.candidate,
        report=args.report,
    )
    reference = load_melody_json(args.reference)
    candidate = load_melody_json(args.candidate)
    report = compare_melodies(reference, candidate, tolerance=args.tolerance)
    print(_comparison_summary(report))
    if args.report:
        _write_json(args.report, report)
        print(f"Wrote detailed comparison to {args.report.resolve()}")
    elif args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Parse MIDI/MusicXML, align it to audio, and compare melody JSON files."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="List score parts, voices, and staves")
    inspect_parser.add_argument("score", type=Path)
    inspect_parser.add_argument("--default-bpm", type=float, default=120.0)
    inspect_parser.add_argument("--no-unfold", action="store_true", help="Keep written repeats folded")
    inspect_parser.add_argument("--json", action="store_true", help="Print machine-readable output")
    inspect_parser.set_defaults(handler=command_inspect)

    convert_parser = subparsers.add_parser("convert", help="Create app melody JSON from a score")
    convert_parser.add_argument("score", type=Path)
    convert_parser.add_argument("-o", "--output", type=Path, required=True)
    convert_parser.add_argument("--audio", type=Path, help="Recording used only for timeline alignment")
    convert_parser.add_argument("--part", action="append", help="Part index, exact ID, or name fragment")
    convert_parser.add_argument("--track", action="append", help="Alias of --part for MIDI files")
    convert_parser.add_argument("--voice", type=int)
    convert_parser.add_argument("--staff", type=int)
    convert_parser.add_argument("--default-bpm", type=float, default=120.0)
    convert_parser.add_argument("--no-unfold", action="store_true", help="Keep written repeats folded")
    convert_parser.add_argument("--transpose", default="auto", help="auto or a signed semitone count")
    convert_parser.add_argument("--offset", type=float, default=0.0, help="Seconds added after alignment")
    convert_parser.add_argument("--time-scale", type=float, default=1.0)
    convert_parser.add_argument(
        "--aligner",
        choices=("sync", "librosa"),
        default="sync",
        help="sync uses Synctoolbox MrMsDTW; librosa is a lighter fallback",
    )
    convert_parser.add_argument("--feature-rate", type=float, default=50.0)
    convert_parser.add_argument("--onset-window", type=float, default=0.025)
    convert_parser.add_argument("--min-midi", type=int, default=36)
    convert_parser.add_argument("--max-midi", type=int, default=96)
    convert_parser.add_argument("--min-duration", type=float, default=0.035)
    convert_parser.add_argument("--compare", type=Path, help="Compare the result with existing melody JSON")
    convert_parser.add_argument("--tolerance", type=float, default=0.25)
    convert_parser.add_argument("--report", type=Path, help="Write conversion and comparison details")
    convert_parser.set_defaults(handler=command_convert)

    compare_parser = subparsers.add_parser("compare", help="Compare a score-derived JSON with another melody")
    compare_parser.add_argument("reference", type=Path, help="Authoritative score-derived melody JSON")
    compare_parser.add_argument("candidate", type=Path, help="Audio transcription or another candidate JSON")
    compare_parser.add_argument("--tolerance", type=float, default=0.25)
    compare_parser.add_argument("--report", type=Path)
    compare_parser.add_argument("--json", action="store_true")
    compare_parser.set_defaults(handler=command_compare)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    finite_options = (
        ("default_bpm", "--default-bpm"),
        ("time_scale", "--time-scale"),
        ("feature_rate", "--feature-rate"),
        ("offset", "--offset"),
        ("onset_window", "--onset-window"),
        ("min_duration", "--min-duration"),
        ("tolerance", "--tolerance"),
    )
    for attribute, option in finite_options:
        value = getattr(args, attribute, None)
        if value is not None and not math.isfinite(value):
            parser.error(f"{option} must be finite")
    if getattr(args, "default_bpm", 120.0) <= 0:
        parser.error("--default-bpm must be greater than zero")
    if getattr(args, "time_scale", 1.0) <= 0:
        parser.error("--time-scale must be greater than zero")
    if getattr(args, "feature_rate", 10.0) < 2:
        parser.error("--feature-rate must be at least 2")
    if getattr(args, "onset_window", 0.0) < 0:
        parser.error("--onset-window must not be negative")
    if getattr(args, "min_duration", 1.0) <= 0:
        parser.error("--min-duration must be greater than zero")
    if getattr(args, "tolerance", 1.0) <= 0:
        parser.error("--tolerance must be greater than zero")
    if hasattr(args, "min_midi") and args.min_midi > args.max_midi:
        parser.error("--min-midi must not exceed --max-midi")
    if hasattr(args, "transpose"):
        try:
            _parse_transpose(args.transpose)
        except ValueError as exc:
            parser.error(str(exc))
    try:
        return int(args.handler(args))
    except ModuleNotFoundError as exc:
        parser.exit(
            2,
            f"error: missing Python package {exc.name!r}; install scripts/requirements-score.txt\n",
        )
    except (ValueError, OSError) as exc:
        parser.exit(2, f"error: {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())

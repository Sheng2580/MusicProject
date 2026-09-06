#!/usr/bin/env python3
"""Build a clean monophonic melody chart from two vocal transcriptions.

The primary input is a pYIN-style JSON event list. A Basic Pitch CSV supplies
independent onset and note-off evidence. This is intentionally a post-process:
source separation and model inference remain replaceable upstream steps.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Mapping, Sequence


MIN_DURATION = 0.060
MATCH_MARGIN = 0.100
MIN_ONSET_SEPARATION = 0.060
MIN_ARTICULATION_SEPARATION = 0.090


AcousticMetrics = Mapping[str, float]
AcousticEvidence = Mapping[float, AcousticMetrics]
PitchMetrics = Mapping[str, float]
PitchEvidence = Mapping[float, PitchMetrics]


def _finite(value: object, field: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite")
    return result


def read_event_json(path: Path) -> list[dict[str, float | int]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError(f"{path}: expected a JSON array")
    notes: list[dict[str, float | int]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"{path}: event {index} is not an object")
        start = _finite(item.get("start"), "start")
        duration = _finite(item.get("duration"), "duration")
        midi_value = _finite(item.get("midi"), "midi")
        midi = int(round(midi_value))
        confidence = _finite(item.get("confidence", 0.5), "confidence")
        strength = _finite(item.get("strength", 0.5), "strength")
        if start < 0 or duration <= 0 or midi < 0 or midi > 127:
            raise ValueError(f"{path}: invalid event {index}")
        notes.append({
            "start": start,
            "end": start + duration,
            "midi": midi,
            "confidence": max(0.0, min(1.0, confidence)),
            "strength": max(0.0, min(1.0, strength)),
        })
    return sorted(notes, key=lambda note: (float(note["start"]), int(note["midi"])))


def read_basic_pitch_csv(path: Path) -> list[dict[str, float | int]]:
    notes: list[dict[str, float | int]] = []
    with path.open(encoding="utf-8", newline="") as handle:
        for index, row in enumerate(csv.DictReader(handle)):
            start = _finite(row.get("start_time_s"), "start_time_s")
            end = _finite(row.get("end_time_s"), "end_time_s")
            midi = int(round(_finite(row.get("pitch_midi"), "pitch_midi")))
            velocity = _finite(row.get("velocity", 64), "velocity")
            if start < 0 or end <= start or midi < 0 or midi > 127:
                raise ValueError(f"{path}: invalid row {index + 2}")
            notes.append({
                "start": start,
                "end": end,
                "midi": midi,
                "quality": max(0.0, min(1.0, velocity / 100.0)),
            })
    # Keep every model onset here. Adjacent chunks are coalesced separately for
    # pitch/duration support, while the raw boundaries remain available as
    # possible repeated attacks.
    return sorted(notes, key=lambda note: (float(note["start"]), int(note["midi"])))


def coalesce_basic_notes(notes: Iterable[dict[str, float | int]]) -> list[dict[str, float | int]]:
    """Build sustained pitch regions for matching without losing the raw input."""
    by_pitch: dict[int, list[dict[str, float | int]]] = defaultdict(list)
    for note in notes:
        by_pitch[int(note["midi"])].append(dict(note))
    result: list[dict[str, float | int]] = []
    for pitch_notes in by_pitch.values():
        pitch_notes.sort(key=lambda note: float(note["start"]))
        pitch_result: list[dict[str, float | int]] = []
        for note in pitch_notes:
            previous = pitch_result[-1] if pitch_result else None
            gap = float(note["start"]) - float(previous["end"]) if previous else math.inf
            if previous and gap <= 0.024:
                previous["end"] = max(float(previous["end"]), float(note["end"]))
                previous["quality"] = max(float(previous["quality"]), float(note["quality"]))
            else:
                pitch_result.append(note)
        result.extend(pitch_result)
    return sorted(result, key=lambda note: (float(note["start"]), int(note["midi"])))


def analyze_acoustic_articulations(
    path: Path,
    candidate_starts: Iterable[float],
) -> dict[float, dict[str, float]]:
    """Measure attack and amplitude-reset evidence around transcription onsets."""
    try:
        import librosa
        import numpy as np
    except ImportError as error:  # pragma: no cover - exercised by the CLI environment
        raise RuntimeError("--audio requires librosa and numpy") from error

    hop_length = 128
    audio, sample_rate = librosa.load(path, sr=22050, mono=True)
    harmonic = librosa.effects.harmonic(audio)
    broadband = librosa.onset.onset_strength(
        y=audio, sr=sample_rate, hop_length=hop_length,
    )
    harmonic_onset = librosa.onset.onset_strength(
        y=harmonic, sr=sample_rate, hop_length=hop_length,
    )
    rms_db = librosa.amplitude_to_db(
        librosa.feature.rms(y=audio, frame_length=1024, hop_length=hop_length)[0],
        ref=1.0,
    )
    frame_times = librosa.frames_to_time(
        np.arange(len(broadband)), sr=sample_rate, hop_length=hop_length,
    )

    def frame_count(seconds: float) -> int:
        return max(1, int(round(seconds * sample_rate / hop_length)))

    peak_radius = frame_count(0.070)
    local_radius = frame_count(0.500)
    rms_radius = frame_count(0.120)
    result: dict[float, dict[str, float]] = {}
    for start in sorted(set(float(value) for value in candidate_starts)):
        index = int(np.searchsorted(frame_times, start))
        index = max(1, min(index, len(broadband) - 1))
        peak_low = max(0, index - peak_radius)
        peak_high = min(len(broadband), index + peak_radius + 1)
        local_low = max(0, index - local_radius)
        local_high = min(len(broadband), index + local_radius + 1)
        broadband_peak = float(np.max(broadband[peak_low:peak_high]))
        harmonic_peak = float(np.max(harmonic_onset[peak_low:peak_high]))
        broadband_floor = float(np.median(broadband[local_low:local_high]))
        harmonic_floor = float(np.median(harmonic_onset[local_low:local_high]))

        pre_low = max(0, index - rms_radius)
        pre_high = max(pre_low + 1, index - 1)
        post_high = min(len(rms_db), index + rms_radius)
        pre_peak = float(np.max(rms_db[pre_low:pre_high]))
        pre_trough = float(np.min(rms_db[pre_low:pre_high]))
        post_peak = float(np.max(rms_db[index:post_high]))
        result[start] = {
            "broadband_peak": broadband_peak,
            "harmonic_peak": harmonic_peak,
            "broadband_ratio": broadband_peak / (broadband_floor + 0.001),
            "harmonic_ratio": harmonic_peak / (harmonic_floor + 0.001),
            "rms_rise_db": post_peak - pre_peak,
            "rms_reset_db": post_peak - pre_trough,
        }
    return result


def analyze_pitch_estimates(
    path: Path,
    notes: Sequence[dict[str, float | int]],
) -> dict[float, dict[str, float]]:
    """Estimate a stable local pitch with a tracker independent of Basic Pitch."""
    try:
        import librosa
        import numpy as np
    except ImportError as error:  # pragma: no cover - exercised by the CLI environment
        raise RuntimeError("--audio requires librosa and numpy") from error

    hop_length = 256
    audio, sample_rate = librosa.load(path, sr=22050, mono=True)
    harmonic = librosa.effects.harmonic(audio, margin=3.0)
    f0 = librosa.yin(
        harmonic,
        fmin=librosa.midi_to_hz(48),
        fmax=librosa.midi_to_hz(84),
        sr=sample_rate,
        frame_length=4096,
        hop_length=hop_length,
    )
    midi = librosa.hz_to_midi(f0)
    frame_times = librosa.frames_to_time(
        np.arange(len(midi)), sr=sample_rate, hop_length=hop_length,
    )
    result: dict[float, dict[str, float]] = {}
    for note in notes:
        start = float(note["start"])
        end = float(note["end"])
        low = start + min(0.015, (end - start) * 0.15)
        high = end - min(0.015, (end - start) * 0.15)
        values = midi[(frame_times >= low) & (frame_times <= high)]
        values = values[np.isfinite(values)]
        if not len(values):
            continue
        median = float(np.median(values))
        result[start] = {
            "median_midi": median,
            "mad_midi": float(np.median(np.abs(values - median))),
        }
    return result


def _overlap(left: dict[str, float | int], right: dict[str, float | int]) -> float:
    return max(0.0, min(float(left["end"]), float(right["end"]))
               - max(float(left["start"]), float(right["start"])))


def support_score(primary: dict[str, float | int], evidence: dict[str, float | int]) -> float:
    overlap = _overlap(primary, evidence)
    shorter = max(MIN_DURATION, min(
        float(primary["end"]) - float(primary["start"]),
        float(evidence["end"]) - float(evidence["start"]),
    ))
    onset_distance = abs(float(primary["start"]) - float(evidence["start"]))
    return (
        0.55 * min(1.0, overlap / shorter)
        + 0.30 * math.exp(-onset_distance / 0.065)
        + 0.15 * float(evidence["quality"])
    )


def best_pitch_support(
    note: dict[str, float | int],
    evidence_by_pitch: Mapping[int, Sequence[dict[str, float | int]]],
) -> tuple[dict[str, float | int] | None, float]:
    candidates = evidence_by_pitch.get(int(note["midi"]), [])
    eligible = [candidate for candidate in candidates
                if float(candidate["start"]) < float(note["end"]) + MATCH_MARGIN
                and float(candidate["end"]) > float(note["start"]) - MATCH_MARGIN]
    if not eligible:
        return None, 0.0
    best = max(eligible, key=lambda candidate: support_score(note, candidate))
    return best, support_score(note, best)


def has_articulation(
    start: float,
    midi: int,
    evidence_by_pitch: dict[int, list[dict[str, float | int]]],
) -> bool:
    return any(
        abs(float(note["start"]) - start) <= 0.055 and float(note["quality"]) >= 0.55
        for note in evidence_by_pitch.get(midi, [])
    )


def _acoustic_metrics_at(
    start: float,
    acoustic: AcousticEvidence | None,
) -> AcousticMetrics | None:
    if not acoustic:
        return None
    closest = min(acoustic, key=lambda value: abs(float(value) - start))
    if abs(float(closest) - start) > 0.015:
        return None
    return acoustic[closest]


def _pitch_metrics_at(
    start: float,
    estimates: PitchEvidence | None,
) -> PitchMetrics | None:
    if not estimates:
        return None
    closest = min(estimates, key=lambda value: abs(float(value) - start))
    if abs(float(closest) - start) > 0.015:
        return None
    return estimates[closest]


def _best_alternative_pitch(
    note: dict[str, float | int],
    evidence_by_pitch: Mapping[int, Sequence[dict[str, float | int]]],
) -> tuple[dict[str, float | int] | None, float, float]:
    _, same_support = best_pitch_support(note, evidence_by_pitch)
    alternatives: list[tuple[float, dict[str, float | int]]] = []
    midi = int(note["midi"])
    for candidate_midi in (midi - 12, midi - 1, midi + 1, midi + 12):
        candidate = dict(note)
        candidate["midi"] = candidate_midi
        match, score = best_pitch_support(candidate, evidence_by_pitch)
        if match is not None:
            alternatives.append((score, match))
    if not alternatives:
        return None, same_support, 0.0
    alternative_support, alternative = max(alternatives, key=lambda item: item[0])
    return alternative, same_support, alternative_support


def correct_pitch_from_consensus(
    note: dict[str, float | int],
    evidence_by_pitch: Mapping[int, Sequence[dict[str, float | int]]],
    pitch_estimates: PitchEvidence | None,
) -> tuple[dict[str, float | int], bool, int | None]:
    """Correct only BP disagreements confirmed by a stable independent YIN estimate."""
    alternative, same_support, alternative_support = _best_alternative_pitch(
        note, evidence_by_pitch,
    )
    if alternative is None or alternative_support <= same_support + 0.05:
        return note, False, None
    difference = int(alternative["midi"]) - int(note["midi"])
    metrics = _pitch_metrics_at(float(note["start"]), pitch_estimates)
    if metrics is None:
        return note, False, abs(difference)
    estimate = float(metrics.get("median_midi", math.nan))
    mad = float(metrics.get("mad_midi", math.inf))
    distance_to_alternative = abs(estimate - int(alternative["midi"]))
    quality = float(alternative["quality"])
    if abs(difference) == 12:
        accepted = (
            alternative_support >= 0.55
            and quality >= 0.75
            and mad <= 0.35
            and distance_to_alternative <= 0.65
        )
    else:
        accepted = (
            alternative_support >= 0.40
            and same_support <= 0.15
            and quality >= 0.80
            and float(note["end"]) - float(note["start"]) >= 0.140
            and mad <= 0.25
            and distance_to_alternative <= 0.20
        )
    if not accepted:
        return note, False, abs(difference)
    corrected = dict(note)
    corrected["midi"] = int(alternative["midi"])
    return corrected, True, abs(difference)


def _strong_articulation(metrics: AcousticMetrics | None, *, strict: bool = False) -> bool:
    if metrics is None:
        return False
    broadband_peak = float(metrics.get("broadband_peak", 0.0))
    harmonic_peak = float(metrics.get("harmonic_peak", 0.0))
    broadband_ratio = float(metrics.get("broadband_ratio", 0.0))
    harmonic_ratio = float(metrics.get("harmonic_ratio", 0.0))
    rms_rise = float(metrics.get("rms_rise_db", -math.inf))
    rms_reset = float(metrics.get("rms_reset_db", -math.inf))
    if strict:
        transient = (
            (broadband_peak >= 0.75 and broadband_ratio >= 2.7)
            or (harmonic_peak >= 0.60 and harmonic_ratio >= 2.7)
        )
        return transient and (rms_rise >= 3.5 or rms_reset >= 6.0)
    transient = (
        (broadband_peak >= 0.45 and broadband_ratio >= 2.1)
        or (harmonic_peak >= 0.38 and harmonic_ratio >= 2.05)
    )
    reset = rms_rise >= 2.0 or rms_reset >= 3.9
    # A consonant can create a clear dual-band attack without a measurable
    # amplitude dip, especially when two syllables are sung legato.
    dual_band_attack = (
        broadband_peak >= 0.65 and harmonic_peak >= 0.45
        and broadband_ratio >= 3.4 and harmonic_ratio >= 2.5
    )
    return transient and (reset or dual_band_attack)


def _near_any_start(start: float, notes: Sequence[dict[str, float | int]], margin: float) -> bool:
    return any(abs(float(note["start"]) - start) < margin for note in notes)


def split_articulated_repetitions(
    notes: Sequence[dict[str, float | int]],
    raw_evidence_by_pitch: Mapping[int, Sequence[dict[str, float | int]]],
    acoustic: AcousticEvidence | None,
) -> tuple[list[dict[str, float | int]], int, int]:
    """Split a stable pYIN pitch only where audio confirms a repeated attack."""
    if not acoustic:
        return [dict(note) for note in notes], 0, 0
    result: list[dict[str, float | int]] = []
    added = 0
    considered = 0
    for note in notes:
        note_start = float(note["start"])
        note_end = float(note["end"])
        boundaries: list[dict[str, float | int]] = []
        for candidate in raw_evidence_by_pitch.get(int(note["midi"]), []):
            start = float(candidate["start"])
            duration = float(candidate["end"]) - start
            if not (note_start + MIN_ARTICULATION_SEPARATION <= start
                    <= note_end - MIN_DURATION):
                continue
            if float(candidate["quality"]) < 0.65 or duration < 0.090:
                continue
            if _near_any_start(start, notes, MIN_ARTICULATION_SEPARATION):
                continue
            if boundaries and start - float(boundaries[-1]["start"]) < MIN_ARTICULATION_SEPARATION:
                continue
            considered += 1
            if _strong_articulation(_acoustic_metrics_at(start, acoustic)):
                boundaries.append(candidate)

        segment_start = note_start
        for boundary in boundaries:
            boundary_start = float(boundary["start"])
            segment = dict(note)
            segment["start"] = segment_start
            segment["end"] = max(segment_start + MIN_DURATION, boundary_start - 0.012)
            result.append(segment)
            segment_start = boundary_start
            added += 1
        final_segment = dict(note)
        final_segment["start"] = segment_start
        final_segment["end"] = note_end
        if boundaries:
            final_segment["confidence"] = max(
                float(final_segment["confidence"]),
                min(0.99, 0.50 + 0.45 * float(boundaries[-1]["quality"])),
            )
            final_segment["strength"] = max(
                float(final_segment["strength"]),
                float(boundaries[-1]["quality"]),
            )
        result.append(final_segment)
    return result, added, considered


def insert_evidence_only_notes(
    notes: Sequence[dict[str, float | int]],
    raw_evidence: Sequence[dict[str, float | int]],
    acoustic: AcousticEvidence | None,
    *,
    min_midi: int,
    max_midi: int,
) -> tuple[list[dict[str, float | int]], int, int]:
    """Recover short connecting notes that pYIN smoothed out of the melody."""
    if not acoustic or len(notes) < 2:
        return [dict(note) for note in notes], 0, 0

    eligible = [dict(note) for note in raw_evidence
                if min_midi <= int(note["midi"]) <= max_midi
                and float(note["quality"]) >= 0.75
                and float(note["end"]) - float(note["start"]) >= 0.120]
    eligible.sort(key=lambda note: float(note["start"]))
    groups: list[list[dict[str, float | int]]] = []
    for candidate in eligible:
        if not groups or float(candidate["start"]) - float(groups[-1][0]["start"]) > 0.065:
            groups.append([candidate])
        else:
            groups[-1].append(candidate)

    result = [dict(note) for note in notes]
    added = 0
    considered = 0
    for group in groups:
        group_start = min(float(candidate["start"]) for candidate in group)
        # A pYIN onset wins over simultaneous lower chord tones and harmonics.
        if _near_any_start(group_start, result, MIN_ARTICULATION_SEPARATION):
            continue
        following_index = next(
            (index for index, note in enumerate(result) if float(note["start"]) > group_start),
            len(result),
        )
        if following_index == 0 or following_index == len(result):
            continue
        previous = result[following_index - 1]
        following = result[following_index]
        previous_end = float(previous["end"])
        following_start = float(following["start"])
        if not (previous_end - 0.030 <= group_start <= previous_end + 0.080):
            continue
        if following_start - group_start < MIN_ARTICULATION_SEPARATION:
            continue

        viable: list[dict[str, float | int]] = []
        for candidate in group:
            start = float(candidate["start"])
            end = float(candidate["end"])
            midi = int(candidate["midi"])
            if end < following_start - 0.100 or end > following_start + 0.075:
                continue
            if max(abs(midi - int(previous["midi"])),
                   abs(midi - int(following["midi"]))) > 7:
                continue
            considered += 1
            if _strong_articulation(_acoustic_metrics_at(start, acoustic), strict=True):
                viable.append(candidate)
        if not viable:
            continue

        source = max(viable, key=lambda candidate: (
            4.0 * float(candidate["quality"])
            - 0.25 * (
                abs(int(candidate["midi"]) - int(previous["midi"]))
                + abs(int(candidate["midi"]) - int(following["midi"]))
            ),
            float(candidate["end"]) - float(candidate["start"]),
        ))
        end = min(float(source["end"]), following_start - 0.012)
        start = float(source["start"])
        if end - start < MIN_DURATION:
            continue
        quality = float(source["quality"])
        result.insert(following_index, {
            "start": start,
            "end": end,
            "midi": int(source["midi"]),
            "confidence": min(0.99, 0.55 + 0.42 * quality),
            "strength": quality,
            "support": quality,
        })
        added += 1
    return result, added, considered


def refine_vocal_notes(
    primary: Sequence[dict[str, float | int]],
    evidence: Sequence[dict[str, float | int]],
    *,
    min_midi: int = 48,
    max_midi: int = 84,
    acoustic: AcousticEvidence | None = None,
    pitch_estimates: PitchEvidence | None = None,
) -> tuple[list[dict[str, float | int]], dict[str, int]]:
    raw_evidence = sorted(
        (dict(note) for note in evidence),
        key=lambda note: (float(note["start"]), int(note["midi"])),
    )
    raw_evidence_by_pitch: dict[int, list[dict[str, float | int]]] = defaultdict(list)
    for note in raw_evidence:
        raw_evidence_by_pitch[int(note["midi"])].append(note)

    evidence_by_pitch: dict[int, list[dict[str, float | int]]] = defaultdict(list)
    for note in coalesce_basic_notes(raw_evidence):
        evidence_by_pitch[int(note["midi"])].append(note)

    kept: list[dict[str, float | int]] = []
    anchored_starts = 0
    anchored_ends = 0
    dropped = 0
    pitch_candidates = 0
    semitone_pitch_candidates = 0
    octave_pitch_candidates = 0
    pitch_corrections = 0
    semitone_corrections = 0
    octave_corrections = 0
    for source in primary:
        if not min_midi <= int(source["midi"]) <= max_midi:
            dropped += 1
            continue
        note = dict(source)
        note, pitch_corrected, pitch_difference = correct_pitch_from_consensus(
            note, raw_evidence_by_pitch, pitch_estimates,
        )
        match, support = best_pitch_support(note, evidence_by_pitch)
        duration = float(note["end"]) - float(note["start"])
        independently_clear = (
            support >= 0.25
            or float(note["confidence"]) >= 0.72
            or (duration >= 0.20 and float(note["confidence"]) >= 0.60
                and float(note["strength"]) >= 0.42)
        )
        if not independently_clear:
            dropped += 1
            continue

        if pitch_difference in (1, 12):
            pitch_candidates += 1
            semitone_pitch_candidates += int(pitch_difference == 1)
            octave_pitch_candidates += int(pitch_difference == 12)
        if pitch_corrected:
            pitch_corrections += 1
            semitone_corrections += int(pitch_difference == 1)
            octave_corrections += int(pitch_difference == 12)

        if match is not None:
            start_delta = float(match["start"]) - float(note["start"])
            end_delta = float(match["end"]) - float(note["end"])
            if abs(start_delta) <= 0.090:
                note["start"] = float(match["start"])
                anchored_starts += 1
            if abs(end_delta) <= 0.120:
                note["end"] = float(match["end"])
                anchored_ends += 1
            note["confidence"] = max(
                float(note["confidence"]), min(0.99, 0.46 + 0.50 * support)
            )
            note["strength"] = min(1.0, 0.78 * float(note["strength"])
                                   + 0.22 * float(match["quality"]))
        note["support"] = support
        kept.append(note)

    kept.sort(key=lambda note: (float(note["start"]), -float(note["strength"])))
    merged: list[dict[str, float | int]] = []
    merge_count = 0
    for note in kept:
        if merged:
            previous = merged[-1]
            gap = float(note["start"]) - float(previous["end"])
            same_pitch = int(note["midi"]) == int(previous["midi"])
            if (same_pitch and gap <= 0.055
                    and not has_articulation(
                        float(note["start"]), int(note["midi"]), raw_evidence_by_pitch,
                    )):
                previous["end"] = max(float(previous["end"]), float(note["end"]))
                previous["confidence"] = max(float(previous["confidence"]), float(note["confidence"]))
                previous["strength"] = max(float(previous["strength"]), float(note["strength"]))
                previous["support"] = max(float(previous["support"]), float(note["support"]))
                merge_count += 1
                continue
        merged.append(note)

    # Sub-frame pitch transitions around a semitone boundary are not playable
    # note attacks. Retain the better-supported side of each collision.
    separated: list[dict[str, float | int]] = []
    onset_collisions = 0
    for note in merged:
        if separated and float(note["start"]) - float(separated[-1]["start"]) < MIN_ONSET_SEPARATION:
            previous = separated[-1]
            previous_score = (2.0 * float(previous["support"])
                              + float(previous["confidence"]) + float(previous["strength"]))
            current_score = (2.0 * float(note["support"])
                             + float(note["confidence"]) + float(note["strength"]))
            if current_score > previous_score:
                separated[-1] = note
            onset_collisions += 1
            continue
        separated.append(note)
    merged = separated

    merged, articulations_added, articulation_candidates = split_articulated_repetitions(
        merged, raw_evidence_by_pitch, acoustic,
    )
    merged, evidence_notes_added, evidence_note_candidates = insert_evidence_only_notes(
        merged, raw_evidence, acoustic, min_midi=min_midi, max_midi=max_midi,
    )

    # Keep the line monophonic. For close pitch changes, sustain to the next
    # attack so the generated practice audio does not become a row of clicks.
    for index, note in enumerate(merged):
        if index + 1 < len(merged):
            following = merged[index + 1]
            next_start = float(following["start"])
            note["end"] = min(float(note["end"]), next_start - 0.012)
            gap = next_start - float(note["end"])
            if int(note["midi"]) != int(following["midi"]) and 0.0 < gap <= 0.120:
                note["end"] = next_start - 0.012
        note["end"] = max(float(note["start"]) + MIN_DURATION, float(note["end"]))

    return merged, {
        "primary": len(primary),
        "kept": len(merged),
        "dropped": dropped,
        "merged": merge_count,
        "onset_collisions": onset_collisions,
        "articulation_candidates": articulation_candidates,
        "articulations_added": articulations_added,
        "articulations_rejected": articulation_candidates - articulations_added,
        "evidence_note_candidates": evidence_note_candidates,
        "evidence_notes_added": evidence_notes_added,
        "evidence_notes_rejected": evidence_note_candidates - evidence_notes_added,
        "pitch_candidates": pitch_candidates,
        "semitone_pitch_candidates": semitone_pitch_candidates,
        "octave_pitch_candidates": octave_pitch_candidates,
        "pitch_corrections": pitch_corrections,
        "pitch_corrections_rejected": pitch_candidates - pitch_corrections,
        "semitone_corrections": semitone_corrections,
        "octave_corrections": octave_corrections,
        "anchored_starts": anchored_starts,
        "anchored_ends": anchored_ends,
    }


def extract_skyline_intro(
    evidence: Sequence[dict[str, float | int]],
    intro_end: float,
    *,
    min_midi: int = 65,
    max_midi: int = 84,
    minimum_quality: float = 0.45,
) -> list[dict[str, float | int]]:
    """Reduce a polyphonic instrumental intro to its articulated upper line."""
    candidates = [dict(note) for note in evidence
                  if float(note["start"]) < intro_end
                  and min_midi <= int(note["midi"]) <= max_midi
                  and float(note["quality"]) >= minimum_quality
                  and float(note["end"]) - float(note["start"]) >= 0.090]
    candidates.sort(key=lambda note: float(note["start"]))
    groups: list[list[dict[str, float | int]]] = []
    for note in candidates:
        if not groups or float(note["start"]) - float(groups[-1][0]["start"]) > 0.065:
            groups.append([note])
        else:
            groups[-1].append(note)

    result: list[dict[str, float | int]] = []
    for group in groups:
        # Chord tones share an onset in Basic Pitch. The upper voice is the
        # perceptually stable monophonic line used by the game chart.
        source = max(group, key=lambda note: (
            int(note["midi"]), float(note["quality"]),
            float(note["end"]) - float(note["start"]),
        ))
        note = {
            "start": float(source["start"]),
            "end": min(intro_end, float(source["end"])),
            "midi": int(source["midi"]),
            "confidence": float(source["quality"]),
            "strength": float(source["quality"]),
        }
        if (result and int(note["midi"]) == int(result[-1]["midi"])
                and float(note["start"]) <= float(result[-1]["end"]) + 0.060):
            result[-1]["end"] = max(float(result[-1]["end"]), float(note["end"]))
            result[-1]["confidence"] = max(float(result[-1]["confidence"]), float(note["confidence"]))
            result[-1]["strength"] = max(float(result[-1]["strength"]), float(note["strength"]))
        else:
            result.append(note)
    for left, right in zip(result, result[1:]):
        left["end"] = min(float(left["end"]), float(right["start"]) - 0.012)
        left["end"] = max(float(left["start"]) + MIN_DURATION, float(left["end"]))
    return result


def combine_intro(
    intro: Sequence[dict[str, float | int]],
    vocal: Sequence[dict[str, float | int]],
    intro_end: float,
) -> list[dict[str, float | int]]:
    selected_intro = [dict(note) for note in intro if float(note["start"]) < intro_end]
    result = selected_intro + [dict(note) for note in vocal if float(note["start"]) >= intro_end]
    result.sort(key=lambda note: (float(note["start"]), -float(note["strength"])))
    for left, right in zip(result, result[1:]):
        left["end"] = min(float(left["end"]), float(right["start"]) - 0.012)
        left["end"] = max(float(left["start"]) + MIN_DURATION, float(left["end"]))
    return result


def serializable(notes: Sequence[dict[str, float | int]]) -> list[dict[str, float | int]]:
    return [{
        "start": round(float(note["start"]), 3),
        "duration": round(float(note["end"]) - float(note["start"]), 3),
        "midi": int(note["midi"]),
        "confidence": round(float(note["confidence"]), 3),
        "strength": round(float(note["strength"]), 3),
    } for note in notes]


def diagnostics(notes: Sequence[dict[str, float | int]], stats: dict[str, int]) -> dict[str, float | int]:
    durations = [float(note["end"]) - float(note["start"]) for note in notes]
    return {
        **stats,
        "output_notes": len(notes),
        "sounding_seconds": round(sum(durations), 3),
        "median_duration": round(statistics.median(durations), 3),
        "shorter_than_150ms": sum(duration < 0.15 for duration in durations),
        "first_start": round(float(notes[0]["start"]), 3),
        "last_end": round(float(notes[-1]["end"]), 3),
        "midi_min": min(int(note["midi"]) for note in notes),
        "midi_max": max(int(note["midi"]) for note in notes),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--primary", type=Path, required=True, help="pYIN event JSON from a separated vocal stem")
    parser.add_argument("--evidence", type=Path, required=True, help="Basic Pitch CSV from the same vocal stem")
    parser.add_argument("--audio", type=Path, help="separated vocal audio used to verify repeated attacks")
    parser.add_argument("--intro", type=Path, help="existing mixed-audio chart used only before --intro-end")
    parser.add_argument("--intro-evidence", type=Path, help="Basic Pitch CSV of the full mix used to extract an upper-voice intro")
    parser.add_argument("--intro-end", type=float, default=0.0)
    parser.add_argument("--intro-min-midi", type=int, default=65)
    parser.add_argument("--min-midi", type=int, default=48)
    parser.add_argument("--max-midi", type=int, default=84)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.intro and args.intro_evidence:
        raise SystemExit("choose either --intro or --intro-evidence")
    if args.output in {args.primary, args.evidence, args.audio, args.intro, args.intro_evidence}:
        raise SystemExit("output must not overwrite an input")
    if args.intro_end < 0 or not math.isfinite(args.intro_end):
        raise SystemExit("intro-end must be a finite non-negative number")

    primary = read_event_json(args.primary)
    evidence = read_basic_pitch_csv(args.evidence)
    acoustic = None
    pitch_estimates = None
    if args.audio:
        acoustic = analyze_acoustic_articulations(
            args.audio, (float(note["start"]) for note in evidence),
        )
        pitch_estimates = analyze_pitch_estimates(args.audio, primary)
    refined, stats = refine_vocal_notes(
        primary, evidence, min_midi=args.min_midi, max_midi=args.max_midi,
        acoustic=acoustic, pitch_estimates=pitch_estimates,
    )
    intro: list[dict[str, float | int]] = []
    if args.intro_evidence:
        intro = extract_skyline_intro(
            coalesce_basic_notes(read_basic_pitch_csv(args.intro_evidence)), args.intro_end,
            min_midi=args.intro_min_midi, max_midi=args.max_midi,
        )
    elif args.intro:
        intro = read_event_json(args.intro)
    if intro:
        refined = combine_intro(intro, refined, args.intro_end)
    if not refined:
        raise SystemExit("refinement produced no notes")
    output = serializable(refined)
    args.output.write_text(json.dumps(output, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(diagnostics(refined, stats), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

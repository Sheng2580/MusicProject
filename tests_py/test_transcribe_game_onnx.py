from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from transcribe_game_onnx import (  # noqa: E402
    find_instrumental_gaps,
    normalize_notes,
    select_instrumental_lead,
)


def note(start: float, duration: float, midi: int) -> dict[str, float | int]:
    return {
        "start": start,
        "duration": duration,
        "midi": midi,
        "confidence": 0.9,
        "strength": 0.9,
    }


def test_normalize_trims_overlap_without_losing_repeated_attack() -> None:
    notes = normalize_notes([
        note(1.0, 0.7, 62),
        note(1.5, 0.4, 62),
        note(2.1, 0.4, 64),
    ], 3.0)

    assert len(notes) == 3
    assert notes[0]["duration"] == 0.5
    assert notes[1]["start"] == 1.5


def test_find_instrumental_gaps_ignores_short_phrase_breaths() -> None:
    assert find_instrumental_gaps([
        note(3.0, 1.0, 60),
        note(5.5, 1.0, 62),
        note(9.0, 1.0, 64),
    ], 13.0, 2.2) == [(0.0, 3.0), (6.5, 9.0), (10.0, 13.0)]


def test_gap_fallback_keeps_onsets_and_selects_upper_simultaneous_voice() -> None:
    events = [
        {"start": 2.10, "end": 2.50, "midi": 55, "velocity": 110},
        {"start": 2.11, "end": 2.60, "midi": 67, "velocity": 85},
        {"start": 2.30, "end": 2.70, "midi": 69, "velocity": 90},
        {"start": 2.50, "end": 2.90, "midi": 71, "velocity": 90},
    ]

    selected = select_instrumental_lead(events, (2.0, 3.0))

    assert [item["midi"] for item in selected] == [67, 69, 71]
    assert [item["start"] for item in selected] == [2.11, 2.3, 2.5]
    assert [item["duration"] for item in selected[:2]] == [0.19, 0.2]

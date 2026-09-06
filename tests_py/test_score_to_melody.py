from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pretty_midi
import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from score_to_melody import (  # noqa: E402
    ScoreNote,
    _collapse_warping_path,
    compare_melodies,
    extract_skyline,
    load_score,
    load_melody_json,
    main,
    notes_to_app_json,
    select_stream,
)


def note(start: float, duration: float, midi: int, name: str = "Piano") -> ScoreNote:
    return ScoreNote(
        start=start,
        duration=duration,
        midi=midi,
        velocity=90,
        part_index=0,
        part_id="P1",
        part_name=name,
        voice=1,
        staff=1,
    )


def test_named_vocal_track_wins_auto_selection(tmp_path: Path) -> None:
    midi = pretty_midi.PrettyMIDI(initial_tempo=120)
    accompaniment = pretty_midi.Instrument(program=0, name="Piano accompaniment")
    accompaniment.notes.extend(
        pretty_midi.Note(velocity=70, pitch=pitch, start=start, end=start + 0.45)
        for start in (0.0, 0.5, 1.0, 1.5)
        for pitch in (48, 52, 55)
    )
    vocal = pretty_midi.Instrument(program=53, name="Vocal Melody")
    vocal.notes.extend(
        pretty_midi.Note(velocity=100, pitch=pitch, start=index * 0.5, end=index * 0.5 + 0.4)
        for index, pitch in enumerate((67, 69, 71, 72))
    )
    midi.instruments.extend([accompaniment, vocal])
    midi_path = tmp_path / "parts.mid"
    midi.write(str(midi_path))

    loaded = load_score(midi_path)
    selected_notes, summary = select_stream(loaded.notes)

    assert summary is not None
    assert summary.part_name == "Vocal Melody"
    assert [item.midi for item in selected_notes] == [67, 69, 71, 72]


def test_musicxml_tempo_and_voice_are_preserved(tmp_path: Path) -> None:
    xml = """<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1"><measure number="1">
    <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time>
      <clef><sign>G</sign><line>2</line></clef></attributes>
    <direction><sound tempo="60"/></direction>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration>
      <voice>1</voice><type>quarter</type><staff>1</staff></note>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration>
      <voice>1</voice><type>quarter</type><staff>1</staff></note>
  </measure></part>
</score-partwise>
"""
    score_path = tmp_path / "tempo.musicxml"
    score_path.write_text(xml, encoding="utf-8")

    loaded = load_score(score_path)

    assert loaded.nominal_bpm == pytest.approx(60.0)
    assert [item.midi for item in loaded.notes] == [60, 62]
    assert [item.start for item in loaded.notes] == pytest.approx([0.0, 1.0])
    assert all(item.voice == 1 and item.staff == 1 for item in loaded.notes)


def test_skyline_ignores_lower_accompaniment_under_sustained_note() -> None:
    notes = [
        note(0.0, 1.0, 72),
        note(0.5, 0.25, 60),
        note(1.0, 0.5, 74),
    ]

    melody = extract_skyline(notes)

    assert [item.midi for item in melody] == [72, 74]


def test_skyline_keeps_descending_melody_after_short_legato_overlap() -> None:
    notes = [
        note(0.0, 0.56, 72),
        note(0.5, 0.4, 69),
        note(0.9, 0.4, 67),
    ]

    melody = extract_skyline(notes)

    assert [item.midi for item in melody] == [72, 69, 67]


def test_compare_classifies_exact_octave_and_wrong_pitch() -> None:
    reference = [
        {"start": 0.0, "duration": 0.4, "midi": 60},
        {"start": 1.0, "duration": 0.5, "midi": 62},
        {"start": 2.0, "duration": 0.5, "midi": 64},
        {"start": 3.0, "duration": 0.5, "midi": 65},
    ]
    candidate = [
        {"start": 0.03, "duration": 0.4, "midi": 60},
        {"start": 1.04, "duration": 0.5, "midi": 74},
        {"start": 2.08, "duration": 0.6, "midi": 63},
        {"start": 4.0, "duration": 0.3, "midi": 70},
    ]

    report = compare_melodies(reference, candidate, tolerance=0.15)

    assert report["matchedOnsets"] == 3
    assert report["exactPitch"] == 1
    assert report["octaveErrors"] == 1
    assert report["wrongPitch"] == 1
    assert report["coverage"] == 0.75
    assert report["precision"] == 0.75
    assert report["unmatchedReference"] == [3]
    assert report["unmatchedCandidate"] == [3]


def test_compare_matches_onsets_in_chronological_order() -> None:
    reference = [
        {"start": 0.0, "duration": 0.2, "midi": 60},
        {"start": 0.2, "duration": 0.2, "midi": 62},
    ]
    candidate = [
        {"start": 0.19, "duration": 0.2, "midi": 60},
        {"start": 0.21, "duration": 0.2, "midi": 62},
    ]

    report = compare_melodies(reference, candidate, tolerance=0.25)

    assert report["matchedOnsets"] == 2
    assert [
        (item["referenceIndex"], item["candidateIndex"])
        for item in report["matches"]
    ] == [(0, 0), (1, 1)]


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_melody_json_rejects_non_finite_numbers(tmp_path: Path, constant: str) -> None:
    melody_path = tmp_path / "invalid.json"
    melody_path.write_text(
        f'[{{"start": {constant}, "duration": 0.2, "midi": 60}}]',
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="non-finite|invalid"):
        load_melody_json(melody_path)


def test_melody_json_reads_exported_app_analysis(tmp_path: Path) -> None:
    melody_path = tmp_path / "exported-analysis.json"
    melody_path.write_text(
        json.dumps(
            {
                "version": 1,
                "title": "Test song",
                "analysis": {
                    "melody": [
                        {
                            "start": 1.25,
                            "duration": 0.4,
                            "midi": 67,
                            "confidence": 0.9,
                            "strength": 0.8,
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    assert load_melody_json(melody_path) == [
        {"start": 1.25, "duration": 0.4, "midi": 67}
    ]


@pytest.mark.parametrize("tolerance", [float("nan"), float("inf"), float("-inf")])
def test_compare_rejects_non_finite_tolerance(tolerance: float) -> None:
    melody = [{"start": 0.0, "duration": 0.2, "midi": 60}]

    with pytest.raises(ValueError, match="finite"):
        compare_melodies(melody, melody, tolerance=tolerance)


def test_app_json_rejects_non_finite_timing_options() -> None:
    with pytest.raises(ValueError, match="finite"):
        notes_to_app_json([note(0.0, 0.2, 60)], offset=float("nan"))
    with pytest.raises(ValueError, match="finite"):
        notes_to_app_json([note(0.0, 0.2, 60)], time_scale=float("inf"))


def test_transposed_notes_are_octave_folded_into_app_range() -> None:
    low = notes_to_app_json([note(0.0, 0.2, 36)], transpose=-24)
    high = notes_to_app_json([note(0.0, 0.2, 96)], transpose=24)

    assert low[0]["midi"] == 24
    assert high[0]["midi"] == 108


@pytest.mark.parametrize("collision", ["score", "compare", "report"])
def test_convert_rejects_path_collisions_without_overwriting(
    tmp_path: Path,
    collision: str,
) -> None:
    score_path = tmp_path / "score.mid"
    compare_path = tmp_path / "candidate.json"
    output_path = tmp_path / "output.json"
    report_path = tmp_path / "report.json"
    score_path.write_bytes(b"not overwritten")
    compare_path.write_text("[]\n", encoding="utf-8")

    if collision == "score":
        output_path = score_path
        watched_path = score_path
    elif collision == "compare":
        output_path = compare_path
        watched_path = compare_path
    else:
        report_path = output_path
        output_path.write_text("sentinel\n", encoding="utf-8")
        watched_path = output_path
    original = watched_path.read_bytes()

    arguments = ["convert", str(score_path), "--output", str(output_path)]
    if collision == "compare":
        arguments.extend(["--compare", str(compare_path)])
    if collision == "report":
        arguments.extend(["--report", str(report_path)])
    with pytest.raises(SystemExit) as exc_info:
        main(arguments)

    assert exc_info.value.code == 2
    assert watched_path.read_bytes() == original


def test_convert_reports_octave_folding(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    midi = pretty_midi.PrettyMIDI(initial_tempo=120)
    vocal = pretty_midi.Instrument(program=53, name="Vocal Melody")
    vocal.notes.append(pretty_midi.Note(velocity=100, pitch=96, start=0.0, end=0.4))
    midi.instruments.append(vocal)
    score_path = tmp_path / "high.mid"
    output_path = tmp_path / "melody.json"
    report_path = tmp_path / "report.json"
    midi.write(str(score_path))

    result = main(
        [
            "convert",
            str(score_path),
            "--output",
            str(output_path),
            "--transpose",
            "24",
            "--report",
            str(report_path),
        ]
    )

    assert result == 0
    assert json.loads(output_path.read_text(encoding="utf-8"))[0]["midi"] == 108
    assert json.loads(report_path.read_text(encoding="utf-8"))["octaveFoldedNotes"] == 1
    assert "Folded 1 transposed notes" in capsys.readouterr().out


def test_warping_path_becomes_monotonic_time_map() -> None:
    reversed_path = np.asarray([[2, 5], [2, 4], [1, 3], [0, 1]])

    score_times, audio_times = _collapse_warping_path(reversed_path, feature_rate=2.0)

    assert score_times.tolist() == [0.0, 0.5, 1.0]
    assert audio_times.tolist() == [0.5, 1.5, 2.25]
    assert np.all(np.diff(audio_times) >= 0)

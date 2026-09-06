from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from refine_vocal_melody import combine_intro, extract_skyline_intro, refine_vocal_notes, serializable


def event(start, end, midi, confidence=.9, strength=.8):
    return {"start": start, "end": end, "midi": midi, "confidence": confidence, "strength": strength}


def evidence(start, end, midi, quality=.9):
    return {"start": start, "end": end, "midi": midi, "quality": quality}


def attack(start, *, peak=.9, ratio=3.2, rise=3.0, reset=7.0):
    return {start: {
        "broadband_peak": peak,
        "harmonic_peak": peak,
        "broadband_ratio": ratio,
        "harmonic_ratio": ratio,
        "rms_rise_db": rise,
        "rms_reset_db": reset,
    }}


def test_anchors_boundaries_to_independent_transcription():
    notes, stats = refine_vocal_notes(
        [event(1.04, 1.47, 64)],
        [evidence(1.00, 1.50, 64)],
    )
    assert notes[0]["start"] == 1.00
    assert notes[0]["end"] == 1.50
    assert stats["anchored_starts"] == 1
    assert stats["anchored_ends"] == 1


def test_filters_weak_unsupported_noise_but_retains_clear_grace_note():
    notes, stats = refine_vocal_notes([
        event(1.0, 1.10, 60, confidence=.5, strength=.2),
        event(1.3, 1.39, 62, confidence=.9, strength=.7),
    ], [])
    assert [note["midi"] for note in notes] == [62]
    assert stats["dropped"] == 1


def test_merges_model_split_but_preserves_independently_detected_repetition():
    notes, stats = refine_vocal_notes([
        event(1.0, 1.20, 60),
        event(1.23, 1.50, 60),
        event(2.0, 2.20, 62),
        event(2.24, 2.50, 62),
    ], [
        evidence(1.0, 1.50, 60),
        evidence(2.0, 2.20, 62),
        evidence(2.24, 2.50, 62),
    ])
    assert [(note["start"], note["end"], note["midi"]) for note in notes] == [
        (1.0, 1.5, 60),
        (2.0, 2.2, 62),
        (2.24, 2.5, 62),
    ]
    assert stats["merged"] == 1


def test_splits_same_pitch_when_raw_boundary_has_acoustic_reset():
    notes, stats = refine_vocal_notes(
        [event(1.0, 1.8, 60)],
        [evidence(1.0, 1.30, 60), evidence(1.30, 1.8, 60)],
        acoustic=attack(1.30),
    )
    assert [note["start"] for note in notes] == [1.0, 1.30]
    assert stats["articulations_added"] == 1


def test_does_not_split_model_chunk_without_waveform_reset():
    notes, stats = refine_vocal_notes(
        [event(1.0, 1.8, 60)],
        [evidence(1.0, 1.30, 60), evidence(1.30, 1.8, 60)],
        acoustic=attack(1.30, ratio=2.2, rise=-1.0, reset=2.0),
    )
    assert [note["start"] for note in notes] == [1.0]
    assert stats["articulations_added"] == 0


def test_preserves_every_confirmed_attack_inside_a_long_note():
    acoustic = {}
    acoustic.update(attack(1.25))
    acoustic.update(attack(1.50))
    acoustic.update(attack(1.75))
    notes, stats = refine_vocal_notes(
        [event(1.0, 2.0, 60)],
        [
            evidence(1.0, 1.25, 60), evidence(1.25, 1.50, 60),
            evidence(1.50, 1.75, 60), evidence(1.75, 2.0, 60),
        ],
        acoustic=acoustic,
    )
    assert [note["start"] for note in notes] == [1.0, 1.25, 1.50, 1.75]
    assert stats["articulations_added"] == 3


def test_inserts_strong_connecting_note_and_rejects_simultaneous_harmonic():
    acoustic = {}
    acoustic.update(attack(1.30, peak=1.2, ratio=3.8, rise=5.0, reset=9.0))
    notes, stats = refine_vocal_notes(
        [event(1.0, 1.25, 60), event(1.65, 2.0, 64)],
        [
            evidence(1.0, 1.25, 60),
            evidence(1.30, 1.56, 62, .86),
            evidence(1.31, 1.56, 74, .97),
            evidence(1.65, 2.0, 64),
        ],
        acoustic=acoustic,
    )
    assert [note["midi"] for note in notes] == [60, 62, 64]
    assert stats["evidence_notes_added"] == 1


def test_primary_onset_wins_over_simultaneous_basic_pitch_harmonic():
    notes, stats = refine_vocal_notes(
        [event(1.0, 1.4, 60), event(1.7, 2.0, 62)],
        [
            evidence(1.0, 1.4, 60), evidence(1.01, 1.30, 72),
            evidence(1.7, 2.0, 62),
        ],
        acoustic=attack(1.01, peak=1.2, ratio=4.0, rise=5.0, reset=10.0),
    )
    assert [note["midi"] for note in notes] == [60, 62]
    assert stats["evidence_notes_added"] == 0


def test_corrects_pitch_only_when_basic_pitch_and_independent_yin_agree():
    notes, stats = refine_vocal_notes(
        [event(1.0, 1.4, 60), event(2.0, 2.4, 60)],
        [evidence(1.0, 1.4, 61, .95), evidence(2.0, 2.4, 72, .95)],
        pitch_estimates={
            1.0: {"median_midi": 61.05, "mad_midi": .05},
            2.0: {"median_midi": 60.02, "mad_midi": .05},
        },
    )
    assert [note["midi"] for note in notes] == [61, 60]
    assert stats["pitch_candidates"] == 2
    assert stats["pitch_corrections"] == 1
    assert stats["semitone_corrections"] == 1
    assert stats["octave_corrections"] == 0


def test_corrects_clear_octave_tracking_error():
    notes, stats = refine_vocal_notes(
        [event(1.0, 1.4, 56, confidence=.55)],
        [evidence(1.0, 1.4, 68, .9)],
        pitch_estimates={1.0: {"median_midi": 67.7, "mad_midi": .1}},
    )
    assert [note["midi"] for note in notes] == [68]
    assert stats["octave_corrections"] == 1


def test_combines_only_the_requested_intro_and_remains_monophonic():
    result = combine_intro(
        [event(.2, .8, 72), event(1.1, 1.4, 74)],
        [event(.9, 1.3, 60), event(1.4, 1.8, 62)],
        intro_end=.85,
    )
    assert [note["midi"] for note in result] == [72, 60, 62]
    assert all(left["end"] <= right["start"] for left, right in zip(result, result[1:]))
    assert serializable(result)[0]["duration"] == .6


def test_extracts_upper_voice_from_polyphonic_intro_and_merges_model_split():
    result = extract_skyline_intro([
        evidence(.1, .5, 60, .95),
        evidence(.1, .3, 72, .75),
        evidence(.31, .6, 72, .9),
        evidence(.7, 1.0, 67, .8),
    ], 1.1, min_midi=60)
    assert [(note["start"], note["end"], note["midi"]) for note in result] == [
        (.1, .6, 72),
        (.7, 1.0, 67),
    ]

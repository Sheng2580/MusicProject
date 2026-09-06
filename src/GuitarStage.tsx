import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { getChordFrets } from './lib/audioEngine';
import type { GuitarTechnique } from './lib/audioEngine';
import { PRACTICE_FLIGHT_SECONDS, PRACTICE_MISS_FADE_SECONDS, nearestPracticeCue, practiceCuesInFlightWindow } from './lib/performanceChart';
import type { PracticeCue, PracticeHit, StrumDirection } from './types';

const STRING_X = [350, 430, 510, 590, 670, 750];
const STRING_WIDTHS = [5.5, 4.7, 3.7, 2.8, 2.1, 1.6];
const STRING_NAMES = ['E₂', 'A₂', 'D₃', 'G₃', 'B₃', 'E₄'];
const STRING_KEY_LABELS = ['A', 'S', 'D', 'F', 'G', 'H'];
const STRING_TOP = -30;
const STRING_BOTTOM = 610;
const STRIKE_Y = 450;
const TRAVEL_PER_SECOND = (STRIKE_Y - STRING_TOP) / PRACTICE_FLIGHT_SECONDS;
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
type Point = { x: number; y: number };
type Attack = { time: number; velocity: number; position: number; duration: number; decay: number };

export interface PracticeSweepState {
  cues: PracticeCue[];
  getTime: () => number;
  isPlaying: () => boolean;
  getJudgedCueIds: () => ReadonlySet<string>;
  hits: PracticeHit[];
  revision: number;
}

export interface PracticeSweepTarget {
  cueId: string;
  stringIndex: number;
}

type Gesture = Point & {
  down: boolean;
  pointerId: number;
  time: number;
  armed: number;
  practiceTarget: PracticeSweepTarget | null;
  matchedPracticeCueId: string | null;
};

export function findPracticeSweepTarget(
  practice: PracticeSweepState | undefined,
  maximumDistance = .18,
): PracticeSweepTarget | null {
  if (!practice?.cues.length || !practice.isPlaying()
    || !Number.isFinite(maximumDistance) || maximumDistance < 0) return null;
  const time = practice.getTime();
  if (!Number.isFinite(time)) return null;
  const nearest = nearestPracticeCue(practice.cues, time, practice.getJudgedCueIds());
  if (!nearest || Math.abs(nearest.difference) > maximumDistance) return null;
  return { cueId: nearest.cue.id, stringIndex: nearest.cue.stringIndex };
}

export function dispatchPracticeSweepStrings(
  stringIndices: readonly number[],
  target: PracticeSweepTarget | null,
  matchedCueId: string | null,
  dispatch: (stringIndex: number, audible: boolean) => boolean,
): string | null {
  let matched = matchedCueId;
  for (const stringIndex of stringIndices) {
    const audible = target === null || (!matched && target.stringIndex === stringIndex);
    const dispatched = dispatch(stringIndex, audible);
    if (dispatched && audible && target) matched = target.cueId;
  }
  return matched;
}

interface Props {
  chord: string;
  technique: GuitarTechnique;
  onWake: () => void;
  onPluck: (index: number, velocity: number, direction: StrumDirection, position: number) => void;
  onMute: () => void;
  strumEvent: { at: number; direction: StrumDirection } | null;
  stringEvent: { at: number; index: number } | null;
  practice?: PracticeSweepState;
}

function GuitarStage({ chord, technique, onWake, onPluck, onMute, strumEvent, stringEvent, practice }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cursorRef = useRef<SVGGElement>(null);
  const stringGroups = useRef<(SVGGElement | null)[]>([]);
  const rippleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const glintRefs = useRef<(SVGCircleElement | null)[]>([]);
  const hoverRefs = useRef<(SVGRectElement | null)[]>([]);
  const receptorPulseRefs = useRef<(SVGCircleElement | null)[]>([]);
  const cueRefs = useRef(new Map<string, SVGGElement>());
  const keyHintsRef = useRef<SVGGElement>(null);
  const hitRef = useRef<SVGGElement>(null);
  const hitRingRef = useRef<SVGCircleElement>(null);
  const hitSparksRef = useRef<SVGGElement>(null);
  const attacks = useRef<Attack[]>(STRING_X.map(() => ({ time: -10000, velocity: 0, position: STRIKE_Y, duration: 1.6, decay: 4.2 })));
  const pointer = useRef<Point | null>(null);
  const pull = useRef<{ index: number; y: number; delta: number } | null>(null);
  const gesture = useRef<Gesture>({
    down: false, pointerId: -1, x: 0, y: 0, time: 0, armed: -1,
    practiceTarget: null, matchedPracticeCueId: null,
  });
  const lastPlucked = useRef(STRING_X.map(() => -10000));
  const inverseMatrix = useRef<DOMMatrix | null>(null);
  const layoutScale = useRef(1);
  const [renderedCues, setRenderedCues] = useState<PracticeCue[]>([]);
  const shape = getChordFrets(chord);
  const settings = useRef({ technique, shape, practice });
  settings.current = { technique, shape, practice };

  // All moving elements share one animation clock. Pointer events only change refs.
  useEffect(() => {
    let frame = 0;
    const paths = stringGroups.current.map(group => Array.from(group?.querySelectorAll<SVGPathElement>('[data-string-path]') ?? []));
    const lastPaths = STRING_X.map(() => '');
    const lastHighlights = STRING_X.map(() => -1);
    const lastRippleLife = STRING_X.map(() => -1);
    const cueTransforms = new Map<string, string>();
    const cueOpacities = new Map<string, string>();
    const cueClasses = new Map<string, string>();
    const consumedCueIds = new Set<string>();
    const pendingHitCues = new Map<string, boolean>();
    const processedHitEvents = new Set<string>();
    let renderedCueValues: PracticeCue[] = [];
    let lastCueArray: PracticeCue[] | undefined;
    let lastTrackTime = 0;
    let lastPracticeRevision = practice?.revision ?? 0;
    let burstAt = -10000;
    let burstX = STRING_X[0];
    let burstPerfect = false;
    let burstString = -1;
    let cursorVisible = false;
    let cursorTransform = '';
    let previousBurstLife = -1;
    let keyHintsVisible = true;

    const refreshMatrix = () => {
      const matrix = svgRef.current?.getScreenCTM();
      inverseMatrix.current = matrix ? matrix.inverse() : null;
      layoutScale.current = window.matchMedia('(max-width: 650px)').matches ? .55 : 1;
    };
    const observer = new ResizeObserver(refreshMatrix);
    if (svgRef.current) observer.observe(svgRef.current);
    refreshMatrix();
    window.addEventListener('scroll', refreshMatrix, true);
    window.addEventListener('resize', refreshMatrix);

    const syncRenderedCues = (cues: PracticeCue[]) => {
      const ids = cues.map(cue => cue.id);
      if (cues.length === renderedCueValues.length && cues.every((cue, index) => cue === renderedCueValues[index])) return;
      const activeIds = new Set(ids);
      for (const { id } of renderedCueValues) {
        if (activeIds.has(id)) continue;
        cueTransforms.delete(id);
        cueOpacities.delete(id);
        cueClasses.delete(id);
      }
      renderedCueValues = cues;
      setRenderedCues(cues);
    };

    const animate = (now: number) => {
      const p = pointer.current;
      const held = pull.current;
      const cursor = cursorRef.current;
      if (cursor && Boolean(p) !== cursorVisible) {
        cursor.style.visibility = p ? 'visible' : 'hidden';
        if (svgRef.current) svgRef.current.style.cursor = p ? 'none' : 'default';
        cursorVisible = Boolean(p);
      }
      if (cursor && p) {
        const transform = `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) rotate(-24)`;
        if (transform !== cursorTransform) { cursor.setAttribute('transform', transform); cursorTransform = transform; }
      }

      STRING_X.forEach((x, index) => {
        const attack = attacks.current[index];
        const elapsed = (now - attack.time) / 1000;
        const ringing = elapsed >= 0 && elapsed < attack.duration;
        const amplitude = ringing ? attack.velocity * (15 - index * 1.1) * Math.exp(-elapsed * attack.decay) : 0;
        const isHeld = held?.index === index;
        const y = clamp(isHeld ? held.y : attack.position, STRING_TOP + 12, STRING_BOTTOM - 12);
        const displacement = isHeld ? held.delta : amplitude * Math.sin(elapsed * (58 + index * 11));
        const d = Math.abs(displacement) < .025
          ? `M ${x} ${STRING_TOP} V ${STRING_BOTTOM}`
          : `M ${x} ${STRING_TOP} Q ${x} ${(STRING_TOP + y) / 2} ${x + displacement} ${y} Q ${x} ${(y + STRING_BOTTOM) / 2} ${x} ${STRING_BOTTOM}`;
        if (d !== lastPaths[index]) {
          paths[index].forEach(path => path.setAttribute('d', d));
          lastPaths[index] = d;
        }
        const hover = Boolean(p && Math.abs(p.x - x) < 25);
        const highlight = isHeld ? .9 : amplitude > .7 ? clamp(amplitude / 16, .07, .7) : hover ? .34 : 0;
        if (highlight !== lastHighlights[index]) {
          hoverRefs.current[index]?.setAttribute('opacity', highlight.toFixed(3));
          lastHighlights[index] = highlight;
        }
        const life = elapsed >= 0 && elapsed < .28 ? elapsed / .28 : 1;
        if (life !== lastRippleLife[index]) {
          const opacity = life < 1 ? (1 - life) ** 2 : 0;
          const ripple = rippleRefs.current[index];
          const glint = glintRefs.current[index];
          if (ripple && glint) {
            ripple.setAttribute('cy', String(attack.position));
            ripple.setAttribute('r', (4 + life * 27).toFixed(2));
            ripple.setAttribute('opacity', (opacity * .65).toFixed(3));
            glint.setAttribute('cy', String(attack.position));
            glint.setAttribute('r', (2.8 + life * 1.5).toFixed(2));
            glint.setAttribute('opacity', (opacity * .8).toFixed(3));
          }
          lastRippleLife[index] = life;
        }
      });

      const exercise = settings.current.practice;
      const playing = exercise?.isPlaying() ?? false;
      if (playing === keyHintsVisible) {
        if (keyHintsRef.current) keyHintsRef.current.style.opacity = playing ? '0' : '.62';
        keyHintsVisible = !playing;
      }
      const trackTime = exercise?.getTime() ?? 0;
      const cuesChanged = exercise?.cues !== lastCueArray;
      const revisionChanged = (exercise?.revision ?? 0) !== lastPracticeRevision;
      if (cuesChanged || revisionChanged || trackTime < lastTrackTime - .08) {
        consumedCueIds.clear();
        pendingHitCues.clear();
        processedHitEvents.clear();
        burstAt = -10000;
        lastCueArray = exercise?.cues;
        lastPracticeRevision = exercise?.revision ?? 0;
        if (!playing) syncRenderedCues([]);
      }
      lastTrackTime = trackTime;
      for (const hit of exercise?.hits ?? []) {
        const eventId = `${hit.cueId}-${hit.at}`;
        if (processedHitEvents.has(eventId)) continue;
        processedHitEvents.add(eventId);
        const cue = exercise?.cues.find(candidate => candidate.id === hit.cueId);
        if (cue && cue.stringIndex >= 0 && cue.stringIndex < STRING_X.length) {
          if (cue.time <= trackTime) {
            consumedCueIds.add(cue.id);
            cueRefs.current.get(cue.id)?.setAttribute('opacity', '0');
          } else {
            // Keep an early hit on the track until its scheduled attack.
            pendingHitCues.set(cue.id, hit.perfect);
          }
          burstAt = now;
          burstX = STRING_X[cue.stringIndex];
          burstString = cue.stringIndex;
          burstPerfect = hit.perfect;
          previousBurstLife = -1;
        }
      }
      if (exercise && playing) {
        for (const cueId of pendingHitCues.keys()) {
          const cue = exercise.cues.find(candidate => candidate.id === cueId);
          if (!cue) { pendingHitCues.delete(cueId); continue; }
          if (cue.time > trackTime) continue;
          pendingHitCues.delete(cueId);
          consumedCueIds.add(cue.id);
        }
        // Keep every chart attack, but consume a successfully played cue at
        // its scored time. The receptor burst below carries hit feedback.
        const visible = practiceCuesInFlightWindow(exercise.cues, trackTime, consumedCueIds);
        syncRenderedCues(visible);

        for (const cue of visible) {
          const group = cueRefs.current.get(cue.id);
          if (!group) continue;
          const ahead = cue.time - trackTime;
          const y = STRIKE_Y - ahead * TRAVEL_PER_SECOND;
          const entering = clamp((PRACTICE_FLIGHT_SECONDS - ahead) / .18, 0, 1);
          const missed = ahead < 0 ? clamp(1 + ahead / PRACTICE_MISS_FADE_SECONDS, 0, 1) : 1;
          const transform = `translate(${STRING_X[cue.stringIndex]} ${y.toFixed(2)})`;
          const alpha = (entering * missed).toFixed(3);
          const pendingPerfect = pendingHitCues.get(cue.id);
          const cueClass = `beat-cue note${pendingPerfect === undefined ? '' : ` resolving${pendingPerfect ? ' perfect' : ''}`}`;
          if (transform !== cueTransforms.get(cue.id)) { group.setAttribute('transform', transform); cueTransforms.set(cue.id, transform); }
          if (alpha !== cueOpacities.get(cue.id)) { group.setAttribute('opacity', alpha); cueOpacities.set(cue.id, alpha); }
          if (cueClass !== cueClasses.get(cue.id)) { group.setAttribute('class', cueClass); cueClasses.set(cue.id, cueClass); }
        }
      } else {
        syncRenderedCues([]);
      }
      if (hitRef.current && hitRingRef.current && hitSparksRef.current) {
        const life = clamp((now - burstAt) / (burstPerfect ? 440 : 290), 0, 1);
        if (life !== previousBurstLife) {
          hitRef.current.setAttribute('transform', `translate(${burstX} ${STRIKE_Y})`);
          hitRef.current.setAttribute('opacity', ((1 - life) ** 1.5).toFixed(3));
          hitRingRef.current.setAttribute('r', String(11 + life * (burstPerfect ? 38 : 23)));
          hitSparksRef.current.setAttribute('transform', `scale(${.55 + life * 1.5})`);
          hitSparksRef.current.setAttribute('opacity', burstPerfect ? '1' : '0');
          receptorPulseRefs.current.forEach((pulse, index) => {
            if (!pulse) return;
            const selected = index === burstString && life < 1;
            pulse.setAttribute('r', (8 + life * (burstPerfect ? 31 : 23)).toFixed(2));
            pulse.setAttribute('opacity', selected ? ((1 - life) ** 1.65 * (burstPerfect ? .92 : .68)).toFixed(3) : '0');
          });
          previousBurstLife = life;
        }
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', refreshMatrix, true);
      window.removeEventListener('resize', refreshMatrix);
    };
  }, []);

  useEffect(() => {
    if (!strumEvent) return;
    const now = performance.now();
    STRING_X.forEach((_, i) => {
      if (settings.current.shape[i] < 0) return;
      attacks.current[i] = {
        time: now + (strumEvent.direction === 'down' ? i : 5 - i) * 16,
        velocity: .75, position: STRIKE_Y,
        duration: settings.current.technique === 'muted' ? .55 : 1.6,
        decay: settings.current.technique === 'muted' ? 12 : 4.2,
      };
    });
  }, [strumEvent]);

  useEffect(() => {
    if (!stringEvent || stringEvent.index < 0 || stringEvent.index >= STRING_X.length) return;
    const melodyPractice = Boolean(settings.current.practice?.cues.length);
    const silent = !melodyPractice && settings.current.shape[stringEvent.index] < 0;
    attacks.current[stringEvent.index] = {
      time: performance.now(), velocity: silent ? .13 : .72, position: STRIKE_Y,
      duration: silent ? .16 : settings.current.technique === 'muted' ? .55 : 1.6,
      decay: silent ? 20 : settings.current.technique === 'muted' ? 12 : 4.2,
    };
  }, [stringEvent]);

  const refreshMatrix = () => {
    const matrix = svgRef.current?.getScreenCTM();
    inverseMatrix.current = matrix ? matrix.inverse() : null;
    layoutScale.current = window.matchMedia('(max-width: 650px)').matches ? .55 : 1;
  };
  const point = (event: PointerEvent<SVGSVGElement>): Point => {
    if (!inverseMatrix.current) refreshMatrix();
    const matrix = inverseMatrix.current;
    if (!matrix) return { x: 550, y: 275 };
    const visualX = matrix.a * event.clientX + matrix.c * event.clientY + matrix.e;
    const scale = layoutScale.current;
    return {
      x: 550 + (visualX - 550) / scale,
      y: matrix.b * event.clientX + matrix.d * event.clientY + matrix.f,
    };
  };
  const inRange = (p: Point) => p.x >= STRING_X[0] - 45 && p.x <= STRING_X[5] + 45 && p.y >= STRING_TOP && p.y <= STRING_BOTTOM;

  const pluck = (index: number, velocity: number, direction: StrumDirection, y: number, audible = true): boolean => {
    const now = performance.now();
    if (now - lastPlucked.current[index] < 38) return false;
    lastPlucked.current[index] = now;
    const melodyPractice = Boolean(settings.current.practice?.cues.length);
    const silent = !melodyPractice && settings.current.shape[index] < 0;
    attacks.current[index] = {
      time: now, velocity: silent ? .13 : velocity,
      position: clamp(y, STRING_TOP + 7, STRING_BOTTOM - 7),
      duration: silent ? .16 : technique === 'muted' ? .55 : 1.6,
      decay: silent ? 20 : technique === 'muted' ? 12 : 4.2,
    };
    if (audible) onPluck(index, velocity, direction, clamp((y - STRING_TOP) / (STRING_BOTTOM - STRING_TOP), 0, 1));
    return true;
  };

  const resetGesture = (hidePointer = false) => {
    const id = gesture.current.pointerId;
    gesture.current.down = false;
    gesture.current.armed = -1;
    gesture.current.pointerId = -1;
    gesture.current.practiceTarget = null;
    gesture.current.matchedPracticeCueId = null;
    pull.current = null;
    if (hidePointer) pointer.current = null;
    if (id >= 0 && svgRef.current?.hasPointerCapture(id)) svgRef.current.releasePointerCapture(id);
  };
  const mute = () => {
    resetGesture();
    onMute();
    attacks.current.forEach(attack => { attack.time = -10000; });
  };
  const cancel = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerId === gesture.current.pointerId) resetGesture(true);
  };
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button === 2) { event.preventDefault(); mute(); return; }
    if (event.button !== 0 || gesture.current.down) return;
    refreshMatrix();
    const p = point(event);
    if (!inRange(p)) return;
    event.preventDefault();
    onWake();
    event.currentTarget.setPointerCapture(event.pointerId);
    const nearest = STRING_X.reduce((best, x, i) => Math.abs(p.x - x) < Math.abs(p.x - STRING_X[best]) ? i : best, 0);
    const armed = Math.abs(STRING_X[nearest] - p.x) <= 24 ? nearest : -1;
    gesture.current = {
      down: true, pointerId: event.pointerId, ...p, time: performance.now(), armed,
      practiceTarget: findPracticeSweepTarget(settings.current.practice),
      matchedPracticeCueId: null,
    };
    pointer.current = p;
    pull.current = armed >= 0 ? { index: armed, y: p.y, delta: p.x - STRING_X[armed] } : null;
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (g.down && event.pointerId !== g.pointerId) return;
    const p = point(event);
    pointer.current = inRange(p) ? p : null;
    if (!g.down) return;
    if (!(event.buttons & 1)) { cancel(event); return; }
    if (event.buttons & 2) { mute(); return; }
    const now = performance.now();
    const speed = Math.abs(p.x - g.x) / Math.max(5, now - g.time);
    const direction = p.x >= g.x ? 'down' : 'up';
    const velocity = clamp(.23 + speed * .22, .2, 1);
    let released = -1;
    if (g.armed >= 0) {
      const delta = p.x - STRING_X[g.armed];
      if (Math.abs(delta) <= 32 && p.y >= STRING_TOP && p.y <= STRING_BOTTOM) {
        pull.current = { index: g.armed, y: p.y, delta };
      } else {
        released = g.armed;
        const plucked = pluck(g.armed, Math.min(1, velocity + .13), delta >= 0 ? 'down' : 'up', clamp(p.y, STRING_TOP, STRING_BOTTOM));
        if (plucked && g.practiceTarget?.stringIndex === g.armed) {
          g.matchedPracticeCueId = g.practiceTarget.cueId;
        }
        g.armed = -1;
        pull.current = null;
      }
    }
    const order = direction === 'down' ? [0, 1, 2, 3, 4, 5] : [5, 4, 3, 2, 1, 0];
    const crossings = new Map<number, number>();
    for (const i of order) {
      if (i === g.armed || i === released) continue;
      const x = STRING_X[i];
      if ((g.x < x && p.x >= x) || (g.x > x && p.x <= x)) {
        // A diagonal sweep only plucks at its actual intersection with each string.
        const crossingY = g.y + (p.y - g.y) * ((x - g.x) / (p.x - g.x));
        if (crossingY >= STRING_TOP && crossingY <= STRING_BOTTOM) crossings.set(i, crossingY);
      }
    }
    g.matchedPracticeCueId = dispatchPracticeSweepStrings(
      [...crossings.keys()],
      g.practiceTarget,
      g.matchedPracticeCueId,
      (index, audible) => pluck(index, velocity, direction, crossings.get(index) ?? p.y, audible),
    );
    Object.assign(g, p, { time: now });
  };
  const up = (event: PointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (event.pointerId !== g.pointerId) return;
    if (g.down && g.armed >= 0) {
      const p = point(event);
      const delta = clamp(p.x - STRING_X[g.armed], -32, 32);
      pluck(g.armed, Math.min(.95, .3 + Math.abs(delta) / 42), delta >= 0 ? 'down' : 'up', clamp(p.y, STRING_TOP, STRING_BOTTOM));
    }
    resetGesture();
  };

  return <div className="guitar-stage minimal-stage vertical-stage guitar-closeup">
    <svg ref={svgRef} viewBox="0 0 1100 560" preserveAspectRatio="xMidYMid slice" className="guitar-svg" style={{ cursor: 'default' }} role="application"
      aria-label="竖排六弦演奏区：按住鼠标左右划弦，向侧面拉弦后松手拨奏，右键止音" tabIndex={0}
      onPointerEnter={refreshMatrix} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={cancel} onLostPointerCapture={cancel}
      onPointerLeave={() => { if (!gesture.current.down) pointer.current = null; }}
      onContextMenu={event => { event.preventDefault(); mute(); }}>
      <defs>
        <linearGradient id="strings-paper" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fffdf8" /><stop offset=".55" stopColor="#f9f6ed" /><stop offset="1" stopColor="#f3eee1" /></linearGradient>
        <linearGradient id="strings-contact" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#e4c77e" stopOpacity="0" /><stop offset=".5" stopColor="#e4c77e" stopOpacity=".26" /><stop offset="1" stopColor="#e4c77e" stopOpacity="0" /></linearGradient>
        <linearGradient id="fingertip-ink" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#e3c789" /><stop offset="1" stopColor="#b58f4d" /></linearGradient>
        <radialGradient id="beat-gold"><stop stopColor="#fae7a4" /><stop offset="1" stopColor="#ddb858" /></radialGradient>
        <linearGradient id="closeup-spruce" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#d2af75" /><stop offset=".35" stopColor="#e7c68e" /><stop offset=".72" stopColor="#dbb57a" /><stop offset="1" stopColor="#be955d" /></linearGradient>
        <linearGradient id="closeup-rosewood" x1="0" y1="0" x2="1" y2="0"><stop stopColor="#221c18" /><stop offset=".15" stopColor="#3a2a20" /><stop offset=".48" stopColor="#30241c" /><stop offset=".73" stopColor="#413025" /><stop offset="1" stopColor="#211b17" /></linearGradient>
        <linearGradient id="closeup-fret-metal" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#777567" /><stop offset=".24" stopColor="#d8d3bd" /><stop offset=".47" stopColor="#fff8df" /><stop offset=".68" stopColor="#b9b5a0" /><stop offset="1" stopColor="#6b6b5e" /></linearGradient>
        <radialGradient id="closeup-soundhole" cx=".5" cy=".34" r=".7"><stop stopColor="#101413" /><stop offset=".72" stopColor="#171713" /><stop offset="1" stopColor="#30271b" /></radialGradient>
        <pattern id="closeup-neck-photo" patternUnits="userSpaceOnUse" x="310" y="-20" width="480" height="580"><image href="/textures/neck-wood.jpg" width="480" height="580" preserveAspectRatio="xMidYMid slice" /></pattern>
        <pattern id="closeup-body-photo" patternUnits="userSpaceOnUse" width="1100" height="560"><image href="/textures/body-wood.jpg" width="1100" height="560" preserveAspectRatio="xMidYMid slice" /></pattern>
        <clipPath id="closeup-frame"><rect width="1100" height="560" rx="24" /></clipPath>
        <clipPath id="closeup-neck"><path d="M 325 -20 H 775 Q 790 -20 790 -5 V 388 Q 790 406 772 406 H 328 Q 310 406 310 388 V -5 Q 310 -20 325 -20 Z" /></clipPath>
        {STRING_X.map((x, i) => <linearGradient key={i} id={`closeup-string-${i}`} gradientUnits="userSpaceOnUse" x1={x - STRING_WIDTHS[i] / 2} y1="0" x2={x + STRING_WIDTHS[i] / 2} y2="0">
          <stop stopColor={i < 3 ? '#75603e' : '#7d837c'} /><stop offset=".3" stopColor={i < 3 ? '#e3cb94' : '#d5dacb'} /><stop offset=".5" stopColor="#fff9dc" /><stop offset=".75" stopColor={i < 3 ? '#ac8c54' : '#a2aa9d'} /><stop offset="1" stopColor="#e5dcb8" />
        </linearGradient>)}
      </defs>
      <rect width="1100" height="560" rx="24" fill="url(#closeup-spruce)" />
      <g className="guitar-closeup-surface" clipPath="url(#closeup-frame)" pointerEvents="none" aria-hidden="true">
        <rect width="1100" height="560" fill="url(#closeup-body-photo)" opacity=".66" />
        <circle cx="550" cy="560" r="222" fill="none" stroke="#886435" strokeWidth="2" opacity=".65" />
        <circle cx="550" cy="560" r="215" fill="none" stroke="#f2dcb0" strokeWidth="5" />
        <circle cx="550" cy="560" r="211" fill="none" stroke="#745634" strokeWidth="4" />
        <circle cx="550" cy="560" r="204" fill="none" stroke="#ebce91" strokeWidth="6" />
        <circle cx="550" cy="560" r="200" fill="url(#closeup-soundhole)" stroke="#4c3822" strokeWidth="3" />
        <path d="M 319 -20 H 781 Q 797 -20 797 -4 V 391 Q 797 414 774 414 H 326 Q 303 414 303 391 V -4 Q 303 -20 319 -20 Z" fill="#291b12" opacity=".19" />
        <path d="M 325 -20 H 775 Q 790 -20 790 -5 V 388 Q 790 406 772 406 H 328 Q 310 406 310 388 V -5 Q 310 -20 325 -20 Z" fill="url(#closeup-rosewood)" stroke="#b59b71" strokeWidth="3" />
        <g clipPath="url(#closeup-neck)">
          <rect x="310" y="-20" width="480" height="426" fill="url(#closeup-neck-photo)" opacity=".88" />
          <rect x="310" y="-20" width="480" height="426" fill="url(#closeup-rosewood)" opacity=".15" />
          {[40, 88, 140, 198, 260, 327, 400].map(y => <g key={y}>
            <rect x="312" y={y - 1} width="476" height="7" fill="#100e0a" opacity=".58" />
            <rect x="312" y={y - 3.5} width="476" height="5.5" rx="1.6" fill="url(#closeup-fret-metal)" />
            <path d={`M 315 ${y - 2.4} H 785`} stroke="#fffbe7" strokeWidth=".55" opacity=".5" />
          </g>)}
          {[113, 229, 363].map(y => <circle key={y} cx="550" cy={y} r="5.5" fill="#d5d2bf" stroke="#f3eedc" strokeWidth=".7" opacity=".8" />)}
          {[530, 570].map(x => <circle key={x} cx={x} cy="292" r="5.5" fill="#d5d2bf" stroke="#f3eedc" strokeWidth=".7" opacity=".8" />)}
        </g>
      </g>
      <g className="playable-layer">
      {STRING_X.map((x, i) => {
        const width = STRING_WIDTHS[i];
        const fret = shape[i];
        const laneDescription = practice?.cues.length ? '旋律轨道' : fret < 0 ? '不弹' : fret === 0 ? '空弦' : `${fret} 品`;
        const d = `M ${x} ${STRING_TOP} V ${STRING_BOTTOM}`;
        return <g key={i} ref={node => { stringGroups.current[i] = node; }} data-string-index={i} aria-label={`${6 - i} 弦 ${STRING_NAMES[i]}，${laneDescription}`}>
          <rect ref={node => { hoverRefs.current[i] = node; }} x={x - 18} y={STRING_TOP} width="36" height={STRING_BOTTOM - STRING_TOP} rx="16" fill="url(#strings-contact)" opacity="0" />
          <path data-string-path d={d} fill="none" stroke="#070908" strokeWidth={width + 2} opacity=".42" transform="translate(2.4 1.4)" />
          <path data-string-path d={d} fill="none" stroke={`url(#closeup-string-${i})`} strokeWidth={width} strokeLinecap="round" />
          <path data-string-path d={d} fill="none" stroke="#fff6d8" strokeWidth={Math.max(.45, width * .18)} opacity=".76" transform="translate(-.65 0)" />
          {i < 3 && <path data-string-path d={d} fill="none" stroke="#655034" strokeWidth={width - .5} strokeDasharray=".65 2.9" opacity=".48" />}
          <circle ref={node => { rippleRefs.current[i] = node; }} className="lane-glyph" cx={x} r="4" fill="none" stroke="#c6a454" strokeWidth="1.3" opacity="0" pointerEvents="none" />
          <circle ref={node => { glintRefs.current[i] = node; }} className="lane-glyph" cx={x} r="2.8" fill="#ddbc72" opacity="0" pointerEvents="none" />
        </g>;
      })}
      <g className="string-receptors" aria-hidden="true" pointerEvents="none">
        <line className="string-hit-rail" x1="322" x2="778" y1={STRIKE_Y} y2={STRIKE_Y} />
        {STRING_X.map((x, index) => <g key={STRING_KEY_LABELS[index]} transform={`translate(${x} ${STRIKE_Y})`}>
          <g className="lane-glyph"><circle ref={node => { receptorPulseRefs.current[index] = node; }} className="string-receptor-strike" r="8" opacity="0" /><circle className="string-receptor-halo" r="17" /><circle className="string-receptor" r="8" /><circle className="string-receptor-core" r="2.4" /></g>
        </g>)}
      </g>
      <g ref={keyHintsRef} className="string-key-hints" aria-hidden="true" pointerEvents="none">
        {STRING_X.map((x, index) => <g key={STRING_KEY_LABELS[index]} transform={`translate(${x} 470)`}>
          <g className="lane-glyph"><rect x="-13" y="-12" width="26" height="24" rx="6" />
          <text y="1" textAnchor="middle" dominantBaseline="middle">{STRING_KEY_LABELS[index]}</text></g>
        </g>)}
      </g>
      <g className="beat-cues" aria-hidden="true" pointerEvents="none">
        {renderedCues.map(cue => {
          const strength = clamp(cue.strength, 0, 1);
          const confidence = clamp(cue.confidence, 0, 1);
          const radius = 9 + strength * 2.5;
          const sustain = clamp(cue.duration * TRAVEL_PER_SECOND, 0, 150);
          return <g key={cue.id} ref={node => { if (node) cueRefs.current.set(cue.id, node); else cueRefs.current.delete(cue.id); }}
            className="beat-cue note" opacity="0" data-cue-id={cue.id} data-string-index={cue.stringIndex}
            data-midi={cue.midi} data-fret={cue.fret} data-source-index={cue.sourceIndex}>
            <g className="single-note-cue lane-glyph">
              {sustain > 12 && <line className="note-sustain" y1={-sustain} y2={-radius} style={{ opacity: .24 + confidence * .42 }} />}
              <circle className="note-cue-halo" r={radius + 6} style={{ opacity: .08 + strength * .12 }} />
              <circle className="note-cue-head" r={radius} />
              <circle className="note-cue-glint" cy={-radius * .28} r={Math.max(1.6, radius * .2)} />
              <text className="cue-fret-label" y="1" textAnchor="middle" dominantBaseline="middle">{cue.fret}</text>
            </g>
          </g>;
        })}
      </g>
      <g ref={hitRef} className="beat-hit" opacity="0" pointerEvents="none" aria-hidden="true">
        <g className="lane-glyph"><circle ref={hitRingRef} r="11" fill="none" stroke="#d6b252" strokeWidth="1.7" />
        <g ref={hitSparksRef} stroke="#d1aa42" strokeWidth="1.8" strokeLinecap="round">
          {Array.from({ length: 8 }, (_, i) => <path key={i} d="M 0 -19 L 0 -25" transform={`rotate(${i * 45})`} />)}
        </g></g>
      </g>
      <g ref={cursorRef} className="finger-cursor" style={{ visibility: 'hidden' }} pointerEvents="none">
        <g className="lane-glyph">
        <path d="M -5 -21 C -5 -27 5 -27 5 -21 L 5 -7 Q 5 -1 0 1 Q -5 -1 -5 -7 Z" fill="url(#fingertip-ink)" stroke="#fff9eb" strokeWidth="1.2" />
        <path d="M -2.7 -17 Q 0 -19 2.7 -17 M -2.7 -13 Q 0 -15 2.7 -13" fill="none" stroke="#fff9e9" strokeWidth=".7" opacity=".7" />
        <path d="M -3 3 Q 0 5 3 3" fill="none" stroke="#b69047" strokeWidth="1.1" strokeLinecap="round" />
        </g>
      </g>
      </g>
    </svg>
  </div>;
}

export default memo(GuitarStage, (previous, next) => previous.chord === next.chord
  && previous.technique === next.technique && previous.onWake === next.onWake
  && previous.onPluck === next.onPluck && previous.onMute === next.onMute && previous.strumEvent === next.strumEvent && previous.stringEvent === next.stringEvent
  && previous.practice?.cues === next.practice?.cues && previous.practice?.getTime === next.practice?.getTime
  && previous.practice?.isPlaying === next.practice?.isPlaying
  && previous.practice?.getJudgedCueIds === next.practice?.getJudgedCueIds
  && previous.practice?.hits === next.practice?.hits
  && previous.practice?.revision === next.practice?.revision);

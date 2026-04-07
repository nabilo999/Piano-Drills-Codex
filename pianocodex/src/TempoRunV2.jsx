import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './TempoRunV2.css'

const TEMPO_RUN_V2_ASSET_URLS = Object.fromEntries(
  Object.entries(
    import.meta.glob('./assets/tempo_run_assets_v2/*.png', {
      eager: true,
      import: 'default',
    }),
  ).map(([path, url]) => [path.split('/').pop(), url]),
)

const BPM = 100
const SECONDS_PER_BEAT = 60 / BPM
const PERFECT_WINDOW = 0.055
const GOOD_WINDOW = 0.145
const MISS_WINDOW = 0.24
const UI_SYNC_MS = 1000 / 30
const JUMP_ANIMATION_MS = 360
const STUMBLE_ANIMATION_MS = 480
const RUN_FRAME_MS = 90
const FEEDBACK_MS = 940
const VIEW_BEATS_BEHIND = 2.8
const VIEW_BEATS_AHEAD = 8
const VIEW_BEATS_TOTAL = VIEW_BEATS_BEHIND + VIEW_BEATS_AHEAD
const SUBDIVISION_STEP = 0.5
const START_LEAD_BEATS = 4
const COURSE_REPEATS = 3

const RHYTHM_TYPES = [
  {
    key: 'quarter',
    label: 'Quarter',
    beats: 1,
    markers: 1,
    hurdle: 'hurdle_quarter.png',
    accent: '#ff9b52',
  },
  {
    key: 'eighth',
    label: 'Eighth',
    beats: 0.5,
    markers: 2,
    hurdle: 'hurdle_eighth.png',
    accent: '#5fd8d3',
  },
  {
    key: 'sixteenth',
    label: 'Sixteenth',
    beats: 0.25,
    markers: 4,
    hurdle: 'hurdle_sixteenth.png',
    accent: '#ff6d6d',
  },
  {
    key: 'half',
    label: 'Half',
    beats: 2,
    markers: 1,
    hurdle: 'hurdle_half.png',
    accent: '#8f93ff',
  },
  {
    key: 'whole',
    label: 'Whole',
    beats: 4,
    markers: 1,
    hurdle: 'hurdle_whole.png',
    accent: '#f7f5d1',
  },
  {
    key: 'rest',
    label: 'Rest',
    beats: 1,
    markers: 0,
    hurdle: null,
    accent: '#8197aa',
  },
]

const RHYTHM_BY_KEY = Object.fromEntries(RHYTHM_TYPES.map((rhythm) => [rhythm.key, rhythm]))
const COURSE_PATTERN = [
  'quarter',
  'eighth',
  'eighth',
  'rest',
  'sixteenth',
  'sixteenth',
  'quarter',
  'half',
  'rest',
  'quarter',
  'quarter',
  'eighth',
  'eighth',
  'whole',
  'rest',
  'sixteenth',
  'sixteenth',
  'sixteenth',
  'sixteenth',
  'quarter',
  'half',
  'rest',
  'eighth',
  'eighth',
  'quarter',
  'rest',
]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatDelta(deltaSec) {
  const rounded = Math.round(deltaSec * 1000)
  return `${rounded > 0 ? '+' : ''}${rounded}ms`
}

function formatAccuracy(accuracy) {
  return Number.isInteger(accuracy) ? `${accuracy}%` : `${accuracy.toFixed(1)}%`
}

function createCourse() {
  let beatCursor = START_LEAD_BEATS
  const events = []
  const hurdles = []

  for (let repeat = 0; repeat < COURSE_REPEATS; repeat += 1) {
    for (let index = 0; index < COURSE_PATTERN.length; index += 1) {
      const rhythmKey = COURSE_PATTERN[index]
      const rhythm = RHYTHM_BY_KEY[rhythmKey]
      const event = {
        id: `event-${repeat}-${index}`,
        rhythmKey,
        label: rhythm.label,
        beat: beatCursor,
        startTime: beatCursor * SECONDS_PER_BEAT,
        endBeat: beatCursor + rhythm.beats,
        endTime: (beatCursor + rhythm.beats) * SECONDS_PER_BEAT,
      }

      events.push(event)

      if (rhythmKey !== 'rest') {
        hurdles.push({
          id: `hurdle-${repeat}-${index}`,
          rhythmKey,
          beat: beatCursor,
          hitTime: beatCursor * SECONDS_PER_BEAT,
          state: 'pending',
          judgedAt: null,
          result: null,
        })
      }

      beatCursor += rhythm.beats
    }
  }

  return {
    events,
    hurdles,
    totalBeats: beatCursor + 2,
    totalTime: (beatCursor + 2) * SECONDS_PER_BEAT,
  }
}

function createGameState(course) {
  return {
    phase: 'ready',
    startedAtMs: 0,
    songTime: 0,
    totalTime: course.totalTime,
    score: 0,
    combo: 0,
    bestCombo: 0,
    hits: 0,
    misses: 0,
    feedback: null,
    nextTargetIndex: 0,
    hurdles: course.hurdles.map((hurdle) => ({ ...hurdle })),
    runner: {
      jumpStartedAtMs: -Infinity,
      stumbleStartedAtMs: -Infinity,
      lastInputAtMs: -Infinity,
    },
    lastUiSyncAtMs: 0,
  }
}

function getAccuracy(state) {
  const attempts = state.hits + state.misses
  if (attempts === 0) return 100
  return Math.round((state.hits / attempts) * 1000) / 10
}

function createUiSnapshot(state, nowMs = performance.now()) {
  return {
    phase: state.phase,
    songTime: state.songTime,
    totalTime: state.totalTime,
    score: state.score,
    combo: state.combo,
    bestCombo: state.bestCombo,
    hits: state.hits,
    misses: state.misses,
    accuracy: getAccuracy(state),
    feedback: state.feedback,
    progress: clamp(state.songTime / state.totalTime, 0, 1),
    nowMs,
    runner: { ...state.runner },
  }
}

function advanceTargetIndex(state) {
  while (state.nextTargetIndex < state.hurdles.length) {
    if (state.hurdles[state.nextTargetIndex].state === 'pending') break
    state.nextTargetIndex += 1
  }
}

function getPendingHurdle(state) {
  return state.hurdles[state.nextTargetIndex] ?? null
}

function buildFeedback(kind, deltaSec, combo, nowMs) {
  if (kind === 'perfect') {
    return {
      label: 'Perfect',
      detail: formatDelta(deltaSec),
      assetName: 'fx_perfect.png',
      color: '#fff29c',
      comboUp: combo > 0 && combo % 4 === 0,
      atMs: nowMs,
    }
  }

  if (kind === 'good') {
    return {
      label: 'Good',
      detail: formatDelta(deltaSec),
      assetName: 'fx_good.png',
      color: '#72efe0',
      comboUp: combo > 0 && combo % 4 === 0,
      atMs: nowMs,
    }
  }

  return {
    label: 'Miss',
    detail: deltaSec === null ? 'No jump' : formatDelta(deltaSec),
    assetName: 'fx_miss.png',
    color: '#ff8c97',
    comboUp: false,
    atMs: nowMs,
  }
}

function getRunnerFrame(state, nowMs) {
  const stumbleElapsed = nowMs - state.runner.stumbleStartedAtMs
  if (stumbleElapsed < STUMBLE_ANIMATION_MS) {
    return {
      spriteName:
        stumbleElapsed < STUMBLE_ANIMATION_MS / 2
          ? 'runner_stumble_01.png'
          : 'runner_stumble_02.png',
      jumpOffset: 0,
      motionBlur: false,
      stateClass: 'is-stumbling',
    }
  }

  const jumpElapsed = nowMs - state.runner.jumpStartedAtMs
  if (jumpElapsed < JUMP_ANIMATION_MS) {
    const progress = clamp(jumpElapsed / JUMP_ANIMATION_MS, 0, 1)
    const spriteName =
      progress < 0.25
        ? 'runner_jump_start.png'
        : progress < 0.72
          ? 'runner_jump_mid.png'
          : 'runner_jump_land.png'

    return {
      spriteName,
      jumpOffset: Math.sin(progress * Math.PI) * 92,
      motionBlur: progress > 0.16 && progress < 0.82,
      stateClass: 'is-jumping',
    }
  }

  if (state.phase !== 'playing') {
    return {
      spriteName: 'runner_idle.png',
      jumpOffset: 0,
      motionBlur: false,
      stateClass: 'is-idle',
    }
  }

  const frame = Math.floor(nowMs / RUN_FRAME_MS) % 4
  return {
    spriteName: `runner_run_0${frame + 1}.png`,
    jumpOffset: Math.sin(nowMs / 120) * 4,
    motionBlur: false,
    stateClass: 'is-running',
  }
}

function beatToTrackPercent(beat, currentBeat) {
  return ((beat - currentBeat + VIEW_BEATS_BEHIND) / VIEW_BEATS_TOTAL) * 100
}

function getBeatLabel(beat) {
  const rounded = Math.round(beat * 2) / 2
  const isHalfBeat = !Number.isInteger(rounded)
  if (isHalfBeat) return '&'
  const measureBeat = ((rounded % 4) + 4) % 4
  return `${measureBeat + 1}`
}

function PixelRunnerArt({ src, className = '' }) {
  if (src) {
    return <img className={`tempo-run-v2-runner-sprite ${className}`.trim()} src={src} alt="" />
  }

  return (
    <div className={`tempo-run-v2-runner-fallback ${className}`.trim()} aria-hidden="true">
      <span className="tempo-run-v2-runner-head" />
      <span className="tempo-run-v2-runner-body" />
      <span className="tempo-run-v2-runner-arm" />
      <span className="tempo-run-v2-runner-leg is-back" />
      <span className="tempo-run-v2-runner-leg is-front" />
    </div>
  )
}

function TempoRunV2({ onExit }) {
  const course = useMemo(() => createCourse(), [])
  const gameRef = useRef(createGameState(course))
  const animationRef = useRef(null)
  const [ui, setUi] = useState(() => createUiSnapshot(createGameState(course)))

  const syncUi = useCallback((force = false) => {
    const state = gameRef.current
    const nowMs = performance.now()
    if (!force && nowMs - state.lastUiSyncAtMs < UI_SYNC_MS) return
    state.lastUiSyncAtMs = nowMs
    const snapshot = createUiSnapshot(state, nowMs)
    startTransition(() => {
      setUi(snapshot)
    })
  }, [])

  const startRun = useCallback(() => {
    const nextState = createGameState(course)
    nextState.phase = 'playing'
    nextState.startedAtMs = performance.now()
    gameRef.current = nextState
    syncUi(true)
  }, [course, syncUi])

  const markMiss = useCallback(
    (hurdle, nowMs, deltaSec = null) => {
      const state = gameRef.current
      if (!hurdle || hurdle.state !== 'pending') return

      hurdle.state = 'missed'
      hurdle.result = 'miss'
      hurdle.judgedAt = state.songTime
      state.combo = 0
      state.misses += 1
      state.runner.stumbleStartedAtMs = nowMs
      state.feedback = buildFeedback('miss', deltaSec, state.combo, nowMs)
      advanceTargetIndex(state)
      syncUi(true)
    },
    [syncUi],
  )

  const markHit = useCallback(
    (hurdle, nowMs, deltaSec) => {
      const state = gameRef.current
      if (!hurdle || hurdle.state !== 'pending') return

      const kind = Math.abs(deltaSec) <= PERFECT_WINDOW ? 'perfect' : 'good'
      hurdle.state = 'cleared'
      hurdle.result = kind
      hurdle.judgedAt = state.songTime
      state.combo += 1
      state.bestCombo = Math.max(state.bestCombo, state.combo)
      state.hits += 1
      state.score += kind === 'perfect' ? 160 : 110
      state.runner.jumpStartedAtMs = nowMs
      state.feedback = buildFeedback(kind, deltaSec, state.combo, nowMs)
      advanceTargetIndex(state)
      syncUi(true)
    },
    [syncUi],
  )

  const handleJumpInput = useCallback(() => {
    const state = gameRef.current
    const nowMs = performance.now()

    if (state.phase !== 'playing') return
    if (nowMs - state.runner.lastInputAtMs < 75) return

    state.runner.lastInputAtMs = nowMs
    state.songTime = (nowMs - state.startedAtMs) / 1000

    const hurdle = getPendingHurdle(state)
    if (!hurdle) return

    const deltaSec = state.songTime - hurdle.hitTime

    if (deltaSec < -GOOD_WINDOW) {
      state.runner.jumpStartedAtMs = nowMs
      syncUi(true)
      return
    }

    if (Math.abs(deltaSec) <= GOOD_WINDOW) {
      markHit(hurdle, nowMs, deltaSec)
      return
    }

    if (deltaSec > GOOD_WINDOW && deltaSec <= MISS_WINDOW) {
      markMiss(hurdle, nowMs, deltaSec)
    }
  }, [markHit, markMiss, syncUi])

  const handlePrimaryAction = useCallback(() => {
    const phase = gameRef.current.phase
    if (phase === 'finished') {
      startRun()
      return
    }

    handleJumpInput()
  }, [handleJumpInput, startRun])

  useEffect(() => {
    startRun()
  }, [startRun])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat) return
      if (event.code !== 'Space' && event.code !== 'ArrowUp' && event.code !== 'KeyW') return
      event.preventDefault()
      handlePrimaryAction()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handlePrimaryAction])

  useEffect(() => {
    const loop = (nowMs) => {
      const state = gameRef.current

      if (state.phase === 'playing') {
        state.songTime = (nowMs - state.startedAtMs) / 1000

        while (state.nextTargetIndex < state.hurdles.length) {
          const hurdle = state.hurdles[state.nextTargetIndex]
          if (hurdle.state !== 'pending') {
            advanceTargetIndex(state)
            continue
          }

          if (state.songTime > hurdle.hitTime + MISS_WINDOW) {
            markMiss(hurdle, nowMs, null)
            continue
          }
          break
        }

        if (state.nextTargetIndex >= state.hurdles.length && state.songTime >= state.totalTime) {
          state.phase = 'finished'
          syncUi(true)
        }
      }

      syncUi()
      animationRef.current = requestAnimationFrame(loop)
    }

    animationRef.current = requestAnimationFrame(loop)
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [markMiss, syncUi])

  const currentBeat = ui.songTime / SECONDS_PER_BEAT
  const runnerXPercent = (VIEW_BEATS_BEHIND / VIEW_BEATS_TOTAL) * 100
  const runnerFrame = getRunnerFrame(ui, ui.nowMs)
  const runnerSpriteUrl = TEMPO_RUN_V2_ASSET_URLS[runnerFrame.spriteName] ?? null
  const backgroundUrl = TEMPO_RUN_V2_ASSET_URLS['background_track.png'] ?? null
  const feedbackAssetUrl = ui.feedback ? TEMPO_RUN_V2_ASSET_URLS[ui.feedback.assetName] ?? null : null
  const feedbackVisible = ui.feedback && ui.nowMs - ui.feedback.atMs <= FEEDBACK_MS

  const visibleHurdles = course.hurdles
    .filter((hurdle) => {
      const relativeBeats = hurdle.beat - currentBeat
      return relativeBeats >= -VIEW_BEATS_BEHIND - 1 && relativeBeats <= VIEW_BEATS_AHEAD + 1
    })
    .map((hurdle) => ({
      ...hurdle,
      leftPercent: beatToTrackPercent(hurdle.beat, currentBeat),
    }))

  const gridLines = []
  const gridStart = Math.floor((currentBeat - VIEW_BEATS_BEHIND - 1) * 2) / 2
  const gridEnd = currentBeat + VIEW_BEATS_AHEAD + 1
  for (let beat = gridStart; beat <= gridEnd; beat += SUBDIVISION_STEP) {
    const leftPercent = beatToTrackPercent(beat, currentBeat)
    if (leftPercent < -8 || leftPercent > 108) continue
    const normalizedBeat = Math.round(beat * 2) / 2
    gridLines.push({
      beat: normalizedBeat,
      leftPercent,
      isBar: Number.isInteger(normalizedBeat) && normalizedBeat % 4 === 0,
      isBeat: Number.isInteger(normalizedBeat),
    })
  }

  const stageBackgroundStyle = backgroundUrl
    ? {
        backgroundImage: `url(${backgroundUrl})`,
        backgroundPosition: `${-ui.songTime * 140}px center`,
      }
    : undefined

  return (
    <main className="tempo-run-v2-shell">
      <section className="tempo-run-v2-stage-card">
        <div className="tempo-run-v2-stage-wrap">
          <div className="tempo-run-v2-track-viewport">
            <div className="tempo-run-v2-track-backdrop" style={stageBackgroundStyle} />
            <div className="tempo-run-v2-sky-glow" aria-hidden="true" />

            <header className="tempo-run-v2-overlay-hud" aria-label="Tempo run side scroll stats">
              <div className="tempo-run-v2-overlay-left">
                <span className="tempo-run-v2-overlay-label">BPM</span>
                <strong>{BPM}</strong>
              </div>
              <div className="tempo-run-v2-overlay-center">
                <span className="tempo-run-v2-overlay-label">Score</span>
                <strong>{ui.score.toLocaleString()}</strong>
              </div>
              <div className="tempo-run-v2-overlay-right">
                <div className="tempo-run-v2-overlay-metric">
                  <span className="tempo-run-v2-overlay-label">Combo</span>
                  <strong>{ui.combo}x</strong>
                </div>
                <div className="tempo-run-v2-overlay-metric">
                  <span className="tempo-run-v2-overlay-label">Accuracy</span>
                  <strong>{formatAccuracy(ui.accuracy)}</strong>
                </div>
              </div>
            </header>

            {gridLines.map((line) => (
              <span
                key={`grid-${line.beat}`}
                className={`tempo-run-v2-grid-line ${
                  line.isBar ? 'is-bar' : line.isBeat ? 'is-beat' : 'is-subdivision'
                }`.trim()}
                style={{ left: `${line.leftPercent}%` }}
                aria-hidden="true"
              />
            ))}

            <div className="tempo-run-v2-lane-shadow" aria-hidden="true" />
            <div className="tempo-run-v2-ground" aria-hidden="true" />
            <div className="tempo-run-v2-ground-edge" aria-hidden="true" />

            {feedbackVisible && ui.feedback && (
              <div className="tempo-run-v2-feedback">
                {feedbackAssetUrl ? (
                  <img
                    className="tempo-run-v2-feedback-art"
                    src={feedbackAssetUrl}
                    alt=""
                    aria-hidden="true"
                  />
                ) : (
                  <div
                    className="tempo-run-v2-feedback-badge"
                    style={{ '--feedback-color': ui.feedback.color }}
                  >
                    {ui.feedback.label}
                  </div>
                )}
                <div className="tempo-run-v2-feedback-copy">
                  <strong>{ui.feedback.label}</strong>
                  <span>{ui.feedback.detail}</span>
                </div>
                {ui.feedback.comboUp && (
                  <>
                    {TEMPO_RUN_V2_ASSET_URLS['fx_combo_up.png'] ? (
                      <img
                        className="tempo-run-v2-combo-up-art"
                        src={TEMPO_RUN_V2_ASSET_URLS['fx_combo_up.png']}
                        alt=""
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="tempo-run-v2-combo-up-copy">Combo Up</span>
                    )}
                  </>
                )}
              </div>
            )}

            {visibleHurdles.map((hurdle) => {
              const rhythm = RHYTHM_BY_KEY[hurdle.rhythmKey]

              return (
                <article
                  key={hurdle.id}
                  className={`tempo-run-v2-hurdle is-${hurdle.state}`.trim()}
                  style={{
                    left: `${hurdle.leftPercent}%`,
                    '--hurdle-accent': rhythm.accent,
                  }}
                  aria-hidden="true"
                >
                  <div className="tempo-run-v2-hurdle-line" />
                </article>
              )
            })}

            <div
              className={`tempo-run-v2-runner ${runnerFrame.stateClass}`.trim()}
              style={{
                left: `${runnerXPercent}%`,
                transform: `translate(-50%, ${-runnerFrame.jumpOffset}px)`,
              }}
            >
              {runnerFrame.motionBlur && (
                <>
                  <PixelRunnerArt
                    src={runnerSpriteUrl}
                    className="tempo-run-v2-runner-afterimage is-far"
                  />
                  <PixelRunnerArt
                    src={runnerSpriteUrl}
                    className="tempo-run-v2-runner-afterimage is-near"
                  />
                </>
              )}
              <PixelRunnerArt src={runnerSpriteUrl} />
            </div>
          </div>

          <div className="tempo-run-v2-count-strip" aria-hidden="true">
            {gridLines.map((line) => (
              <div
                key={`count-${line.beat}`}
                className={`tempo-run-v2-count-slot ${line.isBeat ? 'is-beat' : ''}`.trim()}
                style={{ left: `${line.leftPercent}%` }}
              >
                <span className="tempo-run-v2-count-tick" />
                <span className="tempo-run-v2-count-label">{getBeatLabel(line.beat)}</span>
              </div>
            ))}
          </div>

          <div className="tempo-run-v2-hint">Press Space to jump</div>

          {ui.phase === 'finished' && (
            <div className="tempo-run-v2-popup-backdrop">
              <div className="tempo-run-v2-popup">
                <p className="tempo-run-v2-popup-kicker">Tempo Run Side Scroll</p>
                <h2>Course Complete</h2>
                <p>
                  Score {ui.score.toLocaleString()}
                  <br />
                  Best Combo {ui.bestCombo}x
                  <br />
                  Accuracy {formatAccuracy(ui.accuracy)}
                </p>
                <div className="tempo-run-v2-popup-actions">
                  <button className="tempo-run-v2-button" type="button" onClick={startRun}>
                    Reset
                  </button>
                  <button
                    className="tempo-run-v2-button is-secondary"
                    type="button"
                    onClick={onExit}
                  >
                    Title Screen
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

export default TempoRunV2

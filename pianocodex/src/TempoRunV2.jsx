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
const INPUT_DEBOUNCE_MS = 75
const JUMP_ASCEND_MS = 170
const JUMP_HANG_MS = 120
const JUMP_DESCEND_MS = 220
const JUMP_TOTAL_MS = JUMP_ASCEND_MS + JUMP_HANG_MS + JUMP_DESCEND_MS
const JUMP_PEAK_OFFSET = 92
const FLOAT_HOVER_OFFSET = 84
const FLOAT_BOB_MS = 220
const FLOAT_BOB_AMPLITUDE = 4
const FLOAT_DESCEND_MS = 220
const FLOAT_SPIN_MS = 220
const MIN_GROUND_RESET_MS = 110
const MIN_JUMP_CYCLE_SEC = (JUMP_TOTAL_MS + MIN_GROUND_RESET_MS) / 1000
const FLOAT_RELEASE_BUFFER_SEC = 0.04
const STUMBLE_ANIMATION_MS = 480
const RUN_FRAME_MS = 140
const FEEDBACK_MS = 940
const CHEER_FRAME_MS = 360
const AIR_SPIN_FRAME_MS = 70
const LOSE_FALL_FRAME_MS = 120
const LOSE_FALL_FRAME_COUNT = 4
const LOSE_FALL_TOTAL_MS = LOSE_FALL_FRAME_MS * LOSE_FALL_FRAME_COUNT
const LOSE_FALL_FORWARD_PERCENT = 8
const HURDLE_RENDER_HEIGHT = 96
const VIEW_BEATS_BEHIND = 2.8
const VIEW_BEATS_AHEAD = 8
const VIEW_BEATS_TOTAL = VIEW_BEATS_BEHIND + VIEW_BEATS_AHEAD
const START_LEAD_BEATS = 4
const COURSE_REPEATS = 3
const MAX_LIVES = 3
const RUNNER_TRACK_X_PERCENT = (VIEW_BEATS_BEHIND / VIEW_BEATS_TOTAL) * 100
const INTRO_RUN_IN_MS = 1120
const INTRO_RUNNER_START_X_PERCENT = -12
const INTRO_IDLE_BOB_AMPLITUDE = 3

const RHYTHM_TYPES = [
  {
    key: 'quarter',
    label: 'Quarter',
    beats: 1,
    accent: '#ff9b52',
    hurdle: 'hurdle_quarter.png',
    hurdleSpriteSize: {
      width: 216,
      height: 408,
    },
  },
  {
    key: 'eighth',
    label: 'Eighth',
    beats: 0.5,
    accent: '#5fd8d3',
    hurdle: 'hurdle_eighth.png',
    hurdleSpriteSize: {
      width: 160,
      height: 256,
    },
  },
  {
    key: 'sixteenth',
    label: 'Sixteenth',
    beats: 0.25,
    accent: '#ff6d6d',
    hurdle: 'hurdle_sixteenth.png',
    hurdleSpriteSize: {
      width: 260,
      height: 472,
    },
  },
  {
    key: 'half',
    label: 'Half',
    beats: 2,
    accent: '#8f93ff',
    hurdle: 'hurdle_half.png',
    hurdleSpriteSize: {
      width: 160,
      height: 256,
    },
  },
  {
    key: 'whole',
    label: 'Whole',
    beats: 4,
    accent: '#f7f5d1',
    hurdle: 'hurdle_whole.png',
    hurdleSpriteSize: {
      width: 160,
      height: 256,
    },
  },
  {
    key: 'rest',
    label: 'Rest',
    beats: 1,
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

function lerp(start, end, amount) {
  return start + (end - start) * amount
}

function easeOutQuad(value) {
  return 1 - (1 - value) * (1 - value)
}

function easeInQuad(value) {
  return value * value
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
  const hurdles = []

  for (let repeat = 0; repeat < COURSE_REPEATS; repeat += 1) {
    for (let index = 0; index < COURSE_PATTERN.length; index += 1) {
      const rhythmKey = COURSE_PATTERN[index]
      const rhythm = RHYTHM_BY_KEY[rhythmKey]

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
    hurdles,
    totalTime: (beatCursor + 2) * SECONDS_PER_BEAT,
  }
}

function createGameState(course) {
  return {
    phase: 'ready',
    introStartedAtMs: 0,
    startedAtMs: 0,
    songTime: 0,
    totalTime: course.totalTime,
    score: 0,
    combo: 0,
    bestCombo: 0,
    hits: 0,
    misses: 0,
    lives: MAX_LIVES,
    feedback: null,
    nextTargetIndex: 0,
    hurdles: course.hurdles.map((hurdle) => ({ ...hurdle })),
    runner: {
      airState: 'grounded',
      jumpStartedAtMs: -Infinity,
      floatStartedAtMs: -Infinity,
      floatReleaseAtTime: -Infinity,
      landingStartedAtMs: -Infinity,
      spinStartedAtMs: -Infinity,
      stumbleStartedAtMs: -Infinity,
      loseStartedAtMs: -Infinity,
      loseStartXPercent: RUNNER_TRACK_X_PERCENT,
      loseEndXPercent: RUNNER_TRACK_X_PERCENT + LOSE_FALL_FORWARD_PERCENT,
      lastInputAtMs: -Infinity,
    },
    lastUiSyncAtMs: 0,
  }
}

function createIntroState(course, nowMs = performance.now()) {
  const state = createGameState(course)
  state.phase = 'intro-entering'
  state.introStartedAtMs = nowMs
  return state
}

function getAccuracy(state) {
  const attempts = state.hits + state.misses
  if (attempts === 0) return 100
  return Math.round((state.hits / attempts) * 1000) / 10
}

function createUiSnapshot(state, nowMs = performance.now()) {
  return {
    phase: state.phase,
    introStartedAtMs: state.introStartedAtMs,
    songTime: state.songTime,
    totalTime: state.totalTime,
    score: state.score,
    combo: state.combo,
    bestCombo: state.bestCombo,
    hits: state.hits,
    misses: state.misses,
    lives: state.lives,
    accuracy: getAccuracy(state),
    feedback: state.feedback,
    hurdles: state.hurdles.map((hurdle) => ({ ...hurdle })),
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

function isRunnerAirborne(runner) {
  return runner.airState !== 'grounded'
}

function setRunnerGrounded(runner) {
  runner.airState = 'grounded'
  runner.jumpStartedAtMs = -Infinity
  runner.floatStartedAtMs = -Infinity
  runner.floatReleaseAtTime = -Infinity
  runner.landingStartedAtMs = -Infinity
  runner.spinStartedAtMs = -Infinity
  runner.loseStartedAtMs = -Infinity
  runner.loseStartXPercent = RUNNER_TRACK_X_PERCENT
  runner.loseEndXPercent = RUNNER_TRACK_X_PERCENT + LOSE_FALL_FORWARD_PERCENT
}

function startRunnerJump(runner, nowMs) {
  runner.airState = 'jump'
  runner.jumpStartedAtMs = nowMs
  runner.floatStartedAtMs = -Infinity
  runner.floatReleaseAtTime = -Infinity
  runner.landingStartedAtMs = -Infinity
  runner.spinStartedAtMs = -Infinity
}

function pulseRunnerSpin(runner, nowMs) {
  runner.spinStartedAtMs = nowMs
}

function enterRunnerFloat(runner, nowMs, releaseAtTime) {
  runner.airState = 'float'
  if (!Number.isFinite(runner.floatStartedAtMs)) {
    runner.floatStartedAtMs = nowMs
  } else {
    runner.floatStartedAtMs = Math.min(runner.floatStartedAtMs, nowMs)
  }
  runner.floatReleaseAtTime = Math.max(runner.floatReleaseAtTime, releaseAtTime)
  runner.landingStartedAtMs = -Infinity
  pulseRunnerSpin(runner, nowMs)
}

function startRunnerLanding(runner, nowMs) {
  runner.airState = 'landing'
  runner.landingStartedAtMs = nowMs
  runner.floatStartedAtMs = -Infinity
  runner.floatReleaseAtTime = -Infinity
  runner.spinStartedAtMs = -Infinity
}

function startRunnerLoseFall(runner, nowMs, startXPercent, endXPercent) {
  runner.airState = 'grounded'
  runner.jumpStartedAtMs = -Infinity
  runner.floatStartedAtMs = -Infinity
  runner.floatReleaseAtTime = -Infinity
  runner.landingStartedAtMs = -Infinity
  runner.spinStartedAtMs = -Infinity
  runner.stumbleStartedAtMs = -Infinity
  runner.loseStartedAtMs = nowMs
  runner.loseStartXPercent = startXPercent
  runner.loseEndXPercent = endXPercent
}

function getDenseClusterEndTime(state, anchorHitTime) {
  let clusterEndTime = anchorHitTime
  let previousHitTime = anchorHitTime
  let hasDenseContinuation = false

  for (let index = state.nextTargetIndex; index < state.hurdles.length; index += 1) {
    const hurdle = state.hurdles[index]
    if (hurdle.state !== 'pending') continue
    if (hurdle.hitTime - previousHitTime > MIN_JUMP_CYCLE_SEC) break
    hasDenseContinuation = true
    clusterEndTime = hurdle.hitTime
    previousHitTime = hurdle.hitTime
  }

  return hasDenseContinuation ? clusterEndTime : anchorHitTime
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

function getJumpArcOffset(elapsedMs) {
  if (elapsedMs <= 0) return 0

  if (elapsedMs < JUMP_ASCEND_MS) {
    return easeOutQuad(clamp(elapsedMs / JUMP_ASCEND_MS, 0, 1)) * JUMP_PEAK_OFFSET
  }

  if (elapsedMs < JUMP_ASCEND_MS + JUMP_HANG_MS) {
    return JUMP_PEAK_OFFSET
  }

  if (elapsedMs < JUMP_TOTAL_MS) {
    const progress = clamp((elapsedMs - JUMP_ASCEND_MS - JUMP_HANG_MS) / JUMP_DESCEND_MS, 0, 1)
    return (1 - easeInQuad(progress)) * JUMP_PEAK_OFFSET
  }

  return 0
}

function getFloatLandingOffset(elapsedMs) {
  const progress = clamp(elapsedMs / FLOAT_DESCEND_MS, 0, 1)
  return (1 - easeInQuad(progress)) * FLOAT_HOVER_OFFSET
}

function getRunnerFrame(state, nowMs) {
  const runner = state.runner
  let spriteName = 'runner_idle.png'
  let jumpOffset = 0
  let motionBlur = false
  let stateClass = 'is-idle'

  if (state.phase === 'intro-entering') {
    const frame = Math.floor(nowMs / RUN_FRAME_MS) % 4
    return {
      spriteName: `runner_run_0${frame + 1}.png`,
      jumpOffset: Math.sin(nowMs / 120) * 4,
      motionBlur: false,
      stateClass: 'is-running-in',
    }
  }

  if (state.phase === 'intro-ready') {
    return {
      spriteName: 'runner_ready.png',
      jumpOffset: Math.sin(nowMs / 210) * INTRO_IDLE_BOB_AMPLITUDE,
      motionBlur: false,
      stateClass: 'is-ready',
    }
  }

  if (state.phase === 'losing' || state.phase === 'failed') {
    const loseElapsed = Math.max(0, nowMs - runner.loseStartedAtMs)
    const frame = clamp(
      Math.floor(loseElapsed / LOSE_FALL_FRAME_MS),
      0,
      LOSE_FALL_FRAME_COUNT - 1,
    )
    return {
      spriteName: `lose_fall_0${frame + 1}.png`,
      jumpOffset: 0,
      motionBlur: false,
      stateClass: 'is-losing',
    }
  }

  if (state.phase === 'finished') {
    const frame = Math.floor(nowMs / CHEER_FRAME_MS) % 2
    return {
      spriteName: `runner_cheer_0${frame + 1}.png`,
      jumpOffset: Math.sin(nowMs / 180) * 3,
      motionBlur: false,
      stateClass: 'is-cheering',
    }
  }

  if (runner.airState === 'jump') {
    const jumpElapsed = nowMs - runner.jumpStartedAtMs
    const progress = clamp(jumpElapsed / JUMP_TOTAL_MS, 0, 1)
    spriteName =
      progress < 0.24
        ? 'runner_jump_start.png'
        : progress < 0.7
          ? 'runner_jump_mid.png'
          : 'runner_jump_land.png'
    jumpOffset = getJumpArcOffset(jumpElapsed)
    motionBlur = progress > 0.12 && progress < 0.78
    stateClass = 'is-jumping'
  } else if (runner.airState === 'float') {
    const hasSpin = nowMs - runner.spinStartedAtMs < FLOAT_SPIN_MS
    const spinFrame = Math.floor(Math.max(0, nowMs - runner.spinStartedAtMs) / AIR_SPIN_FRAME_MS) % 4
    spriteName = hasSpin ? `runner_air_spin_0${spinFrame + 1}.png` : 'runner_jump_mid.png'
    jumpOffset =
      FLOAT_HOVER_OFFSET +
      Math.sin((nowMs - runner.floatStartedAtMs) / FLOAT_BOB_MS) * FLOAT_BOB_AMPLITUDE
    stateClass = hasSpin ? 'is-floating-spin' : 'is-floating'
  } else if (runner.airState === 'landing') {
    spriteName = 'runner_jump_land.png'
    jumpOffset = getFloatLandingOffset(nowMs - runner.landingStartedAtMs)
    stateClass = 'is-landing'
  } else if (state.phase === 'playing') {
    const frame = Math.floor(nowMs / RUN_FRAME_MS) % 4
    spriteName = `runner_run_0${frame + 1}.png`
    jumpOffset = Math.sin(nowMs / 120) * 4
    stateClass = 'is-running'
  }

  const stumbleElapsed = nowMs - runner.stumbleStartedAtMs
  if (stumbleElapsed < STUMBLE_ANIMATION_MS) {
    return {
      spriteName:
        stumbleElapsed < STUMBLE_ANIMATION_MS / 2
          ? 'runner_stumble_01.png'
          : 'runner_stumble_02.png',
      jumpOffset,
      motionBlur: false,
      stateClass: `${stateClass} is-stumbling`,
    }
  }

  return {
    spriteName,
    jumpOffset,
    motionBlur,
    stateClass,
  }
}

function getRunnerXPercent(state, nowMs) {
  if (state.phase === 'losing' || state.phase === 'failed') {
    const loseElapsed = Math.max(0, nowMs - state.runner.loseStartedAtMs)
    const progress = clamp(loseElapsed / LOSE_FALL_TOTAL_MS, 0, 1)
    return lerp(
      state.runner.loseStartXPercent,
      state.runner.loseEndXPercent,
      easeOutQuad(progress),
    )
  }

  if (state.phase === 'intro-entering') {
    const progress = clamp((nowMs - state.introStartedAtMs) / INTRO_RUN_IN_MS, 0, 1)
    return lerp(
      INTRO_RUNNER_START_X_PERCENT,
      RUNNER_TRACK_X_PERCENT,
      easeOutQuad(progress),
    )
  }

  return RUNNER_TRACK_X_PERCENT
}

function beatToTrackPercent(beat, currentBeat) {
  return ((beat - currentBeat + VIEW_BEATS_BEHIND) / VIEW_BEATS_TOTAL) * 100
}

function getHurdleRenderWidth(rhythm) {
  if (!rhythm?.hurdleSpriteSize) return 14
  return Math.round(
    (HURDLE_RENDER_HEIGHT * rhythm.hurdleSpriteSize.width) / rhythm.hurdleSpriteSize.height,
  )
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
  const initialState = useMemo(() => createIntroState(course), [course])
  const gameRef = useRef(initialState)
  const animationRef = useRef(null)
  const [ui, setUi] = useState(() => createUiSnapshot(initialState))

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
      state.lives -= 1
      state.feedback = buildFeedback('miss', deltaSec, state.combo, nowMs)
      if (state.lives <= 0) {
        const missBeat = state.songTime / SECONDS_PER_BEAT
        const loseStartXPercent = getRunnerXPercent(state, nowMs)
        const hurdleTrackXPercent = beatToTrackPercent(hurdle.beat, missBeat)
        const loseEndXPercent = clamp(
          Math.max(loseStartXPercent + 3, hurdleTrackXPercent + 2),
          loseStartXPercent,
          loseStartXPercent + LOSE_FALL_FORWARD_PERCENT,
        )
        state.phase = 'losing'
        startRunnerLoseFall(state.runner, nowMs, loseStartXPercent, loseEndXPercent)
      } else {
        state.runner.stumbleStartedAtMs = nowMs
      }
      advanceTargetIndex(state)
      syncUi(true)
    },
    [syncUi],
  )

  const markHit = useCallback(
    (hurdle, nowMs, deltaSec) => {
      const state = gameRef.current
      if (!hurdle || hurdle.state !== 'pending') return

      const runner = state.runner
      const wasAirborne = isRunnerAirborne(runner)
      const kind = Math.abs(deltaSec) <= PERFECT_WINDOW ? 'perfect' : 'good'

      hurdle.state = 'cleared'
      hurdle.result = kind
      hurdle.judgedAt = state.songTime
      state.combo += 1
      state.bestCombo = Math.max(state.bestCombo, state.combo)
      state.hits += 1
      state.score += kind === 'perfect' ? 160 : 110

      if (!wasAirborne) {
        startRunnerJump(runner, nowMs)
      }

      state.feedback = buildFeedback(kind, deltaSec, state.combo, nowMs)
      advanceTargetIndex(state)

      if (wasAirborne) {
        const clusterEndTime = getDenseClusterEndTime(state, hurdle.hitTime)
        if (clusterEndTime > hurdle.hitTime || runner.airState === 'float') {
          enterRunnerFloat(runner, nowMs, clusterEndTime + FLOAT_RELEASE_BUFFER_SEC)
        }
      }

      syncUi(true)
    },
    [syncUi],
  )

  const handleJumpInput = useCallback(() => {
    const state = gameRef.current
    const nowMs = performance.now()

    if (state.phase !== 'playing') return
    if (nowMs - state.runner.lastInputAtMs < INPUT_DEBOUNCE_MS) return

    state.runner.lastInputAtMs = nowMs
    state.songTime = (nowMs - state.startedAtMs) / 1000

    const hurdle = getPendingHurdle(state)
    if (!hurdle) return

    const deltaSec = state.songTime - hurdle.hitTime

    if (deltaSec < -GOOD_WINDOW) {
      if (!isRunnerAirborne(state.runner)) {
        startRunnerJump(state.runner, nowMs)
        syncUi(true)
      }
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
    if (phase === 'finished' || phase === 'failed') {
      startRun()
      return
    }

    if (phase === 'intro-ready') {
      startRun()
      return
    }

    handleJumpInput()
  }, [handleJumpInput, startRun])

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

      if (
        state.phase === 'intro-entering' &&
        nowMs >= state.introStartedAtMs + INTRO_RUN_IN_MS
      ) {
        state.phase = 'intro-ready'
        syncUi(true)
      } else if (state.phase === 'playing') {
        state.songTime = (nowMs - state.startedAtMs) / 1000

        if (state.runner.airState === 'jump' && nowMs >= state.runner.jumpStartedAtMs + JUMP_TOTAL_MS) {
          setRunnerGrounded(state.runner)
        } else if (
          state.runner.airState === 'float' &&
          state.songTime >= state.runner.floatReleaseAtTime
        ) {
          startRunnerLanding(state.runner, nowMs)
        } else if (
          state.runner.airState === 'landing' &&
          nowMs >= state.runner.landingStartedAtMs + FLOAT_DESCEND_MS
        ) {
          setRunnerGrounded(state.runner)
        }

        while (state.nextTargetIndex < state.hurdles.length) {
          const hurdle = state.hurdles[state.nextTargetIndex]
          if (hurdle.state !== 'pending') {
            advanceTargetIndex(state)
            continue
          }

          if (state.songTime > hurdle.hitTime + MISS_WINDOW) {
            markMiss(hurdle, nowMs, null)
            if (state.phase !== 'playing') {
              break
            }
            continue
          }

          break
        }

        if (state.nextTargetIndex >= state.hurdles.length && state.songTime >= state.totalTime) {
          state.phase = 'finished'
          syncUi(true)
        }
      } else if (state.phase === 'losing') {
        if (nowMs >= state.runner.loseStartedAtMs + LOSE_FALL_TOTAL_MS) {
          state.phase = 'failed'
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

  const isPrestartPhase = ui.phase === 'intro-entering' || ui.phase === 'intro-ready'
  const showCourse = !isPrestartPhase
  const currentBeat = ui.songTime / SECONDS_PER_BEAT
  const runnerXPercent = getRunnerXPercent(ui, ui.nowMs)
  const runnerFrame = getRunnerFrame(ui, ui.nowMs)
  const runnerSpriteUrl =
    TEMPO_RUN_V2_ASSET_URLS[runnerFrame.spriteName] ??
    (runnerFrame.spriteName === 'runner_ready.png'
      ? TEMPO_RUN_V2_ASSET_URLS['runner_idle.png'] ?? null
      : null)
  const backgroundUrl = TEMPO_RUN_V2_ASSET_URLS['background_track.png'] ?? null
  const feedbackAssetUrl = ui.feedback ? TEMPO_RUN_V2_ASSET_URLS[ui.feedback.assetName] ?? null : null
  const feedbackVisible = ui.feedback && ui.nowMs - ui.feedback.atMs <= FEEDBACK_MS

  const visibleHurdles = showCourse
    ? ui.hurdles
        .filter((hurdle) => {
          const relativeBeats = hurdle.beat - currentBeat
          return relativeBeats >= -VIEW_BEATS_BEHIND - 1 && relativeBeats <= VIEW_BEATS_AHEAD + 1
        })
        .map((hurdle) => ({
          ...hurdle,
          leftPercent: beatToTrackPercent(hurdle.beat, currentBeat),
        }))
    : []

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

            {showCourse && (
              <header className="tempo-run-v2-overlay-hud" aria-label="Tempo run side scroll stats">
                <div className="tempo-run-v2-overlay-left">
                  <div className="tempo-run-v2-lives" aria-label={`${ui.lives} lives remaining`}>
                    {Array.from({ length: MAX_LIVES }, (_, index) => (
                      <span
                        key={index}
                        className={`tempo-run-v2-heart ${index < ui.lives ? 'is-alive' : 'is-empty'}`}
                        aria-hidden="true"
                      >
                        ♥
                      </span>
                    ))}
                  </div>
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
            )}

            {ui.phase === 'intro-ready' && (
              <div className="tempo-run-v2-start-overlay">
                <button
                  className="tempo-run-v2-start-button"
                  type="button"
                  onClick={startRun}
                >
                  Start
                </button>
              </div>
            )}

            {feedbackVisible && ui.feedback && (
              <div className="tempo-run-v2-feedback">
                {feedbackAssetUrl ? (
                  <img
                    className={`tempo-run-v2-feedback-art ${
                      ui.feedback.label !== 'Perfect' ? 'is-compact' : ''
                    }`.trim()}
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
              const hurdleAssetUrl = rhythm.hurdle ? TEMPO_RUN_V2_ASSET_URLS[rhythm.hurdle] ?? null : null
              const hurdleWidth = getHurdleRenderWidth(rhythm)

              return (
                <article
                  key={hurdle.id}
                  className={`tempo-run-v2-hurdle is-${hurdle.state}`.trim()}
                  style={{
                    left: `${hurdle.leftPercent}%`,
                    '--hurdle-accent': rhythm.accent,
                    '--hurdle-width': `${hurdleWidth}px`,
                    '--hurdle-height': `${HURDLE_RENDER_HEIGHT}px`,
                  }}
                  aria-hidden="true"
                >
                  {hurdleAssetUrl ? (
                    <img
                      className="tempo-run-v2-hurdle-art"
                      src={hurdleAssetUrl}
                      alt=""
                      aria-hidden="true"
                    />
                  ) : (
                    <div className="tempo-run-v2-hurdle-line" />
                  )}
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

          {(ui.phase === 'finished' || ui.phase === 'failed') && (
            <div className="tempo-run-v2-popup-backdrop">
              <div className="tempo-run-v2-popup">
                <p className="tempo-run-v2-popup-kicker">Tempo Run Side Scroll</p>
                <h2>{ui.phase === 'finished' ? 'Course Complete' : 'Out Of Lives'}</h2>
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

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './TempoRun.css'

const TEMPO_RUN_ASSET_URLS = Object.fromEntries(
  Object.entries(
    import.meta.glob('./assets/tempo_run_assets/*.png', {
      eager: true,
      import: 'default',
    }),
  ).map(([path, url]) => [path.split('/').pop(), url]),
)

const BPM = 108
const SECONDS_PER_BEAT = 60 / BPM
const HURDLE_TRAVEL_TIME = 2.35
const PERFECT_WINDOW = 0.055
const GOOD_WINDOW = 0.16
const MISS_WINDOW = 0.24
const UI_SYNC_MS = 90
const JUMP_ANIMATION_MS = 320
const STUMBLE_ANIMATION_MS = 520
const RUN_FRAME_MS = 90
const START_LEAD_BEATS = 4
const COURSE_REPEATS = 4

const RHYTHM_TYPES = [
  {
    key: 'quarter',
    label: 'Quarter',
    beats: 1,
    hurdle: 'hurdle_quarter.png',
    icon: 'rhythm_quarter_icon.png',
    accent: '#fdd055',
  },
  {
    key: 'eighth',
    label: 'Eighth',
    beats: 0.5,
    hurdle: 'hurdle_eighth.png',
    icon: 'rhythm_eighth_icon.png',
    accent: '#74e8d4',
  },
  {
    key: 'sixteenth',
    label: 'Sixteenth',
    beats: 0.25,
    hurdle: 'hurdle_sixteenth.png',
    icon: 'rhythm_sixteenth_icon.png',
    accent: '#ff876c',
  },
  {
    key: 'half',
    label: 'Half',
    beats: 2,
    hurdle: 'hurdle_half.png',
    icon: 'rhythm_half_icon.png',
    accent: '#a29aff',
  },
  {
    key: 'whole',
    label: 'Whole',
    beats: 4,
    hurdle: 'hurdle_whole.png',
    icon: 'rhythm_half_icon.png',
    accent: '#f4f7fb',
  },
]

const RHYTHM_BY_KEY = Object.fromEntries(RHYTHM_TYPES.map((type) => [type.key, type]))
const COURSE_SEQUENCE = [
  'quarter',
  'eighth',
  'eighth',
  'half',
  'quarter',
  'sixteenth',
  'sixteenth',
  'quarter',
  'whole',
  'eighth',
  'eighth',
  'half',
  'quarter',
  'sixteenth',
  'eighth',
  'quarter',
  'half',
]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function lerp(start, end, amount) {
  return start + (end - start) * amount
}

function formatMs(deltaSec) {
  const rounded = Math.round(deltaSec * 1000)
  return `${rounded > 0 ? '+' : ''}${rounded}ms`
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = src
  })
}

function createCourse() {
  let beatCursor = START_LEAD_BEATS
  const hurdles = []

  for (let repeat = 0; repeat < COURSE_REPEATS; repeat += 1) {
    for (let index = 0; index < COURSE_SEQUENCE.length; index += 1) {
      const rhythmKey = COURSE_SEQUENCE[index]
      const rhythm = RHYTHM_BY_KEY[rhythmKey]
      hurdles.push({
        id: `${repeat}-${index}`,
        rhythmKey,
        hitTime: beatCursor * SECONDS_PER_BEAT,
        state: 'pending',
        judgedAt: null,
        result: null,
      })
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
    startedAtMs: 0,
    endPopupAtMs: 0,
    resumeAtMs: 0,
    songTime: 0,
    score: 0,
    combo: 0,
    bestCombo: 0,
    lives: 3,
    hits: 0,
    misses: 0,
    nextTargetIndex: 0,
    hurdles: course.hurdles.map((hurdle) => ({ ...hurdle })),
    totalTime: course.totalTime,
    feedback: null,
    runner: {
      jumpStartedAtMs: -Infinity,
      stumbleStartedAtMs: -Infinity,
      lastInputAtMs: -Infinity,
    },
    lastUiSyncAtMs: 0,
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

function buildFeedback(kind, deltaSec, combo) {
  if (kind === 'perfect') {
    return {
      label: 'Perfect',
      detail: formatMs(deltaSec),
      assetName: 'fx_perfect.png',
      color: '#fff08e',
      comboUp: combo > 0 && combo % 4 === 0,
    }
  }

  if (kind === 'early') {
    return {
      label: 'Early',
      detail: formatMs(deltaSec),
      assetName: 'fx_good.png',
      color: '#74e8d4',
      comboUp: combo > 0 && combo % 4 === 0,
    }
  }

  if (kind === 'late') {
    return {
      label: 'Late',
      detail: formatMs(deltaSec),
      assetName: 'fx_good.png',
      color: '#ffb86d',
      comboUp: combo > 0 && combo % 4 === 0,
    }
  }

  return {
    label: 'Miss',
    detail: deltaSec === null ? 'No jump' : formatMs(deltaSec),
    assetName: 'fx_miss.png',
    color: '#ff7b86',
    comboUp: false,
  }
}

function createUiSnapshot(state) {
  return {
    phase: state.phase,
    score: state.score,
    combo: state.combo,
    bestCombo: state.bestCombo,
    lives: state.lives,
    feedback: state.feedback,
  }
}

function ensureCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const dpr = window.devicePixelRatio || 1
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  const context = canvas.getContext('2d')
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { context, width, height }
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
    }
  }

  const jumpElapsed = nowMs - state.runner.jumpStartedAtMs
  if (jumpElapsed < JUMP_ANIMATION_MS) {
    const progress = clamp(jumpElapsed / JUMP_ANIMATION_MS, 0, 1)
    const spriteName =
      progress < 0.28
        ? 'runner_jump_start.png'
        : progress < 0.72
          ? 'runner_jump_mid.png'
          : 'runner_jump_land.png'

    return {
      spriteName,
      jumpOffset: Math.sin(progress * Math.PI) * 74,
    }
  }

  if (state.phase !== 'playing' && state.phase !== 'failing' && state.phase !== 'recovering') {
    return {
      spriteName: 'runner_idle.png',
      jumpOffset: 0,
    }
  }

  const frame = Math.floor(nowMs / RUN_FRAME_MS) % 4
  return {
    spriteName: `runner_run_0${frame + 1}.png`,
    jumpOffset: Math.sin(nowMs / 120) * 3,
  }
}

function drawScrollingBackground(context, image, width, height, songTime) {
  if (!image) {
    context.fillStyle = '#081019'
    context.fillRect(0, 0, width, height)
    return
  }

  const scale = Math.max(width / image.width, height / image.height) * 1.12
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale
  const x = (width - drawWidth) / 2
  const scrollOffset = ((songTime * 165) % drawHeight) - drawHeight * 0.36

  context.drawImage(image, x, scrollOffset - drawHeight, drawWidth, drawHeight)
  context.drawImage(image, x, scrollOffset, drawWidth, drawHeight)

  const vignette = context.createLinearGradient(0, 0, 0, height)
  vignette.addColorStop(0, 'rgba(6, 10, 18, 0.2)')
  vignette.addColorStop(0.48, 'rgba(6, 10, 18, 0.02)')
  vignette.addColorStop(1, 'rgba(4, 7, 14, 0.46)')
  context.fillStyle = vignette
  context.fillRect(0, 0, width, height)
}

function drawTrackDecor(context, width, height) {
  const horizonY = height * 0.215
  const hitY = height * 0.79
  const centerX = width / 2
  const leftTop = centerX - width * 0.09
  const rightTop = centerX + width * 0.09
  const leftBase = centerX - width * 0.31
  const rightBase = centerX + width * 0.31

  context.strokeStyle = 'rgba(201, 240, 255, 0.92)'
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(leftTop, horizonY)
  context.lineTo(leftBase, hitY + height * 0.12)
  context.moveTo(rightTop, horizonY)
  context.lineTo(rightBase, hitY + height * 0.12)
  context.stroke()

  context.strokeStyle = 'rgba(255, 214, 98, 0.72)'
  context.lineWidth = 6
  context.beginPath()
  context.moveTo(centerX, horizonY)
  context.lineTo(centerX, hitY + height * 0.12)
  context.stroke()

  context.strokeStyle = 'rgba(255, 255, 255, 0.16)'
  for (let index = 0; index < 10; index += 1) {
    const t = index / 9
    const y = lerp(horizonY + 38, hitY + height * 0.08, t)
    const halfWidth = lerp(width * 0.06, width * 0.25, t)
    context.lineWidth = lerp(1.2, 4.5, t)
    context.beginPath()
    context.moveTo(centerX - halfWidth, y)
    context.lineTo(centerX + halfWidth, y)
    context.stroke()
  }

  context.fillStyle = 'rgba(255, 246, 166, 0.18)'
  context.fillRect(centerX - width * 0.19, hitY - 12, width * 0.38, 26)
  context.strokeStyle = 'rgba(255, 238, 145, 0.96)'
  context.lineWidth = 4
  context.strokeRect(centerX - width * 0.19, hitY - 12, width * 0.38, 26)
}

function drawHurdles(context, assets, state, width, height) {
  const horizonY = height * 0.23
  const hitY = height * 0.78
  const centerX = width / 2

  for (const hurdle of state.hurdles) {
    const timeToHit = hurdle.hitTime - state.songTime
    const rawProgress = 1 - timeToHit / HURDLE_TRAVEL_TIME
    if (rawProgress < 0 || rawProgress > 1.18) continue

    const depth = clamp(rawProgress, 0, 1.06)
    const eased = depth * depth
    const rhythm = RHYTHM_BY_KEY[hurdle.rhythmKey]
    const image = assets[rhythm.hurdle]
    if (!image) continue

    const y = lerp(horizonY, hitY, eased)
    const spriteScale = lerp(0.14, 0.82, eased)
    const drawWidth = image.width * spriteScale * 0.62
    const drawHeight = image.height * spriteScale * 0.62
    const x = centerX - drawWidth / 2
    const shadowWidth = drawWidth * 0.65
    const shadowHeight = Math.max(8, drawHeight * 0.08)

    let alpha = 1
    if (hurdle.state === 'cleared' && hurdle.judgedAt !== null) {
      alpha = clamp(1 - (state.songTime - hurdle.judgedAt) / 0.32, 0, 1)
    }
    if (hurdle.state === 'missed' && hurdle.judgedAt !== null) {
      alpha = clamp(1 - (state.songTime - hurdle.judgedAt) / 0.5, 0, 1)
    }
    if (alpha <= 0) continue

    context.globalAlpha = alpha
    context.fillStyle =
      hurdle.state === 'missed' ? 'rgba(255, 107, 122, 0.3)' : 'rgba(7, 12, 22, 0.34)'
    context.beginPath()
    context.ellipse(
      centerX,
      y + drawHeight * 0.37,
      shadowWidth,
      shadowHeight,
      0,
      0,
      Math.PI * 2,
    )
    context.fill()

    if (
      state.phase === 'playing' &&
      state.nextTargetIndex < state.hurdles.length &&
      hurdle.id === state.hurdles[state.nextTargetIndex].id
    ) {
      context.strokeStyle = `${rhythm.accent}bb`
      context.lineWidth = Math.max(2, drawWidth * 0.03)
      context.beginPath()
      context.ellipse(
        centerX,
        y + drawHeight * 0.36,
        drawWidth * 0.48,
        drawHeight * 0.13,
        0,
        0,
        Math.PI * 2,
      )
      context.stroke()
    }

    context.drawImage(image, x, y - drawHeight * 0.58, drawWidth, drawHeight)
    context.globalAlpha = 1
  }
}

function drawRunner(context, assets, state, nowMs, width, height) {
  const { spriteName, jumpOffset } = getRunnerFrame(state, nowMs)
  const image = assets[spriteName]
  if (!image) return

  const baseHeight = height * 0.36
  const scale = baseHeight / image.height
  const drawWidth = image.width * scale
  const drawHeight = image.height * scale
  const x = width / 2 - drawWidth / 2
  const y = height * 0.55 - jumpOffset

  context.fillStyle = 'rgba(5, 8, 18, 0.34)'
  context.beginPath()
  context.ellipse(width / 2, height * 0.88, drawWidth * 0.2, 16, 0, 0, Math.PI * 2)
  context.fill()

  context.drawImage(image, x, y, drawWidth, drawHeight)
}

function drawFeedback(context, assets, feedback, nowMs, width, height) {
  if (!feedback) return

  const age = nowMs - feedback.atMs
  if (age > 980) return

  const fade = clamp(1 - age / 980, 0, 1)
  const effectImage = assets[feedback.assetName]
  if (effectImage) {
    const drawWidth = Math.min(width * 0.32, effectImage.width * 0.8)
    const drawHeight = (effectImage.height / effectImage.width) * drawWidth
    context.globalAlpha = fade
    context.drawImage(effectImage, width / 2 - drawWidth / 2, height * 0.08, drawWidth, drawHeight)
    context.globalAlpha = 1
  }

  context.save()
  context.globalAlpha = fade
  context.fillStyle = feedback.color
  context.font = "700 28px 'Press Start 2P', 'Segoe UI', sans-serif"
  context.textAlign = 'center'
  context.fillText(feedback.label.toUpperCase(), width / 2, height * 0.12 + 112)
  context.font = "700 18px 'Segoe UI', sans-serif"
  context.fillStyle = 'rgba(242, 247, 255, 0.92)'
  context.fillText(feedback.detail, width / 2, height * 0.12 + 148)
  context.restore()

  if (feedback.comboUp) {
    const comboImage = assets['fx_combo_up.png']
    if (!comboImage) return
    const drawWidth = Math.min(width * 0.18, comboImage.width * 0.6)
    const drawHeight = (comboImage.height / comboImage.width) * drawWidth
    context.save()
    context.globalAlpha = clamp(1 - age / 700, 0, 1)
    context.drawImage(comboImage, width * 0.73, height * 0.18, drawWidth, drawHeight)
    context.restore()
  }
}

function drawTempoRunFrame(canvas, assets, state, nowMs) {
  const { context, width, height } = ensureCanvasSize(canvas)
  context.clearRect(0, 0, width, height)

  drawScrollingBackground(context, assets['background_track.png'], width, height, state.songTime)
  drawTrackDecor(context, width, height)
  drawHurdles(context, assets, state, width, height)
  drawRunner(context, assets, state, nowMs, width, height)
  drawFeedback(context, assets, state.feedback, nowMs, width, height)
}

function TempoRun({ onExit }) {
  const canvasRef = useRef(null)
  const assetsRef = useRef({})
  const animationRef = useRef(null)
  const course = useMemo(() => createCourse(), [])
  const gameRef = useRef(createGameState(course))
  const [assetsReady, setAssetsReady] = useState(false)
  const [ui, setUi] = useState(() => createUiSnapshot(createGameState(course)))

  const syncUi = useCallback((force = false) => {
    const state = gameRef.current
    const nowMs = performance.now()
    if (!force && nowMs - state.lastUiSyncAtMs < UI_SYNC_MS) return
    state.lastUiSyncAtMs = nowMs
    const snapshot = createUiSnapshot(state)
    startTransition(() => {
      setUi(snapshot)
    })
  }, [])

  const startRun = useCallback(() => {
    gameRef.current = createGameState(course)
    gameRef.current.phase = 'playing'
    gameRef.current.startedAtMs = performance.now()
    gameRef.current.songTime = 0
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
      state.runner.stumbleStartedAtMs = nowMs
      state.feedback = {
        ...buildFeedback('miss', deltaSec, state.combo),
        atMs: nowMs,
      }
      if (state.lives <= 0) {
        state.phase = 'failing'
        state.endPopupAtMs = nowMs + STUMBLE_ANIMATION_MS + 90
      } else {
        state.phase = 'recovering'
        state.resumeAtMs = nowMs + STUMBLE_ANIMATION_MS + 90
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

      const kind =
        Math.abs(deltaSec) <= PERFECT_WINDOW ? 'perfect' : deltaSec < 0 ? 'early' : 'late'

      hurdle.state = 'cleared'
      hurdle.result = kind
      hurdle.judgedAt = state.songTime
      state.combo += 1
      state.bestCombo = Math.max(state.bestCombo, state.combo)
      state.hits += 1
      state.score += kind === 'perfect' ? 150 : 110
      state.runner.jumpStartedAtMs = nowMs
      state.feedback = {
        ...buildFeedback(kind, deltaSec, state.combo),
        atMs: nowMs,
      }
      advanceTargetIndex(state)
      syncUi(true)
    },
    [syncUi],
  )

  const handleJumpInput = useCallback(() => {
    const state = gameRef.current
    const nowMs = performance.now()

    if (state.phase !== 'playing') return
    if (nowMs - state.runner.lastInputAtMs < 70) return
    state.runner.lastInputAtMs = nowMs
    state.songTime = (nowMs - state.startedAtMs) / 1000

    const hurdle = getPendingHurdle(state)
    if (!hurdle) return

    const deltaSec = state.songTime - hurdle.hitTime

    if (deltaSec < -GOOD_WINDOW) {
      state.runner.jumpStartedAtMs = nowMs
      return
    }

    if (Math.abs(deltaSec) <= GOOD_WINDOW) {
      markHit(hurdle, nowMs, deltaSec)
      return
    }

    if (deltaSec > GOOD_WINDOW && deltaSec <= MISS_WINDOW) {
      markMiss(hurdle, nowMs, deltaSec)
    }
  }, [markHit, markMiss])

  useEffect(() => {
    let cancelled = false

    Promise.all(
      Object.entries(TEMPO_RUN_ASSET_URLS).map(async ([name, src]) => [name, await loadImage(src)]),
    )
      .then((entries) => {
        if (cancelled) return
        assetsRef.current = Object.fromEntries(entries)
        setAssetsReady(true)
      })
      .catch(() => {
        if (cancelled) return
        assetsRef.current = {}
        setAssetsReady(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!assetsReady) return
    startRun()
  }, [assetsReady, startRun])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.code !== 'Space') return
      event.preventDefault()
      handleJumpInput()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleJumpInput])

  useEffect(() => {
    if (!assetsReady) return undefined

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
      } else if (state.phase === 'recovering' && nowMs >= state.resumeAtMs) {
        state.phase = 'playing'
        syncUi(true)
      } else if (state.phase === 'failing' && nowMs >= state.endPopupAtMs) {
        state.phase = 'failed'
        syncUi(true)
      }

      if (canvasRef.current) {
        drawTempoRunFrame(canvasRef.current, assetsRef.current, state, nowMs)
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
  }, [assetsReady, markMiss, syncUi])

  return (
    <main className="tempo-run-shell">
      <section className="tempo-run-stage-card">
        <div className="tempo-run-stage-wrap">
          <canvas
            ref={canvasRef}
            className="tempo-run-canvas"
            aria-label="Tempo Run rhythm course"
          />

          {assetsReady && (
            <div className="tempo-run-hud" aria-label={`Score ${ui.score}, combo ${ui.combo}`}>
              <div className="tempo-run-lives" aria-label={`${ui.lives} lives remaining`}>
                {[0, 1, 2].map((index) => (
                  <span
                    key={index}
                    className={`tempo-run-heart ${index < ui.lives ? 'is-alive' : 'is-empty'}`}
                  >
                    ♥
                  </span>
                ))}
              </div>
              <span className="tempo-run-score">{ui.score}</span>
              <span className="tempo-run-combo">{ui.combo}x</span>
            </div>
          )}

          {!assetsReady && (
            <div className="tempo-run-overlay-card is-loading">
              <h2>Loading</h2>
            </div>
          )}

          {(ui.phase === 'failed' || ui.phase === 'finished') && (
            <div className="tempo-run-popup-backdrop">
              <div className="tempo-run-popup">
                <p className="tempo-run-popup-kicker">Tempo Run</p>
                <h2>{ui.phase === 'finished' ? 'Round Complete' : 'Missed The Jump'}</h2>
                <p>
                  Score {ui.score}
                  <br />
                  Best Combo {ui.bestCombo}
                </p>
                <div className="tempo-run-overlay-actions">
                  <button className="tempo-run-button" type="button" onClick={startRun}>
                    Reset
                  </button>
                  <button className="tempo-run-button is-secondary" type="button" onClick={onExit}>
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

export default TempoRun

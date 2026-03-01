import { useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import './App.css'
import pianoImage from './assets/piano.png'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11])
const PIANO_LINE_Y = 88
const HIT_MIN_Y = 18

const READ_SPEED_OPTIONS = [1, 3, 5, 10, 15]
const LEVEL_OPTIONS = ['beginner', 'intermediate', 'advanced', 'nightmare']
const MOVEMENT_OPTIONS = ['staggered', 'classic']
const NOTE_SPRITES = import.meta.glob('./notes/*.png', { eager: true, import: 'default' })
const CONDUCTOR_SPRITES = import.meta.glob('./assets/conductor/*.png', {
  eager: true,
  import: 'default',
})
const REVOLVER_SPRITES = import.meta.glob('./assets/revolver/*.png', {
  eager: true,
  import: 'default',
})
const EAR_BACKGROUND = import.meta.glob('./assets/background.png', {
  eager: true,
  import: 'default',
})
const NOTE_SPRITE_MAP = Object.fromEntries(
  Object.entries(NOTE_SPRITES).map(([path, url]) => {
    const fileName = path.split('/').pop()
    const key = fileName.replace('.png', '')
    return [key, url]
  }),
)
const CONDUCTOR_MAP = Object.fromEntries(
  Object.entries(CONDUCTOR_SPRITES).map(([path, url]) => [path.split('/').pop(), url]),
)
const REVOLVER_MAP = Object.fromEntries(
  Object.entries(REVOLVER_SPRITES).map(([path, url]) => [path.split('/').pop(), url]),
)
const EAR_BACKGROUND_URL = EAR_BACKGROUND['./assets/background.png'] ?? null
const EAR_NOTE_POOL = [60, 62, 64, 65, 67, 69, 71]

function midiToNoteName(midi) {
  const pitchClass = midi % 12
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[pitchClass]}${octave}`
}

function midiToDisplayName(midi) {
  return midiToNoteName(midi).replace('#', '♯')
}

function midiToSimpleLabel(midi) {
  return NOTE_NAMES[midi % 12].replace('#', '♯')
}

function midiFromFrequency(freq) {
  return 69 + 12 * Math.log2(freq / 440)
}

function midiToSpriteToken(midi) {
  return midiToNoteName(midi).toLowerCase().replace('#', 's')
}

function getNoteSprite(clef, midi) {
  const key = `${clef}_${midiToSpriteToken(midi)}`
  return NOTE_SPRITE_MAP[key] ?? null
}

function getConductorSprite(state) {
  return CONDUCTOR_MAP[`${state}.png`] ?? null
}

function getRevolverSprite(shots) {
  return REVOLVER_MAP[`${shots}_shots.png`] ?? null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function autoCorrelate(buffer, sampleRate) {
  let rms = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i]
    rms += value * value
  }
  rms = Math.sqrt(rms / buffer.length)
  if (rms < 0.015) return -1

  const correlations = new Array(buffer.length).fill(0)
  let bestOffset = -1
  let bestCorrelation = 0

  for (let offset = 8; offset < buffer.length / 2; offset += 1) {
    let correlation = 0
    for (let i = 0; i < buffer.length - offset; i += 1) {
      correlation += Math.abs(buffer[i] - buffer[i + offset])
    }
    correlation = 1 - correlation / (buffer.length - offset)
    correlations[offset] = correlation

    if (correlation > bestCorrelation) {
      bestCorrelation = correlation
      bestOffset = offset
    }
  }

  if (bestCorrelation < 0.9 || bestOffset === -1) {
    return -1
  }

  let shift = 0
  if (bestOffset > 0 && bestOffset < correlations.length - 1) {
    shift =
      (correlations[bestOffset + 1] - correlations[bestOffset - 1]) /
      correlations[bestOffset]
  }

  return sampleRate / (bestOffset + 8 * shift)
}

function getPoolForLevel(level) {
  const pool = []
  let minMidi = 48
  let maxMidi = 72
  let whiteOnly = true

  if (level === 'intermediate') {
    minMidi = 45
    maxMidi = 76
    whiteOnly = false
  }

  if (level === 'advanced' || level === 'nightmare') {
    minMidi = 40
    maxMidi = 84
    whiteOnly = false
  }

  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    if (whiteOnly && !WHITE_PITCH_CLASSES.has(midi % 12)) continue
    pool.push(midi)
  }

  return pool
}

function buildNightmareChord(rootMidi, pool) {
  const chordTemplates = [
    { kind: 'triad', intervals: [0, 4, 7] },
    { kind: 'triad', intervals: [0, 3, 7] },
    { kind: 'triad', intervals: [0, 3, 6] },
    { kind: 'triad', intervals: [0, 4, 8] },
    { kind: 'seventh', intervals: [0, 4, 7, 10] },
    { kind: 'seventh', intervals: [0, 3, 7, 10] },
    { kind: 'seventh', intervals: [0, 4, 7, 11] },
  ]
  const setPool = new Set(pool)

  for (let tries = 0; tries < 12; tries += 1) {
    const picked = chordTemplates[Math.floor(Math.random() * chordTemplates.length)]
    const midis = picked.intervals.map((interval) => rootMidi + interval)
    if (midis.every((midi) => setPool.has(midi))) {
      return { midis, kind: picked.kind }
    }
  }

  return null
}

function App() {
  const [screen, setScreen] = useState('landing')
  const [showGamePicker, setShowGamePicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState({
    readSpeed: 3,
    level: 'beginner',
    movement: 'staggered',
  })

  const [notes, setNotes] = useState([])
  const [bullets, setBullets] = useState([])
  const [particles, setParticles] = useState([])
  const [lives, setLives] = useState(3)
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [detectedNote, setDetectedNote] = useState('--')
  const [micStatus, setMicStatus] = useState('idle')
  const [earRound, setEarRound] = useState(1)
  const [earBulletsLoaded, setEarBulletsLoaded] = useState(0)
  const [earTimerLeft, setEarTimerLeft] = useState(10)
  const [earInputNote, setEarInputNote] = useState('--')
  const [earConductorState, setEarConductorState] = useState('idle')
  const [earHighestRound, setEarHighestRound] = useState(1)

  const rafRef = useRef(null)
  const lastFrameRef = useRef(0)
  const notePoolRef = useRef([])
  const gameStateRef = useRef(null)
  const earTimeoutsRef = useRef([])
  const toneRef = useRef({
    sampler: null,
    ready: false,
    loadingPromise: null,
  })
  const micRef = useRef({
    stream: null,
    audioContext: null,
    analyser: null,
    data: null,
    lastHitAt: 0,
    lastNoteUpdate: 0,
  })

  const stopAudio = () => {
    const mic = micRef.current
    if (mic.stream) {
      mic.stream.getTracks().forEach((track) => track.stop())
    }
    if (mic.audioContext) {
      mic.audioContext.close()
    }

    micRef.current = {
      stream: null,
      audioContext: null,
      analyser: null,
      data: null,
      lastHitAt: 0,
      lastNoteUpdate: 0,
    }
  }

  const clearEarTimeouts = () => {
    for (const timeoutId of earTimeoutsRef.current) {
      clearTimeout(timeoutId)
    }
    earTimeoutsRef.current = []
  }

  const scheduleEarTimeout = (fn, delayMs) => {
    const timeoutId = setTimeout(fn, delayMs)
    earTimeoutsRef.current.push(timeoutId)
  }

  const stopGameLoop = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    clearEarTimeouts()
  }

  const endRun = () => {
    stopGameLoop()
    stopAudio()
    setScreen('gameOver')
  }

  const setupMicrophone = async () => {
    setMicStatus('requesting')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const audioContext = new window.AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)

    micRef.current = {
      stream,
      audioContext,
      analyser,
      data: new Float32Array(analyser.fftSize),
      lastHitAt: 0,
      lastNoteUpdate: 0,
    }

    setMicStatus('ready')
  }

  const initializePianoSampler = async () => {
    if (toneRef.current.ready && toneRef.current.sampler) return
    if (toneRef.current.loadingPromise) {
      await toneRef.current.loadingPromise
      return
    }

    toneRef.current.loadingPromise = (async () => {
      await Tone.start()
      const sampler = new Tone.Sampler({
        urls: {
          A1: 'A1.mp3',
          C2: 'C2.mp3',
          'D#2': 'Ds2.mp3',
          'F#2': 'Fs2.mp3',
          A2: 'A2.mp3',
          C3: 'C3.mp3',
          'D#3': 'Ds3.mp3',
          'F#3': 'Fs3.mp3',
          A3: 'A3.mp3',
          C4: 'C4.mp3',
          'D#4': 'Ds4.mp3',
          'F#4': 'Fs4.mp3',
          A4: 'A4.mp3',
          C5: 'C5.mp3',
          'D#5': 'Ds5.mp3',
          'F#5': 'Fs5.mp3',
          A5: 'A5.mp3',
        },
        release: 1.2,
        baseUrl: 'https://tonejs.github.io/audio/salamander/',
      }).toDestination()

      await Tone.loaded()
      toneRef.current.sampler = sampler
      toneRef.current.ready = true
    })()

    try {
      await toneRef.current.loadingPromise
    } finally {
      toneRef.current.loadingPromise = null
    }
  }

  const detectMicrophoneMidi = (nowMs) => {
    const mic = micRef.current
    if (!mic.analyser || !mic.audioContext || !mic.data) return null

    mic.analyser.getFloatTimeDomainData(mic.data)
    const frequency = autoCorrelate(mic.data, mic.audioContext.sampleRate)
    if (frequency <= 0) return null

    const midiValue = midiFromFrequency(frequency)
    const nearestMidi = Math.round(midiValue)
    const centsOff = Math.abs(midiValue - nearestMidi) * 100
    if (centsOff > 35) return null

    if (nowMs - mic.lastHitAt < 220) return null
    mic.lastHitAt = nowMs
    return nearestMidi
  }

  const playReferenceNote = (midi) => {
    if (toneRef.current.ready && toneRef.current.sampler) {
      const noteName = Tone.Frequency(midi, 'midi').toNote()
      toneRef.current.sampler.triggerAttackRelease(noteName, 1.1)
      return
    }

    const mic = micRef.current
    if (!mic.audioContext) return
    const audioContext = mic.audioContext
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(440 * 2 ** ((midi - 69) / 12), audioContext.currentTime)
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.5)
    oscillator.connect(gain)
    gain.connect(audioContext.destination)
    oscillator.start()
    oscillator.stop(audioContext.currentTime + 0.52)
  }

  const spawnNote = (state, nowMs) => {
    if (notePoolRef.current.length === 0) return
    const randomIndex = Math.floor(Math.random() * notePoolRef.current.length)
    const rootMidi = notePoolRef.current[randomIndex]
    const shouldSpawnChord = state.level === 'nightmare' && Math.random() < 0.5

    let midis = [rootMidi]
    let kind = 'single'
    if (shouldSpawnChord) {
      const chord = buildNightmareChord(rootMidi, notePoolRef.current)
      if (chord) {
        midis = chord.midis
        kind = chord.kind
      }
    }

    const averageMidi = midis.reduce((sum, midi) => sum + midi, 0) / Math.max(1, midis.length)
    const clef = averageMidi >= 60 ? 'treble' : 'bass'
    const laneCenter = clef === 'treble' ? 35 : 65
    const isStaggered = state.movement === 'staggered'
    const baseX = isStaggered ? clamp(laneCenter + (Math.random() * 14 - 7), 14, 86) : laneCenter
    const startY = isStaggered ? -4 - Math.random() * 10 : 0

    state.notes.push({
      id: state.nextId,
      midis,
      remainingMidis: [...midis],
      kind,
      clef,
      y: startY,
      baseX,
      x: baseX,
      driftAmp: isStaggered ? 1.8 + Math.random() * 5.2 : 0,
      driftFreq: isStaggered ? 0.8 + Math.random() * 1.9 : 1,
      driftPhase: isStaggered ? Math.random() * Math.PI * 2 : 0,
      speedFactor: isStaggered ? 0.82 + Math.random() * 0.42 : 1,
      age: 0,
      destroyAt: null,
    })
    state.nextId += 1
    state.lastSpawnAt = nowMs
  }

  const detectAndApplyHit = (state, nowMs) => {
    const mic = micRef.current
    if (!mic.analyser || !mic.audioContext || !mic.data) return

    mic.analyser.getFloatTimeDomainData(mic.data)
    const frequency = autoCorrelate(mic.data, mic.audioContext.sampleRate)

    if (frequency <= 0) {
      if (nowMs - mic.lastNoteUpdate > 120) {
        setDetectedNote('--')
        mic.lastNoteUpdate = nowMs
      }
      return
    }

    const midiValue = midiFromFrequency(frequency)
    const nearestMidi = Math.round(midiValue)
    const centsOff = Math.abs(midiValue - nearestMidi) * 100

    if (centsOff > 35) {
      if (nowMs - mic.lastNoteUpdate > 120) {
        setDetectedNote('...')
        mic.lastNoteUpdate = nowMs
      }
      return
    }

    if (nowMs - mic.lastNoteUpdate > 120) {
      setDetectedNote(midiToDisplayName(nearestMidi))
      mic.lastNoteUpdate = nowMs
    }

    if (nowMs - mic.lastHitAt < 220) return

    const targetIndex = state.notes.findIndex((note) => {
      if (note.destroyAt !== null) return false
      if (!(note.y >= HIT_MIN_Y && note.y < PIANO_LINE_Y)) return false
      return note.remainingMidis.includes(nearestMidi)
    })

    if (targetIndex !== -1) {
      const target = state.notes[targetIndex]
      target.remainingMidis = target.remainingMidis.filter((midi) => midi !== nearestMidi)
      state.streak += 1
      state.score += 6 + Math.min(state.streak, 18)
      const distance = Math.sqrt((target.x - 50) ** 2 + (target.y - 92) ** 2)
      const bulletMs = clamp(120 + distance * 7, 120, 340)
      const bulletEndAt = nowMs + bulletMs

      state.bullets.push({
        id: state.nextBulletId,
        startX: 50,
        startY: 92,
        targetX: target.x,
        targetY: target.y,
        x: 50,
        y: 92,
        startAt: nowMs,
        endAt: bulletEndAt,
      })
      state.nextBulletId += 1

      if (target.remainingMidis.length === 0) {
        const clearBonus = target.midis.length === 1 ? 6 : target.midis.length * 6
        state.score += clearBonus
        target.destroyAt = bulletEndAt
      }
      mic.lastHitAt = nowMs
    }
  }

  const startEarRound = (state) => {
    const randomIndex = Math.floor(Math.random() * EAR_NOTE_POOL.length)
    state.targetMidi = EAR_NOTE_POOL[randomIndex]
    state.mode = 'resolving'
    setEarInputNote('--')
    setEarTimerLeft(10)
    setEarConductorState('listen')
    playReferenceNote(state.targetMidi)
    scheduleEarTimeout(() => {
      state.roundDeadline = performance.now() + 10000
      state.mode = 'awaiting'
      setEarConductorState('idle')
    }, 2300)
  }

  const endEarRun = () => {
    stopGameLoop()
    stopAudio()
    clearEarTimeouts()
    setScreen('earGameOver')
  }

  const handleEarCorrect = (state) => {
    state.mode = 'resolving'
    state.round += 1
    if (state.round > state.highestRound) {
      state.highestRound = state.round
      setEarHighestRound(state.round)
    }
    setEarRound(state.round)
    setEarConductorState('right')
    scheduleEarTimeout(() => {
      setEarConductorState('idle')
    }, 2200)
    scheduleEarTimeout(() => {
      startEarRound(state)
    }, 4000)
  }

  const handleEarWrong = (state) => {
    state.mode = 'resolving'
    state.bulletsLoaded = clamp(state.bulletsLoaded + 1, 0, 6)
    setEarBulletsLoaded(state.bulletsLoaded)
    setEarConductorState('wrong')

    scheduleEarTimeout(() => setEarConductorState('reload'), 2300)
    scheduleEarTimeout(() => setEarConductorState('aim'), 3900)
    scheduleEarTimeout(() => {
      const fireChance = clamp((state.bulletsLoaded / 6) * 0.82, 0, 0.99)
      const fire = Math.random() < fireChance
      if (fire) {
        setEarConductorState('fire')
        scheduleEarTimeout(() => {
          setEarHighestRound(state.highestRound)
          endEarRun()
        }, 1900)
      } else {
        state.round += 1
        if (state.round > state.highestRound) {
          state.highestRound = state.round
          setEarHighestRound(state.round)
        }
        setEarRound(state.round)
        setEarConductorState('idle')
        scheduleEarTimeout(() => startEarRound(state), 4000)
      }
    }, 5500)
  }

  const earGameLoop = (nowMs) => {
    const state = gameStateRef.current
    if (!state || state.type !== 'ear') return

    if (state.mode === 'awaiting') {
      const remainingMs = Math.max(0, state.roundDeadline - nowMs)
      setEarTimerLeft(Math.ceil(remainingMs / 1000))

      const detectedMidi = detectMicrophoneMidi(nowMs)
      if (detectedMidi !== null) {
        setEarInputNote(midiToSimpleLabel(detectedMidi))
        if (detectedMidi % 12 === state.targetMidi % 12) {
          handleEarCorrect(state)
        } else {
          handleEarWrong(state)
        }
      } else if (remainingMs <= 0) {
        setEarInputNote('TIME')
        handleEarWrong(state)
      }
    }

    rafRef.current = requestAnimationFrame(earGameLoop)
  }

  const gameLoop = (nowMs) => {
    const state = gameStateRef.current
    if (!state || state.type !== 'arcade') return

    if (lastFrameRef.current === 0) {
      lastFrameRef.current = nowMs
    }

    const dt = (nowMs - lastFrameRef.current) / 1000
    lastFrameRef.current = nowMs

    state.elapsed += dt

    const baseSpawnGap =
      state.level === 'beginner'
        ? 4.6
        : state.level === 'intermediate'
          ? 4.2
          : state.level === 'advanced'
            ? 3.8
            : 3.4
    const ramp = Math.min(1.2, state.elapsed / 120)
    const spawnGap = Math.max(2.2, baseSpawnGap - ramp)

    if (nowMs - state.lastSpawnAt > spawnGap * 1000) {
      spawnNote(state, nowMs)
    }

    const baseNoteVelocity = 100 / state.readSpeed
    let misses = 0
    const movedNotes = []
    const newParticles = []

    for (const note of state.notes) {
      if (note.destroyAt !== null) {
        if (nowMs >= note.destroyAt) {
          for (let i = 0; i < 9; i += 1) {
            const angle = Math.random() * Math.PI * 2
            const speed = 4 + Math.random() * 8
            newParticles.push({
              id: state.nextParticleId,
              x: note.x,
              y: note.y,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed - 1.5,
              bornAt: nowMs,
              dieAt: nowMs + 280 + Math.random() * 120,
            })
            state.nextParticleId += 1
          }
          continue
        }
        movedNotes.push(note)
        continue
      }

      const nextAge = note.age + dt
      const nextY = note.y + baseNoteVelocity * note.speedFactor * dt
      const drift = Math.sin(nextAge * note.driftFreq + note.driftPhase) * note.driftAmp
      const nextX = clamp(note.baseX + drift, 10, 90)
      if (nextY >= PIANO_LINE_Y) {
        misses += 1
      } else {
        movedNotes.push({ ...note, age: nextAge, y: nextY, x: nextX })
      }
    }

    state.notes = movedNotes
    if (newParticles.length > 0) {
      state.particles.push(...newParticles)
    }
    state.bullets = state.bullets
      .filter((bullet) => nowMs < bullet.endAt)
      .map((bullet) => {
        const progress = clamp((nowMs - bullet.startAt) / (bullet.endAt - bullet.startAt), 0, 1)
        return {
          ...bullet,
          x: bullet.startX + (bullet.targetX - bullet.startX) * progress,
          y: bullet.startY + (bullet.targetY - bullet.startY) * progress,
        }
      })
    state.particles = state.particles
      .filter((particle) => nowMs < particle.dieAt)
      .map((particle) => {
        const life = clamp((nowMs - particle.bornAt) / (particle.dieAt - particle.bornAt), 0, 1)
        return {
          ...particle,
          x: particle.x + particle.vx * 0.016,
          y: particle.y + particle.vy * 0.016 + life * 0.42,
        }
      })

    if (misses > 0) {
      state.lives -= misses
      state.streak = 0
    }

    detectAndApplyHit(state, nowMs)

    if (state.lives <= 0) {
      setNotes([])
      setLives(0)
      setStreak(0)
      setParticles([])
      endRun()
      return
    }

    setNotes([...state.notes])
    setBullets([...state.bullets])
    setParticles([...state.particles])
    setLives(state.lives)
    setScore(state.score)
    setStreak(state.streak)

    rafRef.current = requestAnimationFrame(gameLoop)
  }

  const startRun = async () => {
    stopGameLoop()
    stopAudio()

    setLives(3)
    setScore(0)
    setStreak(0)
    setDetectedNote('--')
    setNotes([])
    setBullets([])
    setParticles([])

    notePoolRef.current = getPoolForLevel(settings.level)

    gameStateRef.current = {
      type: 'arcade',
      lives: 3,
      score: 0,
      streak: 0,
      elapsed: 0,
      level: settings.level,
      movement: settings.movement,
      readSpeed: Number(settings.readSpeed),
      notes: [],
      bullets: [],
      particles: [],
      lastSpawnAt: performance.now(),
      nextId: 1,
      nextBulletId: 1,
      nextParticleId: 1,
    }

    try {
      await setupMicrophone()
      setScreen('game')
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(gameLoop)
    } catch {
      setMicStatus('error')
      setScreen('landing')
      setShowSettings(false)
    }
  }

  const startEarRun = async () => {
    stopGameLoop()
    stopAudio()
    clearEarTimeouts()

    setDetectedNote('--')
    setEarRound(1)
    setEarHighestRound(1)
    setEarBulletsLoaded(0)
    setEarInputNote('--')
    setEarTimerLeft(10)
    setEarConductorState('idle')

    gameStateRef.current = {
      type: 'ear',
      mode: 'booting',
      round: 1,
      highestRound: 1,
      bulletsLoaded: 0,
      targetMidi: EAR_NOTE_POOL[0],
      roundDeadline: 0,
    }

    try {
      await setupMicrophone()
      try {
        await initializePianoSampler()
      } catch {
        // Fallback in playReferenceNote handles cases where samples cannot load.
      }
      setScreen('earGame')
      setShowGamePicker(false)
      startEarRound(gameStateRef.current)
      rafRef.current = requestAnimationFrame(earGameLoop)
    } catch {
      setMicStatus('error')
      setScreen('landing')
      setShowGamePicker(false)
    }
  }

  useEffect(() => {
    return () => {
      stopGameLoop()
      stopAudio()
      if (toneRef.current.sampler) {
        toneRef.current.sampler.dispose()
        toneRef.current.sampler = null
        toneRef.current.ready = false
      }
    }
  }, [])

  return (
    <div
      className={`app-shell ${
        screen === 'game' || screen === 'earGame' || screen === 'earGameOver'
          ? 'game-mode'
          : 'menu-mode'
      }`}
    >
      {screen === 'landing' && (
        <main className="landing">
          <h1 className="crawl-title">Piano Drills</h1>
          <button className="start-button" onClick={() => setShowGamePicker(true)}>
            Start
          </button>
          {micStatus === 'error' && (
            <p className="error">Microphone permission is required to play.</p>
          )}
        </main>
      )}

      {screen === 'game' && (
        <main className="game">
          <header className="hud">
            <span>Lives: {lives}</span>
            <span>Score: {score}</span>
            <span>Streak: {streak}</span>
            <span>Mic: {detectedNote}</span>
          </header>

          <section className="lane" aria-label="Music lane">
            <div className="staff" />
            <div className="bullet-layer" aria-hidden="true">
              {bullets.map((bullet) => (
                <span
                  key={bullet.id}
                  className="bullet-dot"
                  style={{ left: `${bullet.x}%`, top: `${bullet.y}%` }}
                />
              ))}
              {particles.map((particle) => (
                <span
                  key={particle.id}
                  className="particle-dot"
                  style={{
                    left: `${particle.x}%`,
                    top: `${particle.y}%`,
                    opacity: clamp(
                      1 - (performance.now() - particle.bornAt) / (particle.dieAt - particle.bornAt),
                      0,
                      1,
                    ),
                  }}
                />
              ))}
            </div>
            {notes.map((note) => {
              const previewMidi =
                note.remainingMidis.find((midi) => getNoteSprite(note.clef, midi)) ??
                note.remainingMidis[0] ??
                note.midis[0]
              const spriteSrc = getNoteSprite(note.clef, previewMidi)

              return (
                <article
                  key={note.id}
                  className="note"
                  style={{ top: `${note.y}%`, left: `${note.x}%` }}
                >
                  {spriteSrc ? (
                    <img
                      className="note-sprite"
                      src={spriteSrc}
                      alt={`${note.clef} ${midiToDisplayName(previewMidi)}`}
                    />
                  ) : (
                    <span>{midiToDisplayName(previewMidi)}</span>
                  )}
                  {note.kind !== 'single' && (
                    <small className="chord-left">{note.remainingMidis.length}</small>
                  )}
                </article>
              )
            })}
            <div className="piano-line" />
            <img className="piano-image" src={pianoImage} alt="Piano" />
          </section>
        </main>
      )}

      {screen === 'gameOver' && (
        <main className="game-over">
          <h2>Game Over</h2>
          <p>Your score: {score}</p>
          <div className="game-over-actions">
            <button className="primary" onClick={() => setShowSettings(true)}>
              Play Again
            </button>
            <button className="primary" onClick={() => setScreen('landing')}>
              Title Screen
            </button>
          </div>
        </main>
      )}

      {screen === 'earGame' && (
        <main className="ear-game-shell">
          <section
            className="ear-game-window"
            style={
              EAR_BACKGROUND_URL ? { backgroundImage: `url(${EAR_BACKGROUND_URL})` } : undefined
            }
          >
            {getConductorSprite(earConductorState) ? (
              <img
                className="conductor-sprite"
                src={getConductorSprite(earConductorState)}
                alt="Conductor"
              />
            ) : (
              <div className="conductor-fallback">{earConductorState}</div>
            )}

            <div className="round-badge">Round {earRound}</div>

            <div className="revolver-panel">
              {getRevolverSprite(earBulletsLoaded) ? (
                <img
                  className="revolver-sprite"
                  src={getRevolverSprite(earBulletsLoaded)}
                  alt={`${earBulletsLoaded} loaded shots`}
                />
              ) : (
                <div className="revolver-fallback">{earBulletsLoaded}/6</div>
              )}
            </div>

            <aside className="ear-right-ui">
              <div className="timer-pill">{earTimerLeft}s</div>
              <div className="note-feedback">{earInputNote}</div>
            </aside>
          </section>
        </main>
      )}

      {screen === 'earGameOver' && (
        <main className="ear-game-over">
          <h2>Game Over</h2>
          <p>Highest Round: {earHighestRound}</p>
          <div className="game-over-actions">
            <button className="primary" onClick={startEarRun}>
              Try Again
            </button>
            <button className="primary" onClick={() => setScreen('landing')}>
              Title Screen
            </button>
          </div>
        </main>
      )}

      {showSettings && (
        <aside className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Session Settings</h2>

            <label>
              Read speed (seconds to reach piano)
              <select
                value={settings.readSpeed}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    readSpeed: Number(event.target.value),
                  }))
                }
              >
                {READ_SPEED_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}s
                  </option>
                ))}
              </select>
            </label>

            <label>
              Music level
              <select
                value={settings.level}
                onChange={(event) =>
                  setSettings((previous) => ({ ...previous, level: event.target.value }))
                }
              >
                {LEVEL_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Movement style
              <select
                value={settings.movement}
                onChange={(event) =>
                  setSettings((previous) => ({ ...previous, movement: event.target.value }))
                }
              >
                {MOVEMENT_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>

            <button
              className="primary"
              onClick={() => {
                setShowSettings(false)
                startRun()
              }}
            >
              Begin
            </button>
            <button className="secondary" onClick={() => setShowSettings(false)}>
              Cancel
            </button>
          </div>
        </aside>
      )}

      {showGamePicker && (
        <aside className="picker-backdrop" onClick={() => setShowGamePicker(false)}>
          <div className="picker-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Select A Game</h2>
            <div className="game-card-grid">
              <button
                className="game-card is-active"
                onClick={() => {
                  setShowGamePicker(false)
                  setShowSettings(true)
                }}
              >
                <div className="game-card-art" />
                <span>Piano Arcade</span>
              </button>

              <button
                className="game-card is-active"
                onClick={() => {
                  startEarRun()
                }}
              >
                <div className="game-card-art" />
                <span>Play It By Ear</span>
              </button>

              <button className="game-card" type="button" disabled>
                <div className="game-card-art" />
                <span>Coming Soon</span>
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

export default App



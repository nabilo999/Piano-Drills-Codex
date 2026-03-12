import { useEffect, useRef, useState } from 'react'
import * as Tone from 'tone'
import './App.css'
import pianoImage from './assets/piano.png'
import arcadeCardImage from './assets/arcade_background.PNG'
import playItByEarCardImage from './assets/play_it_by_ear_card.png'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11])
const PIANO_LINE_Y = 92
const HIT_MIN_Y = 18
const MIC_MIN_RMS = 0.02
const MIC_STABLE_CENTS = 30
const MIC_HISTORY_SIZE = 6
const MIC_CONFIRM_FRAMES = 3
const MIC_MAX_JUMP_SEMITONES = 7
const MIC_NOTE_HOLD_MS = 180

const READ_SPEED_OPTIONS = [1, 3, 5, 10, 15]
const LEVEL_OPTIONS = ['beginner', 'intermediate', 'advanced', 'nightmare']
const MOVEMENT_OPTIONS = ['staggered', 'classic']
const UI_FRAME_MS = 1000 / 30
const AUDIO_UNLOCK_SRC =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA='
const NOTE_SPRITE_LOADERS = import.meta.glob('./notes/*.png', { import: 'default' })
const CONDUCTOR_SPRITE_LOADERS = import.meta.glob('./assets/conductor/*.png', {
  import: 'default',
})
const REVOLVER_SPRITE_LOADERS = import.meta.glob('./assets/revolver/*.png', {
  import: 'default',
})
const EAR_BACKGROUND_LOADERS = import.meta.glob('./assets/background.png', {
  import: 'default',
})
const SFX_LOADERS = import.meta.glob('./assets/sfx/*.mp3', {
  import: 'default',
})
const EMPTY_SFX_BANK = {
  correct: null,
  wrong: null,
  reloads: [],
  pump: null,
  shotgunBlast: null,
  shellFalling: null,
  dryFire: [],
  heartbeatMed: null,
  heartbeatFast: null,
  littleTroubleThere: null,
  notQuiteMyTempo: null,
  youreDone: null,
  shipBlast: null,
  shipDamage: null,
  shipExplode: null,
}

const buildSfxBank = (map) => {
  const get = (key) => map?.[key] ?? null
  return {
    correct: get('correct'),
    wrong: get('wrong'),
    reloads: [get('shell_load1'), get('shell_load2'), get('shot_load3')].filter(Boolean),
    pump: get('pump_action'),
    shotgunBlast: get('shotgun_blast'),
    shellFalling: get('shell_falling'),
    dryFire: [get('dry_fire1'), get('dry_fire2')].filter(Boolean),
    heartbeatMed: get('heartbeat_med'),
    heartbeatFast: get('heartbeat_fast'),
    littleTroubleThere: get('little_trouble_there'),
    notQuiteMyTempo: get('not_quite_my_tempo'),
    youreDone: get('youre_done'),
    shipBlast: get('ship_blast'),
    shipDamage: get('ship_damage'),
    shipExplode: get('ship_explode'),
  }
}
const EAR_NOTE_POOL = [60, 62, 64, 65, 67, 69, 71]
const TESTER_NOTE_RANGE = Array.from({ length: 13 }, (_, index) => 60 + index)
const EAR_FEEDBACK_DELAY_MS = 900
const EAR_CAPTURE_WINDOW_MS = 260
const EAR_CAPTURE_MIN_SAMPLES = 3

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

function getNoteSprite(clef, midi, noteSpriteMap) {
  const key = `${clef}_${midiToSpriteToken(midi)}`
  return noteSpriteMap?.[key] ?? null
}

function getConductorSprite(state, conductorMap) {
  return conductorMap?.[`${state}.png`] ?? null
}

function getRevolverSprite(shots, revolverMap) {
  return revolverMap?.[`${shots}_shots.png`] ?? null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getTesterPositionPercent(midiValue) {
  if (midiValue === null) return 50
  const rangeStart = TESTER_NOTE_RANGE[0]
  const rangeEnd = TESTER_NOTE_RANGE[TESTER_NOTE_RANGE.length - 1]
  return ((clamp(midiValue, rangeStart, rangeEnd) - rangeStart) / (rangeEnd - rangeStart)) * 100
}

function getRms(buffer) {
  let rms = 0
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i]
    rms += value * value
  }
  return Math.sqrt(rms / buffer.length)
}

function getDominantPitchClass(midis) {
  if (midis.length === 0) return null

  const counts = new Map()
  for (const midi of midis) {
    const pitchClass = ((midi % 12) + 12) % 12
    counts.set(pitchClass, (counts.get(pitchClass) ?? 0) + 1)
  }

  let dominantPitchClass = null
  let dominantCount = -1
  for (const [pitchClass, count] of counts.entries()) {
    if (count > dominantCount) {
      dominantPitchClass = pitchClass
      dominantCount = count
    }
  }

  return dominantPitchClass
}

function autoCorrelate(buffer, sampleRate) {
  const rms = getRms(buffer)
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
  const [showPitchTester, setShowPitchTester] = useState(false)
  const [settings, setSettings] = useState({
    readSpeed: 3,
    level: 'beginner',
    movement: 'staggered',
  })

  const [noteSpriteMap, setNoteSpriteMap] = useState({})
  const [conductorMap, setConductorMap] = useState({})
  const [revolverMap, setRevolverMap] = useState({})
  const [earBackgroundUrl, setEarBackgroundUrl] = useState(null)

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
  const [earRevolverShake, setEarRevolverShake] = useState(false)
  const [earAimShake, setEarAimShake] = useState(false)
  const [earFlashActive, setEarFlashActive] = useState(false)
  const [earTimerLeft, setEarTimerLeft] = useState(10)
  const [earInputNote, setEarInputNote] = useState('--')
  const [earConductorState, setEarConductorState] = useState('idle')
  const [earHighestRound, setEarHighestRound] = useState(1)
  const [testerReading, setTesterReading] = useState({
    label: '--',
    midiValue: null,
    centsOff: null,
    stable: false,
  })

  const rafRef = useRef(null)
  const testerRafRef = useRef(null)
  const lastFrameRef = useRef(0)
  const notePoolRef = useRef([])
  const gameStateRef = useRef(null)
  const earTimeoutsRef = useRef([])
  const assetLoadRef = useRef({
    notes: null,
    conductor: null,
    revolver: null,
    background: null,
    sfx: null,
  })
  const audioUnlockRef = useRef({
    done: false,
    audio: null,
    context: null,
  })
  const lastArcadeUiSyncRef = useRef(0)
  const earUiRef = useRef({
    timerLeft: 10,
    inputNote: '--',
    lastNoteAt: 0,
  })
  const toneRef = useRef({
    sampler: null,
    ready: false,
    loadingPromise: null,
  })
  const sfxRef = useRef({
    heartbeat: null,
    heartbeatMode: null,
    preloaded: new Map(),
    bank: EMPTY_SFX_BANK,
  })
  const micRef = useRef({
    stream: null,
    audioContext: null,
    analyser: null,
    data: null,
    lastHitAt: 0,
    lastNoteUpdate: 0,
    pitchHistory: [],
    lockedMidi: null,
    lockedMidiValue: null,
    lockUntil: 0,
  })

  const loadNoteSprites = () => {
    if (assetLoadRef.current.notes) return assetLoadRef.current.notes
    assetLoadRef.current.notes = Promise.all(
      Object.entries(NOTE_SPRITE_LOADERS).map(async ([path, loader]) => {
        try {
          const url = await loader()
          const fileName = path.split('/').pop()
          const key = fileName.replace('.png', '')
          return [key, url]
        } catch {
          return null
        }
      }),
    ).then((entries) => {
      const map = Object.fromEntries(entries.filter(Boolean))
      setNoteSpriteMap(map)
      return map
    })
    return assetLoadRef.current.notes
  }

  const loadConductorSprites = () => {
    if (assetLoadRef.current.conductor) return assetLoadRef.current.conductor
    assetLoadRef.current.conductor = Promise.all(
      Object.entries(CONDUCTOR_SPRITE_LOADERS).map(async ([path, loader]) => {
        try {
          const url = await loader()
          const key = path.split('/').pop()
          return [key, url]
        } catch {
          return null
        }
      }),
    ).then((entries) => {
      const map = Object.fromEntries(entries.filter(Boolean))
      setConductorMap(map)
      return map
    })
    return assetLoadRef.current.conductor
  }

  const loadRevolverSprites = () => {
    if (assetLoadRef.current.revolver) return assetLoadRef.current.revolver
    assetLoadRef.current.revolver = Promise.all(
      Object.entries(REVOLVER_SPRITE_LOADERS).map(async ([path, loader]) => {
        try {
          const url = await loader()
          const key = path.split('/').pop()
          return [key, url]
        } catch {
          return null
        }
      }),
    ).then((entries) => {
      const map = Object.fromEntries(entries.filter(Boolean))
      setRevolverMap(map)
      return map
    })
    return assetLoadRef.current.revolver
  }

  const loadEarBackground = () => {
    if (assetLoadRef.current.background) return assetLoadRef.current.background
    const loader = EAR_BACKGROUND_LOADERS['./assets/background.png']
    assetLoadRef.current.background = (async () => {
      if (!loader) return null
      try {
        const url = await loader()
        setEarBackgroundUrl(url ?? null)
        return url
      } catch {
        setEarBackgroundUrl(null)
        return null
      }
    })()
    return assetLoadRef.current.background
  }

  const loadSfx = () => {
    if (assetLoadRef.current.sfx) return assetLoadRef.current.sfx
    assetLoadRef.current.sfx = Promise.all(
      Object.entries(SFX_LOADERS).map(async ([path, loader]) => {
        try {
          const url = await loader()
          const fileName = path.split('/').pop()
          const key = fileName.replace('.mp3', '')
          return [key, url]
        } catch {
          return null
        }
      }),
    ).then((entries) => {
      const map = Object.fromEntries(entries.filter(Boolean))
      sfxRef.current.bank = buildSfxBank(map)
      return map
    })
    return assetLoadRef.current.sfx
  }

  const ensureAudioUnlocked = () => {
    if (audioUnlockRef.current.done) return
    audioUnlockRef.current.done = true

    try {
      const audio = new Audio(AUDIO_UNLOCK_SRC)
      audio.volume = 0
      const playPromise = audio.play()
      if (playPromise?.catch) {
        playPromise.catch(() => {})
      }
      audioUnlockRef.current.audio = audio
    } catch {
      // Ignore unlock failures; a later user gesture can still succeed.
    }

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) return
      const context = new AudioContext()
      const buffer = context.createBuffer(1, 1, 22050)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start(0)
      if (context.state === 'suspended' && context.resume) {
        context.resume().catch(() => {})
      }
      audioUnlockRef.current.context = context
      setTimeout(() => {
        context.close?.().catch(() => {})
      }, 200)
    } catch {
      // Ignore unlock failures; audio can still work via HTMLAudioElement.
    }
  }

  const preloadSfx = async () => {
    const map = await loadSfx()
    if (!map) return
    const preloadAudio = (url) =>
      new Promise((resolve) => {
        if (sfxRef.current.preloaded.has(url)) {
          resolve(sfxRef.current.preloaded.get(url))
          return
        }
        const audio = new Audio(url)
        audio.preload = 'auto'
        const cleanup = () => {
          audio.removeEventListener('canplaythrough', onReady)
          audio.removeEventListener('loadeddata', onReady)
          audio.removeEventListener('error', onError)
          if (timeoutId) clearTimeout(timeoutId)
        }
        const onReady = () => {
          cleanup()
          sfxRef.current.preloaded.set(url, audio)
          resolve(audio)
        }
        const onError = () => {
          cleanup()
          resolve(null)
        }
        const timeoutId = setTimeout(() => {
          cleanup()
          sfxRef.current.preloaded.set(url, audio)
          resolve(audio)
        }, 1500)
        audio.addEventListener('canplaythrough', onReady, { once: true })
        audio.addEventListener('loadeddata', onReady, { once: true })
        audio.addEventListener('error', onError, { once: true })
        audio.load()
      })

    await Promise.allSettled(Object.values(map).filter(Boolean).map(preloadAudio))
  }

  const syncArcadeUi = (state, nowMs, force = false) => {
    if (!force && nowMs - lastArcadeUiSyncRef.current < UI_FRAME_MS) return
    lastArcadeUiSyncRef.current = nowMs
    setNotes([...state.notes])
    setBullets([...state.bullets])
    setParticles([...state.particles])
    setLives(state.lives)
    setScore(state.score)
    setStreak(state.streak)
  }

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
      pitchHistory: [],
      lockedMidi: null,
      lockedMidiValue: null,
      lockUntil: 0,
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

  const stopPitchTesterLoop = () => {
    if (testerRafRef.current) {
      cancelAnimationFrame(testerRafRef.current)
      testerRafRef.current = null
    }
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

  const closePitchTester = () => {
    stopPitchTesterLoop()
    stopAudio()
    setTesterReading({
      label: '--',
      midiValue: null,
      centsOff: null,
      stable: false,
    })
    setShowPitchTester(false)
    setMicStatus('idle')
  }

  const setupMicrophone = async () => {
    setMicStatus('requesting')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const audioContext = new window.AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.85
    source.connect(analyser)

    micRef.current = {
      stream,
      audioContext,
      analyser,
      data: new Float32Array(analyser.fftSize),
      lastHitAt: 0,
      lastNoteUpdate: 0,
      pitchHistory: [],
      lockedMidi: null,
      lockedMidiValue: null,
      lockUntil: 0,
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

  const readMicrophonePitch = () => {
    const mic = micRef.current
    if (!mic.analyser || !mic.audioContext || !mic.data) return null

    const nowMs = performance.now()
    mic.analyser.getFloatTimeDomainData(mic.data)
    const rms = getRms(mic.data)
    if (rms < MIC_MIN_RMS) {
      mic.pitchHistory = []
      if (mic.lockedMidi !== null && nowMs < mic.lockUntil) {
        return {
          frequency: null,
          midiValue: mic.lockedMidiValue ?? mic.lockedMidi,
          nearestMidi: mic.lockedMidi,
          centsOff: 0,
          stable: true,
        }
      }
      mic.lockedMidi = null
      mic.lockedMidiValue = null
      return null
    }

    const frequency = autoCorrelate(mic.data, mic.audioContext.sampleRate)
    if (frequency <= 0) {
      if (mic.lockedMidi !== null && nowMs < mic.lockUntil) {
        return {
          frequency: null,
          midiValue: mic.lockedMidiValue ?? mic.lockedMidi,
          nearestMidi: mic.lockedMidi,
          centsOff: 0,
          stable: true,
        }
      }
      mic.pitchHistory = []
      mic.lockedMidi = null
      mic.lockedMidiValue = null
      return null
    }

    const midiValue = midiFromFrequency(frequency)
    const nearestMidi = Math.round(midiValue)
    const centsOff = Math.abs(midiValue - nearestMidi) * 100
    if (centsOff > MIC_STABLE_CENTS) {
      if (mic.lockedMidi !== null && nowMs < mic.lockUntil) {
        return {
          frequency,
          midiValue: mic.lockedMidiValue ?? mic.lockedMidi,
          nearestMidi: mic.lockedMidi,
          centsOff: 0,
          stable: true,
        }
      }
      return {
        frequency,
        midiValue,
        nearestMidi,
        centsOff,
        stable: false,
      }
    }

    mic.pitchHistory.push({ midi: nearestMidi, midiValue, at: nowMs })
    if (mic.pitchHistory.length > MIC_HISTORY_SIZE) {
      mic.pitchHistory.shift()
    }

    const counts = new Map()
    for (const sample of mic.pitchHistory) {
      counts.set(sample.midi, (counts.get(sample.midi) ?? 0) + 1)
    }

    let dominantMidi = nearestMidi
    let dominantCount = 0
    for (const [midi, count] of counts.entries()) {
      if (count > dominantCount) {
        dominantMidi = midi
        dominantCount = count
      }
    }

    const hasConfirmedPitch = dominantCount >= MIC_CONFIRM_FRAMES
    const shouldResistJump =
      mic.lockedMidi !== null &&
      Math.abs(dominantMidi - mic.lockedMidi) > MIC_MAX_JUMP_SEMITONES &&
      dominantCount < MIC_CONFIRM_FRAMES + 1 &&
      nowMs < mic.lockUntil + 90

    if (hasConfirmedPitch && !shouldResistJump) {
      const dominantSamples = mic.pitchHistory.filter((sample) => sample.midi === dominantMidi)
      const averageMidiValue =
        dominantSamples.reduce((sum, sample) => sum + sample.midiValue, 0) / dominantSamples.length

      mic.lockedMidi = dominantMidi
      mic.lockedMidiValue = averageMidiValue
      mic.lockUntil = nowMs + MIC_NOTE_HOLD_MS

      return {
        frequency,
        midiValue: averageMidiValue,
        nearestMidi: dominantMidi,
        centsOff: Math.abs(averageMidiValue - dominantMidi) * 100,
        stable: true,
      }
    }

    if (mic.lockedMidi !== null && nowMs < mic.lockUntil) {
      return {
        frequency,
        midiValue: mic.lockedMidiValue ?? mic.lockedMidi,
        nearestMidi: mic.lockedMidi,
        centsOff: 0,
        stable: true,
      }
    }

    return {
      frequency,
      midiValue,
      nearestMidi,
      centsOff,
      stable: false,
    }
  }

  const pitchTesterLoop = () => {
    const pitch = readMicrophonePitch()

    if (!pitch) {
      setTesterReading({
        label: '--',
        midiValue: null,
        centsOff: null,
        stable: false,
      })
    } else {
      setTesterReading({
        label: midiToDisplayName(pitch.nearestMidi),
        midiValue: pitch.midiValue,
        centsOff: Math.round((pitch.midiValue - pitch.nearestMidi) * 100),
        stable: pitch.stable,
      })
    }

    testerRafRef.current = requestAnimationFrame(pitchTesterLoop)
  }

  const openPitchTester = async () => {
    stopGameLoop()
    stopAudio()
    stopPitchTesterLoop()
    setTesterReading({
      label: '--',
      midiValue: null,
      centsOff: null,
      stable: false,
    })

    try {
      await setupMicrophone()
      setShowPitchTester(true)
      testerRafRef.current = requestAnimationFrame(pitchTesterLoop)
    } catch {
      setMicStatus('error')
      setShowPitchTester(false)
    }
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
    const isStaggered = state.movement === 'staggered'
    const baseX = clamp(10 + Math.random() * 80, 10, 90)
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
    const pitch = readMicrophonePitch()

    if (!pitch) {
      if (nowMs - mic.lastNoteUpdate > 120) {
        setDetectedNote('--')
        mic.lastNoteUpdate = nowMs
      }
      return
    }

    if (!pitch.stable) {
      if (nowMs - mic.lastNoteUpdate > 120) {
        setDetectedNote('...')
        mic.lastNoteUpdate = nowMs
      }
      return
    }

    if (nowMs - mic.lastNoteUpdate > 120) {
      setDetectedNote(midiToDisplayName(pitch.nearestMidi))
      mic.lastNoteUpdate = nowMs
    }

    if (nowMs - mic.lastHitAt < 220) return

    const targetIndex = state.notes.findIndex((note) => {
      if (note.destroyAt !== null) return false
      if (!(note.y >= HIT_MIN_Y && note.y < PIANO_LINE_Y)) return false
      return note.remainingMidis.includes(pitch.nearestMidi)
    })

    if (targetIndex !== -1) {
      const target = state.notes[targetIndex]
      target.remainingMidis = target.remainingMidis.filter((midi) => midi !== pitch.nearestMidi)
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
      playSfx(sfxRef.current.bank.shipBlast, 0.51)
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
    state.captureStartedAt = null
    state.heardMidis = []
    setEarInputNote('--')
    setEarTimerLeft(10)
    setEarConductorState('idle')
    earUiRef.current.timerLeft = 10
    earUiRef.current.inputNote = '--'
    earUiRef.current.lastNoteAt = 0
    stopHeartbeatLoop()
    playReferenceNote(state.targetMidi)
    scheduleEarTimeout(() => {
      state.roundDeadline = performance.now() + 10000
      state.mode = 'awaiting'
    }, 2300)
  }

  const pickRandom = (options) => {
    if (!options || options.length === 0) return null
    return options[Math.floor(Math.random() * options.length)]
  }

  const playSfx = (url, volume = 0.72) => {
    if (!url) {
      void loadSfx()
      return
    }
    const cached = sfxRef.current.preloaded.get(url)
    const audio = cached ? cached.cloneNode(true) : new Audio(url)
    audio.volume = volume
    audio.play().catch(() => {})
  }

  const playRandomSfx = (urls, volume = 0.72) => {
    playSfx(pickRandom(urls), volume)
  }

  const stopHeartbeatLoop = () => {
    const heartbeat = sfxRef.current.heartbeat
    if (heartbeat) {
      heartbeat.pause()
      heartbeat.currentTime = 0
    }
    sfxRef.current.heartbeat = null
    sfxRef.current.heartbeatMode = null
  }

  const startHeartbeatLoop = (bulletsLoaded) => {
    const mode = bulletsLoaded >= 4 ? 'fast' : 'med'
    const nextUrl = mode === 'fast' ? sfxRef.current.bank.heartbeatFast : sfxRef.current.bank.heartbeatMed
    if (!nextUrl) return
    if (sfxRef.current.heartbeat && sfxRef.current.heartbeatMode === mode) return

    stopHeartbeatLoop()
    const audio = new Audio(nextUrl)
    audio.loop = true
    audio.volume = mode === 'fast' ? 0.65 : 0.55
    audio.play().catch(() => {})
    sfxRef.current.heartbeat = audio
    sfxRef.current.heartbeatMode = mode
  }

  const playReloadTaunt = (state) => {
    const bulletsLoaded = state.bulletsLoaded
    if (
      bulletsLoaded >= 1 &&
      bulletsLoaded <= 2 &&
      !state.playedTaunts.littleTroubleThere &&
      Math.random() < 0.1
    ) {
      playSfx(sfxRef.current.bank.littleTroubleThere, 0.72)
      state.playedTaunts.littleTroubleThere = true
      return
    }
    if (
      bulletsLoaded >= 3 &&
      bulletsLoaded <= 4 &&
      !state.playedTaunts.notQuiteMyTempo &&
      Math.random() < 0.1
    ) {
      playSfx(sfxRef.current.bank.notQuiteMyTempo, 0.72)
      state.playedTaunts.notQuiteMyTempo = true
    }
  }

  const playAimTaunt = (bulletsLoaded) => {
    if (bulletsLoaded >= 6) {
      playSfx(sfxRef.current.bank.youreDone, 0.78)
    }
  }

  const endEarRun = () => {
    stopGameLoop()
    stopAudio()
    clearEarTimeouts()
    stopHeartbeatLoop()
    setEarFlashActive(false)
    setScreen('earGameOver')
  }

  const handleEarCorrect = (state) => {
    state.mode = 'resolving'
    stopHeartbeatLoop()
    playSfx(sfxRef.current.bank.correct, 0.7)
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
    stopHeartbeatLoop()
    setEarConductorState('wrong')
    playSfx(sfxRef.current.bank.wrong, 0.72)

    scheduleEarTimeout(() => {
      setEarConductorState('reload')
      playRandomSfx(sfxRef.current.bank.reloads, 0.72)
      state.bulletsLoaded = clamp(state.bulletsLoaded + 1, 0, 6)
      setEarBulletsLoaded(state.bulletsLoaded)
      playReloadTaunt(state)
      setEarRevolverShake(true)
      scheduleEarTimeout(() => setEarRevolverShake(false), 240)
    }, 2300)
    scheduleEarTimeout(() => {
      setEarConductorState('aim')
      setEarAimShake(true)
      playSfx(sfxRef.current.bank.pump, 0.66)
      playAimTaunt(state.bulletsLoaded)
      startHeartbeatLoop(state.bulletsLoaded)
    }, 3900)
    scheduleEarTimeout(() => {
      stopHeartbeatLoop()
      const fireChance = clamp((state.bulletsLoaded / 6) * 0.82, 0, 0.99)
      const fire = Math.random() < fireChance
      if (fire) {
        setEarAimShake(false)
        setEarConductorState('fire')
        playSfx(sfxRef.current.bank.shotgunBlast, 0.8)
        scheduleEarTimeout(() => playSfx(sfxRef.current.bank.shellFalling, 0.62), 220)
        scheduleEarTimeout(() => {
          setEarFlashActive(true)
        }, 500)
        scheduleEarTimeout(() => {
          setEarHighestRound(state.highestRound)
          setEarFlashActive(false)
          endEarRun()
        }, 680)
      } else {
        // Keep aiming while dry-fire plays, then release back to idle.
        playRandomSfx(sfxRef.current.bank.dryFire, 0.72)
        scheduleEarTimeout(() => {
          setEarAimShake(false)
          state.round += 1
          if (state.round > state.highestRound) {
            state.highestRound = state.round
            setEarHighestRound(state.round)
          }
          setEarRound(state.round)
          setEarConductorState('idle')
          scheduleEarTimeout(() => startEarRound(state), 4000)
        }, 900)
      }
    }, 7600)
  }

  const earGameLoop = (nowMs) => {
    const state = gameStateRef.current
    if (!state || state.type !== 'ear') return

    if (state.mode === 'awaiting') {
      const remainingMs = Math.max(0, state.roundDeadline - nowMs)
      const secondsLeft = Math.ceil(remainingMs / 1000)
      if (secondsLeft !== earUiRef.current.timerLeft) {
        earUiRef.current.timerLeft = secondsLeft
        setEarTimerLeft(secondsLeft)
      }

      const pitch = readMicrophonePitch()
      if (pitch?.stable) {
        const label = midiToSimpleLabel(pitch.nearestMidi)
        if (
          label !== earUiRef.current.inputNote &&
          nowMs - earUiRef.current.lastNoteAt >= UI_FRAME_MS
        ) {
          earUiRef.current.inputNote = label
          earUiRef.current.lastNoteAt = nowMs
          setEarInputNote(label)
        }
        if (state.captureStartedAt === null) {
          state.captureStartedAt = nowMs
          state.heardMidis = []
        }
        state.heardMidis.push(pitch.nearestMidi)
      }

      const captureIsReady =
        state.captureStartedAt !== null &&
        nowMs - state.captureStartedAt >= EAR_CAPTURE_WINDOW_MS &&
        state.heardMidis.length >= EAR_CAPTURE_MIN_SAMPLES

      if (captureIsReady) {
        const dominantPitchClass = getDominantPitchClass(state.heardMidis)
        const previewMidi =
          state.heardMidis.find((midi) => midi % 12 === dominantPitchClass) ?? state.heardMidis[0]

        state.mode = 'resolving'
        state.captureStartedAt = null
        state.heardMidis = []
        const previewLabel = midiToSimpleLabel(previewMidi)
        if (previewLabel !== earUiRef.current.inputNote) {
          earUiRef.current.inputNote = previewLabel
          earUiRef.current.lastNoteAt = nowMs
          setEarInputNote(previewLabel)
        }

        scheduleEarTimeout(() => {
          const liveState = gameStateRef.current
          if (!liveState || liveState.type !== 'ear') return
          if (dominantPitchClass === liveState.targetMidi % 12) {
            handleEarCorrect(liveState)
          } else {
            handleEarWrong(liveState)
          }
        }, EAR_FEEDBACK_DELAY_MS)
      } else if (remainingMs <= 0) {
        state.captureStartedAt = null
        state.heardMidis = []
        if (earUiRef.current.inputNote !== 'TIME') {
          earUiRef.current.inputNote = 'TIME'
          earUiRef.current.lastNoteAt = nowMs
          setEarInputNote('TIME')
        }
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

    if (state.deathStartedAt !== null) {
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

      syncArcadeUi(state, nowMs)

      if (nowMs >= state.deathEndsAt && state.particles.length === 0) {
        endRun()
        return
      }

      rafRef.current = requestAnimationFrame(gameLoop)
      return
    }

    state.elapsed += dt

    // Ship turbo: emit a steady, thick flame trail from beneath the center of the piano.
    while (nowMs >= state.nextTurboAt) {
      const burstCount = 3
      for (let i = 0; i < burstCount; i += 1) {
        const x = 50 + (Math.random() * 3 - 1.5)
        const y = 93.2 + Math.random() * 1.2
        const hue = 16 + Math.random() * 34
        const lightness = 52 + Math.random() * 28
        state.particles.push({
          id: state.nextParticleId,
          x,
          y,
          vx: Math.random() * 2.6 - 1.3,
          vy: 10 + Math.random() * 14,
          bornAt: state.nextTurboAt,
          dieAt: state.nextTurboAt + 220 + Math.random() * 190,
          color: `hsl(${hue} 98% ${lightness}%)`,
          size: 4.2 + Math.random() * 5.4,
        })
        state.nextParticleId += 1
      }
      state.nextTurboAt += 42
    }

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
      const fallProgress = clamp(nextY / PIANO_LINE_Y, 0, 1)
      const homeX = note.baseX + (50 - note.baseX) * fallProgress
      const nextX = clamp(homeX + drift * (1 - fallProgress), 10, 90)
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
      const nextLives = state.lives - misses
      if (nextLives > 0) {
        playSfx(sfxRef.current.bank.shipDamage, 0.56)
      }
      state.lives = nextLives
      state.streak = 0
    }

    detectAndApplyHit(state, nowMs)

    if (state.lives <= 0) {
      playSfx(sfxRef.current.bank.shipExplode, 0.62)
      const burstParticles = []
      for (let i = 0; i < 75; i += 1) {
        const angle = Math.random() * Math.PI * 2
        const speed = 6 + Math.random() * 16
        const hue = 18 + Math.random() * 38
        const lightness = 44 + Math.random() * 24
        const size = 5 + Math.random() * 8
        burstParticles.push({
          id: state.nextParticleId,
          x: 50,
          y: 92,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 2.2,
          bornAt: nowMs,
          dieAt: nowMs + 500 + Math.random() * 500,
          color: `hsl(${hue} 96% ${lightness}%)`,
          size,
        })
        state.nextParticleId += 1
      }

      state.particles.push(...burstParticles)
      state.notes = []
      state.bullets = []
      state.lives = 0
      state.streak = 0
      state.deathStartedAt = nowMs
      state.deathEndsAt = nowMs + 900

      syncArcadeUi(state, nowMs, true)

      rafRef.current = requestAnimationFrame(gameLoop)
      return
    }

    syncArcadeUi(state, nowMs)

    rafRef.current = requestAnimationFrame(gameLoop)
  }

  const startRun = async () => {
    ensureAudioUnlocked()
    stopGameLoop()
    stopPitchTesterLoop()
    stopAudio()
    setShowPitchTester(false)

    setLives(3)
    setScore(0)
    setStreak(0)
    setDetectedNote('--')
    setNotes([])
    setBullets([])
    setParticles([])

    lastArcadeUiSyncRef.current = 0
    try {
      await Promise.allSettled([loadNoteSprites(), preloadSfx()])
    } catch {
      // Best-effort preload; gameplay can still proceed with fallbacks.
    }

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
      nextTurboAt: performance.now(),
      deathStartedAt: null,
      deathEndsAt: 0,
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
    ensureAudioUnlocked()
    stopGameLoop()
    stopPitchTesterLoop()
    stopAudio()
    clearEarTimeouts()
    stopHeartbeatLoop()

    setDetectedNote('--')
    setEarRound(1)
    setEarHighestRound(1)
    setEarBulletsLoaded(0)
    setEarRevolverShake(false)
    setEarAimShake(false)
    setEarFlashActive(false)
    setEarInputNote('--')
    setEarTimerLeft(10)
    setEarConductorState('idle')
    earUiRef.current.timerLeft = 10
    earUiRef.current.inputNote = '--'
    earUiRef.current.lastNoteAt = 0

    try {
      await Promise.allSettled([
        loadConductorSprites(),
        loadRevolverSprites(),
        loadEarBackground(),
        preloadSfx(),
      ])
    } catch {
      // Best-effort preload; gameplay can still proceed with fallbacks.
    }

    gameStateRef.current = {
      type: 'ear',
      mode: 'booting',
      round: 1,
      highestRound: 1,
      bulletsLoaded: 0,
      captureStartedAt: null,
      heardMidis: [],
      playedTaunts: {
        littleTroubleThere: false,
        notQuiteMyTempo: false,
      },
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
      stopPitchTesterLoop()
      stopAudio()
      stopHeartbeatLoop()
      if (toneRef.current.sampler) {
        toneRef.current.sampler.dispose()
        toneRef.current.sampler = null
        toneRef.current.ready = false
      }
    }
  }, [])

  const conductorSrc = getConductorSprite(earConductorState, conductorMap)
  const revolverSrc = getRevolverSprite(earBulletsLoaded, revolverMap)
  const earBackgroundStyle = earBackgroundUrl
    ? { backgroundImage: `url(${earBackgroundUrl})` }
    : undefined

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
          <button className="secondary test-button" onClick={openPitchTester}>
            Test
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
                    width: `${particle.size ?? 5.2}px`,
                    height: `${particle.size ?? 5.2}px`,
                    background: particle.color ?? undefined,
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
                note.remainingMidis.find((midi) => getNoteSprite(note.clef, midi, noteSpriteMap)) ??
                note.remainingMidis[0] ??
                note.midis[0]
              const spriteSrc = getNoteSprite(note.clef, previewMidi, noteSpriteMap)

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
            {lives > 0 && <img className="piano-image" src={pianoImage} alt="Piano" />}
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
            className={`ear-game-window ${earAimShake ? 'is-aiming-shake' : ''}`}
            style={earBackgroundStyle}
          >
            {conductorSrc ? (
              <img
                className="conductor-sprite"
                src={conductorSrc}
                alt="Conductor"
              />
            ) : (
              <div className="conductor-fallback">{earConductorState}</div>
            )}

            <div className="round-badge">Round {earRound}</div>

            <div className={`revolver-panel ${earRevolverShake ? 'is-shaking' : ''}`}>
              {revolverSrc ? (
                <img
                  className="revolver-sprite"
                  src={revolverSrc}
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
            {earFlashActive && <div className="ear-flash-overlay" aria-hidden="true" />}
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

      {showPitchTester && (
        <aside className="modal-backdrop" onClick={closePitchTester}>
          <div className="modal tester-modal" onClick={(event) => event.stopPropagation()}>
            <h2>Pitch Test</h2>
            <p className="tester-copy">Play a note and watch where the detector places it.</p>
            <div className="tester-readout">
              <span>{testerReading.label}</span>
              <span>
                {testerReading.midiValue === null
                  ? 'Waiting for input'
                  : `${testerReading.centsOff > 0 ? '+' : ''}${testerReading.centsOff} cents`}
              </span>
            </div>
            <div className="tester-scale" aria-label="Pitch detector scale">
              <div className="tester-track" />
              <div
                className={`tester-indicator ${testerReading.stable ? 'is-stable' : ''}`}
                style={{ left: `${getTesterPositionPercent(testerReading.midiValue)}%` }}
              />
              <div className="tester-ticks" aria-hidden="true">
                {TESTER_NOTE_RANGE.map((midi) => (
                  <div key={midi} className="tester-tick">
                    <span>{midiToDisplayName(midi)}</span>
                  </div>
                ))}
              </div>
            </div>
            <button className="secondary" onClick={closePitchTester}>
              Close
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
                <div
                  className="game-card-art"
                  style={{
                    backgroundImage: `url(${arcadeCardImage})`,
                    backgroundSize: 'contain',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                  }}
                />
                <span>Piano Arcade</span>
              </button>

              <button
                className="game-card is-active"
                onClick={() => {
                  startEarRun()
                }}
              >
                <div
                  className="game-card-art"
                  style={{
                    backgroundImage: `url(${playItByEarCardImage})`,
                    backgroundSize: 'contain',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                  }}
                />
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







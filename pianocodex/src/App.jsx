import { useEffect, useRef, useState } from 'react'
import { Suspense, lazy } from 'react'
import * as Tone from 'tone'
import './App.css'
import pianoImage from './assets/piano.png'
import arcadeCardImage from './assets/arcade_background.PNG'
import playItByEarCardImage from './assets/play_it_by_ear_card.png'
import tempoRunCardImage from './assets/tempo_run_assets_v2/tempo_run_card.png'
import tempoRunGuideImage from './assets/tempo_run_guide.png'
import underConstructionImage from './assets/under_construction.png'

const TempoRunV2 = lazy(() => import('./TempoRunV2.jsx'))

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
const MIDI_NOTE_HOLD_MS = 220

const DIFFICULTY_OPTIONS = ['beginner', 'intermediate', 'advanced', 'nightmare']
const DIFFICULTY_CONFIG = {
  beginner: {
    readSpeed: 15,
    minMidi: 48,
    maxMidi: 72,
    whiteOnly: true,
    movement: 'classic',
  },
  intermediate: {
    readSpeed: 10,
    minMidi: 48,
    maxMidi: 72,
    whiteOnly: false,
    movement: 'classic',
  },
  advanced: {
    readSpeed: 5,
    minMidi: 40,
    maxMidi: 84,
    whiteOnly: false,
    movement: 'mixed',
  },
  nightmare: {
    readSpeed: 3,
    minMidi: 40,
    maxMidi: 84,
    whiteOnly: false,
    movement: 'mixed',
  },
}
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

function getDifficultyConfig(level) {
  return DIFFICULTY_CONFIG[level] ?? DIFFICULTY_CONFIG.beginner
}

function getPoolForLevel(level) {
  const pool = []
  const { minMidi, maxMidi, whiteOnly } = getDifficultyConfig(level)

  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    if (whiteOnly && !WHITE_PITCH_CLASSES.has(midi % 12)) continue
    pool.push(midi)
  }

  return pool
}

function App() {
  const [screen, setScreen] = useState('landing')
  const [showGamePicker, setShowGamePicker] = useState(false)
  const [showInputPicker, setShowInputPicker] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPitchTester, setShowPitchTester] = useState(false)
  const [showLandingSettings, setShowLandingSettings] = useState(false)
  const [showLandingProfile, setShowLandingProfile] = useState(false)
  const [showLandingLeaderboard, setShowLandingLeaderboard] = useState(false)
  const [showTempoRunGuide, setShowTempoRunGuide] = useState(false)
  const [landingInputType, setLandingInputType] = useState('audio')
  const [isLoading, setIsLoading] = useState(false)
  const [pendingGameMode, setPendingGameMode] = useState(null)
  const [settings, setSettings] = useState({
    level: 'beginner',
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
  const [midiStatus, setMidiStatus] = useState('idle')
  const [midiDeviceName, setMidiDeviceName] = useState('')
  const [midiStatusMessage, setMidiStatusMessage] = useState('')
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
  const fallbackAudioContextRef = useRef(null)
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
  const midiRef = useRef({
    access: null,
    activeNotes: new Map(),
    pendingPresses: [],
    heldMidi: null,
    holdUntil: 0,
  })

  const clearMidiPerformanceState = () => {
    const midi = midiRef.current
    midi.activeNotes.clear()
    midi.pendingPresses = []
    midi.heldMidi = null
    midi.holdUntil = 0
  }

  const getConnectedMidiInputs = (access = midiRef.current.access) => {
    if (!access?.inputs) return []
    return Array.from(access.inputs.values()).filter((input) => input.state === 'connected')
  }

  const handleMidiMessage = (event) => {
    const [status = 0, midiNote = 0, velocity = 0] = event.data ?? []
    const command = status & 0xf0
    const nowMs = performance.now()
    const midi = midiRef.current

    if (command === 0x90 && velocity > 0) {
      midi.activeNotes.set(midiNote, {
        midi: midiNote,
        at: nowMs,
      })
      midi.pendingPresses.push({
        midi: midiNote,
        at: nowMs,
      })
      if (midi.pendingPresses.length > 24) {
        midi.pendingPresses.shift()
      }
      midi.heldMidi = midiNote
      midi.holdUntil = nowMs + MIDI_NOTE_HOLD_MS
      return
    }

    if (command === 0x80 || (command === 0x90 && velocity === 0)) {
      midi.activeNotes.delete(midiNote)
      midi.heldMidi = midiNote
      midi.holdUntil = nowMs + MIDI_NOTE_HOLD_MS
    }
  }

  const syncMidiConnectionState = (access = midiRef.current.access) => {
    const inputs = getConnectedMidiInputs(access)
    const primaryInput = inputs[0] ?? null
    const primaryName = primaryInput?.name?.trim() || 'MIDI piano'

    setMidiDeviceName(primaryInput?.name?.trim() ?? '')

    if (inputs.length === 0) {
      setMidiStatus('disconnected')
      setMidiStatusMessage('No MIDI piano detected. Connect it with USB and try again.')
      clearMidiPerformanceState()
      return false
    }

    setMidiStatus('connected')
    setMidiStatusMessage(
      inputs.length === 1
        ? `${primaryName} connected.`
        : `${inputs.length} MIDI devices connected. Using ${primaryName}.`,
    )
    return true
  }

  const attachMidiListeners = (access = midiRef.current.access) => {
    if (!access?.inputs) return
    for (const input of access.inputs.values()) {
      input.onmidimessage = null
    }
    for (const input of getConnectedMidiInputs(access)) {
      input.onmidimessage = handleMidiMessage
    }
  }

  const ensureMidiConnected = async ({ fromButton = false } = {}) => {
    if (!navigator.requestMIDIAccess) {
      setMidiStatus('unsupported')
      setMidiStatusMessage('This browser does not support Web MIDI.')
      throw new Error('midi-unsupported')
    }

    setMidiStatus('checking')
    setMidiStatusMessage('Checking for connected MIDI devices...')

    try {
      const access = midiRef.current.access ?? (await navigator.requestMIDIAccess())
      midiRef.current.access = access
      access.onstatechange = () => {
        attachMidiListeners(access)
        syncMidiConnectionState(access)
      }
      attachMidiListeners(access)

      const connected = syncMidiConnectionState(access)
      if (!connected) {
        throw new Error('midi-not-found')
      }

      if (fromButton) {
        setLandingInputType('midi')
      }

      return access
    } catch (error) {
      if (error instanceof Error && error.message === 'midi-not-found') {
        throw error
      }

      setMidiStatus('error')
      setMidiStatusMessage('MIDI access was blocked. Allow browser access and try again.')
      throw error
    }
  }

  const connectMidiPiano = async () => {
    setIsLoading(true)
    setMicStatus('idle')
    try {
      await ensureMidiConnected({ fromButton: true })
    } catch {
      // UI state already reflects the connection problem.
    } finally {
      setIsLoading(false)
    }
  }

  const promptForGameInput = (gameMode) => {
    setPendingGameMode(gameMode)
    setShowGamePicker(false)
    setShowInputPicker(true)
  }

  const closeInputPicker = () => {
    setShowInputPicker(false)
    setPendingGameMode(null)
  }

  const chooseGameInput = async (inputType) => {
    const selectedGameMode = pendingGameMode

    setLandingInputType(inputType)
    setMicStatus('idle')

    if (inputType === 'midi') {
      setIsLoading(true)
      try {
        await ensureMidiConnected({ fromButton: true })
      } catch {
        setIsLoading(false)
        return
      }
      setIsLoading(false)
    }

    closeInputPicker()

    if (selectedGameMode === 'arcade') {
      setShowSettings(true)
      return
    }

    if (selectedGameMode === 'ear') {
      void startEarRun(inputType)
    }
  }

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
    clearMidiPerformanceState()
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

  const readMidiPitch = () => {
    const midi = midiRef.current
    const nowMs = performance.now()
    const activeNotes = Array.from(midi.activeNotes.values()).sort((left, right) => left.at - right.at)

    if (activeNotes.length > 0) {
      const primaryMidi = activeNotes[activeNotes.length - 1].midi
      return {
        frequency: null,
        midiValue: primaryMidi,
        nearestMidi: primaryMidi,
        centsOff: 0,
        stable: true,
        activeMidis: activeNotes.map((note) => note.midi),
      }
    }

    if (midi.heldMidi !== null && nowMs < midi.holdUntil) {
      return {
        frequency: null,
        midiValue: midi.heldMidi,
        nearestMidi: midi.heldMidi,
        centsOff: 0,
        stable: true,
        activeMidis: [midi.heldMidi],
      }
    }

    midi.heldMidi = null
    midi.holdUntil = 0
    return null
  }

  const readSelectedPitch = (inputType = landingInputType) => {
    if (inputType === 'midi') {
      return readMidiPitch()
    }

    const pitch = readMicrophonePitch()
    if (!pitch) return null

    return {
      ...pitch,
      activeMidis: pitch.stable ? [pitch.nearestMidi] : [],
    }
  }

  const consumeMidiPresses = (nowMs) => {
    const midi = midiRef.current
    const recentPresses = midi.pendingPresses.filter((press) => nowMs - press.at <= 600)
    midi.pendingPresses = []
    return [...new Set(recentPresses.map((press) => press.midi))]
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
    setIsLoading(true)
    stopGameLoop()
    stopAudio()
    stopPitchTesterLoop()
    setShowLandingSettings(false)
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
    } finally {
      setIsLoading(false)
    }
  }

  const playReferenceNote = (midi) => {
    if (toneRef.current.ready && toneRef.current.sampler) {
      const noteName = Tone.Frequency(midi, 'midi').toNote()
      toneRef.current.sampler.triggerAttackRelease(noteName, 1.1)
      return
    }

    const mic = micRef.current
    const AudioContext = window.AudioContext || window.webkitAudioContext
    const audioContext =
      mic.audioContext ??
      fallbackAudioContextRef.current ??
      (AudioContext ? new AudioContext() : null)
    if (!audioContext) return
    fallbackAudioContextRef.current = audioContext
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
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
    const midi = notePoolRef.current[randomIndex]
    const clef = midi >= 60 ? 'treble' : 'bass'
    const isStaggered =
      state.movementMode === 'mixed' ? Math.random() < 0.5 : state.movementMode === 'staggered'
    const baseX = clamp(10 + Math.random() * 80, 10, 90)
    const startY = isStaggered ? -4 - Math.random() * 10 : 0

    state.notes.push({
      id: state.nextId,
      midi,
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
    const pitch = readSelectedPitch(state.inputType)

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

    const activeMidis =
      state.inputType === 'midi'
        ? consumeMidiPresses(nowMs)
        : nowMs - mic.lastHitAt >= 220
          ? [pitch.nearestMidi]
          : []

    if (activeMidis.length === 0) return

    const targetIndex = state.notes.findIndex((note) => {
      if (note.destroyAt !== null) return false
      if (!(note.y >= HIT_MIN_Y && note.y < PIANO_LINE_Y)) return false
      return activeMidis.includes(note.midi)
    })

    if (targetIndex !== -1) {
      const target = state.notes[targetIndex]
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

      state.score += 6
      target.destroyAt = bulletEndAt
      if (landingInputType !== 'midi') {
        mic.lastHitAt = nowMs
      }
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

      const pitch = readSelectedPitch(state.inputType)
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
        state.heardMidis.push(...(pitch.activeMidis.length > 0 ? pitch.activeMidis : [pitch.nearestMidi]))
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

  const startRun = async (inputTypeOverride = null) => {
    const selectedInputType = inputTypeOverride ?? landingInputType
    setIsLoading(true)
    ensureAudioUnlocked()
    stopGameLoop()
    stopPitchTesterLoop()
    stopAudio()
    setShowPitchTester(false)
    if (selectedInputType === 'midi') {
      setMicStatus('idle')
    }

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

    const difficulty = getDifficultyConfig(settings.level)
    notePoolRef.current = getPoolForLevel(settings.level)

    gameStateRef.current = {
      type: 'arcade',
      inputType: selectedInputType,
      lives: 3,
      score: 0,
      streak: 0,
      elapsed: 0,
      level: settings.level,
      movementMode: difficulty.movement,
      readSpeed: difficulty.readSpeed,
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
      if (selectedInputType === 'midi') {
        await ensureMidiConnected()
        clearMidiPerformanceState()
      } else {
        await setupMicrophone()
      }
      setScreen('game')
      lastFrameRef.current = 0
      rafRef.current = requestAnimationFrame(gameLoop)
    } catch {
      if (selectedInputType !== 'midi') {
        setMicStatus('error')
      }
      setScreen('landing')
      setShowSettings(false)
    } finally {
      setIsLoading(false)
    }
  }

  const startEarRun = async (inputTypeOverride = null) => {
    const selectedInputType = inputTypeOverride ?? landingInputType
    setIsLoading(true)
    ensureAudioUnlocked()
    stopGameLoop()
    stopPitchTesterLoop()
    stopAudio()
    clearEarTimeouts()
    stopHeartbeatLoop()
    if (selectedInputType === 'midi') {
      setMicStatus('idle')
    }

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
      inputType: selectedInputType,
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
      if (selectedInputType === 'midi') {
        await ensureMidiConnected()
        clearMidiPerformanceState()
      } else {
        await setupMicrophone()
      }
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
      if (selectedInputType !== 'midi') {
        setMicStatus('error')
      }
      setScreen('landing')
      setShowGamePicker(false)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    const animationFrameRef = rafRef
    const pitchTesterFrameRef = testerRafRef
    const timeoutQueueRef = earTimeoutsRef
    const microphoneStateRef = micRef
    const midiStateRef = midiRef
    const heartbeatStateRef = sfxRef
    const samplerStateRef = toneRef
    const oscillatorContextRef = fallbackAudioContextRef

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      if (pitchTesterFrameRef.current) {
        cancelAnimationFrame(pitchTesterFrameRef.current)
        pitchTesterFrameRef.current = null
      }
      for (const timeoutId of timeoutQueueRef.current) {
        clearTimeout(timeoutId)
      }
      timeoutQueueRef.current = []

      const mic = microphoneStateRef.current
      if (mic.stream) {
        mic.stream.getTracks().forEach((track) => track.stop())
      }
      mic.audioContext?.close()
      microphoneStateRef.current = {
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

      const midi = midiStateRef.current
      midi.activeNotes.clear()
      midi.pendingPresses = []
      midi.heldMidi = null
      midi.holdUntil = 0
      if (midi.access?.inputs) {
        for (const input of midi.access.inputs.values()) {
          input.onmidimessage = null
        }
        midi.access.onstatechange = null
      }

      const heartbeat = heartbeatStateRef.current.heartbeat
      if (heartbeat) {
        heartbeat.pause()
        heartbeat.currentTime = 0
      }
      heartbeatStateRef.current.heartbeat = null
      heartbeatStateRef.current.heartbeatMode = null

      const samplerState = samplerStateRef.current
      if (samplerState.sampler) {
        samplerState.sampler.dispose()
        samplerState.sampler = null
        samplerState.ready = false
      }

      oscillatorContextRef.current?.close?.().catch(() => {})
      oscillatorContextRef.current = null
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
        screen === 'game' ||
        screen === 'earGame' ||
        screen === 'earGameOver' ||
        screen === 'tempoRunV2'
          ? 'game-mode'
          : 'menu-mode'
      }`}
    >
      {screen === 'landing' && (
        <main className="landing">
          <h1 className="crawl-title">Piano Drills</h1>
          <div className="landing-buttons">
            <button className="start-button" onClick={() => setShowGamePicker(true)}>
              <span className="landing-button-label">Start</span>
            </button>
            <button className="secondary" onClick={() => setShowLandingSettings(true)}>
              <span className="landing-button-label">Settings</span>
            </button>
            <button className="secondary" onClick={() => setShowLandingProfile(true)}>
              <span className="landing-button-label">Profile</span>
            </button>
            <button className="secondary" onClick={() => setShowLandingLeaderboard(true)}>
              <span className="landing-button-label">Leaderboard</span>
            </button>
            <div className="landing-connect-slot">
              <button
                className="secondary landing-connect-button"
                type="button"
                onClick={connectMidiPiano}
              >
                <span className="landing-button-label">Connect Piano</span>
              </button>
              {midiStatus !== 'idle' && midiStatus !== 'checking' && (
                <span
                  className={`landing-piano-indicator ${
                    midiStatus === 'connected' ? 'is-connected' : 'is-disconnected'
                  }`}
                  aria-label={
                    midiStatus === 'connected' ? 'Piano connected' : 'Piano not connected'
                  }
                  title={midiStatusMessage || undefined}
                >
                  {midiStatus === 'connected' ? '✓' : '✕'}
                </span>
              )}
            </div>
          </div>
          {micStatus === 'error' && (
            <p className="error">Microphone permission is required to play with audio input.</p>
          )}
        </main>
      )}

      {screen === 'game' && (
        <main className="game">
          <header className="hud">
            <span>Lives: {lives}</span>
            <span>Score: {score}</span>
            <span>Streak: {streak}</span>
            <span>{landingInputType === 'midi' ? 'Piano' : 'Mic'}: {detectedNote}</span>
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
              const spriteSrc = getNoteSprite(note.clef, note.midi, noteSpriteMap)

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
                      alt={`${note.clef} ${midiToDisplayName(note.midi)}`}
                    />
                  ) : (
                    <span>{midiToDisplayName(note.midi)}</span>
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

      {screen === 'tempoRunV2' && (
        <Suspense
          fallback={
            <div className="loading-backdrop" aria-busy="true" aria-live="polite">
              <div className="loading-card" role="status" aria-label="Loading">
                <div className="loading-spinner" />
              </div>
            </div>
          }
        >
          <TempoRunV2 onExit={() => setScreen('landing')} />
        </Suspense>
      )}

      {showSettings && (
        <aside className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setShowSettings(false)}
            >
              ×
            </button>
            <h2>Session Settings</h2>

            <label>
              Difficulty level
              <select
                value={settings.level}
                onChange={(event) =>
                  setSettings((previous) => ({ ...previous, level: event.target.value }))
                }
              >
                {DIFFICULTY_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <p className="modal-helper">
              {settings.level === 'beginner'
                ? '15 second read speed, white notes only, classic movement.'
                : settings.level === 'intermediate'
                  ? '10 second read speed, sharps added, classic movement.'
                  : settings.level === 'advanced'
                    ? '5 second read speed, full note range, mixed classic and staggered movement.'
                    : '3 second read speed, full note range, mixed classic and staggered movement.'}
            </p>

            <button
              className="primary"
              onClick={() => {
                setShowSettings(false)
                startRun()
              }}
            >
              Begin
            </button>
          </div>
        </aside>
      )}

      {showPitchTester && (
        <aside className="modal-backdrop" onClick={closePitchTester}>
          <div className="modal tester-modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={closePitchTester}
            >
              ×
            </button>
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
          </div>
        </aside>
      )}

      {showLandingSettings && (
        <aside className="modal-backdrop" onClick={() => setShowLandingSettings(false)}>
          <div className="modal landing-modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setShowLandingSettings(false)}
            >
              ×
            </button>
            <h2>Settings</h2>
            <div className="modal-divider" />
            <div className="modal-field">
              <span>Input Type</span>
              <div className="toggle-group">
                <button
                  className={`toggle-button ${
                    landingInputType === 'audio' ? 'is-active' : ''
                  }`}
                  type="button"
                  onClick={() => setLandingInputType('audio')}
                >
                  Audio
                </button>
                <button
                  className={`toggle-button ${
                    landingInputType === 'midi' ? 'is-active' : ''
                  }`}
                  type="button"
                  onClick={() => {
                    setLandingInputType('midi')
                    setMicStatus('idle')
                    if (midiStatus === 'idle') {
                      setMidiStatusMessage('Click Connect Piano to detect a USB MIDI keyboard.')
                    }
                  }}
                >
                  MIDI
                </button>
              </div>
            </div>
            <div className="modal-field">
              <span>Test Audio</span>
              <button className="modal-button" onClick={openPitchTester}>
                <span className="landing-button-label">Test Audio</span>
              </button>
            </div>
          </div>
        </aside>
      )}

      {showLandingProfile && (
        <aside className="modal-backdrop" onClick={() => setShowLandingProfile(false)}>
          <div className="modal landing-modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setShowLandingProfile(false)}
            >
              ×
            </button>
            <h2>Profile</h2>
            <div className="modal-divider" />
            <div className="under-construction-wrap">
              <img
                className="under-construction-image"
                src={underConstructionImage}
                alt="Under construction"
              />
            </div>
          </div>
        </aside>
      )}

      {showLandingLeaderboard && (
        <aside className="modal-backdrop" onClick={() => setShowLandingLeaderboard(false)}>
          <div className="modal leaderboard-modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setShowLandingLeaderboard(false)}
            >
              ×
            </button>
            <header className="leaderboard-header">
              <h2>Leaderboard</h2>
              <div className="leaderboard-divider" />
            </header>
            <div className="under-construction-wrap under-construction-wrap--leaderboard">
              <img
                className="under-construction-image"
                src={underConstructionImage}
                alt="Under construction"
              />
            </div>
            {/*
            <div className="leaderboard-filter">
              <select
                className="leaderboard-select"
                value={leaderboardGame}
                onChange={(event) => setLeaderboardGame(event.target.value)}
              >
                <option value="arcade">Piano Arcade</option>
                <option value="ear">Play It By Ear</option>
              </select>
            </div>
            <div className="leaderboard-list" role="list">
              {LEADERBOARD_ENTRIES.map((entry) => (
                <article key={entry.id} className="leaderboard-entry" role="listitem">
                  <div className="leaderboard-avatar">
                    {entry.profileSrc ? (
                      <img
                        className="leaderboard-avatar-image"
                        src={entry.profileSrc}
                        alt={`Profile of ${entry.name}`}
                      />
                    ) : (
                      <span className="leaderboard-avatar-fallback" aria-hidden="true">
                        ?
                      </span>
                    )}
                  </div>
                  <div className="leaderboard-name">{entry.name}</div>
                  <div className="leaderboard-stats">
                    <div className="leaderboard-stat">
                      <span className="leaderboard-stat-icon">
                        <img src={leaderboardArcadeIcon} alt="" aria-hidden="true" />
                      </span>
                      <span className="leaderboard-stat-value">{entry.score}</span>
                    </div>
                    <div className="leaderboard-stat">
                      <span className="leaderboard-stat-icon">
                        <img src={leaderboardPibeIcon} alt="" aria-hidden="true" />
                      </span>
                      <span className="leaderboard-stat-value">{entry.streak}</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            */}
          </div>
        </aside>
      )}

      {showGamePicker && (
        <aside className="picker-backdrop" onClick={() => setShowGamePicker(false)}>
          <div className="picker-modal" onClick={(event) => event.stopPropagation()}>
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setShowGamePicker(false)}
            >
              ×
            </button>
            <h2>Select A Game</h2>
            <div className="game-card-grid">
              <button
                className="game-card is-active"
                onClick={() => {
                  promptForGameInput('arcade')
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
                <span className="game-card-copy">
                  <strong className="game-card-title">Note Invaders</strong>
                  <small className="game-card-subtitle">Sight Reading</small>
                </span>
              </button>

              <button
                className="game-card is-active"
                onClick={() => {
                  promptForGameInput('ear')
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
                <span className="game-card-copy">
                  <strong className="game-card-title">Play It By Ear</strong>
                  <small className="game-card-subtitle">Ear Training</small>
                </span>
              </button>

              <button
                className="game-card is-active"
                onClick={() => {
                  setShowGamePicker(false)
                  setShowTempoRunGuide(true)
                }}
              >
                <div
                  className="game-card-art"
                  style={{
                    backgroundImage: `url(${tempoRunCardImage})`,
                    backgroundSize: 'contain',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                  }}
                />
                <span className="game-card-copy">
                  <strong className="game-card-title">Temple Run</strong>
                  <small className="game-card-subtitle">Rhythmic Training</small>
                </span>
              </button>
            </div>
          </div>
        </aside>
      )}

      {showInputPicker && (
        <aside className="modal-backdrop" onClick={closeInputPicker}>
          <div
            className="modal input-picker-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={closeInputPicker}
            >
              ×
            </button>
            <h2>Choose Input</h2>
            <p className="modal-helper">
              {pendingGameMode === 'arcade'
                ? 'Pick the input you want to use for Piano Arcade before the run starts.'
                : 'Pick the input you want to use for Play It By Ear before the round starts.'}
            </p>
            <div className="input-picker-actions">
              <button
                className="input-picker-button"
                type="button"
                onClick={() => chooseGameInput('audio')}
              >
                <span className="input-picker-label">Microphone</span>
                <span className="input-picker-caption">Use your mic to detect notes.</span>
              </button>
              <button
                className="input-picker-button is-dark"
                type="button"
                onClick={() => chooseGameInput('midi')}
              >
                <span className="input-picker-label">MIDI Piano</span>
                <span className="input-picker-caption">
                  {midiStatus === 'connected'
                    ? `${midiDeviceName || 'Keyboard'} is ready.`
                    : 'Use your USB MIDI keyboard.'}
                </span>
              </button>
            </div>
            <p
              className={`modal-helper input-picker-status ${
                midiStatus === 'connected'
                  ? 'is-success'
                  : midiStatus === 'checking'
                    ? 'is-info'
                    : ''
              }`.trim()}
            >
              {midiStatus === 'connected'
                ? `${midiDeviceName || 'MIDI piano'} connected.`
                : midiStatusMessage || 'You can still connect a piano from the landing page.'}
            </p>
          </div>
        </aside>
      )}

      {showTempoRunGuide && (
        <aside className="modal-backdrop" onClick={() => setShowTempoRunGuide(false)}>
          <div
            className="modal tempo-run-guide-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setShowTempoRunGuide(false)}
            >
              ×
            </button>
            <h2>Temple Run Guide</h2>
            <img
              className="tempo-run-guide-image"
              src={tempoRunGuideImage}
              alt="Temple Run guide"
            />
            <button
              className="primary"
              type="button"
              onClick={() => {
                setShowTempoRunGuide(false)
                setScreen('tempoRunV2')
              }}
            >
              Understood
            </button>
          </div>
        </aside>
      )}

      {isLoading && (
        <div className="loading-backdrop" aria-busy="true" aria-live="polite">
          <div className="loading-card" role="status" aria-label="Loading">
            <div className="loading-spinner" />
          </div>
        </div>
      )}
    </div>
  )
}

export default App







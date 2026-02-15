import { useEffect, useRef, useState } from 'react'
import './App.css'

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const WHITE_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11])
const PIANO_LINE_Y = 88
const HIT_MIN_Y = 18

const READ_SPEED_OPTIONS = [1, 3, 5, 10, 15]
const LEVEL_OPTIONS = ['beginner', 'intermediate', 'advanced', 'nightmare']
const MOVEMENT_OPTIONS = ['staggered', 'classic']
const NOTE_SPRITES = import.meta.glob('./notes/*.png', { eager: true, import: 'default' })
const NOTE_SPRITE_MAP = Object.fromEntries(
  Object.entries(NOTE_SPRITES).map(([path, url]) => {
    const fileName = path.split('/').pop()
    const key = fileName.replace('.png', '')
    return [key, url]
  }),
)

function midiToNoteName(midi) {
  const pitchClass = midi % 12
  const octave = Math.floor(midi / 12) - 1
  return `${NOTE_NAMES[pitchClass]}${octave}`
}

function midiToDisplayName(midi) {
  return midiToNoteName(midi).replace('#', '♯')
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
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState({
    readSpeed: 3,
    level: 'beginner',
    movement: 'staggered',
  })

  const [notes, setNotes] = useState([])
  const [lives, setLives] = useState(3)
  const [score, setScore] = useState(0)
  const [streak, setStreak] = useState(0)
  const [detectedNote, setDetectedNote] = useState('--')
  const [micStatus, setMicStatus] = useState('idle')

  const rafRef = useRef(null)
  const lastFrameRef = useRef(0)
  const notePoolRef = useRef([])
  const gameStateRef = useRef(null)
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

  const stopGameLoop = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
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
      if (!(note.y >= HIT_MIN_Y && note.y < PIANO_LINE_Y)) return false
      return note.remainingMidis.includes(nearestMidi)
    })

    if (targetIndex !== -1) {
      const target = state.notes[targetIndex]
      target.remainingMidis = target.remainingMidis.filter((midi) => midi !== nearestMidi)
      state.streak += 1
      state.score += 6 + Math.min(state.streak, 18)
      if (target.remainingMidis.length === 0) {
        const clearBonus = target.midis.length === 1 ? 6 : target.midis.length * 6
        state.score += clearBonus
        state.notes.splice(targetIndex, 1)
      }
      mic.lastHitAt = nowMs
    }
  }

  const gameLoop = (nowMs) => {
    const state = gameStateRef.current
    if (!state) return

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

    for (const note of state.notes) {
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

    if (misses > 0) {
      state.lives -= misses
      state.streak = 0
    }

    detectAndApplyHit(state, nowMs)

    if (state.lives <= 0) {
      setNotes([])
      setLives(0)
      setStreak(0)
      endRun()
      return
    }

    setNotes([...state.notes])
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

    notePoolRef.current = getPoolForLevel(settings.level)

    gameStateRef.current = {
      lives: 3,
      score: 0,
      streak: 0,
      elapsed: 0,
      level: settings.level,
      movement: settings.movement,
      readSpeed: Number(settings.readSpeed),
      notes: [],
      lastSpawnAt: performance.now(),
      nextId: 1,
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

  useEffect(() => {
    return () => {
      stopGameLoop()
      stopAudio()
    }
  }, [])

  return (
    <div className={`app-shell ${screen === 'game' ? 'game-mode' : 'menu-mode'}`}>
      {screen === 'landing' && (
        <main className="landing">
          <h1>Piano Sightline</h1>
          <p>Train your note reading speed with real-time microphone input.</p>
          <button className="primary" onClick={() => setShowSettings(true)}>
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
            <footer className="mini-piano">
              <div className="white-keys">
                {['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((keyName) => (
                  <span key={keyName}>{keyName}</span>
                ))}
              </div>
            </footer>
          </section>
        </main>
      )}

      {screen === 'gameOver' && (
        <main className="game-over">
          <h2>Game Over</h2>
          <p>Your score: {score}</p>
          <button className="primary" onClick={() => setShowSettings(true)}>
            Play Again
          </button>
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
          </div>
        </aside>
      )}
    </div>
  )
}

export default App

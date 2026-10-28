// Piano Tutor — lógica del navegador.
// Flujo: audio (descarga, captura de la pestaña o archivo) → basic-pitch (IA) → notas → pasos → práctica.

// La IA (basic-pitch + TensorFlow.js) se carga de un CDN; si uno falla se prueba el otro.
const BASIC_PITCH_URLS = [
  'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/+esm',
  'https://esm.sh/@spotify/basic-pitch@1.0.1?bundle',
];
const MODEL_URL = '/model/model.json';
const SR = 22050; // basic-pitch exige 22050 Hz mono

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- Ajustes

const DEFAULTS = { mode: 'melody', group: 3, sens: 5, speed: 0.75, names: 'es', autoplay: true, labels: false };
const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pt-settings') || '{}') };
const saveSettings = () => localStorage.setItem('pt-settings', JSON.stringify(settings));

// ---------------------------------------------------------------- Estado

let song = null; // { id, title, source: 'youtube'|'file', videoId?, raw?: { frames, onsets } }
let steps = []; // [{ time, dur, pitches: [midi...] }]
let groupIdx = 0;
let busy = false;

// ---------------------------------------------------------------- Utilidades

const NAMES = {
  es: ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'],
  en: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
};
const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
const noteName = (m) => `${NAMES[settings.names][m % 12]}${Math.floor(m / 12) - 1}`;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1, 12);
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/) || [])[1];
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function setStatus(text, progress = null, { error = false, stoppable = false } = {}) {
  const box = $('status');
  box.hidden = false;
  box.classList.toggle('error', error);
  $('status-text').textContent = text;
  $('status-bar').style.width = progress == null ? '0' : `${Math.round(progress * 100)}%`;
  $('btn-stop-capture').hidden = !stoppable;
}
const hideStatus = () => ($('status').hidden = true);

function setBusy(v) {
  busy = v;
  $('btn-download').disabled = v;
  $('btn-capture').disabled = v;
  $('file-input').disabled = v;
}

// ---------------------------------------------------------------- IndexedDB (canciones guardadas)

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('piano-tutor', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('meta', { keyPath: 'id' });
    req.result.createObjectStore('raw', { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function idb(store, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

function flatten(rows) {
  const width = rows[0]?.length || 0;
  const flat = new Float32Array(rows.length * width);
  rows.forEach((r, i) => flat.set(r, i * width));
  return { flat, width };
}

function unflatten(flat, width) {
  const n = flat.length / width;
  const rows = new Array(n);
  for (let i = 0; i < n; i++) rows[i] = Array.from(flat.subarray(i * width, (i + 1) * width));
  return rows;
}

async function saveSong(s) {
  const f = flatten(s.raw.frames);
  const o = flatten(s.raw.onsets);
  await idb('raw', 'readwrite', (st) => st.put({ id: s.id, width: f.width, frames: f.flat, onsets: o.flat }));
  await saveMeta(s);
}

function saveMeta(s) {
  const meta = { id: s.id, title: s.title, source: s.source, videoId: s.videoId || null, savedAt: Date.now() };
  return idb('meta', 'readwrite', (st) => st.put(meta));
}

async function loadRaw(id) {
  const rec = await idb('raw', 'readonly', (st) => st.get(id));
  if (!rec) return null;
  return { frames: unflatten(rec.frames, rec.width), onsets: unflatten(rec.onsets, rec.width) };
}

async function renderRecent() {
  const list = await idb('meta', 'readonly', (st) => st.getAll());
  list.sort((a, b) => b.savedAt - a.savedAt);
  $('recent-wrap').hidden = list.length === 0;
  const ul = $('recent-list');
  ul.innerHTML = '';
  for (const m of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="r-title"></span><span class="r-meta"></span><button class="r-del" title="Borrar">✕</button>`;
    li.querySelector('.r-title').textContent = m.title;
    li.querySelector('.r-meta').textContent = m.source === 'youtube' ? 'YouTube' : 'Archivo';
    li.addEventListener('click', () => openSaved(m));
    li.querySelector('.r-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await idb('meta', 'readwrite', (st) => st.delete(m.id));
      await idb('raw', 'readwrite', (st) => st.delete(m.id));
      localStorage.removeItem(`pt-pos:${m.id}`);
      renderRecent();
    });
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- YouTube

let ytApi;
let player = null;
const stateListeners = new Set();

function loadYouTubeApi() {
  if (!ytApi) {
    ytApi = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
  }
  return ytApi;
}

async function showVideo(videoId) {
  $('yt-player').closest('.video-frame').hidden = false;
  await loadYouTubeApi();
  if (player) {
    player.cueVideoById(videoId);
    return;
  }
  await new Promise((resolve) => {
    player = new YT.Player('yt-player', {
      videoId,
      playerVars: { rel: 0, playsinline: 1 },
      events: {
        onReady: () => {
          updateTitleFromPlayer();
          resolve();
        },
        onStateChange: (e) => {
          stateListeners.forEach((fn) => fn(e.data));
          updateTitleFromPlayer();
        },
        onError: (e) => {
          if (e.data === 101 || e.data === 150 || e.data === 153) {
            toast('Este video no se puede reproducir embebido. Probá "Descargar audio" o subí el archivo.', 7000);
          }
        },
      },
    });
  });
}

function updateTitleFromPlayer() {
  if (!song || song.source !== 'youtube' || !player?.getVideoData) return;
  const t = player.getVideoData()?.title;
  if (t && song.title !== t && song.title === 'Video de YouTube') {
    song.title = t;
    $('song-title').textContent = t;
    if (song.raw) saveMeta(song);
  }
}

// ---------------------------------------------------------------- Audio: decodificar y remuestrear

function toMono(audioBuffer) {
  const n = audioBuffer.numberOfChannels;
  if (n === 1) return new Float32Array(audioBuffer.getChannelData(0));
  const out = new Float32Array(audioBuffer.length);
  for (let c = 0; c < n; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / n;
  }
  return out;
}

async function decodeToMono22k(arrayBuffer) {
  // decodeAudioData remuestrea a la frecuencia del contexto (22050).
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(arrayBuffer);
  return toMono(buf);
}

async function resampleTo22k(samples, srcRate) {
  if (srcRate === SR) return samples;
  const off = new OfflineAudioContext(1, Math.ceil((samples.length * SR) / srcRate), SR);
  const b = off.createBuffer(1, samples.length, srcRate);
  b.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = b;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// ---------------------------------------------------------------- IA: basic-pitch

let bpModule;
function loadBasicPitch() {
  bpModule ??= (async () => {
    let lastErr;
    for (const url of BASIC_PITCH_URLS) {
      try {
        return await import(url);
      } catch (err) {
        lastErr = err;
      }
    }
    bpModule = null;
    throw new Error(`No se pudo cargar la IA (¿sin internet?): ${lastErr.message}`);
  })();
  return bpModule;
}

async function transcribe(mono) {
  let peak = 0;
  for (let i = 0; i < mono.length; i += 64) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak < 0.002) throw new Error('El audio está en silencio. ¿El video estaba muteado?');

  setStatus('Cargando la IA...', 0);
  const { BasicPitch } = await loadBasicPitch();
  const bp = new BasicPitch(MODEL_URL);
  // La primera pasada del modelo en WebGL devuelve activaciones débiles y se pierden las notas
  // del comienzo. Se "calienta" con un segundo de silencio antes de procesar la canción.
  await bp.evaluateModel(new Float32Array(SR), () => {}, () => {});
  const frames = [];
  const onsets = [];
  await bp.evaluateModel(
    mono,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    (p) => setStatus(`Sacando las notas con IA... ${Math.round(p * 100)}%`, p),
  );
  return { frames, onsets };
}

async function finishTranscription(raw) {
  song.raw = raw;
  await saveSong(song);
  hideStatus();
  await recompute({ keepTime: false });
  showPractice();
  toast('Listo. Usá Espacio para avanzar.');
}

// ---------------------------------------------------------------- Fuentes de audio

async function fromDownload() {
  setBusy(true);
  try {
    setStatus('Descargando el audio del video (la primera vez puede tardar)...', null);
    const r = await fetch(`/api/audio?url=${encodeURIComponent(song.videoId)}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `Error HTTP ${r.status}`);
    }
    const title = decodeURIComponent(r.headers.get('X-Video-Title') || '');
    if (title) {
      song.title = title;
      $('song-title').textContent = title;
    }
    setStatus('Preparando el audio...', null);
    const mono = await decodeToMono22k(await r.arrayBuffer());
    await finishTranscription(await transcribe(mono));
  } catch (err) {
    setStatus(err.message, null, { error: true });
  } finally {
    setBusy(false);
  }
}

let stopCapture = null;

async function fromCapture() {
  if (!player) return toast('Primero cargá un video.');
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return setStatus('Tu navegador no permite capturar el audio de la pestaña. Usá Chrome o Edge.', null, { error: true });
  }
  setBusy(true);
  let stream;
  let ctx;
  let progressTimer;
  try {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
    } catch {
      throw new Error('No se compartió la pestaña. Volvé a intentar y elegí esta pestaña con "Compartir audio".');
    }
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('No llegó audio: al compartir, dejá marcado "Compartir audio de la pestaña".');

    ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const chunks = [];
    let total = 0;
    let startSample = null;
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(d));
      total += d.length;
    };
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);

    // Alinea el audio grabado con el tiempo del video, para que "Original" caiga en el lugar justo.
    const onState = (st) => {
      if (st === YT.PlayerState.PLAYING && startSample == null) {
        startSample = Math.max(0, total - Math.round(player.getCurrentTime() * ctx.sampleRate));
      }
    };
    stateListeners.add(onState);

    const done = new Promise((resolve) => {
      stopCapture = resolve;
      const onEnd = (st) => st === YT.PlayerState.ENDED && resolve();
      stateListeners.add(onEnd);
      track.addEventListener('ended', resolve);
    });

    player.unMute();
    player.setVolume(100);
    player.setPlaybackRate(1);
    player.seekTo(0, true);
    player.playVideo();

    const dur = player.getDuration() || 0;
    progressTimer = setInterval(() => {
      const t = player.getCurrentTime() || 0;
      setStatus(`Escuchando el video... ${fmtTime(t)} / ${fmtTime(dur)}. No lo pauses ni lo mutees.`, dur ? t / dur : null, { stoppable: true });
    }, 300);

    await done;
    clearInterval(progressTimer);
    stateListeners.clear();
    player.pauseVideo();
    stream.getTracks().forEach((t) => t.stop());
    source.disconnect();
    proc.disconnect();

    const from = startSample ?? 0;
    const merged = new Float32Array(Math.max(0, total - from));
    let off = 0;
    let skip = from;
    for (const c of chunks) {
      if (skip >= c.length) {
        skip -= c.length;
        continue;
      }
      const part = skip ? c.subarray(skip) : c;
      skip = 0;
      merged.set(part, off);
      off += part.length;
    }
    if (merged.length < ctx.sampleRate * 2) throw new Error('Se grabó muy poco audio. Dejá que el video suene un rato más.');

    setStatus('Preparando el audio...', null);
    const mono = await resampleTo22k(merged, ctx.sampleRate);
    await finishTranscription(await transcribe(mono));
  } catch (err) {
    setStatus(err.message, null, { error: true });
  } finally {
    clearInterval(progressTimer);
    stopCapture = null;
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    setBusy(false);
  }
}

async function fromFile(file) {
  const id = `file:${file.name}:${file.size}`;
  openSongView({ id, title: file.name, source: 'file' });
  const audio = $('file-audio');
  audio.src = URL.createObjectURL(file);
  audio.hidden = false;

  const raw = await loadRaw(id);
  if (raw) {
    song.raw = raw;
    await recompute({ keepTime: false });
    return showPractice();
  }

  setBusy(true);
  try {
    setStatus('Preparando el audio...', null);
    const mono = await decodeToMono22k(await file.arrayBuffer());
    await finishTranscription(await transcribe(mono));
  } catch (err) {
    setStatus(`No se pudo leer el archivo: ${err.message}`, null, { error: true });
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- Abrir canciones

function openSongView(s) {
  stopPlayback();
  song = s;
  steps = [];
  $('welcome').hidden = true;
  $('song').hidden = false;
  $('practice').hidden = true;
  $('settings').hidden = true;
  $('song-title').textContent = s.title;
  $('source-panel').hidden = s.source !== 'youtube';
  $('file-audio').hidden = true;
  $('yt-player').closest('.video-frame').hidden = s.source !== 'youtube';
  if (s.source !== 'youtube') player?.pauseVideo?.();
  hideStatus();
}

async function openYouTube(videoId) {
  const id = `yt:${videoId}`;
  const meta = await idb('meta', 'readonly', (st) => st.get(id));
  if (meta) return openSaved(meta);
  openSongView({ id, title: 'Video de YouTube', source: 'youtube', videoId });
  await showVideo(videoId);
}

async function openSaved(meta) {
  openSongView({ id: meta.id, title: meta.title, source: meta.source, videoId: meta.videoId });
  if (meta.source === 'youtube') showVideo(meta.videoId);
  else toast('Para usar "Original" con un archivo, volvé a subirlo.', 5000);
  setStatus('Abriendo...', null);
  song.raw = await loadRaw(meta.id);
  hideStatus();
  if (!song.raw) return setStatus('No se encontraron las notas guardadas. Volvé a transcribir.', null, { error: true });
  await recompute({ keepTime: false });
  showPractice();
}

function showPractice() {
  $('practice').hidden = false;
  $('settings').hidden = false;
}

// ---------------------------------------------------------------- Notas → pasos

// Sensibilidad 1..10 → umbral de ataque de basic-pitch (más sensibilidad = umbral más bajo = más notas).
const onsetThreshold = () => 0.8 - settings.sens * 0.055;

function buildSteps(notes, mode) {
  // 1) Notas que arrancan casi juntas (<= 50 ms) forman un mismo "golpe".
  const clusters = [];
  for (const n of notes) {
    const last = clusters[clusters.length - 1];
    if (last && n.startTimeSeconds - last.time <= 0.05) last.notes.push(n);
    else clusters.push({ time: n.startTimeSeconds, notes: [n] });
  }
  if (!clusters.length) return [];

  // 2) Armónicos: la IA suele marcar una "nota fantasma" una octava (o quinta/doble octava) arriba
  //    de la real, más débil. Se descarta si suena a menos del 60% de la nota que la genera.
  for (const c of clusters) {
    c.notes = c.notes.filter(
      (n) => !c.notes.some((b) => [12, 19, 24].includes(n.pitchMidi - b.pitchMidi) && n.amplitude < b.amplitude * 0.6),
    );
  }

  const tops = clusters.map((c) => Math.max(...c.notes.map((n) => n.pitchMidi))).sort((a, b) => a - b);
  const medianTop = tops[Math.floor(tops.length / 2)];

  const out = [];
  let prevTop = null;
  for (const c of clusters) {
    const top = c.notes.reduce((a, b) => (b.pitchMidi > a.pitchMidi ? b : a));
    let chosen;
    if (mode === 'all') {
      chosen = c.notes;
    } else {
      // Golpes muy graves respecto de la línea melódica: acompañamiento de la mano izquierda.
      if (top.pitchMidi < medianTop - 12) continue;
      // Nota más grave y más suave mientras la melodía anterior sigue sonando: acompañamiento.
      if (
        prevTop &&
        prevTop.startTimeSeconds + prevTop.durationSeconds > c.time + 0.03 &&
        top.pitchMidi < prevTop.pitchMidi - 2 &&
        top.amplitude < prevTop.amplitude * 0.75
      ) continue;
      // La misma nota detectada dos veces seguidas casi al mismo tiempo.
      if (prevTop && top.pitchMidi === prevTop.pitchMidi && c.time - prevTop.startTimeSeconds < 0.1) continue;
      // "Rebote" corto y débil justo cuando termina una nota larga de la misma altura.
      if (
        prevTop &&
        top.pitchMidi === prevTop.pitchMidi &&
        c.time <= prevTop.startTimeSeconds + prevTop.durationSeconds + 0.05 &&
        top.durationSeconds < 0.2 &&
        top.amplitude < prevTop.amplitude * 0.9
      ) continue;
      // Mano derecha: notas dentro de la octava debajo de la melodía (lo más grave suele ser el bajo).
      chosen = mode === 'melody' ? [top] : c.notes.filter((n) => n.pitchMidi > top.pitchMidi - 12);
      prevTop = top;
    }
    const pitches = [...new Set(chosen.map((n) => n.pitchMidi))].sort((a, b) => a - b);
    out.push({ time: c.time, dur: Math.max(...chosen.map((n) => n.durationSeconds)), pitches });
  }
  return out;
}

async function recompute({ keepTime = true } = {}) {
  if (!song?.raw) return;
  const anchorTime = keepTime && steps.length ? currentGroup()[0]?.time : null;
  const { outputToNotesPoly, noteFramesToTime } = await loadBasicPitch();
  const events = outputToNotesPoly(song.raw.frames, song.raw.onsets, onsetThreshold(), 0.3, 5, true, null, null, false);
  const notes = noteFramesToTime(events)
    .filter((n) => n.durationSeconds >= 0.05)
    .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
  steps = buildSteps(notes, settings.mode);

  let stepIndex;
  if (anchorTime != null) {
    stepIndex = Math.max(0, steps.findIndex((s) => s.time >= anchorTime - 0.02));
  } else {
    stepIndex = Number(localStorage.getItem(`pt-pos:${song.id}`)) || 0;
  }
  groupIdx = Math.floor(Math.min(stepIndex, Math.max(0, steps.length - 1)) / settings.group);

  buildPiano();
  buildStrip();
  render();
}

const groupCount = () => Math.ceil(steps.length / settings.group);
const groupAt = (g) => steps.slice(g * settings.group, (g + 1) * settings.group);
const currentGroup = () => groupAt(groupIdx);

// ---------------------------------------------------------------- Teclado

let keyEls = new Map();

function buildPiano() {
  const piano = $('piano');
  piano.innerHTML = '';
  keyEls = new Map();
  if (!steps.length) return;

  const all = steps.flatMap((s) => s.pitches);
  let lo = Math.max(21, Math.floor(Math.min(...all) / 12) * 12);
  let hi = Math.min(108, Math.floor(Math.max(...all) / 12) * 12 + 11);
  while (hi - lo < 23) {
    if (hi < 107) hi += 12;
    else lo -= 12;
  }

  const whites = [];
  for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
  const ww = 100 / whites.length;

  for (let m = lo; m <= hi; m++) {
    const k = document.createElement('div');
    k.dataset.midi = m;
    if (isBlack(m)) {
      const idx = whites.filter((w) => w < m).length;
      k.className = 'key black';
      k.style.left = `${idx * ww - ww * 0.3}%`;
      k.style.width = `${ww * 0.6}%`;
    } else {
      k.className = 'key white';
    }
    if (settings.labels || m % 12 === 0) {
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = noteName(m);
      k.appendChild(lbl);
    }
    k.addEventListener('pointerdown', () => {
      playNote(m, 0, 0.6);
      k.classList.add('pressed');
      setTimeout(() => k.classList.remove('pressed'), 150);
    });
    piano.appendChild(k);
    keyEls.set(m, k);
  }
}

function buildStrip() {
  const strip = $('strip');
  strip.innerHTML = '';
  for (let g = 0; g < groupCount(); g++) {
    const grp = document.createElement('div');
    grp.className = 'grp';
    grp.dataset.g = g;
    for (const s of groupAt(g)) {
      const st = document.createElement('span');
      st.className = 'st';
      st.innerHTML = s.pitches.slice().reverse().map(noteName).join('<br>');
      grp.appendChild(st);
    }
    grp.addEventListener('click', () => goTo(g));
    strip.appendChild(grp);
  }
}

function render() {
  const total = groupCount();
  const grp = currentGroup();
  const next = groupAt(groupIdx + 1);

  $('step-count').textContent = total ? `Paso ${groupIdx + 1} de ${total}` : 'Sin notas';
  $('step-time').textContent = grp[0] ? `En el video: ${fmtTime(grp[0].time)}` : '';
  $('progress-bar').style.width = total ? `${((groupIdx + 1) / total) * 100}%` : '0';
  $('btn-prev').disabled = groupIdx <= 0;
  $('btn-next').disabled = groupIdx >= total - 1;
  $('btn-orig').disabled = song?.source === 'file' && !$('file-audio').src;

  const now = $('now-notes');
  now.innerHTML = '';
  grp.forEach((s, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'note-sep';
      sep.textContent = '→';
      now.appendChild(sep);
    }
    const chip = document.createElement('span');
    chip.className = 'note-chip';
    chip.innerHTML = `<span class="n">${i + 1}</span>`;
    chip.append(s.pitches.map(noteName).join(' + '));
    now.appendChild(chip);
  });
  if (!grp.length) now.textContent = 'La IA no encontró notas. Probá subir la sensibilidad.';

  keyEls.forEach((k) => {
    k.classList.remove('now', 'next');
    k.querySelector('.badge')?.remove();
  });
  const order = new Map();
  grp.forEach((s, i) => s.pitches.forEach((p) => order.set(p, [...(order.get(p) || []), i + 1])));
  order.forEach((nums, p) => {
    const k = keyEls.get(p);
    if (!k) return;
    k.classList.add('now');
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = nums.join('·');
    k.appendChild(b);
  });
  next.forEach((s) => s.pitches.forEach((p) => keyEls.get(p)?.classList.add('next')));

  const strip = $('strip');
  strip.querySelectorAll('.grp').forEach((el) => {
    const g = Number(el.dataset.g);
    el.classList.toggle('cur', g === groupIdx);
    el.classList.toggle('done', g < groupIdx);
  });
  const cur = strip.querySelector('.grp.cur');
  if (cur) strip.scrollTo({ left: cur.offsetLeft - strip.clientWidth / 2 + cur.clientWidth / 2 });

  if (song && grp[0]) localStorage.setItem(`pt-pos:${song.id}`, String(groupIdx * settings.group));
}

function goTo(g, { play = settings.autoplay } = {}) {
  const total = groupCount();
  if (!total) return;
  groupIdx = Math.max(0, Math.min(total - 1, g));
  render();
  if (play) playGroup();
}

// ---------------------------------------------------------------- Sonido (sintetizador simple)

let actx = null;
let master = null;
let voices = [];
let timers = [];

function audio() {
  if (!actx) {
    actx = new AudioContext();
    const comp = actx.createDynamicsCompressor();
    master = actx.createGain();
    master.gain.value = 0.7;
    master.connect(comp);
    comp.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function playNote(midi, when = 0, dur = 0.6) {
  const ctx = audio();
  const t = Math.max(ctx.currentTime, when || 0);
  const f = 440 * 2 ** ((midi - 69) / 12);
  const env = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(f * 8, 12000);
  const o1 = ctx.createOscillator();
  o1.type = 'triangle';
  o1.frequency.value = f;
  const o2 = ctx.createOscillator();
  o2.type = 'sine';
  o2.frequency.value = f * 2;
  const g2 = ctx.createGain();
  g2.gain.value = 0.25;
  o1.connect(lp);
  o2.connect(g2).connect(lp);
  lp.connect(env).connect(master);

  const end = t + Math.max(dur, 0.25) + 0.9;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(0.35, t + 0.008);
  env.gain.exponentialRampToValueAtTime(0.12, t + 0.3);
  env.gain.exponentialRampToValueAtTime(0.0005, end);
  o1.start(t);
  o2.start(t);
  o1.stop(end);
  o2.stop(end);
  voices.push({ o1, o2, env });
  o1.onended = () => (voices = voices.filter((v) => v.o1 !== o1));
}

function stopPlayback() {
  timers.forEach(clearTimeout);
  timers = [];
  if (actx) {
    const t = actx.currentTime;
    voices.forEach(({ o1, o2, env }) => {
      env.gain.cancelScheduledValues(t);
      env.gain.setTargetAtTime(0.0001, t, 0.02);
      o1.stop(t + 0.1);
      o2.stop(t + 0.1);
    });
  }
  voices = [];
  keyEls.forEach((k) => k.classList.remove('playing'));
  stopOriginal();
}

function playGroup() {
  stopPlayback();
  const grp = currentGroup();
  if (!grp.length) return;
  const ctx = audio();
  const speed = settings.speed;
  let t = ctx.currentTime + 0.05;
  let prev = grp[0].time;
  grp.forEach((s, i) => {
    if (i) t += Math.min(Math.max(s.time - prev, 0.12), 1.5) / speed;
    prev = s.time;
    const d = Math.min(s.dur, 1.6) / speed;
    s.pitches.forEach((p) => playNote(p, t, d));
    const delay = (t - ctx.currentTime) * 1000;
    timers.push(
      setTimeout(() => s.pitches.forEach((p) => keyEls.get(p)?.classList.add('playing')), delay),
      setTimeout(() => s.pitches.forEach((p) => keyEls.get(p)?.classList.remove('playing')), delay + Math.min(d * 1000, 500)),
    );
  });
}

let origTimer = null;

function stopOriginal() {
  if (origTimer) {
    clearInterval(origTimer);
    origTimer = null;
    if (song?.source === 'youtube') player?.pauseVideo?.();
    else $('file-audio').pause();
  }
}

function playOriginal() {
  stopPlayback();
  const grp = currentGroup();
  if (!grp.length) return;
  const last = grp[grp.length - 1];
  const start = Math.max(0, grp[0].time - 0.3);
  const end = last.time + Math.min(last.dur, 1.2) + 0.25;

  if (song.source === 'youtube') {
    if (!player?.seekTo) return toast('El video todavía no cargó.');
    const rates = player.getAvailablePlaybackRates?.() || [1];
    const rate = rates.reduce((a, b) => (Math.abs(b - settings.speed) < Math.abs(a - settings.speed) ? b : a), 1);
    player.setPlaybackRate(rate);
    player.seekTo(start, true);
    player.playVideo();
    origTimer = setInterval(() => {
      if ((player.getCurrentTime() || 0) >= end) stopOriginal();
    }, 40);
  } else {
    const a = $('file-audio');
    if (!a.src) return toast('Volvé a subir el archivo para escuchar el original.');
    a.playbackRate = settings.speed;
    a.currentTime = start;
    a.play();
    origTimer = setInterval(() => {
      if (a.currentTime >= end) stopOriginal();
    }, 40);
  }
}

// ---------------------------------------------------------------- Controles

function initControls() {
  $('url-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const id = extractVideoId($('url-input').value);
    if (!id) return toast('Ese link no parece de YouTube.');
    openYouTube(id);
  });

  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f && !busy) fromFile(f);
  });

  $('btn-download').addEventListener('click', fromDownload);
  $('btn-capture').addEventListener('click', fromCapture);
  $('btn-stop-capture').addEventListener('click', () => stopCapture?.());

  $('btn-prev').addEventListener('click', () => goTo(groupIdx - 1));
  $('btn-next').addEventListener('click', () => goTo(groupIdx + 1));
  $('btn-play').addEventListener('click', playGroup);
  $('btn-orig').addEventListener('click', playOriginal);

  const mode = $('opt-mode');
  const group = $('opt-group');
  const sens = $('opt-sens');
  const speed = $('opt-speed');
  const names = $('opt-names');
  const autoplay = $('opt-autoplay');
  const labels = $('opt-labels');

  mode.value = settings.mode;
  group.value = String(settings.group);
  sens.value = settings.sens;
  speed.value = settings.speed;
  names.value = settings.names;
  autoplay.checked = settings.autoplay;
  labels.checked = settings.labels;
  const showVals = () => {
    $('sens-val').textContent = settings.sens;
    $('speed-val').textContent = `${Math.round(settings.speed * 100)}%`;
  };
  showVals();

  mode.addEventListener('change', () => {
    settings.mode = mode.value;
    saveSettings();
    recompute();
  });
  group.addEventListener('change', () => setGroupSize(Number(group.value)));
  sens.addEventListener('change', () => {
    settings.sens = Number(sens.value);
    saveSettings();
    showVals();
    recompute();
  });
  sens.addEventListener('input', () => ($('sens-val').textContent = sens.value));
  speed.addEventListener('input', () => {
    settings.speed = Number(speed.value);
    saveSettings();
    showVals();
  });
  names.addEventListener('change', () => {
    settings.names = names.value;
    saveSettings();
    buildPiano();
    buildStrip();
    render();
  });
  autoplay.addEventListener('change', () => {
    settings.autoplay = autoplay.checked;
    saveSettings();
  });
  labels.addEventListener('change', () => {
    settings.labels = labels.checked;
    saveSettings();
    buildPiano();
    render();
  });

  // Que Espacio/flechas sigan manejando la práctica después de tocar un control.
  document.querySelectorAll('#settings select, #settings input').forEach((el) =>
    el.addEventListener('change', () => el.blur()),
  );

  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input[type="text"], textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($('practice').hidden) return;
    const k = e.key;
    if (k === ' ' || k === 'ArrowRight') {
      e.preventDefault();
      goTo(groupIdx + 1);
    } else if (k === 'ArrowLeft') {
      e.preventDefault();
      goTo(groupIdx - 1);
    } else if (k === 'r' || k === 'R' || k === 'Enter') {
      e.preventDefault();
      playGroup();
    } else if (k === 'o' || k === 'O') {
      playOriginal();
    } else if (k === 'Home') {
      goTo(0);
    } else if (/^[1-68]$/.test(k)) {
      setGroupSize(Number(k));
    }
  });
}

function setGroupSize(n) {
  const firstStep = groupIdx * settings.group;
  settings.group = n;
  saveSettings();
  $('opt-group').value = String(n);
  groupIdx = Math.floor(firstStep / n);
  buildStrip();
  render();
}

initControls();
renderRecent();

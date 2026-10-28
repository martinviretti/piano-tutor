// Servidor local de Piano Tutor. Sin dependencias: solo Node 18+.
// - Sirve la app (carpeta public/).
// - /api/audio?url=<youtube>  baja el audio con yt-dlp (sin convertir) y lo cachea en cache/.
//   El navegador se encarga de pasarlo a 22050 Hz mono, que es lo que pide basic-pitch.
// - Si yt-dlp no está en bin/, lo descarga de GitHub al arrancar.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 3737;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_DIR = path.join(ROOT, 'cache');
const BIN_DIR = path.join(ROOT, 'bin');
const MAX_DURATION_SEC = 15 * 60;

const YTDLP_ASSET = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' }[process.platform];
const YTDLP = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.webm': 'audio/webm',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1, 12);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v');
    if (!id) {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) id = m[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP)) return;
  if (!YTDLP_ASSET) throw new Error(`Plataforma no soportada: ${process.platform}`);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
  console.log(`Descargando yt-dlp (~20 MB, solo la primera vez)...`);
  const tmp = `${YTDLP}.part`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    fs.writeFileSync(tmp, Buffer.from(await resp.arrayBuffer()));
  } catch (err) {
    // Plan B: curl (viene con Windows 10/11, macOS y casi todos los Linux) usa los certificados
    // del sistema, lo que ayuda en redes corporativas con proxy.
    console.log(`fetch falló (${err.cause?.code || err.message}); probando con curl...`);
    await new Promise((resolve, reject) => {
      const p = spawn('curl', ['-fsSL', '-o', tmp, url], { windowsHide: true });
      p.on('error', () => reject(new Error('No se pudo descargar yt-dlp y no hay curl disponible.')));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`No se pudo descargar yt-dlp (curl código ${code}).`))));
    });
  }
  fs.renameSync(tmp, YTDLP);
  if (process.platform !== 'win32') fs.chmodSync(YTDLP, 0o755);
  console.log('yt-dlp listo.');
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    // YouTube necesita un runtime de JS para extraer formatos; usamos el mismo Node que corre esto.
    const fullArgs = ['--encoding', 'utf-8', '--js-runtimes', `node:${process.execPath}`, ...args];
    // Opcional: si YouTube pide "confirmar que no sos un bot", se pueden usar las cookies de un
    // navegador donde tengas sesión iniciada, ej. YTDLP_COOKIES_FROM_BROWSER=firefox
    if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
      fullArgs.unshift('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
    }
    const proc = spawn(YTDLP, fullArgs, { cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const errLines = stderr.split(/\r?\n/).filter((l) => l.startsWith('ERROR'));
      const msg = errLines.slice(-2).join(' | ') || `yt-dlp terminó con código ${code}`;
      if (/not a bot|Sign in to confirm/i.test(msg)) {
        return reject(new Error('YouTube bloqueó la descarga desde esta red ("confirmá que no sos un bot"). Usá "Escuchar el video y transcribir".'));
      }
      reject(new Error(msg));
    });
  });
}

// Evita bajar dos veces el mismo video si llegan pedidos simultáneos.
const inFlight = new Map();

async function ensureAudio(id) {
  const metaPath = path.join(CACHE_DIR, `${id}.json`);
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const audioPath = path.join(CACHE_DIR, meta.file);
    if (fs.existsSync(audioPath)) return { audioPath, meta };
  }
  if (inFlight.has(id)) return inFlight.get(id);

  const job = (async () => {
    const { stdout } = await runYtDlp([
      '--no-playlist',
      '--no-progress',
      '--match-filter', `duration <= ${MAX_DURATION_SEC}`,
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--print', 'after_move:%(title)s\t%(duration)s\t%(filepath)s',
      '--no-simulate',
      '-o', path.join(CACHE_DIR, `${id}.%(ext)s`),
      `https://www.youtube.com/watch?v=${id}`,
    ]);
    const lastLine = stdout.trim().split(/\r?\n/).pop() || '';
    const [title, duration, filepath] = lastLine.split('\t');
    if (!filepath || !fs.existsSync(filepath)) {
      throw new Error(`No se pudo obtener el audio. ¿El video dura más de ${MAX_DURATION_SEC / 60} minutos?`);
    }
    const meta = { id, title: title || id, duration: Number(duration) || 0, file: path.basename(filepath) };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    return { audioPath: filepath, meta };
  })();

  inFlight.set(id, job);
  try {
    return await job;
  } finally {
    inFlight.delete(id);
  }
}

async function handleAudio(req, res, urlObj) {
  const id = extractVideoId(urlObj.searchParams.get('url'));
  if (!id) return sendJson(res, 400, { error: 'Link de YouTube inválido.' });
  try {
    await ensureYtDlp();
    const { audioPath, meta } = await ensureAudio(id);
    const stat = fs.statSync(audioPath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(audioPath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Video-Id': id,
      'X-Video-Title': encodeURIComponent(meta.title),
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(audioPath).pipe(res);
  } catch (err) {
    console.error(`[${id}]`, err.message);
    sendJson(res, 500, { error: err.message });
  }
}

function serveStatic(req, res, urlObj) {
  let rel = decodeURIComponent(urlObj.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  if (urlObj.pathname === '/api/audio') return handleAudio(req, res, urlObj);
  return serveStatic(req, res, urlObj);
});

server.listen(PORT, HOST, () => {
  console.log(`Piano Tutor listo en http://localhost:${PORT}`);
  ensureYtDlp().catch((err) => console.error(err.message));
});

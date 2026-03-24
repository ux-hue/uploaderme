/**
 * Faba•Me Audio Uploader - Backend Server
 * 
 * Proxies requests to the MyFaba studio API and handles MP3→WAV conversion.
 * Uses the same flow as the open-source myfaba_upload.py script.
 */

const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { JSDOM } = require('jsdom');
const { parse: parseUrl } = require('url');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/m4a'];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|ogg|aac|m4a)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Formato audio non supportato'));
    }
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const BASE_URL = 'https://studio.myfaba.com/record/';

/**
 * Validates and extracts the 10-char share_id from a URL or raw string.
 */
function extractShareId(input) {
  const match = input.match(/([A-Za-z0-9]{10})(?:[/?].*)?$/);
  return match ? match[1] : null;
}

/**
 * Step 1: Load the share page to get session cookies and redirect URL.
 */
async function loadPage(shareId) {
  const url = `${BASE_URL}${shareId}`;
  const response = await axios.get(url, {
    maxRedirects: 0,
    validateStatus: (s) => s < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    }
  });

  if (response.status === 302) {
    const cookies = response.headers['set-cookie'] || [];
    let xsrfToken = null;
    let sessionCookie = null;

    for (const c of cookies) {
      const xsrf = c.match(/XSRF-TOKEN=([^;]+)/);
      const sess = c.match(/myfaba_cms_session=([^;]+)/);
      if (xsrf) xsrfToken = decodeURIComponent(xsrf[1]);
      if (sess) sessionCookie = sess[1];
    }

    const locationUrl = response.headers['location'];
    return { xsrfToken, sessionCookie, locationUrl };
  }

  throw new Error(`Link non valido o scaduto (status: ${response.status})`);
}

/**
 * Step 2: Load the redirect page to extract the form action URL and CSRF token.
 */
async function fetchParameters(xsrfToken, sessionCookie, locationUrl) {
  const cookieStr = `XSRF-TOKEN=${encodeURIComponent(xsrfToken)}; myfaba_cms_session=${sessionCookie}`;
  
  const response = await axios.get(locationUrl, {
    headers: {
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    }
  });

  const dom = new JSDOM(response.data);
  const form = dom.window.document.getElementById('form');

  if (!form) {
    throw new Error('Form non trovato nella pagina. Il link potrebbe essere scaduto.');
  }

  const actionUrl = form.getAttribute('action');
  const tokenInput = dom.window.document.querySelector('input[name="_token"]');

  if (!actionUrl || !tokenInput) {
    throw new Error('Parametri del form non trovati.');
  }

  const parsedAction = parseUrl(actionUrl, true);
  const expires = parsedAction.query.expires;
  const signature = parsedAction.query.signature;

  return {
    actionUrl,
    expires,
    signature,
    _token: tokenInput.value,
    cookieStr
  };
}

/**
 * Converts audio buffer to WAV using ffmpeg.
 * Returns a Buffer of WAV data.
 */
function convertToWav(inputBuffer, inputName) {
  return new Promise((resolve, reject) => {
    const tmpIn = path.join(os.tmpdir(), `faba_in_${Date.now()}${path.extname(inputName) || '.mp3'}`);
    const tmpOut = path.join(os.tmpdir(), `faba_out_${Date.now()}.wav`);

    fs.writeFileSync(tmpIn, inputBuffer);

    ffmpeg(tmpIn)
      .audioCodec('pcm_s16le')
      .audioChannels(2)
      .audioFrequency(44100)
      .toFormat('wav')
      .on('end', () => {
        const wavBuffer = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
        resolve(wavBuffer);
      })
      .on('error', (err) => {
        try { fs.unlinkSync(tmpIn); } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
        reject(new Error(`Conversione audio fallita: ${err.message}`));
      })
      .save(tmpOut);
  });
}

/**
 * Gets WAV duration in seconds from a WAV buffer.
 */
function getWavDuration(wavBuffer) {
  // WAV header: bytes 24-27 = sample rate, bytes 4-7 = file size - 8, data chunk at offset ~44
  // Parse the header to get nChannels, sampleRate, bitsPerSample
  const sampleRate = wavBuffer.readUInt32LE(24);
  const numChannels = wavBuffer.readUInt16LE(22);
  const bitsPerSample = wavBuffer.readUInt16LE(34);
  const dataSize = wavBuffer.readUInt32LE(40);
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = dataSize / (numChannels * bytesPerSample);
  return Math.floor(numSamples / sampleRate);
}

/**
 * Step 3: Upload the WAV file to MyFaba.
 */
async function uploadWav(actionUrl, cookieStr, _token, wavBuffer, author, title) {
  const duration = getWavDuration(wavBuffer);

  const form = new FormData();
  form.append('_token', _token);
  form.append('duration', String(duration));
  form.append('creator', author);
  form.append('title', title);
  form.append('userAudio', wavBuffer, {
    filename: 'recorded.wav',
    contentType: 'audio/wav',
    knownLength: wavBuffer.length
  });

  const response = await axios.post(actionUrl, form, {
    headers: {
      ...form.getHeaders(),
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://studio.myfaba.com/'
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  if (response.status >= 200 && response.status < 400) {
    return true;
  }

  throw new Error(`Upload fallito con status ${response.status}`);
}

// ─── API Route: Validate link ───────────────────────────────────────────────

app.post('/api/validate', async (req, res) => {
  const { url } = req.body;
  const shareId = extractShareId(url || '');

  if (!shareId) {
    return res.status(400).json({ ok: false, error: 'URL non valido. Deve avere la forma https://studio.myfaba.com/record/XXXXXXXXXX' });
  }

  try {
    const { xsrfToken, sessionCookie, locationUrl } = await loadPage(shareId);
    if (!xsrfToken || !sessionCookie || !locationUrl) {
      return res.status(400).json({ ok: false, error: 'Link non valido o già scaduto.' });
    }

    // Parse expiry from redirect URL
    const parsed = parseUrl(locationUrl, true);
    const expires = parsed.query.expires ? parseInt(parsed.query.expires) : null;
    const expiresDate = expires ? new Date(expires * 1000).toLocaleString('it-IT') : null;

    return res.json({ ok: true, shareId, expiresDate });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── API Route: Upload audio ─────────────────────────────────────────────────

app.post('/api/upload', upload.single('audio'), async (req, res) => {
  const { shareId, author, title } = req.body;

  if (!shareId || !author || !title) {
    return res.status(400).json({ ok: false, error: 'Campi mancanti: shareId, author, title.' });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Nessun file audio caricato.' });
  }

  try {
    // Step 1: Get session
    const { xsrfToken, sessionCookie, locationUrl } = await loadPage(shareId);
    if (!xsrfToken) throw new Error('Link scaduto o non valido.');

    // Step 2: Get form parameters
    const { actionUrl, _token, cookieStr } = await fetchParameters(xsrfToken, sessionCookie, locationUrl);

    // Step 3: Convert to WAV if needed
    let wavBuffer;
    const isWav = req.file.originalname.match(/\.wav$/i) || req.file.mimetype === 'audio/wav';

    if (isWav) {
      wavBuffer = req.file.buffer;
    } else {
      wavBuffer = await convertToWav(req.file.buffer, req.file.originalname);
    }

    // Step 4: Upload
    await uploadWav(actionUrl, cookieStr, _token, wavBuffer, author, title);

    return res.json({ ok: true, message: 'Audio caricato con successo! Controlla l\'app MyFaba.' });

  } catch (err) {
    console.error('Upload error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎵 Faba Uploader running on http://localhost:${PORT}`);
});

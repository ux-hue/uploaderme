# 🎵 Faba•Me Audio Uploader

Web app mobile-first per caricare file MP3/audio su **Faba•Me** (Personaggio Sonoro di FABA+) tramite il link d'invito generato dall'app MyFaba.

## Come funziona

Il sistema Faba•Me permette all'utente di condividere un link temporaneo (24 ore) tramite l'app MyFaba, affinché parenti o amici possano registrare una voce. Questa webapp estende quella funzionalità permettendo di **caricare un file audio già pronto** (MP3, WAV, ecc.) invece di registrare dal microfono.

**Flusso:**
1. L'utente incolla il link tipo `https://studio.myfaba.com/record/XXXXXXXXXX`
2. La webapp verifica il link e ne legge la sessione
3. L'utente carica un file MP3/audio e inserisce titolo + autore
4. Il server converte l'audio in WAV (44100Hz, stereo, PCM 16bit) e lo carica sul cloud MyFaba
5. Il proprietario del Faba•Me riceve la notifica sull'app e può sincronizzare il dispositivo

## Requisiti

- **Node.js** ≥ 18
- **ffmpeg** installato nel sistema

### Installazione ffmpeg

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows: scarica da https://ffmpeg.org/download.html
```

## Setup e avvio

```bash
# 1. Installa dipendenze
npm install

# 2. Avvia il server
npm start

# Oppure in sviluppo con auto-reload
npm run dev
```

Il server parte su `http://localhost:3000`.

## Deploy

### Con PM2 (VPS / server)

```bash
npm install -g pm2
pm2 start server.js --name faba-uploader
pm2 save
pm2 startup
```

### Con Docker

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t faba-uploader .
docker run -p 3000:3000 faba-uploader
```

### Con Render / Railway / Fly.io

Questi servizi supportano applicazioni Node.js + ffmpeg. Aggiungi ffmpeg nel build step se richiesto.

### Con Nginx (reverse proxy)

```nginx
server {
    listen 80;
    server_name tuodominio.it;

    client_max_body_size 200M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

## Note tecniche

- Il server fa da **proxy** verso l'API `studio.myfaba.com` per evitare problemi CORS
- Usa lo stesso flusso HTTP del progetto open-source [60ne/faba-tools](https://github.com/60ne/faba-tools)
- L'audio viene convertito in **WAV PCM 16bit, 44100Hz, stereo** (formato richiesto dall'API Faba)
- I file temporanei vengono eliminati automaticamente dopo l'upload
- Limite upload: 200MB per file

## Formati audio supportati

MP3, WAV, OGG, AAC, M4A (e qualsiasi formato supportato da ffmpeg)

## Crediti

Basato sulla ricerca del progetto [60ne/faba-tools](https://github.com/60ne/faba-tools) (Apache 2.0).

const API_BASE = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://localhost:8020'
  : '/api';

const crateGrid = document.getElementById('crateGrid');
const crateEmpty = document.getElementById('crateEmpty');
const crateLoading = document.getElementById('crateLoading');
const submitForm = document.getElementById('submitForm');
const linkInput = document.getElementById('linkInput');
const btnDrop = document.getElementById('btnDrop');
const submitFeedback = document.getElementById('submitFeedback');

const turntableVinyl = document.getElementById('turntableVinyl');
const turntableLabel = document.getElementById('turntableLabel');
const tonearm = document.getElementById('tonearm');
const nowPlayingIdle = document.getElementById('nowPlayingIdle');
const nowPlayingActive = document.getElementById('nowPlayingActive');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingArtist = document.getElementById('nowPlayingArtist');
const nowPlayingPlatform = document.getElementById('nowPlayingPlatform');
const btnStop = document.getElementById('btnStop');
const btnOpen = document.getElementById('btnOpen');
const embedContainer = document.getElementById('embedContainer');
const powerLed = document.getElementById('powerLed');
const crateCount = document.getElementById('crateCount');
const visualizerRing = document.getElementById('visualizerRing');
const bottomViz = document.getElementById('bottomViz');
const waveformCanvas = document.getElementById('waveformCanvas');
const gridCanvas = document.getElementById('gridCanvas');

let tracks = [];
let currentTrack = null;
let lastSubmitTime = 0;
const COOLDOWN_MS = 30000;
const POLL_INTERVAL = 15000;

let audioContext = null;
let analyser = null;
let audioElement = null;
let audioSourceNode = null;
let vizAnimationId = null;
let usingRealAudio = false;

function initVisualizer() {
  const BAR_COUNT = 40;
  const radius = 135;
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'viz-bar';
    const angle = (i / BAR_COUNT) * 360;
    bar.style.transform = `rotate(${angle}deg) translateY(-${radius}px)`;
    bar.style.animationDelay = `${(Math.random() * 0.8).toFixed(2)}s`;
    bar.style.animationDuration = `${(0.3 + Math.random() * 0.5).toFixed(2)}s`;
    visualizerRing.appendChild(bar);
  }
}
initVisualizer();

const waveCtx = waveformCanvas.getContext('2d');

function resizeWaveformCanvas() {
  const rect = bottomViz.getBoundingClientRect();
  waveformCanvas.width = rect.width * window.devicePixelRatio;
  waveformCanvas.height = rect.height * window.devicePixelRatio;
  waveCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
resizeWaveformCanvas();
window.addEventListener('resize', resizeWaveformCanvas);

function getLikedIds() {
  try {
    return JSON.parse(localStorage.getItem('soundshelf_likes') || '[]');
  } catch {
    return [];
  }
}

function saveLikedIds(ids) {
  localStorage.setItem('soundshelf_likes', JSON.stringify(ids));
}

function isLiked(trackId) {
  return getLikedIds().includes(trackId);
}

function addLiked(trackId) {
  const ids = getLikedIds();
  if (!ids.includes(trackId)) {
    ids.push(trackId);
    saveLikedIds(ids);
  }
}

function parseSpotifyUrl(url) {
  const blockedMatch = url.match(/open\.spotify\.com\/(episode|show)\//) || url.match(/spotify:(episode|show):/);
  if (blockedMatch) return { type: blockedMatch[1], id: null, blocked: true };

  const webMatch = url.match(/open\.spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
  if (webMatch) return { type: webMatch[1], id: webMatch[2] };
  const uriMatch = url.match(/spotify:(track|playlist|album):([a-zA-Z0-9]+)/);
  if (uriMatch) return { type: uriMatch[1], id: uriMatch[2] };
  return null;
}

function parseYouTubeUrl(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

function parseUrl(url) {
  const spotify = parseSpotifyUrl(url);
  if (spotify) {
    if (spotify.blocked) return { blocked: true, reason: 'Podcasts and episodes aren\'t allowed — music only!' };
    return { platform: 'spotify', spotifyType: spotify.type, embedId: spotify.id, url };
  }

  const youtubeId = parseYouTubeUrl(url);
  if (youtubeId) return { platform: 'youtube', spotifyType: null, embedId: youtubeId, url };

  return null;
}

async function fetchMetadata(platform, url) {
  try {
    let endpoint;
    if (platform === 'spotify') {
      endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    } else {
      endpoint = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
    }

    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`oEmbed returned ${res.status}`);
    const data = await res.json();

    if (platform === 'spotify') {
      const titleParts = (data.title || '').split(' - ');
      let title = titleParts[0]?.trim() || data.title || 'Unknown Track';
      let artist = titleParts[1]?.trim() || null;

      if (!artist) {
        artist = await fetchSpotifyArtist(url);
      }

      return {
        title,
        artist,
        thumbnail_url: data.thumbnail_url || null,
      };
    } else {
      return {
        title: data.title || 'Unknown Video',
        artist: data.author_name || null,
        thumbnail_url: data.thumbnail_url || null,
      };
    }
  } catch (err) {
    console.warn('oEmbed fetch failed:', err);
    return { title: 'Unknown Track', artist: null, thumbnail_url: null };
  }
}

async function fetchSpotifyArtist(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<meta property="og:description" content="([^"]+)"/);
    if (match) {
        const artist = match[1].split('·')[0].trim();
      if (artist) return artist;
    }
  } catch (err) {
    console.warn('Spotify artist fetch failed:', err);
  }
  return null;
}

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const error = new Error(err.detail || `API ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function setFeedback(msg, type) {
  submitFeedback.textContent = msg;
  submitFeedback.className = 'submit-feedback ' + (type || '');
}

submitForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const url = linkInput.value.trim();
  if (!url) return;

  const now = Date.now();
  if (now - lastSubmitTime < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (now - lastSubmitTime)) / 1000);
    setFeedback(`Easy there! Wait ${remaining}s before dropping another.`, 'error');
    return;
  }

  const parsed = parseUrl(url);
  if (!parsed) {
    setFeedback('That doesn\'t look like a Spotify or YouTube link.', 'error');
    return;
  }
  if (parsed.blocked) {
    setFeedback(parsed.reason, 'error');
    return;
  }

  if (tracks.some(t => t.embed_id === parsed.embedId)) {
    setFeedback('That record is already in the crate!', 'error');
    return;
  }

  btnDrop.disabled = true;
  setFeedback('Fetching track info...', 'loading');

  const meta = await fetchMetadata(parsed.platform, url);

  try {
    const newTrack = await apiPost('/tracks', {
      platform: parsed.platform,
      spotify_type: parsed.spotifyType || 'track',
      url: parsed.url,
      embed_id: parsed.embedId,
      title: meta.title,
      artist: meta.artist,
      thumbnail_url: meta.thumbnail_url,
    });

    tracks.unshift(newTrack);
    renderCrate();

    lastSubmitTime = Date.now();
    setFeedback('Record dropped! Audio downloading...', 'success');
    linkInput.value = '';
  } catch (err) {
    if (err.status === 409) {
      setFeedback('That record is already in the crate!', 'error');
    } else if (err.status === 400 || err.status === 429) {
      setFeedback(err.message || 'That track was rejected.', 'error');
    } else {
      setFeedback('Something went wrong. Try again.', 'error');
    }
  }

  btnDrop.disabled = false;
  setTimeout(() => setFeedback('', ''), 4000);
});

function renderCrate() {
  crateGrid.innerHTML = '';
  crateEmpty.style.display = tracks.length === 0 ? 'block' : 'none';
  crateCount.textContent = tracks.length > 0 ? `${tracks.length} record${tracks.length !== 1 ? 's' : ''}` : '';

  tracks.forEach((track, i) => {
    const card = createRecordCard(track);
    card.style.animationDelay = `${i * 0.05}s`;
    crateGrid.appendChild(card);
  });
}

function createRecordCard(track) {
  const card = document.createElement('div');
  card.className = 'record-card';
  if (currentTrack && currentTrack.id === track.id) {
    card.classList.add('playing');
  }
  card.dataset.trackId = track.id;

  const disc = document.createElement('div');
  disc.className = 'record-disc';

  disc.innerHTML = `
    <div class="vinyl-grooves"></div>
    <div class="record-label">
      ${track.thumbnail_url
        ? `<img src="${escapeAttr(track.thumbnail_url)}" alt="" loading="lazy">`
        : `<span class="record-label-initial">${getInitial(track.title)}</span>`
      }
    </div>
    <div class="record-hole"></div>
    <div class="record-shine"></div>
  `;

  card.appendChild(disc);

  const info = document.createElement('div');
  info.className = 'record-info';

  const title = document.createElement('div');
  title.className = 'record-title';
  title.textContent = track.title || 'Unknown';

  const artist = document.createElement('div');
  artist.className = 'record-artist';
  artist.textContent = track.artist || track.platform;

  const likeBtn = document.createElement('button');
  likeBtn.className = 'record-like' + (isLiked(track.id) ? ' liked' : '');
  likeBtn.innerHTML = `<span class="heart">${isLiked(track.id) ? '&#9829;' : '&#9825;'}</span> <span class="like-count">${track.likes || 0}</span>`;

  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleLike(track.id, likeBtn);
  });

  info.appendChild(title);
  info.appendChild(artist);
  info.appendChild(likeBtn);
  card.appendChild(info);

  disc.addEventListener('click', () => playRecord(track));

  return card;
}

function getInitial(title) {
  if (!title) return '?';
  return title.charAt(0).toUpperCase();
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleLike(trackId, btn) {
  if (isLiked(trackId)) return;

  addLiked(trackId);
  btn.classList.add('liked');
  btn.querySelector('.heart').innerHTML = '&#9829;';

  const countEl = btn.querySelector('.like-count');
  const current = parseInt(countEl.textContent) || 0;
  countEl.textContent = current + 1;

  const track = tracks.find(t => t.id === trackId);
  if (track) track.likes = current + 1;

  try {
    await apiPost(`/tracks/${trackId}/like`);
  } catch (err) {
    console.error('Like error:', err);
  }
}

function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}

function loadSelfHostedAudio(track) {
  embedContainer.innerHTML = '';
  usingRealAudio = true;

  audioElement = new Audio(API_BASE + track.audio_url);
  audioElement.crossOrigin = 'anonymous';
  audioElement.volume = 0.8;

  initAudioContext();

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 128;
  analyser.smoothingTimeConstant = 0.8;

  audioSourceNode = audioContext.createMediaElementSource(audioElement);
  audioSourceNode.connect(analyser);
  analyser.connect(audioContext.destination);

  audioElement.play().catch(err => {
    console.warn('Autoplay blocked:', err);
  });

  startRealVisualizer();

  audioElement.addEventListener('ended', () => {
    stopRecord();
  });

  const playerEl = document.createElement('div');
  playerEl.className = 'self-hosted-player';
  playerEl.innerHTML = `
    <div class="shp-status">PREVIEW — 30s</div>
    <div class="shp-progress-wrap">
      <div class="shp-progress" id="shpProgress"></div>
    </div>
  `;
  embedContainer.appendChild(playerEl);

  const progressBar = playerEl.querySelector('#shpProgress');
  function updateProgress() {
    if (!audioElement || audioElement.paused) return;
    const pct = (audioElement.currentTime / audioElement.duration) * 100 || 0;
    progressBar.style.width = `${pct}%`;
    requestAnimationFrame(updateProgress);
  }
  audioElement.addEventListener('playing', () => requestAnimationFrame(updateProgress));
}

function startRealVisualizer() {
  const ringBars = visualizerRing.querySelectorAll('.viz-bar');
  const freqLength = analyser.frequencyBinCount;
  const freqData = new Uint8Array(freqLength);

  bottomViz.classList.add('active');

  function animate() {
    analyser.getByteFrequencyData(freqData);

    ringBars.forEach((bar, i) => {
      const dataIndex = Math.floor((i / ringBars.length) * freqLength);
      const value = freqData[dataIndex] / 255;
      const height = 4 + value * 28;
      bar.style.height = `${height}px`;
      bar.style.opacity = 0.3 + value * 0.7;
      if (value > 0.7) {
        bar.style.background = 'var(--neon-magenta)';
        bar.style.boxShadow = '0 0 6px var(--neon-magenta)';
      } else if (value > 0.4) {
        bar.style.background = 'var(--neon-purple)';
        bar.style.boxShadow = '0 0 4px var(--neon-purple)';
      } else {
        bar.style.background = 'var(--neon-cyan)';
        bar.style.boxShadow = '0 0 3px var(--neon-cyan)';
      }
    });

    drawMirroredSpectrum(freqData, freqLength);

    vizAnimationId = requestAnimationFrame(animate);
  }

  animate();
}

function drawMirroredSpectrum(freqData, freqLength) {
  const dpr = window.devicePixelRatio;
  const w = waveformCanvas.width / dpr;
  const h = waveformCanvas.height / dpr;

  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveCtx.clearRect(0, 0, w, h);

  const centerY = h / 2;
  const barCount = 80;
  const gap = 2;
  const barWidth = (w - gap * (barCount - 1)) / barCount;

  for (let i = 0; i < barCount; i++) {
    const dataIndex = Math.floor((i / barCount) * freqLength);
    const value = freqData[dataIndex] / 255;
    const barH = value * (centerY - 4);
    const x = i * (barWidth + gap);

    const t = i / barCount;
    let r, g, b;
    if (t < 0.5) {
      const p = t / 0.5;
      r = Math.round(0 + p * 180);
      g = Math.round(240 - p * 166);
      b = Math.round(255 - p * 0);
    } else {
      const p = (t - 0.5) / 0.5;
      r = Math.round(180 + p * 75);
      g = Math.round(74 - p * 74);
      b = Math.round(255 - p * 85);
    }
    const color = `rgb(${r},${g},${b})`;

    waveCtx.shadowColor = color;
    waveCtx.shadowBlur = 8 + value * 12;

    const gradUp = waveCtx.createLinearGradient(x, centerY, x, centerY - barH);
    gradUp.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
    gradUp.addColorStop(1, color);
    waveCtx.fillStyle = gradUp;
    waveCtx.fillRect(x, centerY - barH, barWidth, barH);

    const gradDown = waveCtx.createLinearGradient(x, centerY, x, centerY + barH);
    gradDown.addColorStop(0, `rgba(${r},${g},${b},0.25)`);
    gradDown.addColorStop(0.4, `rgba(${r},${g},${b},0.08)`);
    gradDown.addColorStop(1, 'transparent');
    waveCtx.fillStyle = gradDown;
    waveCtx.fillRect(x, centerY, barWidth, barH);
  }

  waveCtx.shadowBlur = 0;

  waveCtx.fillStyle = 'rgba(0, 240, 255, 0.12)';
  waveCtx.fillRect(0, centerY - 0.5, w, 1);
}

function stopRealVisualizer() {
  if (vizAnimationId) {
    cancelAnimationFrame(vizAnimationId);
    vizAnimationId = null;
  }

  visualizerRing.querySelectorAll('.viz-bar').forEach(bar => {
    bar.style.height = '';
    bar.style.opacity = '';
    bar.style.background = '';
    bar.style.boxShadow = '';
  });

  bottomViz.classList.remove('active');
  const cw = waveformCanvas.width / window.devicePixelRatio;
  const ch = waveformCanvas.height / window.devicePixelRatio;
  waveCtx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  waveCtx.clearRect(0, 0, cw, ch);
}

function stopAudio() {
  if (audioElement) {
    audioElement.pause();
    audioElement.src = '';
    audioElement = null;
  }
  if (audioSourceNode) {
    audioSourceNode.disconnect();
    audioSourceNode = null;
  }
  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }
  stopRealVisualizer();
  usingRealAudio = false;
}

function playRecord(track) {
  if (currentTrack && currentTrack.id === track.id) {
    stopRecord();
    return;
  }

  stopAudio();
  embedContainer.innerHTML = '';

  currentTrack = track;

  powerLed.classList.add('on');
  turntableVinyl.classList.add('visible');

  if (track.thumbnail_url) {
    turntableLabel.innerHTML = `<img src="${escapeAttr(track.thumbnail_url)}" alt="">`;
  } else {
    turntableLabel.innerHTML = `<span class="vinyl-label-text">${getInitial(track.title)}</span>`;
  }

  setTimeout(() => {
    tonearm.classList.add('playing');
  }, 100);

  setTimeout(() => {
    turntableVinyl.classList.add('spinning');
  }, 400);

  nowPlayingIdle.style.display = 'none';
  nowPlayingActive.style.display = 'flex';
  nowPlayingTitle.textContent = track.title || 'Unknown';
  nowPlayingArtist.textContent = track.artist || '—';
  nowPlayingPlatform.innerHTML = `<span class="platform-badge ${track.platform}">${track.platform}</span>`;
  btnOpen.href = track.url;

  if (track.audio_url) {
    loadSelfHostedAudio(track);
  } else {
    showDownloadingMessage(track);
    visualizerRing.classList.add('active');
  }

  document.querySelectorAll('.record-card').forEach(c => c.classList.remove('playing'));
  const playingCard = document.querySelector(`.record-card[data-track-id="${track.id}"]`);
  if (playingCard) playingCard.classList.add('playing');
}

function stopRecord() {
  currentTrack = null;

  stopAudio();

  powerLed.classList.remove('on');
  tonearm.classList.remove('playing');
  turntableVinyl.classList.remove('spinning');
  visualizerRing.classList.remove('active');

  setTimeout(() => {
    turntableVinyl.classList.remove('visible');
    turntableLabel.innerHTML = '<span class="vinyl-label-text">SS</span>';
  }, 500);

  nowPlayingIdle.style.display = 'flex';
  nowPlayingActive.style.display = 'none';
  embedContainer.innerHTML = '';

  document.querySelectorAll('.record-card').forEach(c => c.classList.remove('playing'));
}

function showDownloadingMessage(track) {
  embedContainer.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'downloading-msg';
  msg.innerHTML = `
    <div class="downloading-spinner"></div>
    <span>Downloading audio... hang tight</span>
  `;
  embedContainer.appendChild(msg);

  const wrapper = document.createElement('div');
  wrapper.style.marginTop = '8px';
  let iframe;
  if (track.platform === 'spotify') {
    const sType = track.spotify_type || 'track';
    iframe = document.createElement('iframe');
    iframe.src = `https://open.spotify.com/embed/${sType}/${track.embed_id}?theme=0`;
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    iframe.loading = 'lazy';
    iframe.style.height = sType === 'track' ? '152px' : '352px';
  } else {
    iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${track.embed_id}?autoplay=1`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.loading = 'lazy';
    iframe.style.height = '200px';
  }
  wrapper.appendChild(iframe);
  embedContainer.appendChild(wrapper);
}

function loadEmbed(track) {
  embedContainer.innerHTML = '';

  let iframe;
  if (track.platform === 'spotify') {
    const sType = track.spotify_type || 'track';
    iframe = document.createElement('iframe');
    iframe.src = `https://open.spotify.com/embed/${sType}/${track.embed_id}?theme=0`;
    iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
    iframe.loading = 'lazy';
    iframe.style.height = sType === 'track' ? '152px' : '352px';
  } else {
    iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${track.embed_id}?autoplay=1`;
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.loading = 'lazy';
    iframe.style.height = '200px';
  }

  embedContainer.appendChild(iframe);
}

btnStop.addEventListener('click', stopRecord);

async function loadTracks() {
  crateLoading.style.display = 'block';
  crateEmpty.style.display = 'none';

  try {
    tracks = await apiGet('/tracks');
    renderCrate();
  } catch (err) {
    console.error('Load error:', err);
    crateEmpty.style.display = 'block';
  }

  crateLoading.style.display = 'none';
}

async function pollTracks() {
  try {
    const fresh = await apiGet('/tracks');

    const freshKey = fresh.map(t => t.id + t.likes + (t.audio_url || '')).join(',');
    const currentKey = tracks.map(t => t.id + t.likes + (t.audio_url || '')).join(',');

    if (freshKey !== currentKey) {
      if (currentTrack && !currentTrack.audio_url) {
        const updated = fresh.find(t => t.id === currentTrack.id);
        if (updated && updated.audio_url) {
          currentTrack.audio_url = updated.audio_url;
          stopAudio();
          visualizerRing.classList.remove('active');
          loadSelfHostedAudio(currentTrack);
        }
      }

      tracks = fresh;
      renderCrate();
    }
  } catch {
  }
}

const gCtx = gridCanvas.getContext('2d');
let bgPulses = [];
let bgAnimId = null;
let lastBeatTime = 0;
let lastMidHit = 0;
let lastAmbientPulse = 0;
let smoothBass = 0;
let smoothMid = 0;
let prevBass = 0;
let prevMid = 0;

const PULSE_COLORS = [
  { r: 0, g: 240, b: 255 },    // cyan
  { r: 255, g: 0, b: 170 },    // magenta
  { r: 180, g: 74, b: 255 },   // purple
  { r: 57, g: 255, b: 20 },    // green
  { r: 255, g: 170, b: 0 },    // amber
];

function resizeGridCanvas() {
  gridCanvas.width = window.innerWidth * window.devicePixelRatio;
  gridCanvas.height = window.innerHeight * window.devicePixelRatio;
}

window.addEventListener('resize', resizeGridCanvas);
resizeGridCanvas();

function spawnPulse(intensity, ambient = false) {
  const w = gridCanvas.width / window.devicePixelRatio;
  const h = gridCanvas.height / window.devicePixelRatio;
  const color = PULSE_COLORS[Math.floor(Math.random() * PULSE_COLORS.length)];

  if (ambient) {
    bgPulses.push({
      x: Math.random() * w,
      y: Math.random() * h,
      born: performance.now(),
      maxRadius: 30 + intensity * 80 + Math.random() * 50,
      duration: 600 + Math.random() * 400,
      color,
      intensity: intensity * 0.6,
    });
  } else {
    bgPulses.push({
      x: Math.random() * w,
      y: Math.random() * h,
      born: performance.now(),
      maxRadius: 80 + intensity * 250 + Math.random() * 100,
      duration: 1200 + Math.random() * 800,
      color,
      intensity,
    });
  }
}

function startBgAnimation() {
  if (bgAnimId) return;

  function animate() {
    if (!analyser || !usingRealAudio) {
      const dpr = window.devicePixelRatio;
      gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gCtx.clearRect(0, 0, gridCanvas.width / dpr, gridCanvas.height / dpr);
      bgPulses = [];
      bgAnimId = null;
      return;
    }

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);

    const bassRange = Math.floor(analyser.frequencyBinCount * 0.12);
    const midRange = Math.floor(analyser.frequencyBinCount * 0.45);
    let bassSum = 0, midSum = 0;
    for (let i = 0; i < bassRange; i++) bassSum += freqData[i];
    for (let i = bassRange; i < midRange; i++) midSum += freqData[i];
    const bass = bassSum / (bassRange * 255);
    const mid = midSum / ((midRange - bassRange) * 255);

    smoothBass += (bass - smoothBass) * 0.4;
    smoothMid += (mid - smoothMid) * 0.3;

    const now = performance.now();

    const bassRise = smoothBass - prevBass;
    if (bassRise > 0.02 && smoothBass > 0.15 && now - lastBeatTime > 150) {
      lastBeatTime = now;
      const count = smoothBass > 0.5 ? 3 : smoothBass > 0.3 ? 2 : 1;
      for (let i = 0; i < count; i++) spawnPulse(smoothBass);
    }

    const midRise = smoothMid - prevMid;
    if (midRise > 0.03 && smoothMid > 0.2 && now - lastMidHit > 200) {
      lastMidHit = now;
      spawnPulse(smoothMid * 0.7);
    }

    const energy = smoothBass * 0.5 + smoothMid * 0.5;
    const ambientInterval = energy > 0.3 ? 120 : energy > 0.15 ? 250 : 500;
    if (now - lastAmbientPulse > ambientInterval && energy > 0.05) {
      lastAmbientPulse = now;
      spawnPulse(energy * 0.4, true);
    }

    prevBass = smoothBass;
    prevMid = smoothMid;

    bgPulses = bgPulses.filter(p => now - p.born < p.duration);

    drawPulses(now);

    bgAnimId = requestAnimationFrame(animate);
  }

  bgAnimId = requestAnimationFrame(animate);
}

function drawPulses(now) {
  const dpr = window.devicePixelRatio;
  const w = gridCanvas.width / dpr;
  const h = gridCanvas.height / dpr;

  gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gCtx.clearRect(0, 0, w, h);

  for (const p of bgPulses) {
    const age = (now - p.born) / p.duration; // 0 → 1
    const radius = Math.max(0, age * p.maxRadius);
    const fade = Math.max(0, 1 - age);
    const { r, g, b } = p.color;

    gCtx.save();
    gCtx.beginPath();
    gCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    gCtx.strokeStyle = `rgba(${r},${g},${b},${fade * 0.4 * p.intensity})`;
    gCtx.lineWidth = 2 + fade * 3;
    gCtx.shadowColor = `rgb(${r},${g},${b})`;
    gCtx.shadowBlur = 15 + fade * 25;
    gCtx.stroke();
    gCtx.restore();

    if (age < 0.4) {
      const fillFade = (1 - age / 0.4);
      const grad = gCtx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      grad.addColorStop(0, `rgba(${r},${g},${b},${fillFade * 0.12 * p.intensity})`);
      grad.addColorStop(0.6, `rgba(${r},${g},${b},${fillFade * 0.04 * p.intensity})`);
      grad.addColorStop(1, 'transparent');
      gCtx.fillStyle = grad;
      gCtx.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
    }

    if (age < 0.15) {
      const dotFade = 1 - age / 0.15;
      gCtx.save();
      gCtx.beginPath();
      gCtx.arc(p.x, p.y, 3 + p.intensity * 4, 0, Math.PI * 2);
      gCtx.fillStyle = `rgba(255,255,255,${dotFade * 0.7})`;
      gCtx.shadowColor = `rgb(${r},${g},${b})`;
      gCtx.shadowBlur = 20;
      gCtx.fill();
      gCtx.restore();
    }
  }
}

const _origLoadSelfHosted = loadSelfHostedAudio;
loadSelfHostedAudio = function(track) {
  _origLoadSelfHosted(track);
  startBgAnimation();
};

const _origStopAudio = stopAudio;
stopAudio = function() {
  _origStopAudio();
};

loadTracks();
setInterval(pollTracks, POLL_INTERVAL);

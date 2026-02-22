from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import sqlite3
import uuid
import subprocess
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from contextlib import contextmanager

app = FastAPI(title="SoundShelf API", docs_url=None, redoc_url=None, openapi_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://soundshelf.ochiba.dev"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = Path(__file__).parent / "soundshelf.db"
AUDIO_DIR = Path(__file__).parent / "audio"
AUDIO_DIR.mkdir(exist_ok=True)

YTDLP_BIN = Path(__file__).parent / "venv" / "bin" / "yt-dlp"
FFMPEG_BIN = Path.home() / "bin" / "ffmpeg"

MAX_DURATION_SECONDS = 420  # 7 minutes
SUBMIT_COOLDOWN_SECONDS = 30
LIKE_COOLDOWN_SECONDS = 2

# In-memory rate limit tracking: {ip: last_timestamp}
_submit_times: dict[str, float] = {}
_like_times: dict[str, float] = {}
_download_times: dict[str, float] = {}
DOWNLOAD_COOLDOWN_SECONDS = 10


def get_real_ip(request: Request) -> str:
    return request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or request.client.host


def rate_limit(store: dict, ip: str, cooldown: int):
    import time
    now = time.time()
    last = store.get(ip, 0)
    if now - last < cooldown:
        remaining = int(cooldown - (now - last))
        raise HTTPException(429, f"Slow down! Try again in {remaining}s.")
    store[ip] = now
    if len(store) > 10000:
        cutoff = now - 3600
        for k in [k for k, v in store.items() if v < cutoff]:
            del store[k]

# Words that auto-reject a submission (checked against title + artist, case-insensitive)
BLOCKED_WORDS = {
    "porn", "porno", "pornhub", "xvideos", "xnxx", "xhamster", "redtube",
    "hentai", "onlyfans", "brazzers", "bangbros", "naughtyamerica",
    "xxx", "sexvideo", "sextape", "sex tape",
    "leaked nudes", "nude video", "naked video",
}

# Compile a single regex from all blocked words for fast matching
_blocked_pattern = re.compile(
    r'\b(' + '|'.join(re.escape(w) for w in BLOCKED_WORDS) + r')\b',
    re.IGNORECASE,
)


def check_profanity(title: str, artist: str | None) -> str | None:
    """Return the matched word if blocked, else None."""
    text = f"{title} {artist or ''}"
    m = _blocked_pattern.search(text)
    return m.group(0) if m else None


def fetch_spotify_artist(url: str) -> str | None:
    if not re.match(r'^https://open\.spotify\.com/', url):
        return None
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
        m = re.search(r'<meta property="og:description" content="([^"]+)"', html)
        if m:
            # Format: "Artist1, Artist2 · Album · Song · Year"
            desc = m.group(1)
            artist_part = desc.split("·")[0].strip()
            if artist_part:
                return artist_part
    except Exception as e:
        print(f"[spotify] Failed to fetch artist from {url}: {e}")
    return None


def check_youtube_duration(url: str) -> int | None:
    """Get YouTube video duration in seconds using yt-dlp. Returns None on failure."""
    try:
        result = subprocess.run(
            [str(YTDLP_BIN), "--dump-json", "--no-download", "--no-playlist", url],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        info = json.loads(result.stdout)
        return int(info.get("duration", 0))
    except Exception as e:
        print(f"[validate] Duration check failed for {url}: {e}")
        return None


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tracks (
                id TEXT PRIMARY KEY,
                platform TEXT NOT NULL CHECK (platform IN ('spotify', 'youtube')),
                spotify_type TEXT DEFAULT 'track',
                url TEXT NOT NULL,
                embed_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                artist TEXT,
                thumbnail_url TEXT,
                audio_url TEXT,
                likes INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            )
        """)
        for col, default in [
            ("spotify_type", "'track'"),
            ("audio_url", "NULL"),
        ]:
            try:
                conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} TEXT DEFAULT {default}")
            except sqlite3.OperationalError:
                pass
        conn.commit()


init_db()

# Serve audio files
app.mount("/audio", StaticFiles(directory=str(AUDIO_DIR)), name="audio")


# --- Models ---

MAX_TRACKS = 500

class TrackIn(BaseModel):
    platform: str
    spotify_type: str = "track"
    url: str
    embed_id: str
    title: str
    artist: str | None = None
    thumbnail_url: str | None = None


class TrackOut(BaseModel):
    id: str
    platform: str
    spotify_type: str | None
    url: str
    embed_id: str
    title: str
    artist: str | None
    thumbnail_url: str | None
    audio_url: str | None
    likes: int
    created_at: str


# --- Audio Download ---

def download_audio(track_id: str, platform: str, url: str, embed_id: str, title: str, artist: str | None):
    """Download audio using yt-dlp and trim to 30s preview with ffmpeg."""
    try:
        output_path = AUDIO_DIR / f"{embed_id}.mp3"
        temp_path = AUDIO_DIR / f"{embed_id}_full"

        if output_path.exists():
            audio_url = f"/audio/{embed_id}.mp3"
            with get_db() as conn:
                conn.execute("UPDATE tracks SET audio_url = ? WHERE id = ?", (audio_url, track_id))
                conn.commit()
            return

        # Build source URL
        if platform == "youtube":
            source = url
        else:
            # For Spotify, build a precise YouTube search query.
            # If artist is missing (oEmbed doesn't always include it),
            # fetch the Spotify page's og:description which has full metadata.
            search_artist = artist
            if not search_artist:
                search_artist = fetch_spotify_artist(url)
            search_query = f"{title} {search_artist}" if search_artist else title
            source = f"ytsearch1:{search_query}"

        # Download audio with yt-dlp
        cmd = [
            str(YTDLP_BIN),
            "--ffmpeg-location", str(FFMPEG_BIN.parent),
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "128K",
            "-o", str(temp_path) + ".%(ext)s",
            "--no-playlist",
            "--max-filesize", "50M",
            source,
        ]

        subprocess.run(cmd, capture_output=True, timeout=120, check=True)

        # Find downloaded file
        temp_mp3 = temp_path.with_suffix(".mp3")
        if not temp_mp3.exists():
            for f in AUDIO_DIR.glob(f"{embed_id}_full.*"):
                temp_mp3 = f
                break

        if not temp_mp3.exists():
            print(f"[audio] Download failed - no file for {embed_id}")
            return

        # Trim to 30 seconds
        trim_cmd = [
            str(FFMPEG_BIN),
            "-y",
            "-i", str(temp_mp3),
            "-t", "30",
            "-acodec", "libmp3lame",
            "-ab", "128k",
            str(output_path),
        ]

        subprocess.run(trim_cmd, capture_output=True, timeout=60, check=True)

        # Clean up temp
        if temp_mp3 != output_path:
            temp_mp3.unlink(missing_ok=True)

        # Update DB
        audio_url = f"/audio/{embed_id}.mp3"
        with get_db() as conn:
            conn.execute("UPDATE tracks SET audio_url = ? WHERE id = ?", (audio_url, track_id))
            conn.commit()

        print(f"[audio] Downloaded: {embed_id}.mp3")

    except subprocess.TimeoutExpired:
        print(f"[audio] Timeout for {embed_id}")
    except subprocess.CalledProcessError as e:
        print(f"[audio] yt-dlp/ffmpeg error for {embed_id}: {e.stderr[:500] if e.stderr else 'no stderr'}")
    except Exception as e:
        print(f"[audio] Error for {embed_id}: {e}")


# --- Routes ---

@app.get("/")
def health():
    return {"status": "ok", "service": "soundshelf"}


@app.get("/tracks", response_model=list[TrackOut])
def get_tracks():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM tracks ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/tracks", response_model=TrackOut, status_code=201)
def add_track(track: TrackIn, background_tasks: BackgroundTasks, request: Request):
    rate_limit(_submit_times, get_real_ip(request), SUBMIT_COOLDOWN_SECONDS)
    if track.platform not in ("spotify", "youtube"):
        raise HTTPException(400, "Platform must be spotify or youtube")

    if track.title and len(track.title) > 300:
        raise HTTPException(400, "Title too long")
    if track.artist and len(track.artist) > 300:
        raise HTTPException(400, "Artist name too long")
    if track.thumbnail_url and len(track.thumbnail_url) > 2000:
        raise HTTPException(400, "Thumbnail URL too long")

    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
        if count >= MAX_TRACKS:
            raise HTTPException(400, "The crate is full! No more tracks can be added.")

    if track.platform == "spotify" and not re.match(r'^https://open\.spotify\.com/', track.url):
        raise HTTPException(400, "Invalid Spotify URL")
    if track.platform == "youtube" and not re.match(r'^https://(www\.)?(youtube\.com|youtu\.be)/', track.url):
        raise HTTPException(400, "Invalid YouTube URL")

    if not re.match(r'^[a-zA-Z0-9_-]{1,64}$', track.embed_id):
        raise HTTPException(400, "Invalid track ID")

    # --- Content restrictions ---

    # Profanity filter
    bad_word = check_profanity(track.title, track.artist)
    if bad_word:
        raise HTTPException(400, "That track was rejected — keep it clean!")

    # Duration check for YouTube
    if track.platform == "youtube":
        duration = check_youtube_duration(track.url)
        if duration is not None and duration > MAX_DURATION_SECONDS:
            minutes = duration // 60
            raise HTTPException(400, f"That's {minutes} minutes long — max is 7. Music only, no movies or podcasts!")
        if duration is not None and duration < 10:
            raise HTTPException(400, "That's too short — must be at least 10 seconds.")

    # Block Spotify podcasts/episodes (extra backend safety)
    if track.platform == "spotify" and track.spotify_type in ("episode", "show"):
        raise HTTPException(400, "Podcasts and episodes aren't allowed — music only!")

    # --- End restrictions ---

    # Only download audio for individual tracks, not playlists/albums
    should_download = (
        track.platform == "youtube" or
        (track.platform == "spotify" and track.spotify_type == "track")
    )

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM tracks WHERE embed_id = ?", (track.embed_id,)
        ).fetchone()
        if existing:
            raise HTTPException(409, "Track already exists")

        track_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()

        conn.execute(
            """INSERT INTO tracks (id, platform, spotify_type, url, embed_id, title, artist, thumbnail_url, audio_url, likes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)""",
            (track_id, track.platform, track.spotify_type, track.url, track.embed_id,
             track.title, track.artist, track.thumbnail_url, now),
        )
        conn.commit()

        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()

    if should_download:
        background_tasks.add_task(
            download_audio, track_id, track.platform, track.url, track.embed_id, track.title, track.artist
        )

    return dict(row)


@app.post("/tracks/{track_id}/like", response_model=TrackOut)
def like_track(track_id: str, request: Request):
    ip = get_real_ip(request)
    rate_limit(_like_times, ip, LIKE_COOLDOWN_SECONDS)
    with get_db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")

        conn.execute(
            "UPDATE tracks SET likes = likes + 1 WHERE id = ?", (track_id,)
        )
        conn.commit()

        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()

    return dict(row)


@app.post("/tracks/{track_id}/download-audio")
def trigger_download(track_id: str, background_tasks: BackgroundTasks, request: Request):
    rate_limit(_download_times, get_real_ip(request), DOWNLOAD_COOLDOWN_SECONDS)
    """Manually trigger audio download for an existing track."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Track not found")
        track = dict(row)

    if track.get("audio_url"):
        return {"status": "already_downloaded", "audio_url": track["audio_url"]}

    background_tasks.add_task(
        download_audio, track_id, track["platform"], track["url"],
        track["embed_id"], track["title"], track.get("artist")
    )

    return {"status": "downloading"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8020)

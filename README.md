# MediaAnalyzer

Dockerized Node.js app with a simple Web UI to browse a mounted folder of media files and inspect metadata (codec, resolution, size, duration, bitrate, etc.) using `ffprobe`.

## Prereqs
- Docker Desktop

## Run
1. Create a `.env` file (you can copy `.env.example`) and set `MEDIA_HOST_PATH` to a folder on your machine that contains media files.
2. (Optional) If port 3000 is already in use, set `HOST_PORT` (e.g. `HOST_PORT=3001`).
3. Start:

```bash
docker compose up --build
```

3. Open: http://localhost:3000

## Notes
- The container assumes media is mounted at `MEDIA_ROOT` (default `/media`).
- Metadata is extracted via `ffprobe` (from `ffmpeg`), plus file stats.
- If `MEDIA_HOST_PATH` is not set, it mounts `./media` (repo folder) into the container.

If you changed `HOST_PORT`, open that port instead.

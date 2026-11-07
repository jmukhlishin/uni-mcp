# Universal MCP Hub (`uni-mcp`)

**Universal / Modular Model Context Protocol (MCP) Hub** berbasis **Node.js & TypeScript** menggunakan SDK resmi `@modelcontextprotocol/sdk`.

Dirancang khusus dengan **Stateless Streamable HTTP Transport** (`StreamableHTTPServerTransport`, **bukan** legacy SSE) dan sistem **Dynamic Plugin Tool Loader** sehingga Anda dapat menggabungkan berbagai API/tools (Obsidian Vault/Memory Integration, YouTube Level 2 Autonomous Channel & Video Management + Research, Serper Google Search, Server & Docker Monitoring, Network & MikroTik Diagnostics, Remote Computer Operation Dual-Target Windows PC, dll.) dalam satu container MCP yang ringan dan mudah diintegrasikan dengan **n8n MCP Client Node**.

---

## Fitur Utama

1. **Stateless Streamable HTTP Transport (`POST /mcp` & `POST /`)**
   - Menggunakan standar transport terbaru MCP (`StreamableHTTPServerTransport` dengan `sessionIdGenerator: undefined`).
   - Bebas masalah *session drop* atau *timeout* yang sering terjadi pada koneksi SSE jangka panjang.
2. **Arsitektur Plugin Modular (Auto-Discovery)**
   - Semua modul tool berada di dalam folder `src/tools/`.
   - Saat server dijalankan, `src/tools/index.ts` otomatis memindai dan memuat seluruh file di `src/tools/` tanpa perlu mengubah kode `src/server.ts`.
3. **Modul YouTube — Level 2: Full Autonomous Channel & Video Management + Public Research (`src/tools/youtube.ts`)**
   - Menghubungkan AI Agent ke **YouTube Data API v3** dan ekstraktor *subtitle/closed captions* untuk riset konten publik serta manajemen penuh akun/channel YouTube pribadi (`jmukhlishin@gmail.com`).
   - Mendukung **Auto-Refresh OAuth2 Access Token** (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`) dan fallback `YOUTUBE_API_KEY` untuk pencarian publik.
   - Menyediakan 7 tools utama: `youtube_search`, `youtube_get_video_details`, `youtube_get_transcript`, `youtube_get_channel_info`, `youtube_manage_playlist`, `youtube_upload_video`, dan `youtube_manage_video`.
4. **Modul Obsidian Local REST API — Memory & Vault Integration (`src/tools/obsidian.ts`)**
   - Menghubungkan AI Agent ke **Obsidian Local REST API** untuk manajemen memori jangka panjang dan catatan (*notes*) di dalam *vault* Obsidian.
   - **Multi-Target Vault Support** — Mendukung dua target vault Obsidian secara bersamaan melalui parameter opsional `target`:
     - **`lera`** (default): Menggunakan `OBSIDIAN_BASE_URL` + `OBSIDIAN_API_KEY`
     - **`lena`**: Menggunakan `OBSIDIAN_LENA_BASE_URL` + `OBSIDIAN_LENA_API_KEY`
   - Mendukung HTTP maupun HTTPS (*self-signed certificate* otomatis ditangani) dengan autentikasi `Bearer` token.
   - Menyediakan 5 tools utama: `obsidian_read_note`, `obsidian_append_note`, `obsidian_write_note`, `obsidian_search_notes`, dan `obsidian_list_files`.
5. **Modul Computer Operation — Dual Target Windows PC (`src/tools/computer_operation.ts` + `server.py`)**
   - Mengontrol PC Windows secara *remote* dari `uni-mcp` melalui protokol HTTP ke worker `server.py` (FastAPI + PyAutoGUI + MSS) yang berjalan di port `8181`.
   - Mendukung **Routing Dual Target IP** otomatis melalui parameter `target`:
     - **`office`** (PC Kantor): `http://192.168.0.91:8181`
     - **`home`** (PC Rumah / Tailscale): `http://100.107.229.43:8181`
   - Fitur lengkap: Mouse Click (kiri, kanan, tengah, double click), Mouse Move, Mouse Drag, Mouse Scroll, Screenshot Layar (MSS), Screen Record (MP4), Buka Aplikasi (`launch`), Tutup/Kill Aplikasi (`taskkill`), Ketik Teks Keyboard, Shortcut/Hotkey kombinasi tombol, dan Power Management (`shutdown`, `restart`, `cancel`).
6. **Modul Serper API (`src/tools/serper.ts`)**
   - `serper_google_search`: Pencarian web Google (`https://google.serper.dev/search`) lengkap dengan parameter `query`, `gl`, `hl`, `num`, `location`, `tbs`, `autocorrect`, `page`.
   - `serper_news_search`: Pencarian berita terbaru Google News (`https://google.serper.dev/news`) lengkap dengan parameter `query`, `gl`, `hl`, `num`, `location`, `tbs`, `autocorrect`, `page`.
7. **Modul Server Ubuntu & Docker Monitoring (`src/tools/monitoring.ts`)**
   - `monitor_system_metrics`: Memantau metrik sistem host Ubuntu meliputi penggunaan CPU (%), *load average* (1m, 5m, 15m), penggunaan RAM & Swap (`free -m`), penggunaan Disk (`df -h`), serta *uptime*.
   - `monitor_docker_containers`: Menampilkan daftar dan status container Docker (`docker ps` / `docker ps -a`) beserta filter nama container.
   - `monitor_docker_stats`: Memantau *resource usage* container secara *real-time snapshot* (`docker stats --no-stream`) meliputi CPU %, Memory usage/limit, Network I/O, dan Block I/O.
   - `monitor_docker_logs`: Mengambil log terbaru dari container tertentu (`docker logs --tail`) lengkap dengan dukungan opsi `--since` dan `timestamps`.
8. **Port Default Aman (`3301`)**
   - Berjalan di port `3301` (dapat diubah melalui variabel environment `PORT`) agar tidak bentrok dengan layanan lain (seperti port `3000` atau `3300`).

---

## Struktur Proyek

```text
uni-mcp/
├── src/
│   ├── server.ts                  # Entrypoint Express + Stateless Streamable HTTP MCP Server
│   ├── types.ts                   # Interface standar ToolDefinition & helper formatToolResult
│   └── tools/
│       ├── index.ts               # Dynamic Auto-Loader & Tool Registry
│       ├── youtube.ts             # Plugin tool Integrasi YouTube (Level 2: Channel, Video, Playlist, Search & Transcript)
│       ├── obsidian.ts            # Plugin tool Integrasi Memory/Vault via Obsidian Local REST API (Multi-Target: lera & lena)
│       ├── computer_operation.ts  # Plugin tool Remote Computer Operation (Dual Target: Office & Home)
│       ├── serper.ts              # Plugin tool Google Search & News Search (Serper.dev)
│       ├── monitoring.ts          # Plugin tool Monitoring Server Ubuntu & Docker Container
│       └── network.ts             # Plugin tool Network Diagnostics & MikroTik Monitoring
├── server.py                      # Worker Agent (FastAPI/PyAutoGUI/MSS) untuk PC Windows (Port 8181)
├── .env.example                   # Template konfigurasi environment
├── Dockerfile                     # Multi-stage Docker build (node:20-alpine + docker-cli + procps)
├── docker-compose.yml             # Konfigurasi container, port 3301:3301 & mount docker.sock
├── package.json
└── tsconfig.json
```

---

## Modul YouTube — Level 2: Full Autonomous Channel & Video Management + Public Research (`src/tools/youtube.ts`)

Modul ini mengintegrasikan **YouTube Data API v3**, **Google OAuth2 Auto-Refresh**, dan ekstraktor **Transcript / Closed Captions** ke dalam `uni-mcp` sehingga AI Agent dapat melakukan riset publik, merangkum isi video secara utuh dari transkrip, sekaligus mengelola channel, video, dan playlist milik akun pribadi (`jmukhlishin@gmail.com`).

### Daftar Tool `youtube`

| Nama Tool | Deskripsi & Fungsi | Parameter Utama |
| :--- | :--- | :--- |
| `youtube_search` | Mencari video, channel, atau playlist berdasarkan kata kunci/topik menggunakan YouTube Data API v3. | `query` (wajib), `type` (`'video'` \| `'channel'` \| `'playlist'` \| `'all'`, default `'video'`), `max_results` (1-50, default `10`), `order` (`'relevance'` \| `'date'` \| `'viewCount'` \| `'rating'` \| `'title'` \| `'videoCount'`), `channel_id`, `published_after`, `published_before`, `video_duration` (`'any'` \| `'short'` \| `'medium'` \| `'long'`), `region_code`, `relevance_language`, `page_token` |
| `youtube_get_video_details` | Mengambil metadata lengkap dan statistik satu atau beberapa video YouTube (`title`, `description`, `tags`, `viewCount`, `likeCount`, `commentCount`, `duration`, `uploadDate`, `channelTitle`, serta komentar teratas opsional). | `video_id` (wajib, ID video / URL YouTube / daftar ID dipisahkan koma), `include_top_comments` (opsional, boolean, default `false`), `max_comments` (opsional, default `10`) |
| `youtube_get_transcript` | Mengekstrak transkrip / *closed captions* (subtitle) video YouTube secara utuh (`full_text`, `timestamped_transcript`, dan daftar `segments`) menggunakan `youtube-transcript` + fallback scraper `captionTracks` agar AI dapat membaca dan merangkum video. | `video_id` (wajib, ID video atau URL YouTube), `language` (opsional, kode ISO bahasa seperti `'id'` atau `'en'`), `include_timestamps` (opsional, boolean, default `true`) |
| `youtube_get_channel_info` | Mengambil profil, statistik (`subscriberCount`, `viewCount`, `videoCount`), *branding*, dan daftar *relatedPlaylists* dari channel pribadi (`jmukhlishin@gmail.com`, `mine=true`) atau channel publik lainnya. | `mine` (opsional, default `true`), `channel_id` (opsional), `handle` (opsional, misal `'@GoogleDevelopers'`) |
| `youtube_manage_playlist` | Manajemen playlist lengkap: menampilkan daftar playlist (`list`), melihat isi video dalam playlist (`list_items`), membuat playlist baru (`create`), memperbarui playlist (`update`), menghapus playlist (`delete`), menambah video ke playlist (`add_video`), dan menghapus video dari playlist (`remove_video`). | `action` (wajib: `'list'` \| `'list_items'` \| `'create'` \| `'update'` \| `'delete'` \| `'add_video'` \| `'remove_video'`), `playlist_id`, `title`, `description`, `privacy_status` (`'private'` \| `'unlisted'` \| `'public'`), `tags`, `video_id`, `playlist_item_id`, `position`, `channel_id`, `max_results`, `page_token` |
| `youtube_upload_video` | Mengunggah (*upload*) video baru ke channel YouTube pribadi menggunakan protokol *Resumable Upload* (mendukung `file_path` lokal, `video_url` HTTP/HTTPS, atau `video_base64`). | `title` (wajib), `description`, `tags` (array string), `privacy_status` (`'private'` \| `'unlisted'` \| `'public'`, default `'private'`), `category_id` (default `'22'`), `made_for_kids` (boolean, default `false`), `file_path`, `video_url`, `video_base64`, `mime_type` (default `'video/mp4'`) |
| `youtube_manage_video` | Mengelola video milik channel sendiri: menampilkan daftar video yang diunggah di channel pribadi beserta statistiknya (`list_my_videos`), mengubah metadata video (`update`), atau menghapus video (`delete`). | `action` (wajib: `'list_my_videos'` \| `'update'` \| `'delete'`), `video_id` (wajib untuk `update` & `delete`), `title`, `description`, `tags`, `category_id`, `privacy_status`, `max_results` (default `20`), `page_token` |

### Environment Variables Modul YouTube

Tambahkan variabel berikut pada file `.env` Anda:

| Environment Variable | Status | Deskripsi |
| :--- | :--- | :--- |
| `YOUTUBE_CLIENT_ID` | Wajib untuk OAuth2 (Channel/Video/Playlist Management) | OAuth 2.0 Client ID dari Google Cloud Console (YouTube Data API v3 diaktifkan). |
| `YOUTUBE_CLIENT_SECRET` | Wajib untuk OAuth2 | OAuth 2.0 Client Secret pasangan dari `YOUTUBE_CLIENT_ID`. |
| `YOUTUBE_REFRESH_TOKEN` | Wajib untuk OAuth2 | Refresh Token hasil otorisasi akun `jmukhlishin@gmail.com` dengan scope `https://www.googleapis.com/auth/youtube` dan `https://www.googleapis.com/auth/youtube.upload`. Digunakan untuk *auto-refresh* access token secara otomatis. |
| `YOUTUBE_API_KEY` | Opsional / Fallback | API Key YouTube Data API v3 sebagai fallback untuk pencarian publik (`youtube_search`) dan pembacaan metadata (`youtube_get_video_details`) jika OAuth2 belum dikonfigurasi. |

> **Graceful Credential Handling:** Jika variabel environment di atas belum diset saat server menyala, `uni-mcp` tetap berjalan normal tanpa crash (hanya mencatat *warning* ringan di log). Tool `youtube_get_transcript` tetap dapat digunakan tanpa API key, sedangkan tool lainnya akan memberikan pesan panduan konfigurasi yang jelas saat dipanggil.

### Contoh Penggunaan Tools YouTube

```json
// 1. Mencari video berdasarkan topik
{
  "name": "youtube_search",
  "arguments": {
    "query": "Model Context Protocol n8n automation",
    "type": "video",
    "max_results": 5,
    "order": "relevance"
  }
}

// 2. Mengambil detail & metadata lengkap sebuah video
{
  "name": "youtube_get_video_details",
  "arguments": {
    "video_id": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "include_top_comments": true,
    "max_comments": 5
  }
}

// 3. Mengambil transkrip / subtitle untuk merangkum isi video
{
  "name": "youtube_get_transcript",
  "arguments": {
    "video_id": "dQw4w9WgXcQ",
    "language": "id",
    "include_timestamps": true
  }
}

// 4. Mengecek info & statistik channel pribadi (jmukhlishin@gmail.com)
{
  "name": "youtube_get_channel_info",
  "arguments": {
    "mine": true
  }
}

// 5. Membuat playlist baru & menambahkan video ke playlist
{
  "name": "youtube_manage_playlist",
  "arguments": {
    "action": "create",
    "title": "AI Engineering & MCP Tutorials",
    "description": "Kumpulan referensi arsitektur AI Agent dan MCP",
    "privacy_status": "unlisted"
  }
}

{
  "name": "youtube_manage_playlist",
  "arguments": {
    "action": "add_video",
    "playlist_id": "PLxxxxxxxxxxxxxxxx",
    "video_id": "dQw4w9WgXcQ"
  }
}

// 6. Upload video baru ke channel pribadi
{
  "name": "youtube_upload_video",
  "arguments": {
    "title": "Demo Autonomous Agent LERA dengan uni-mcp",
    "description": "Video demonstrasi automasi YouTube melalui MCP Server.",
    "tags": ["AI", "MCP", "Automation", "n8n"],
    "privacy_status": "private",
    "category_id": "28",
    "file_path": "/tmp/demo_video.mp4"
  }
}

// 7. Menampilkan daftar video milik channel sendiri & update metadata video
{
  "name": "youtube_manage_video",
  "arguments": {
    "action": "list_my_videos",
    "max_results": 10
  }
}

{
  "name": "youtube_manage_video",
  "arguments": {
    "action": "update",
    "video_id": "xxxxxxxxxxx",
    "title": "Judul Video Baru (Updated)",
    "tags": ["AI", "YouTubeAPI", "uni-mcp"],
    "privacy_status": "unlisted"
  }
}
```

---

## Modul Obsidian — Memory & Vault Integration (`src/tools/obsidian.ts`)

Modul ini menghubungkan `uni-mcp` ke plugin **Obsidian Local REST API** untuk membaca, menulis, menambahkan (*append*), mencari, dan menjelajahi file catatan Markdown di dalam *vault* Obsidian sebagai *knowledge base* / *long-term memory* AI Agent.

### Multi-Target Vault Support

Modul Obsidian mendukung **dua target vault** secara bersamaan melalui parameter opsional `target` pada setiap tool:

| Target | Deskripsi | Environment Variables | Default URL |
| :--- | :--- | :--- | :--- |
| `lera` (default) | Vault Obsidian utama (Lera) | `OBSIDIAN_BASE_URL` + `OBSIDIAN_API_KEY` | `http://obsidian:27124` |
| `lena` | Vault Obsidian sekunder (Lena) | `OBSIDIAN_LENA_BASE_URL` + `OBSIDIAN_LENA_API_KEY` | `http://obsidian-lena:27124` |

Setiap respons tool akan menyertakan field `target` yang menunjukkan vault mana yang diakses, memudahkan *traceability* saat AI Agent bekerja dengan kedua vault secara bergantian.

### Daftar Tool `obsidian`

| Nama Tool | Deskripsi & Fungsi | Parameter Utama |
| :--- | :--- | :--- |
| `obsidian_read_note` | Membaca isi catatan Markdown (serta metadata *frontmatter*/tag opsional) dari *vault* Obsidian. | `path` (wajib), `include_metadata` (opsional, boolean, default `false`), `target` (opsional, `'lera'` \| `'lena'`, default `'lera'`) |
| `obsidian_append_note` | Menambahkan (*append*) konten Markdown ke bagian akhir catatan yang sudah ada (atau membuat file baru jika belum ada). | `path` (wajib), `content` (wajib, teks Markdown), `target` (opsional, default `'lera'`) |
| `obsidian_write_note` | Membuat catatan baru atau menimpa (*overwrite*) seluruh isi catatan di *vault* Obsidian. | `path` (wajib), `content` (wajib, teks Markdown), `target` (opsional, default `'lera'`) |
| `obsidian_search_notes` | Mencari teks di seluruh catatan dalam *vault* Obsidian (`/search/simple/`) beserta cuplikan konteks dan skor relevansi. | `query` (wajib), `context_length` (opsional, default `100`), `target` (opsional, default `'lera'`) |
| `obsidian_list_files` | Menampilkan daftar file dan subfolder di dalam direktori tertentu (atau *root* *vault* jika dikosongkan). | `folder_path` (opsional, default `""`), `target` (opsional, default `'lera'`) |

> **Catatan:** Jika parameter `path` pada `obsidian_read_note`, `obsidian_append_note`, atau `obsidian_write_note` diberikan tanpa ekstensi file (misalnya `"Memory/catatan"`), ekstensi `.md` akan ditambahkan secara otomatis menjadi `"Memory/catatan.md"`.

### Contoh Penggunaan Multi-Target

```json
// Membaca catatan dari vault Lera (default)
{ "name": "obsidian_read_note", "arguments": { "path": "Memory/profile.md" } }

// Membaca catatan dari vault Lena
{ "name": "obsidian_read_note", "arguments": { "path": "Memory/profile.md", "target": "lena" } }

// Menulis catatan ke vault Lena
{ "name": "obsidian_write_note", "arguments": { "path": "Daily/2026-11-07.md", "content": "# Hari ini...", "target": "lena" } }

// Mencari di vault Lera
{ "name": "obsidian_search_notes", "arguments": { "query": "project roadmap" } }

// Mencari di vault Lena
{ "name": "obsidian_search_notes", "arguments": { "query": "project roadmap", "target": "lena" } }
```

### Cara Konfigurasi Modul Obsidian

1. **Aktifkan Plugin di Obsidian:**
   - Buka aplikasi **Obsidian** (atau container Docker Obsidian Anda).
   - Buka **Settings → Community Plugins**, cari dan instal **Local REST API**, lalu aktifkan (*Enable*).
   - Salin **API Key** yang tertera pada pengaturan plugin **Local REST API**.
   - Pastikan port REST API aktif (default: `27124` atau HTTP port sesuai konfigurasi Anda) dan dapat diakses dari jaringan container `uni-mcp`.
   - **Untuk target Lena:** Lakukan hal yang sama pada instance Obsidian kedua (vault Lena), pastikan berjalan di port/network yang berbeda dari vault Lera.

2. **Tambahkan Environment Variable di `.env`:**
   Atur variabel untuk kedua target pada file `.env` di repository `uni-mcp`:

   ```env
   # Obsidian Local REST API — Target 'lera' (default)
   OBSIDIAN_BASE_URL=http://obsidian:27124
   OBSIDIAN_API_KEY=your_obsidian_lera_api_key_here

   # Obsidian Local REST API — Target 'lena' (secondary vault)
   OBSIDIAN_LENA_BASE_URL=http://obsidian-lena:27124
   OBSIDIAN_LENA_API_KEY=your_obsidian_lena_api_key_here
   ```

   - **`OBSIDIAN_BASE_URL`**: URL endpoint Obsidian vault Lera. Default: `http://obsidian:27124`.
   - **`OBSIDIAN_API_KEY`**: Token Bearer API Key dari plugin Obsidian vault Lera (wajib jika menggunakan target `lera`).
   - **`OBSIDIAN_LENA_BASE_URL`**: URL endpoint Obsidian vault Lena. Default: `http://obsidian-lena:27124`.
   - **`OBSIDIAN_LENA_API_KEY`**: Token Bearer API Key dari plugin Obsidian vault Lena (wajib jika menggunakan target `lena`).

3. **Pastikan Environment Variable Diteruskan ke Container Docker (Jika Menggunakan Docker Compose):**
   Karena `docker-compose.yml` sudah memuat `env_file: - .env`, variabel di atas akan otomatis terbaca di dalam container `uni-mcp` setelah container dijalankan ulang (`docker compose up -d --build`).

---

## Modul Computer Operation (`src/tools/computer_operation.ts`)

Modul ini memungkinkan AI Agent (melalui `uni-mcp` dengan mode **Streamable HTTP**) mengoperasikan GUI, mouse, keyboard, layar, aplikasi, dan daya pada PC Windows di **Kantor (`office`)** maupun **Rumah (`home`)**.

### Routing Dual Target IP

Setiap tool pada modul `computer_operation` memiliki parameter `target` (`"office"` atau `"home"`):

| Target | Lokasi | Default Endpoint URL | Environment Variable Override |
| :--- | :--- | :--- | :--- |
| `office` | PC Windows Kantor (LAN) | `http://192.168.0.91:8181` | `COMPUTER_OFFICE_URL` |
| `home` | PC Windows Rumah (Tailscale/VPN) | `http://100.107.229.43:8181` | `COMPUTER_HOME_URL` |

### Daftar Tool `computer_operation`

| Nama Tool | Deskripsi & Fungsi | Parameter Utama |
| :--- | :--- | :--- |
| `computer_status` | Mengecek konektivitas worker, resolusi layar, jumlah monitor, dan posisi kursor saat ini. | `target` (`office` \| `home`) |
| `computer_mouse_click` | Klik mouse kiri (`left`), kanan (`right`), tengah (`middle`), atau `double` / `triple` click pada koordinat `(x, y)`. | `target`, `x`, `y`, `button` (`left`\|`right`\|`middle`), `click_type` (`single`\|`double`\|`triple`), `clicks`, `interval`, `duration` |
| `computer_mouse_move` | Memindahkan kursor mouse ke koordinat `(x, y)` absolut atau relatif. | `target`, `x`, `y`, `duration`, `relative` |
| `computer_mouse_drag` | Menyeret (*drag & drop*) mouse dari `(start_x, start_y)` ke `(x, y)` sambil menahan tombol mouse. | `target`, `x`, `y`, `start_x`, `start_y`, `button`, `duration`, `relative` |
| `computer_mouse_scroll` | Melakukan *scroll* roda mouse secara vertikal atau horizontal. | `target`, `clicks` (positif=atas/kanan, negatif=bawah/kiri), `direction` (`vertical`\|`horizontal`), `x`, `y` |
| `computer_screenshot` | Mengambil tangkapan layar (*screenshot*) menggunakan MSS dan mengembalikan gambar Base64 + path file. | `target`, `monitor` (default `1`), `format` (`png`\|`jpeg`), `quality`, `return_image_content` |
| `computer_screen_record` | Merekam aktivitas layar menjadi video `.mp4` selama durasi tertentu. | `target`, `duration` (detik, 1-60), `fps` (default `10`), `monitor`, `return_base64` |
| `computer_app_launch` | Membuka / menjalankan aplikasi, file executable, atau URL di PC Windows. | `target`, `app` (contoh: `notepad.exe`, `calc`, `chrome`), `args`, `working_dir` |
| `computer_app_kill` | Menutup / menghentikan paksa aplikasi (`taskkill`) berdasarkan nama proses atau PID. | `target`, `process_name` (contoh: `notepad.exe`), `pid`, `force` |
| `computer_keyboard_type` | Mengetikkan teks bebas pada jendela aktif di PC Windows. | `target`, `text`, `interval`, `press_enter` |
| `computer_keyboard_hotkey` | Menekan satu tombol atau kombinasi shortcut keyboard (*hotkey*). | `target`, `keys` (contoh: `["ctrl", "c"]`, `["alt", "tab"]`, `["win", "r"]`), `interval` |
| `computer_power_management` | Menjalankan perintah daya Windows: `shutdown`, `restart`, atau `cancel` (membatalkan shutdown). | `target`, `action` (`shutdown`\|`restart`\|`cancel`), `delay_seconds`, `force` |

### Konfigurasi Environment Dual Target (Opsional di `.env`)

Secara default `uni-mcp` sudah mengarah ke `http://192.168.0.91:8181` (`office`) dan `http://100.107.229.43:8181` (`home`). Anda juga dapat menyesuaikan konfigurasi di file `.env`:

```env
# Dual Target Windows PC Worker Endpoints
COMPUTER_OFFICE_URL=http://192.168.0.91:8181
COMPUTER_HOME_URL=http://100.107.229.43:8181
COMPUTER_DEFAULT_TARGET=office

# Opsional: Jika server.py menggunakan autentikasi X-API-Key
# COMPUTER_API_KEY=your_secret_worker_key
```

---

## Cara Menjalankan Worker `server.py` di PC Windows (Kantor & Rumah)

File `server.py` di root repository ini adalah **Worker Agent** berbasis **FastAPI + PyAutoGUI + MSS + OpenCV** yang harus dijalankan di PC Windows Kantor (`192.168.0.91`) dan PC Windows Rumah (`100.107.229.43`) pada port **`8181`**.

### 1. Prasyarat di PC Windows
Pastikan **Python 3.9+** sudah terinstal di PC Windows dan dicentang opsi *"Add Python to PATH"*.

### 2. Salin File `server.py` & Install Library Python
Buka **PowerShell** atau **Command Prompt (CMD)** di PC Windows, lalu jalankan:

```powershell
pip install fastapi uvicorn pyautogui mss pillow opencv-python numpy pydantic
```

### 3. Buka Firewall Windows untuk Port `8181`
Jalankan PowerShell sebagai **Administrator** (cukup sekali saja) agar server Ubuntu / `uni-mcp` dapat mengakses port `8181`:

```powershell
New-NetFirewallRule -DisplayName "uni-mcp Windows Worker 8181" -Direction Inbound -LocalPort 8181 -Protocol TCP -Action Allow
```

### 4. Jalankan `server.py` di Port `8181`
Jalankan perintah berikut pada sesi desktop Windows yang sedang aktif (bukan sebagai Session 0 service, agar PyAutoGUI & MSS dapat mengakses GUI desktop):

```powershell
python server.py
```

Output saat berjalan:
```text
=================================================================
Starting uni-mcp Windows Worker Server on http://0.0.0.0:8181
Captures Output Directory: C:\Users\<Username>\uni_mcp_captures
=================================================================
INFO:     Started server process [...]
INFO:     Uvicorn running on http://0.0.0.0:8181 (Press CTRL+C to quit)
```

### 5. (Opsional) Menjalankan Otomatis Saat Login Windows (Startup)
Agar `server.py` otomatis berjalan setiap kali PC Windows menyala/login:
1. Tekan `Win + R`, ketik `shell:startup`, lalu tekan **Enter**.
2. Buat file `start_uni_mcp_worker.bat` di dalam folder Startup tersebut dengan isi:
   ```bat
   @echo off
   cd /d C:\path\ke\folder\script
   python server.py
   ```

### 6. Verifikasi Koneksi dari Server `uni-mcp`
Dari server tempat `uni-mcp` berjalan, uji koneksi ke kedua PC Windows:
```bash
# Test PC Kantor (Office)
curl http://192.168.0.91:8181/status

# Test PC Rumah (Home - Tailscale)
curl http://100.107.229.43:8181/status
```

---

## Cara Setup & Menjalankan `uni-mcp` Secara Lokal

1. **Clone repository:**
   ```bash
   git clone https://github.com/jmukhlishin/uni-mcp.git
   cd uni-mcp
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Salin dan atur file `.env`:**
   ```bash
   cp .env.example .env
   nano .env
   ```
   Isi konfigurasi environment Anda:
   ```env
   PORT=3301
   HOST=0.0.0.0
   SERPER_API_KEY=your_serper_api_key_here

   # Obsidian — Target 'lera' (default)
   OBSIDIAN_BASE_URL=http://obsidian:27124
   OBSIDIAN_API_KEY=your_obsidian_lera_api_key_here

   # Obsidian — Target 'lena' (secondary vault)
   OBSIDIAN_LENA_BASE_URL=http://obsidian-lena:27124
   OBSIDIAN_LENA_API_KEY=your_obsidian_lena_api_key_here

   # YouTube Integration (OAuth2 + Optional API Key)
   YOUTUBE_CLIENT_ID=your_google_oauth_client_id_here
   YOUTUBE_CLIENT_SECRET=your_google_oauth_client_secret_here
   YOUTUBE_REFRESH_TOKEN=your_google_oauth_refresh_token_here
   YOUTUBE_API_KEY=your_youtube_data_api_v3_key_here

   COMPUTER_OFFICE_URL=http://192.168.0.91:8181
   COMPUTER_HOME_URL=http://100.107.229.43:8181
   COMPUTER_DEFAULT_TARGET=office
   ```

4. **Build dan jalankan:**
   ```bash
   # Mode development (auto-reload)
   npm run dev

   # Mode production
   npm run build
   npm start
   ```

5. **Cek Health & Daftar Tool yang Terdaftar:**
   ```bash
   curl http://localhost:3301/health
   ```
   Contoh respons:
   ```json
   {
     "status": "ok",
     "service": "uni-mcp",
     "version": "1.0.0",
     "transport": "streamable-http",
     "endpoints": {
       "mcp": "/mcp",
       "root": "/",
       "health": "/health"
     },
     "loadedTools": [
       "computer_status",
       "computer_mouse_click",
       "computer_mouse_move",
       "computer_mouse_drag",
       "computer_mouse_scroll",
       "computer_screenshot",
       "computer_screen_record",
       "computer_app_launch",
       "computer_app_kill",
       "computer_keyboard_type",
       "computer_keyboard_hotkey",
       "computer_power_management",
       "monitor_system_metrics",
       "monitor_docker_containers",
       "monitor_docker_stats",
       "monitor_docker_logs",
       "obsidian_read_note",
       "obsidian_append_note",
       "obsidian_write_note",
       "obsidian_search_notes",
       "obsidian_list_files",
       "serper_google_search",
       "serper_news_search",
       "youtube_search",
       "youtube_get_video_details",
       "youtube_get_transcript",
       "youtube_get_channel_info",
       "youtube_manage_playlist",
       "youtube_upload_video",
       "youtube_manage_video"
     ]
   }
   ```

---

## Deployment dengan Docker di Server Ubuntu

1. **Pastikan file `.env` sudah dibuat dan diisi:**
   ```bash
   cp .env.example .env
   nano .env
   ```

2. **Build dan jalankan container di background:**
   ```bash
   docker compose up -d --build
   ```

3. **Cek log container:**
   ```bash
   docker logs -f uni-mcp
   ```

---

## Cara Menghubungkan ke n8n (MCP Client Node)

Karena `uni-mcp` menggunakan **HTTP Streamable Transport**, pastikan Anda memilih mode **HTTP Streamable** (bukan SSE) pada node **MCP Client** di n8n:

1. Buka workflow n8n Anda dan tambahkan node **MCP Client** (atau hubungkan sebagai Tool pada node **AI Agent**).
2. Pada pengaturan **Connection Type / Transport**, pilih **HTTP Streamable** (atau **Streamable HTTP**).
3. Pada kolom **MCP Endpoint URL**, masukkan URL sesuai topologi jaringan Docker di server Ubuntu Anda:

   - **Opsi A — Akses via IP Docker Host / Bridge Gateway (Paling Praktis tanpa ubah network n8n):**
     Karena port `3301:3301` sudah di-publish ke host Ubuntu:
     ```text
     http://172.17.0.1:3301/mcp
     ```
     *(Atau gunakan IP lokal server Ubuntu Anda, misalnya `http://192.168.x.x:3301/mcp`, atau `http://host.docker.internal:3301/mcp` jika container n8n memiliki `extra_hosts`)*

   - **Opsi B — Satu Docker Network dengan Container n8n:**
     Hubungkan container `uni-mcp` ke network Docker tempat `n8n` berjalan:
     ```bash
     # Cek nama network n8n
     docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' n8n

     # Hubungkan uni-mcp ke network tersebut (misal: n8n_default)
     docker network connect n8n_default uni-mcp
     ```
     Lalu gunakan nama container secara langsung di n8n:
     ```text
     http://uni-mcp:3301/mcp
     ```

---

## Panduan Menambahkan Tool Plugin Baru (`src/tools/`)

Untuk menambahkan tool baru ke `uni-mcp`, Anda **cukup membuat 1 file baru di dalam folder `src/tools/`** tanpa perlu mengedit `src/server.ts` atau `src/tools/index.ts`.

### Contoh: Membuat Plugin `src/tools/weather.ts`

Buat file `src/tools/weather.ts`:

```typescript
import axios from "axios";
import { ToolDefinition, formatToolResult } from "../types.js";

export const getWeatherTool: ToolDefinition = {
  name: "get_current_weather",
  description: "Get current weather information for a given latitude and longitude.",
  inputSchema: {
    type: "object",
    properties: {
      latitude: {
        type: "number",
        description: "Latitude coordinate (e.g., -6.2088)",
      },
      longitude: {
        type: "number",
        description: "Longitude coordinate (e.g., 106.8456)",
      },
    },
    required: ["latitude", "longitude"],
  },
  handler: async (args) => {
    const { latitude, longitude } = args;
    const response = await axios.get("https://api.open-meteo.com/v1/forecast", {
      params: {
        latitude,
        longitude,
        current_weather: true,
      },
    });

    return formatToolResult(response.data);
  },
};

// Anda bisa mengekspor 1 tool atau array berisi banyak tool:
export default [getWeatherTool];
```

Setelah membuat file baru, cukup rebuild container:

```bash
docker compose up -d --build
```

Tool baru akan langsung muncul secara otomatis di `/health` dan langsung terbaca oleh **n8n MCP Client**!

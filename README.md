# Universal MCP Hub (`uni-mcp`)

**Universal / Modular Model Context Protocol (MCP) Hub** berbasis **Node.js & TypeScript** menggunakan SDK resmi `@modelcontextprotocol/sdk`.

Dirancang khusus dengan **Stateless Streamable HTTP Transport** (`StreamableHTTPServerTransport`, **bukan** legacy SSE) dan sistem **Dynamic Plugin Tool Loader** sehingga Anda dapat menggabungkan berbagai API/tools (Serper Google Search, Server & Docker Monitoring, Network & MikroTik Diagnostics, Remote Computer Operation Dual-Target Windows PC, dll.) dalam satu container MCP yang ringan dan mudah diintegrasikan dengan **n8n MCP Client Node**.

---

## Fitur Utama

1. **Stateless Streamable HTTP Transport (`POST /mcp` & `POST /`)**
   - Menggunakan standar transport terbaru MCP (`StreamableHTTPServerTransport` dengan `sessionIdGenerator: undefined`).
   - Bebas masalah *session drop* atau *timeout* yang sering terjadi pada koneksi SSE jangka panjang.
2. **Arsitektur Plugin Modular (Auto-Discovery)**
   - Semua modul tool berada di dalam folder `src/tools/`.
   - Saat server dijalankan, `src/tools/index.ts` otomatis memindai dan memuat seluruh file di `src/tools/` tanpa perlu mengubah kode `src/server.ts`.
3. **Modul Computer Operation — Dual Target Windows PC (`src/tools/computer_operation.ts` + `server.py`)**
   - Mengontrol PC Windows secara *remote* dari `uni-mcp` melalui protokol HTTP ke worker `server.py` (FastAPI + PyAutoGUI + MSS) yang berjalan di port `8181`.
   - Mendukung **Routing Dual Target IP** otomatis melalui parameter `target`:
     - **`office`** (PC Kantor): `http://192.168.0.91:8181`
     - **`home`** (PC Rumah / Tailscale): `http://100.107.229.43:8181`
   - Fitur lengkap: Mouse Click (kiri, kanan, tengah, double click), Mouse Move, Mouse Drag, Mouse Scroll, Screenshot Layar (MSS), Screen Record (MP4), Buka Aplikasi (`launch`), Tutup/Kill Aplikasi (`taskkill`), Ketik Teks Keyboard, Shortcut/Hotkey kombinasi tombol, dan Power Management (`shutdown`, `restart`, `cancel`).
4. **Modul Serper API (`src/tools/serper.ts`)**
   - `serper_google_search`: Pencarian web Google (`https://google.serper.dev/search`) lengkap dengan parameter `query`, `gl`, `hl`, `num`, `location`, `tbs`, `autocorrect`, `page`.
   - `serper_news_search`: Pencarian berita terbaru Google News (`https://google.serper.dev/news`) lengkap dengan parameter `query`, `gl`, `hl`, `num`, `location`, `tbs`, `autocorrect`, `page`.
5. **Modul Server Ubuntu & Docker Monitoring (`src/tools/monitoring.ts`)**
   - `monitor_system_metrics`: Memantau metrik sistem host Ubuntu meliputi penggunaan CPU (%), *load average* (1m, 5m, 15m), penggunaan RAM & Swap (`free -m`), penggunaan Disk (`df -h`), serta *uptime*.
   - `monitor_docker_containers`: Menampilkan daftar dan status container Docker (`docker ps` / `docker ps -a`) beserta filter nama container.
   - `monitor_docker_stats`: Memantau *resource usage* container secara *real-time snapshot* (`docker stats --no-stream`) meliputi CPU %, Memory usage/limit, Network I/O, dan Block I/O.
   - `monitor_docker_logs`: Mengambil log terbaru dari container tertentu (`docker logs --tail`) lengkap dengan dukungan opsi `--since` dan `timestamps`.
6. **Port Default Aman (`3301`)**
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
       "serper_google_search",
       "serper_news_search"
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

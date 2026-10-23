# Universal MCP Hub (`uni-mcp`)

**Universal / Modular Model Context Protocol (MCP) Hub** berbasis **Node.js & TypeScript** menggunakan SDK resmi `@modelcontextprotocol/sdk`.

Dirancang khusus dengan **Stateless Streamable HTTP Transport** (`StreamableHTTPServerTransport`, **bukan** legacy SSE) dan sistem **Dynamic Plugin Tool Loader** sehingga Anda dapat menggabungkan berbagai API/tools (Serper Google Search, Server & Docker Monitoring, Maps, Internal API, Database, dll.) dalam satu container MCP yang ringan dan mudah diintegrasikan dengan **n8n MCP Client Node**.

---

## Fitur Utama

1. **Stateless Streamable HTTP Transport (`POST /mcp` & `POST /`)**
   - Menggunakan standar transport terbaru MCP (`StreamableHTTPServerTransport` dengan `sessionIdGenerator: undefined`).
   - Bebas masalah *session drop* atau *timeout* yang sering terjadi pada koneksi SSE jangka panjang.
2. **Arsitektur Plugin Modular (Auto-Discovery)**
   - Semua modul tool berada di dalam folder `src/tools/`.
   - Saat server dijalankan, `src/tools/index.ts` otomatis memindai dan memuat seluruh file di `src/tools/` tanpa perlu mengubah kode `src/server.ts`.
3. **Modul Serper API (`src/tools/serper.ts`)**
   - `serper_google_search`: Pencarian web Google (`https://google.serper.dev/search`) lengkap dengan parameter `query`, `gl`, `hl`, `num`, `location`, `tbs`, `autocorrect`, `page`.
   - `serper_news_search`: Pencarian berita terbaru Google News (`https://google.serper.dev/news`) lengkap dengan parameter `query`, `gl`, `hl`, `num`, `location`, `tbs`, `autocorrect`, `page`.
4. **Modul Server Ubuntu & Docker Monitoring (`src/tools/monitoring.ts`)**
   - `monitor_system_metrics`: Memantau metrik sistem host Ubuntu meliputi penggunaan CPU (%), *load average* (1m, 5m, 15m), penggunaan RAM & Swap (`free -m`), penggunaan Disk (`df -h`), serta *uptime*.
   - `monitor_docker_containers`: Menampilkan daftar dan status container Docker (`docker ps` / `docker ps -a`) beserta filter nama container.
   - `monitor_docker_stats`: Memantau *resource usage* container secara *real-time snapshot* (`docker stats --no-stream`) meliputi CPU %, Memory usage/limit, Network I/O, dan Block I/O.
   - `monitor_docker_logs`: Mengambil log terbaru dari container tertentu (`docker logs --tail`) lengkap dengan dukungan opsi `--since` dan `timestamps`.
5. **Port Default Aman (`3301`)**
   - Berjalan di port `3301` (dapat diubah melalui variabel environment `PORT`) agar tidak bentrok dengan layanan lain (seperti port `3000` atau `3300`).

---

## Struktur Proyek

```text
uni-mcp/
├── src/
│   ├── server.ts          # Entrypoint Express + Stateless Streamable HTTP MCP Server
│   ├── types.ts           # Interface standar ToolDefinition & helper formatToolResult
│   └── tools/
│       ├── index.ts       # Dynamic Auto-Loader & Tool Registry
│       ├── serper.ts      # Plugin tool Google Search & News Search (Serper.dev)
│       └── monitoring.ts  # Plugin tool Monitoring Server Ubuntu & Docker Container
├── .env.example           # Template konfigurasi environment
├── Dockerfile             # Multi-stage Docker build (node:20-alpine + docker-cli + procps)
├── docker-compose.yml     # Konfigurasi container, port 3301:3301 & mount docker.sock
├── package.json
└── tsconfig.json
```

---

## Cara Setup & Menjalankan Secara Lokal

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
   Isi `SERPER_API_KEY` Anda (dapatkan di [https://serper.dev](https://serper.dev)):
   ```env
   PORT=3301
   HOST=0.0.0.0
   SERPER_API_KEY=your_serper_api_key_here
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

Karena `uni-mcp` menggunakan **HTTP Streamable Transport**, pastikan Anda memilih mode **HTTP Streamable** pada node **MCP Client** di n8n:

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

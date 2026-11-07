import fs from "node:fs";
import path from "node:path";
import axios, { AxiosRequestConfig } from "axios";
import { YoutubeTranscript } from "youtube-transcript";
import { ToolDefinition, formatToolResult } from "../types.js";

/**
 * YouTube Data API v3 & Google OAuth2 Endpoints
 */
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_API_BASE = "https://www.googleapis.com/upload/youtube/v3";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Cached OAuth2 Access Token in memory for auto-refresh lifecycle
 */
interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedAccessToken | null = null;
let hasLoggedMissingCredentialsWarning = false;

/**
 * Reads YouTube environment credentials and logs a one-time graceful warning
 * during module initialization if neither OAuth2 nor API Key is set.
 */
function getYouTubeCredentialsConfig() {
  const clientId = (process.env.YOUTUBE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.YOUTUBE_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.YOUTUBE_REFRESH_TOKEN || "").trim();
  const apiKey = (process.env.YOUTUBE_API_KEY || "").trim();

  const hasOAuth = Boolean(clientId && clientSecret && refreshToken);
  const hasApiKey = Boolean(apiKey);

  return {
    clientId,
    clientSecret,
    refreshToken,
    apiKey,
    hasOAuth,
    hasApiKey,
  };
}

/**
 * Log a non-fatal startup notice if credentials are not yet configured in `.env`
 */
function checkCredentialsOnStartup(): void {
  if (hasLoggedMissingCredentialsWarning) return;
  hasLoggedMissingCredentialsWarning = true;

  const { hasOAuth, hasApiKey } = getYouTubeCredentialsConfig();
  if (!hasOAuth && !hasApiKey) {
    console.warn(
      "[YouTube Module] Warning: YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN and YOUTUBE_API_KEY are not configured yet. Public transcript extraction works without keys, while Data API & Channel Management tools will prompt for credentials when invoked."
    );
  }
}

checkCredentialsOnStartup();

/**
 * Obtains a valid OAuth2 Access Token, automatically refreshing via
 * `YOUTUBE_REFRESH_TOKEN` when missing or within 60 seconds of expiry.
 */
async function getValidAccessToken(forceRefresh = false): Promise<string> {
  const { clientId, clientSecret, refreshToken, hasOAuth } =
    getYouTubeCredentialsConfig();

  if (!hasOAuth) {
    const missing: string[] = [];
    if (!clientId) missing.push("YOUTUBE_CLIENT_ID");
    if (!clientSecret) missing.push("YOUTUBE_CLIENT_SECRET");
    if (!refreshToken) missing.push("YOUTUBE_REFRESH_TOKEN");

    throw new Error(
      `Missing YouTube OAuth2 credentials (${missing.join(", ")}). Please configure YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN in your .env file to authorize channel & video operations for jmukhlishin@gmail.com.`
    );
  }

  const now = Date.now();
  if (
    !forceRefresh &&
    cachedToken &&
    cachedToken.accessToken &&
    cachedToken.expiresAtMs - 60_000 > now
  ) {
    return cachedToken.accessToken;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  try {
    const response = await axios.post(
      GOOGLE_OAUTH_TOKEN_URL,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      }
    );

    const accessToken = response.data?.access_token;
    const expiresInSec = Number(response.data?.expires_in || 3599);

    if (!accessToken) {
      throw new Error(
        "Google OAuth2 token endpoint did not return an access_token."
      );
    }

    cachedToken = {
      accessToken,
      expiresAtMs: now + expiresInSec * 1000,
    };

    return accessToken;
  } catch (err: any) {
    const detail =
      err?.response?.data?.error_description ||
      err?.response?.data?.error ||
      err?.message ||
      String(err);
    throw new Error(
      `Failed to refresh YouTube OAuth2 access token: ${detail}`
    );
  }
}

/**
 * Executes an authenticated or public YouTube Data API v3 request.
 * - If `requireOAuth` is true: strictly uses OAuth2 Bearer token (with 401 auto-retry).
 * - If `requireOAuth` is false: uses OAuth2 if configured, otherwise falls back to `YOUTUBE_API_KEY`.
 */
async function youtubeApiRequest<T = any>(
  endpoint: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    params?: Record<string, any>;
    data?: any;
    headers?: Record<string, string>;
    requireOAuth?: boolean;
    timeoutMs?: number;
    baseUrl?: string;
  } = {}
): Promise<T> {
  const {
    method = "GET",
    params = {},
    data = undefined,
    headers = {},
    requireOAuth = false,
    timeoutMs = 30000,
    baseUrl = YOUTUBE_API_BASE,
  } = options;

  const { hasOAuth, hasApiKey, apiKey } = getYouTubeCredentialsConfig();

  if (requireOAuth && !hasOAuth) {
    // Trigger descriptive missing OAuth error
    await getValidAccessToken();
  }

  if (!requireOAuth && !hasOAuth && !hasApiKey) {
    throw new Error(
      "YouTube credentials are not configured. Please set OAuth2 credentials (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN) or YOUTUBE_API_KEY in your .env file."
    );
  }

  const useOAuth = requireOAuth || hasOAuth;
  const url = `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;

  const executeCall = async (forceRefreshToken = false): Promise<T> => {
    const reqHeaders: Record<string, string> = { ...headers };
    const reqParams: Record<string, any> = { ...params };

    if (useOAuth) {
      try {
        const token = await getValidAccessToken(forceRefreshToken);
        reqHeaders["Authorization"] = `Bearer ${token}`;
      } catch (oauthErr) {
        if (!requireOAuth && hasApiKey) {
          reqParams["key"] = apiKey;
        } else {
          throw oauthErr;
        }
      }
    } else if (hasApiKey) {
      reqParams["key"] = apiKey;
    }

    const config: AxiosRequestConfig = {
      url,
      method,
      params: reqParams,
      data,
      headers: reqHeaders,
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    };

    const response = await axios.request<T>(config);
    return response.data;
  };

  try {
    return await executeCall(false);
  } catch (error: any) {
    // Auto-retry once with forced token refresh on HTTP 401 Unauthorized
    if (useOAuth && error?.response?.status === 401) {
      return await executeCall(true);
    }

    const apiErrorMsg =
      error?.response?.data?.error?.message ||
      error?.response?.data?.error_description ||
      error?.message ||
      String(error);
    const statusCode = error?.response?.status;
    throw new Error(
      `YouTube API Error${statusCode ? ` (HTTP ${statusCode})` : ""}: ${apiErrorMsg}`
    );
  }
}

/**
 * Extracts a clean 11-character YouTube Video ID from a video ID string or any YouTube URL
 * (watch?v=, youtu.be/, shorts/, embed/, live/).
 */
export function extractVideoId(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error(
      "Parameter 'video_id' (or YouTube URL) is required and cannot be empty."
    );
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.includes("youtu.be")) {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
    const vParam = parsed.searchParams.get("v");
    if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
      return vParam;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const markerIdx = segments.findIndex((s) =>
      ["shorts", "embed", "live", "v"].includes(s.toLowerCase())
    );
    if (markerIdx !== -1 && segments[markerIdx + 1]) {
      const candidate = segments[markerIdx + 1];
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate)) return candidate;
    }
  } catch {
    // Fallback regex if URL parsing fails
  }

  const regexMatch = raw.match(
    /(?:v=|\/(?:embed|shorts|live|v)\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  if (regexMatch && regexMatch[1]) {
    return regexMatch[1];
  }

  return raw;
}

/**
 * Converts ISO 8601 duration (e.g., "PT1H12M35S") to human-readable "1:12:35" / "12:35"
 * and total seconds.
 */
function parseIso8601Duration(isoDuration?: string): {
  formatted: string;
  totalSeconds: number;
} {
  if (!isoDuration) {
    return { formatted: "0:00", totalSeconds: 0 };
  }
  const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) {
    return { formatted: isoDuration, totalSeconds: 0 };
  }
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;

  const pad = (n: number) => String(n).padStart(2, "0");
  const formatted =
    hours > 0
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${minutes}:${pad(seconds)}`;

  return { formatted, totalSeconds };
}

/**
 * Formats seconds into MM:SS or HH:MM:SS timestamp string.
 */
function formatTimestampSeconds(seconds: number): string {
  const totalSec = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hrs > 0
    ? `${hrs}:${pad(mins)}:${pad(secs)}`
    : `${pad(mins)}:${pad(secs)}`;
}

/**
 * Decodes HTML entities commonly returned in YouTube caption XML/JSON tracks.
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\s+/g, " ")
    .trim();
}

interface TranscriptSegment {
  text: string;
  startSeconds: number;
  durationSeconds: number;
  timestamp: string;
}

/**
 * Fallback caption scraper via YouTube Watch Page `ytInitialPlayerResponse` captionTracks
 * in case `youtube-transcript` encounters age-gates, locale mismatches, or format changes.
 */
async function fetchTranscriptViaWatchPageFallback(
  videoId: string,
  preferredLang?: string
): Promise<{
  language: string;
  availableLanguages: string[];
  segments: TranscriptSegment[];
}> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`;
  const pageRes = await axios.get<string>(watchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    },
    timeout: 15000,
  });

  const html = typeof pageRes.data === "string" ? pageRes.data : "";
  const tracksMarker = '"captionTracks":';
  const markerIdx = html.indexOf(tracksMarker);
  if (markerIdx === -1) {
    throw new Error(
      `No closed captions / subtitles found for video '${videoId}'.`
    );
  }

  const arrayStart = html.indexOf("[", markerIdx);
  if (arrayStart === -1) {
    throw new Error(
      `Failed to parse captionTracks array for video '${videoId}'.`
    );
  }

  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") {
      depth--;
      if (depth === 0) {
        arrayEnd = i + 1;
        break;
      }
    }
  }

  if (arrayEnd === -1) {
    throw new Error(`Malformed captionTracks JSON on video '${videoId}'.`);
  }

  const tracksJson = html.slice(arrayStart, arrayEnd);
  const captionTracks: Array<{
    baseUrl: string;
    languageCode: string;
    name?: { simpleText?: string };
    kind?: string;
  }> = JSON.parse(tracksJson);

  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error(`Video '${videoId}' has an empty captionTracks list.`);
  }

  const availableLanguages = captionTracks.map((t) => t.languageCode);
  const targetLang = preferredLang?.trim().toLowerCase();

  let selectedTrack = captionTracks[0];
  if (targetLang) {
    const exactMatch = captionTracks.find(
      (t) => t.languageCode.toLowerCase() === targetLang
    );
    const prefixMatch = captionTracks.find((t) =>
      t.languageCode.toLowerCase().startsWith(targetLang)
    );
    selectedTrack = exactMatch || prefixMatch || captionTracks[0];
  } else {
    const idOrEn = captionTracks.find((t) =>
      ["id", "en"].includes(t.languageCode.toLowerCase())
    );
    if (idOrEn) selectedTrack = idOrEn;
  }

  const captionRes = await axios.get<string>(selectedTrack.baseUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    },
    timeout: 15000,
  });

  const xml = typeof captionRes.data === "string" ? captionRes.data : "";
  const segments: TranscriptSegment[] = [];

  const textTagRegex =
    /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;
  while ((match = textTagRegex.exec(xml)) !== null) {
    const startSec = parseFloat(match[1] || "0");
    const durSec = parseFloat(match[2] || "0");
    const rawText = match[3].replace(/<[^>]+>/g, "");
    const cleanText = decodeHtmlEntities(rawText);
    if (cleanText) {
      segments.push({
        text: cleanText,
        startSeconds: Number(startSec.toFixed(2)),
        durationSeconds: Number(durSec.toFixed(2)),
        timestamp: formatTimestampSeconds(startSec),
      });
    }
  }

  return {
    language: selectedTrack.languageCode,
    availableLanguages,
    segments,
  };
}

/**
 * Resolves a video source from a local file path, an HTTP/HTTPS URL, or a Base64 string
 * into a Node.js Buffer for YouTube Resumable Upload.
 */
async function resolveVideoUploadBuffer(args: {
  file_path?: string;
  video_url?: string;
  video_base64?: string;
  mime_type?: string;
}): Promise<{ buffer: Buffer; mimeType: string; sourceDescription: string }> {
  const mimeType = (args.mime_type || "video/mp4").trim();

  if (args.file_path) {
    const resolvedPath = path.resolve(String(args.file_path).trim());
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Local video file not found at path: '${resolvedPath}'.`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Path '${resolvedPath}' is not a regular file.`);
    }
    const buffer = await fs.promises.readFile(resolvedPath);
    return {
      buffer,
      mimeType,
      sourceDescription: `local_file:${resolvedPath}`,
    };
  }

  if (args.video_url) {
    const url = String(args.video_url).trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("Parameter 'video_url' must be a valid HTTP/HTTPS URL.");
    }
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    const detectedMime =
      (res.headers["content-type"] as string) || mimeType || "video/mp4";
    return {
      buffer: Buffer.from(res.data),
      mimeType: detectedMime,
      sourceDescription: `url:${url}`,
    };
  }

  if (args.video_base64) {
    const rawB64 = String(args.video_base64).trim();
    const cleanedB64 = rawB64.replace(/^data:video\/[a-zA-Z0-9.+-]+;base64,/, "");
    const buffer = Buffer.from(cleanedB64, "base64");
    if (buffer.length === 0) {
      throw new Error("Decoded 'video_base64' payload is empty.");
    }
    return {
      buffer,
      mimeType,
      sourceDescription: `base64_payload (${buffer.length} bytes)`,
    };
  }

  throw new Error(
    "One of 'file_path' (local server path), 'video_url' (HTTP/HTTPS URL), or 'video_base64' must be provided to upload a video."
  );
}

// ============================================================================
// 1. SEARCH & RESEARCH: youtube_search
// ============================================================================
export const youtubeSearchTool: ToolDefinition = {
  name: "youtube_search",
  description:
    "Search YouTube for videos, channels, or playlists by keyword/topic using YouTube Data API v3. Supports sorting, duration filters, date range filters, region/language filters, and channel scoping.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search keyword or topic (e.g., 'MCP server tutorial', 'AI automation n8n').",
      },
      type: {
        type: "string",
        enum: ["video", "channel", "playlist", "all"],
        description:
          "Resource type to search: 'video' (default), 'channel', 'playlist', or 'all'.",
        default: "video",
      },
      max_results: {
        type: "number",
        description: "Number of results to return (1 to 50). Default: 10.",
        default: 10,
      },
      order: {
        type: "string",
        enum: [
          "relevance",
          "date",
          "viewCount",
          "rating",
          "title",
          "videoCount",
        ],
        description:
          "Sort order of results: 'relevance' (default), 'date', 'viewCount', 'rating', 'title', or 'videoCount'.",
        default: "relevance",
      },
      channel_id: {
        type: "string",
        description:
          "Optional YouTube Channel ID to restrict search results to a specific channel.",
      },
      published_after: {
        type: "string",
        description:
          "Optional ISO 8601 datetime filter for items published after this date (e.g., '2026-01-01T00:00:00Z').",
      },
      published_before: {
        type: "string",
        description:
          "Optional ISO 8601 datetime filter for items published before this date.",
      },
      video_duration: {
        type: "string",
        enum: ["any", "short", "medium", "long"],
        description:
          "Optional duration filter (only applies when type='video'): 'any', 'short' (<4m), 'medium' (4m-20m), 'long' (>20m).",
      },
      region_code: {
        type: "string",
        description:
          "Optional ISO 3166-1 alpha-2 country code (e.g., 'ID', 'US').",
      },
      relevance_language: {
        type: "string",
        description:
          "Optional ISO 639-1 language code for relevant results (e.g., 'id', 'en').",
      },
      page_token: {
        type: "string",
        description: "Optional pagination token from a previous search result.",
      },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const query = String(args.query || "").trim();
    if (!query) {
      return formatToolResult(
        { error: "Parameter 'query' is required and cannot be empty." },
        true
      );
    }

    const searchType = String(args.type || "video")
      .trim()
      .toLowerCase();
    const maxResults = Math.min(
      50,
      Math.max(1, Number(args.max_results) || 10)
    );
    const order = String(args.order || "relevance").trim();

    const params: Record<string, any> = {
      part: "snippet",
      q: query,
      maxResults,
      order,
    };

    if (searchType !== "all") {
      params.type = searchType;
    }
    if (args.channel_id) params.channelId = String(args.channel_id).trim();
    if (args.published_after)
      params.publishedAfter = String(args.published_after).trim();
    if (args.published_before)
      params.publishedBefore = String(args.published_before).trim();
    if (args.video_duration && searchType === "video") {
      params.videoDuration = String(args.video_duration).trim();
    }
    if (args.region_code) params.regionCode = String(args.region_code).trim();
    if (args.relevance_language)
      params.relevanceLanguage = String(args.relevance_language).trim();
    if (args.page_token) params.pageToken = String(args.page_token).trim();

    const data = await youtubeApiRequest("search", {
      method: "GET",
      params,
      requireOAuth: false,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    const formattedResults = items.map((item: any) => {
      const kind = item?.id?.kind || "";
      const videoId = item?.id?.videoId;
      const channelId = item?.id?.channelId || item?.snippet?.channelId;
      const playlistId = item?.id?.playlistId;
      const snippet = item?.snippet || {};

      let url = "";
      if (videoId) url = `https://www.youtube.com/watch?v=${videoId}`;
      else if (playlistId)
        url = `https://www.youtube.com/playlist?list=${playlistId}`;
      else if (channelId)
        url = `https://www.youtube.com/channel/${channelId}`;

      return {
        kind,
        videoId: videoId || undefined,
        channelId: channelId || undefined,
        playlistId: playlistId || undefined,
        title: snippet.title,
        description: snippet.description,
        channelTitle: snippet.channelTitle,
        publishedAt: snippet.publishedAt,
        liveBroadcastContent: snippet.liveBroadcastContent,
        thumbnailUrl:
          snippet?.thumbnails?.high?.url ||
          snippet?.thumbnails?.medium?.url ||
          snippet?.thumbnails?.default?.url,
        url,
      };
    });

    return formatToolResult({
      status: "ok",
      query,
      type: searchType,
      order,
      totalResultsEstimated: data?.pageInfo?.totalResults ?? formattedResults.length,
      resultsReturned: formattedResults.length,
      nextPageToken: data?.nextPageToken || null,
      prevPageToken: data?.prevPageToken || null,
      items: formattedResults,
    });
  },
};

// ============================================================================
// 2. VIDEO DETAILS / METADATA: youtube_get_video_details
// ============================================================================
export const youtubeGetVideoDetailsTool: ToolDefinition = {
  name: "youtube_get_video_details",
  description:
    "Get comprehensive metadata and statistics for one or more YouTube videos (title, full description, tags, viewCount, likeCount, commentCount, duration, uploadDate, channelTitle, categoryId, privacyStatus, and top comments).",
  inputSchema: {
    type: "object",
    properties: {
      video_id: {
        type: "string",
        description:
          "YouTube Video ID (e.g., 'dQw4w9WgXcQ'), full YouTube URL, or comma-separated list of Video IDs (up to 50).",
      },
      include_top_comments: {
        type: "boolean",
        description:
          "If true, also fetches the top comments thread for the video. Default: false.",
        default: false,
      },
      max_comments: {
        type: "number",
        description:
          "Number of top comments to retrieve when include_top_comments is true (1 to 50). Default: 10.",
        default: 10,
      },
    },
    required: ["video_id"],
  },
  handler: async (args) => {
    const rawInput = String(args.video_id || "").trim();
    if (!rawInput) {
      return formatToolResult(
        { error: "Parameter 'video_id' is required." },
        true
      );
    }

    const videoIds = rawInput
      .split(",")
      .map((part) => extractVideoId(part))
      .filter(Boolean)
      .slice(0, 50);

    const data = await youtubeApiRequest("videos", {
      method: "GET",
      params: {
        part: "snippet,contentDetails,statistics,status,topicDetails,liveStreamingDetails",
        id: videoIds.join(","),
      },
      requireOAuth: false,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      return formatToolResult(
        {
          status: "not_found",
          error: `No video found for ID(s): ${videoIds.join(", ")}`,
        },
        true
      );
    }

    const videos = await Promise.all(
      items.map(async (item: any) => {
        const snippet = item.snippet || {};
        const stats = item.statistics || {};
        const contentDetails = item.contentDetails || {};
        const status = item.status || {};
        const durationInfo = parseIso8601Duration(contentDetails.duration);

        let topComments: any[] | undefined = undefined;
        if (args.include_top_comments && videoIds.length === 1) {
          try {
            const maxComments = Math.min(
              50,
              Math.max(1, Number(args.max_comments) || 10)
            );
            const commentsRes = await youtubeApiRequest("commentThreads", {
              method: "GET",
              params: {
                part: "snippet",
                videoId: item.id,
                maxResults: maxComments,
                order: "relevance",
                textFormat: "plainText",
              },
              requireOAuth: false,
            });
            topComments = (commentsRes?.items || []).map((c: any) => {
              const top = c?.snippet?.topLevelComment?.snippet || {};
              return {
                author: top.authorDisplayName,
                text: top.textDisplay,
                likeCount: Number(top.likeCount || 0),
                publishedAt: top.publishedAt,
                replyCount: Number(c?.snippet?.totalReplyCount || 0),
              };
            });
          } catch {
            topComments = [];
          }
        }

        return {
          videoId: item.id,
          url: `https://www.youtube.com/watch?v=${item.id}`,
          title: snippet.title,
          description: snippet.description,
          tags: snippet.tags || [],
          categoryId: snippet.categoryId,
          defaultLanguage: snippet.defaultLanguage || snippet.defaultAudioLanguage || null,
          uploadDate: snippet.publishedAt,
          channelId: snippet.channelId,
          channelTitle: snippet.channelTitle,
          viewCount: stats.viewCount !== undefined ? Number(stats.viewCount) : null,
          likeCount: stats.likeCount !== undefined ? Number(stats.likeCount) : null,
          commentCount:
            stats.commentCount !== undefined ? Number(stats.commentCount) : null,
          duration: durationInfo.formatted,
          durationIso: contentDetails.duration,
          durationSeconds: durationInfo.totalSeconds,
          definition: contentDetails.definition,
          captionAvailable: contentDetails.caption === "true",
          privacyStatus: status.privacyStatus,
          madeForKids: status.madeForKids,
          embeddable: status.embeddable,
          thumbnails: snippet.thumbnails,
          topicCategories: item?.topicDetails?.topicCategories || [],
          ...(topComments !== undefined ? { topComments } : {}),
        };
      })
    );

    return formatToolResult({
      status: "ok",
      count: videos.length,
      video: videos.length === 1 ? videos[0] : undefined,
      videos: videos.length > 1 ? videos : undefined,
    });
  },
};

// ============================================================================
// 3. TRANSCRIPT / SUBTITLE EXTRACTOR: youtube_get_transcript
// ============================================================================
export const youtubeGetTranscriptTool: ToolDefinition = {
  name: "youtube_get_transcript",
  description:
    "Extract full transcript / closed captions (subtitles) from a YouTube video so AI can read, analyze, and summarize the video content accurately. Uses youtube-transcript with multi-layer fallback to YouTube watch page caption tracks and YouTube Data API v3 captions list.",
  inputSchema: {
    type: "object",
    properties: {
      video_id: {
        type: "string",
        description:
          "YouTube Video ID (e.g., 'dQw4w9WgXcQ') or full YouTube video URL (watch, youtu.be, shorts).",
      },
      language: {
        type: "string",
        description:
          "Preferred subtitle language ISO code (e.g., 'id' for Indonesian, 'en' for English). Automatically falls back to available language if preferred is not found.",
      },
      include_timestamps: {
        type: "boolean",
        description:
          "If true, includes the timestamped segments array alongside the combined full_text. Default: true.",
        default: true,
      },
    },
    required: ["video_id"],
  },
  handler: async (args) => {
    const videoId = extractVideoId(args.video_id);
    const preferredLang = args.language
      ? String(args.language).trim()
      : undefined;
    const includeTimestamps =
      args.include_timestamps !== undefined
        ? Boolean(args.include_timestamps)
        : true;

    let segments: TranscriptSegment[] = [];
    let resolvedLanguage = preferredLang || "auto";
    let availableLanguages: string[] = [];
    let extractionMethod = "youtube-transcript";

    // Layer 1: Primary extraction via `youtube-transcript` library
    try {
      const rawItems = await YoutubeTranscript.fetchTranscript(
        videoId,
        preferredLang ? { lang: preferredLang } : undefined
      );

      if (Array.isArray(rawItems) && rawItems.length > 0) {
        segments = rawItems.map((item: any) => {
          const offsetVal = Number(item.offset || 0);
          const durationVal = Number(item.duration || 0);
          // Normalize offset (some versions return ms, some return seconds)
          const startSec = offsetVal > 86400 ? offsetVal / 1000 : offsetVal;
          const durSec = durationVal > 3600 ? durationVal / 1000 : durationVal;
          const cleanText = decodeHtmlEntities(String(item.text || ""));
          return {
            text: cleanText,
            startSeconds: Number(startSec.toFixed(2)),
            durationSeconds: Number(durSec.toFixed(2)),
            timestamp: formatTimestampSeconds(startSec),
          };
        });
        if (rawItems[0]?.lang) {
          resolvedLanguage = String(rawItems[0].lang);
        }
      }
    } catch {
      // Retry `youtube-transcript` without language constraint if preferredLang failed
      if (preferredLang) {
        try {
          const rawFallback = await YoutubeTranscript.fetchTranscript(videoId);
          if (Array.isArray(rawFallback) && rawFallback.length > 0) {
            segments = rawFallback.map((item: any) => {
              const offsetVal = Number(item.offset || 0);
              const durationVal = Number(item.duration || 0);
              const startSec = offsetVal > 86400 ? offsetVal / 1000 : offsetVal;
              const durSec =
                durationVal > 3600 ? durationVal / 1000 : durationVal;
              return {
                text: decodeHtmlEntities(String(item.text || "")),
                startSeconds: Number(startSec.toFixed(2)),
                durationSeconds: Number(durSec.toFixed(2)),
                timestamp: formatTimestampSeconds(startSec),
              };
            });
            resolvedLanguage = String(rawFallback[0]?.lang || "default");
          }
        } catch {
          // Proceed to Layer 2 fallback
        }
      }
    }

    // Layer 2: Watch page `captionTracks` parser fallback
    if (segments.length === 0) {
      try {
        const fallbackResult = await fetchTranscriptViaWatchPageFallback(
          videoId,
          preferredLang
        );
        segments = fallbackResult.segments;
        resolvedLanguage = fallbackResult.language;
        availableLanguages = fallbackResult.availableLanguages;
        extractionMethod = "watch-page-caption-tracks";
      } catch (fallbackErr: any) {
        // Layer 3: Check official YouTube Data API v3 captions endpoint if OAuth/API key is available
        const { hasOAuth, hasApiKey } = getYouTubeCredentialsConfig();
        if (hasOAuth || hasApiKey) {
          try {
            const captionsList = await youtubeApiRequest("captions", {
              method: "GET",
              params: {
                part: "snippet",
                videoId,
              },
              requireOAuth: false,
            });
            const tracks = (captionsList?.items || []).map((t: any) => ({
              id: t.id,
              language: t?.snippet?.language,
              name: t?.snippet?.name,
              trackKind: t?.snippet?.trackKind,
            }));

            return formatToolResult(
              {
                status: "error",
                videoId,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                error:
                  fallbackErr?.message ||
                  `Transcript extraction failed for video '${videoId}'.`,
                availableCaptionTracksMetadata: tracks,
              },
              true
            );
          } catch {
            // Ignore secondary error and return primary message
          }
        }

        return formatToolResult(
          {
            status: "error",
            videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            error:
              fallbackErr?.message ||
              `Could not retrieve transcript/subtitles for video '${videoId}'. The video may have disabled captions or is private/unavailable.`,
          },
          true
        );
      }
    }

    const fullText = segments.map((s) => s.text).join(" ");
    const timestampedText = segments
      .map((s) => `[${s.timestamp}] ${s.text}`)
      .join("\n");

    return formatToolResult({
      status: "ok",
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      language: resolvedLanguage,
      ...(availableLanguages.length > 0 ? { availableLanguages } : {}),
      extractionMethod,
      segmentCount: segments.length,
      characterCount: fullText.length,
      wordCount: fullText.split(/\s+/).filter(Boolean).length,
      full_text: fullText,
      timestamped_transcript: timestampedText,
      ...(includeTimestamps ? { segments } : {}),
    });
  },
};

// ============================================================================
// 4. CHANNEL INFO & STATISTICS: youtube_get_channel_info
// ============================================================================
export const youtubeGetChannelInfoTool: ToolDefinition = {
  name: "youtube_get_channel_info",
  description:
    "Get YouTube channel profile, statistics (subscriberCount, viewCount, videoCount), branding, and playlists metadata. Defaults to the authenticated personal account (jmukhlishin@gmail.com via mine=true) when channel_id/handle is omitted.",
  inputSchema: {
    type: "object",
    properties: {
      mine: {
        type: "boolean",
        description:
          "If true (default when channel_id and handle are omitted), fetches the authenticated user's own channel (jmukhlishin@gmail.com). Requires OAuth2 credentials.",
        default: true,
      },
      channel_id: {
        type: "string",
        description:
          "Optional specific YouTube Channel ID (e.g., 'UC_x5XG1OV2P6uZZ5FSM9Ttw'). If provided, fetches that channel's info.",
      },
      handle: {
        type: "string",
        description:
          "Optional YouTube channel handle (e.g., '@GoogleDevelopers' or 'GoogleDevelopers').",
      },
    },
    required: [],
  },
  handler: async (args) => {
    const channelId = args.channel_id ? String(args.channel_id).trim() : "";
    const handle = args.handle ? String(args.handle).trim() : "";
    const useMine = !channelId && !handle ? true : Boolean(args.mine && !channelId && !handle);

    const params: Record<string, any> = {
      part: "snippet,statistics,contentDetails,brandingSettings,status",
    };

    if (channelId) {
      params.id = channelId;
    } else if (handle) {
      params.forHandle = handle.startsWith("@") ? handle : `@${handle}`;
    } else {
      params.mine = true;
    }

    const data = await youtubeApiRequest("channels", {
      method: "GET",
      params,
      requireOAuth: useMine,
    });

    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      return formatToolResult(
        {
          status: "not_found",
          error: useMine
            ? "No YouTube channel found for the authenticated account (jmukhlishin@gmail.com)."
            : `No YouTube channel found matching '${channelId || handle}'.`,
        },
        true
      );
    }

    const ch = items[0];
    const snippet = ch.snippet || {};
    const stats = ch.statistics || {};
    const contentDetails = ch.contentDetails || {};
    const branding = ch.brandingSettings?.channel || {};

    return formatToolResult({
      status: "ok",
      account: useMine ? "jmukhlishin@gmail.com (authenticated owner)" : "public_lookup",
      channel: {
        channelId: ch.id,
        title: snippet.title,
        handle: snippet.customUrl || null,
        description: snippet.description,
        publishedAt: snippet.publishedAt,
        country: snippet.country || branding.country || null,
        url: snippet.customUrl
          ? `https://www.youtube.com/${snippet.customUrl}`
          : `https://www.youtube.com/channel/${ch.id}`,
        statistics: {
          subscriberCount:
            stats.subscriberCount !== undefined
              ? Number(stats.subscriberCount)
              : null,
          hiddenSubscriberCount: Boolean(stats.hiddenSubscriberCount),
          viewCount:
            stats.viewCount !== undefined ? Number(stats.viewCount) : null,
          videoCount:
            stats.videoCount !== undefined ? Number(stats.videoCount) : null,
        },
        relatedPlaylists: contentDetails.relatedPlaylists || {},
        keywords: branding.keywords || null,
        privacyStatus: ch.status?.privacyStatus || null,
        isLinked: ch.status?.isLinked ?? null,
        longUploadsStatus: ch.status?.longUploadsStatus || null,
        thumbnails: snippet.thumbnails || {},
      },
    });
  },
};

// ============================================================================
// 5. PLAYLIST MANAGEMENT: youtube_manage_playlist
// ============================================================================
export const youtubeManagePlaylistTool: ToolDefinition = {
  name: "youtube_manage_playlist",
  description:
    "Full YouTube playlist management for the authenticated channel (jmukhlishin@gmail.com) or public playlist lookup: list playlists, list items inside a playlist, create a new playlist, update a playlist, delete a playlist, add a video to a playlist, or remove a video from a playlist.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "list_items",
          "create",
          "update",
          "delete",
          "add_video",
          "remove_video",
        ],
        description:
          "Playlist operation to execute: 'list' (list channel playlists), 'list_items' (list videos inside a playlist), 'create' (create new playlist), 'update' (edit playlist title/description/privacy), 'delete' (delete a playlist), 'add_video' (add a video to playlist), or 'remove_video' (remove a video from playlist).",
      },
      playlist_id: {
        type: "string",
        description:
          "Target Playlist ID (required for 'list_items', 'update', 'delete', 'add_video', and optional for 'remove_video' if playlist_item_id is omitted).",
      },
      channel_id: {
        type: "string",
        description:
          "Optional Channel ID when action='list' to inspect another channel's public playlists. Leave empty to list own playlists (mine=true).",
      },
      title: {
        type: "string",
        description: "Playlist title (required for 'create' and 'update').",
      },
      description: {
        type: "string",
        description: "Playlist description (optional for 'create' and 'update').",
      },
      privacy_status: {
        type: "string",
        enum: ["private", "unlisted", "public"],
        description:
          "Privacy status for 'create' or 'update': 'private' (default), 'unlisted', or 'public'.",
        default: "private",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of tags for the playlist ('create' / 'update').",
      },
      video_id: {
        type: "string",
        description:
          "YouTube Video ID or URL to add/remove (required for 'add_video', or used to locate the item in 'remove_video' when playlist_item_id is not provided).",
      },
      playlist_item_id: {
        type: "string",
        description:
          "Specific playlistItem ID for 'remove_video'. If omitted, you can provide 'playlist_id' + 'video_id' and the tool will automatically look up the matching playlistItem ID.",
      },
      position: {
        type: "number",
        description:
          "Optional 0-based index position when adding a video to a playlist ('add_video').",
      },
      max_results: {
        type: "number",
        description:
          "Max items to return for 'list' or 'list_items' (1 to 50). Default: 25.",
        default: 25,
      },
      page_token: {
        type: "string",
        description: "Optional pagination token for 'list' or 'list_items'.",
      },
    },
    required: ["action"],
  },
  handler: async (args) => {
    const action = String(args.action || "")
      .trim()
      .toLowerCase();
    const maxResults = Math.min(
      50,
      Math.max(1, Number(args.max_results) || 25)
    );

    switch (action) {
      case "list": {
        const channelId = args.channel_id
          ? String(args.channel_id).trim()
          : "";
        const params: Record<string, any> = {
          part: "snippet,contentDetails,status",
          maxResults,
        };
        if (channelId) {
          params.channelId = channelId;
        } else {
          params.mine = true;
        }
        if (args.page_token) params.pageToken = String(args.page_token).trim();

        const data = await youtubeApiRequest("playlists", {
          method: "GET",
          params,
          requireOAuth: !channelId,
        });

        const playlists = (data?.items || []).map((pl: any) => ({
          playlistId: pl.id,
          title: pl.snippet?.title,
          description: pl.snippet?.description,
          publishedAt: pl.snippet?.publishedAt,
          channelId: pl.snippet?.channelId,
          channelTitle: pl.snippet?.channelTitle,
          itemCount: pl.contentDetails?.itemCount ?? 0,
          privacyStatus: pl.status?.privacyStatus,
          url: `https://www.youtube.com/playlist?list=${pl.id}`,
        }));

        return formatToolResult({
          status: "ok",
          action: "list",
          owner: channelId || "mine (jmukhlishin@gmail.com)",
          count: playlists.length,
          nextPageToken: data?.nextPageToken || null,
          playlists,
        });
      }

      case "list_items": {
        const playlistId = String(args.playlist_id || "").trim();
        if (!playlistId) {
          return formatToolResult(
            { error: "Parameter 'playlist_id' is required for action 'list_items'." },
            true
          );
        }

        const params: Record<string, any> = {
          part: "snippet,contentDetails,status",
          playlistId,
          maxResults,
        };
        if (args.page_token) params.pageToken = String(args.page_token).trim();

        const data = await youtubeApiRequest("playlistItems", {
          method: "GET",
          params,
          requireOAuth: false,
        });

        const items = (data?.items || []).map((item: any) => {
          const vid =
            item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
          return {
            playlistItemId: item.id,
            position: item.snippet?.position,
            videoId: vid,
            title: item.snippet?.title,
            description: item.snippet?.description,
            videoOwnerChannelTitle: item.snippet?.videoOwnerChannelTitle,
            addedAt: item.snippet?.publishedAt,
            videoPublishedAt: item.contentDetails?.videoPublishedAt,
            privacyStatus: item.status?.privacyStatus,
            url: vid ? `https://www.youtube.com/watch?v=${vid}` : null,
          };
        });

        return formatToolResult({
          status: "ok",
          action: "list_items",
          playlistId,
          count: items.length,
          totalResults: data?.pageInfo?.totalResults ?? items.length,
          nextPageToken: data?.nextPageToken || null,
          items,
        });
      }

      case "create": {
        const title = String(args.title || "").trim();
        if (!title) {
          return formatToolResult(
            { error: "Parameter 'title' is required to create a playlist." },
            true
          );
        }
        const description = args.description ? String(args.description) : "";
        const privacyStatus = String(args.privacy_status || "private")
          .trim()
          .toLowerCase();

        const body: Record<string, any> = {
          snippet: {
            title,
            description,
            ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
          },
          status: {
            privacyStatus,
          },
        };

        const created = await youtubeApiRequest("playlists", {
          method: "POST",
          params: { part: "snippet,status" },
          data: body,
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "create",
          playlistId: created.id,
          title: created.snippet?.title,
          description: created.snippet?.description,
          privacyStatus: created.status?.privacyStatus,
          url: `https://www.youtube.com/playlist?list=${created.id}`,
        });
      }

      case "update": {
        const playlistId = String(args.playlist_id || "").trim();
        const title = String(args.title || "").trim();
        if (!playlistId || !title) {
          return formatToolResult(
            {
              error:
                "Parameters 'playlist_id' and 'title' are required for action 'update'.",
            },
            true
          );
        }

        const body: Record<string, any> = {
          id: playlistId,
          snippet: {
            title,
            description: args.description !== undefined ? String(args.description) : "",
            ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
          },
          ...(args.privacy_status
            ? {
                status: {
                  privacyStatus: String(args.privacy_status).toLowerCase(),
                },
              }
            : {}),
        };

        const parts = ["snippet"];
        if (args.privacy_status) parts.push("status");

        const updated = await youtubeApiRequest("playlists", {
          method: "PUT",
          params: { part: parts.join(",") },
          data: body,
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "update",
          playlistId: updated.id,
          title: updated.snippet?.title,
          description: updated.snippet?.description,
          privacyStatus: updated.status?.privacyStatus,
        });
      }

      case "delete": {
        const playlistId = String(args.playlist_id || "").trim();
        if (!playlistId) {
          return formatToolResult(
            { error: "Parameter 'playlist_id' is required for action 'delete'." },
            true
          );
        }

        await youtubeApiRequest("playlists", {
          method: "DELETE",
          params: { id: playlistId },
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "delete",
          playlistId,
          message: `Playlist '${playlistId}' has been deleted.`,
        });
      }

      case "add_video": {
        const playlistId = String(args.playlist_id || "").trim();
        if (!playlistId || !args.video_id) {
          return formatToolResult(
            {
              error:
                "Parameters 'playlist_id' and 'video_id' are required for action 'add_video'.",
            },
            true
          );
        }
        const videoId = extractVideoId(args.video_id);

        const snippetPayload: Record<string, any> = {
          playlistId,
          resourceId: {
            kind: "youtube#video",
            videoId,
          },
        };
        if (args.position !== undefined && args.position !== null) {
          snippetPayload.position = Number(args.position);
        }

        const added = await youtubeApiRequest("playlistItems", {
          method: "POST",
          params: { part: "snippet" },
          data: { snippet: snippetPayload },
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "add_video",
          playlistId,
          playlistItemId: added.id,
          videoId,
          title: added.snippet?.title,
          position: added.snippet?.position,
        });
      }

      case "remove_video": {
        let playlistItemId = args.playlist_item_id
          ? String(args.playlist_item_id).trim()
          : "";

        if (!playlistItemId) {
          const playlistId = String(args.playlist_id || "").trim();
          if (!playlistId || !args.video_id) {
            return formatToolResult(
              {
                error:
                  "Provide either 'playlist_item_id' OR both 'playlist_id' and 'video_id' for action 'remove_video'.",
              },
              true
            );
          }
          const videoId = extractVideoId(args.video_id);
          const lookup = await youtubeApiRequest("playlistItems", {
            method: "GET",
            params: {
              part: "id,snippet",
              playlistId,
              videoId,
              maxResults: 5,
            },
            requireOAuth: true,
          });
          const firstItem = lookup?.items?.[0];
          if (!firstItem?.id) {
            return formatToolResult(
              {
                status: "not_found",
                error: `Video '${videoId}' was not found inside playlist '${playlistId}'.`,
              },
              true
            );
          }
          playlistItemId = firstItem.id;
        }

        await youtubeApiRequest("playlistItems", {
          method: "DELETE",
          params: { id: playlistItemId },
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "remove_video",
          playlistItemId,
          message: `Removed playlist item '${playlistItemId}' successfully.`,
        });
      }

      default:
        return formatToolResult(
          {
            error: `Unsupported playlist action '${action}'. Valid actions: list, list_items, create, update, delete, add_video, remove_video.`,
          },
          true
        );
    }
  },
};

// ============================================================================
// 6. VIDEO UPLOAD: youtube_upload_video
// ============================================================================
export const youtubeUploadVideoTool: ToolDefinition = {
  name: "youtube_upload_video",
  description:
    "Upload a new video to the authenticated YouTube channel (jmukhlishin@gmail.com) via YouTube Data API v3 Resumable Upload protocol. Supports local file_path, remote video_url, or video_base64, along with title, description, tags, privacy_status (private/unlisted/public), category_id, and made_for_kids.",
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Video title (required, max 100 characters).",
      },
      description: {
        type: "string",
        description: "Video description (supports hashtags and links).",
        default: "",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional array of keyword tags for the video.",
      },
      privacy_status: {
        type: "string",
        enum: ["private", "unlisted", "public"],
        description:
          "Video visibility status: 'private' (default), 'unlisted', or 'public'.",
        default: "private",
      },
      category_id: {
        type: "string",
        description:
          "YouTube video category ID (e.g., '22' for People & Blogs, '27' for Education, '28' for Science & Technology). Default: '22'.",
        default: "22",
      },
      made_for_kids: {
        type: "boolean",
        description:
          "Whether the video is designated as Made for Kids (COPPA compliance). Default: false.",
        default: false,
      },
      file_path: {
        type: "string",
        description:
          "Local file path on the server to the video file (e.g., '/tmp/video.mp4'). Provide one of file_path, video_url, or video_base64.",
      },
      video_url: {
        type: "string",
        description:
          "HTTP/HTTPS URL to download the video binary from before uploading to YouTube.",
      },
      video_base64: {
        type: "string",
        description: "Base64-encoded video file content.",
      },
      mime_type: {
        type: "string",
        description: "Video MIME type (e.g., 'video/mp4', 'video/quicktime'). Default: 'video/mp4'.",
        default: "video/mp4",
      },
    },
    required: ["title"],
  },
  handler: async (args) => {
    const title = String(args.title || "").trim();
    if (!title) {
      return formatToolResult(
        { error: "Parameter 'title' is required for uploading a video." },
        true
      );
    }

    const token = await getValidAccessToken();
    const { buffer, mimeType, sourceDescription } =
      await resolveVideoUploadBuffer({
        file_path: args.file_path,
        video_url: args.video_url,
        video_base64: args.video_base64,
        mime_type: args.mime_type,
      });

    const privacyStatus = String(args.privacy_status || "private")
      .trim()
      .toLowerCase();
    const categoryId = String(args.category_id || "22").trim();
    const description = args.description ? String(args.description) : "";
    const tags = Array.isArray(args.tags)
      ? args.tags.map((t: any) => String(t))
      : undefined;
    const selfDeclaredMadeForKids = Boolean(args.made_for_kids);

    const metadataBody = {
      snippet: {
        title,
        description,
        categoryId,
        ...(tags && tags.length > 0 ? { tags } : {}),
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids,
      },
    };

    // Step 1: Initiate YouTube Resumable Upload session
    const initResponse = await axios.post(
      `${YOUTUBE_UPLOAD_API_BASE}/videos`,
      metadataBody,
      {
        params: {
          uploadType: "resumable",
          part: "snippet,status",
        },
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(buffer.length),
          "X-Upload-Content-Type": mimeType,
        },
        timeout: 30000,
      }
    );

    const uploadUrl = initResponse.headers["location"];
    if (!uploadUrl) {
      throw new Error(
        "Failed to initialize YouTube resumable upload session (no Location header returned)."
      );
    }

    // Step 2: Upload binary video stream to the session URI
    const uploadResponse = await axios.put(uploadUrl, buffer, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mimeType,
        "Content-Length": String(buffer.length),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000, // 5 minutes for large uploads
    });

    const uploaded = uploadResponse.data || {};
    return formatToolResult({
      status: "ok",
      action: "upload_video",
      videoId: uploaded.id,
      url: `https://www.youtube.com/watch?v=${uploaded.id}`,
      studioUrl: `https://studio.youtube.com/video/${uploaded.id}/edit`,
      title: uploaded.snippet?.title || title,
      description: uploaded.snippet?.description ?? description,
      tags: uploaded.snippet?.tags || tags || [],
      categoryId: uploaded.snippet?.categoryId || categoryId,
      privacyStatus: uploaded.status?.privacyStatus || privacyStatus,
      uploadStatus: uploaded.status?.uploadStatus,
      bytesUploaded: buffer.length,
      source: sourceDescription,
    });
  },
};

// ============================================================================
// 7. VIDEO MANAGEMENT (LIST OWN VIDEOS, UPDATE METADATA, DELETE): youtube_manage_video
// ============================================================================
export const youtubeManageVideoTool: ToolDefinition = {
  name: "youtube_manage_video",
  description:
    "Manage videos on the authenticated YouTube channel (jmukhlishin@gmail.com): 'list_my_videos' (list videos uploaded to own channel with full stats & privacy status), 'update' (update video title, description, tags, category_id, or privacy_status), or 'delete' (permanently delete a video).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list_my_videos", "update", "delete"],
        description:
          "Operation to perform: 'list_my_videos' (list own channel videos), 'update' (update video metadata/privacy), or 'delete' (delete video by video_id).",
      },
      video_id: {
        type: "string",
        description:
          "Target YouTube Video ID or URL (required for 'update' and 'delete').",
      },
      title: {
        type: "string",
        description:
          "New video title for 'update'. If omitted during 'update', existing title is preserved.",
      },
      description: {
        type: "string",
        description:
          "New video description for 'update'. If omitted during 'update', existing description is preserved.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "New array of keyword tags for 'update'. If omitted during 'update', existing tags are preserved.",
      },
      category_id: {
        type: "string",
        description:
          "Optional YouTube categoryId for 'update' (preserves existing categoryId if omitted).",
      },
      privacy_status: {
        type: "string",
        enum: ["private", "unlisted", "public"],
        description:
          "Optional new privacy status for 'update': 'private', 'unlisted', or 'public'.",
      },
      max_results: {
        type: "number",
        description:
          "Number of videos to list when action='list_my_videos' (1 to 50). Default: 20.",
        default: 20,
      },
      page_token: {
        type: "string",
        description:
          "Optional pagination token when action='list_my_videos'.",
      },
    },
    required: ["action"],
  },
  handler: async (args) => {
    const action = String(args.action || "")
      .trim()
      .toLowerCase();

    switch (action) {
      case "list_my_videos": {
        const maxResults = Math.min(
          50,
          Math.max(1, Number(args.max_results) || 20)
        );

        // Fetch authenticated user's uploads playlist ID
        const channelData = await youtubeApiRequest("channels", {
          method: "GET",
          params: {
            part: "id,snippet,contentDetails",
            mine: true,
          },
          requireOAuth: true,
        });

        const channelItem = channelData?.items?.[0];
        if (!channelItem) {
          return formatToolResult(
            {
              status: "not_found",
              error:
                "No YouTube channel found for the authenticated user (jmukhlishin@gmail.com).",
            },
            true
          );
        }

        const uploadsPlaylistId =
          channelItem?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsPlaylistId) {
          return formatToolResult({
            status: "ok",
            action: "list_my_videos",
            channelId: channelItem.id,
            channelTitle: channelItem.snippet?.title,
            count: 0,
            videos: [],
          });
        }

        const plParams: Record<string, any> = {
          part: "snippet,contentDetails,status",
          playlistId: uploadsPlaylistId,
          maxResults,
        };
        if (args.page_token) plParams.pageToken = String(args.page_token).trim();

        const playlistItemsData = await youtubeApiRequest("playlistItems", {
          method: "GET",
          params: plParams,
          requireOAuth: true,
        });

        const rawItems = Array.isArray(playlistItemsData?.items)
          ? playlistItemsData.items
          : [];
        const videoIds = rawItems
          .map(
            (i: any) =>
              i?.contentDetails?.videoId || i?.snippet?.resourceId?.videoId
          )
          .filter(Boolean);

        let detailedMap = new Map<string, any>();
        if (videoIds.length > 0) {
          const videosData = await youtubeApiRequest("videos", {
            method: "GET",
            params: {
              part: "snippet,statistics,contentDetails,status",
              id: videoIds.join(","),
            },
            requireOAuth: true,
          });
          for (const v of videosData?.items || []) {
            detailedMap.set(v.id, v);
          }
        }

        const videos = videoIds.map((vid: string) => {
          const v = detailedMap.get(vid) || {};
          const snippet = v.snippet || {};
          const stats = v.statistics || {};
          const status = v.status || {};
          const duration = parseIso8601Duration(v.contentDetails?.duration);

          return {
            videoId: vid,
            url: `https://www.youtube.com/watch?v=${vid}`,
            title: snippet.title,
            description: snippet.description,
            tags: snippet.tags || [],
            categoryId: snippet.categoryId,
            publishedAt: snippet.publishedAt,
            privacyStatus: status.privacyStatus,
            duration: duration.formatted,
            viewCount:
              stats.viewCount !== undefined ? Number(stats.viewCount) : 0,
            likeCount:
              stats.likeCount !== undefined ? Number(stats.likeCount) : 0,
            commentCount:
              stats.commentCount !== undefined ? Number(stats.commentCount) : 0,
          };
        });

        return formatToolResult({
          status: "ok",
          action: "list_my_videos",
          channelId: channelItem.id,
          channelTitle: channelItem.snippet?.title,
          uploadsPlaylistId,
          count: videos.length,
          totalResults:
            playlistItemsData?.pageInfo?.totalResults ?? videos.length,
          nextPageToken: playlistItemsData?.nextPageToken || null,
          videos,
        });
      }

      case "update": {
        if (!args.video_id) {
          return formatToolResult(
            { error: "Parameter 'video_id' is required for action 'update'." },
            true
          );
        }
        const videoId = extractVideoId(args.video_id);

        // Fetch existing video snippet & status first so partial updates don't wipe existing fields
        const existingData = await youtubeApiRequest("videos", {
          method: "GET",
          params: {
            part: "snippet,status",
            id: videoId,
          },
          requireOAuth: true,
        });

        const existingVideo = existingData?.items?.[0];
        if (!existingVideo) {
          return formatToolResult(
            {
              status: "not_found",
              error: `Video '${videoId}' not found or not accessible by the authenticated channel.`,
            },
            true
          );
        }

        const curSnippet = existingVideo.snippet || {};
        const curStatus = existingVideo.status || {};

        const updatedSnippet: Record<string, any> = {
          title:
            args.title !== undefined
              ? String(args.title).trim()
              : curSnippet.title,
          description:
            args.description !== undefined
              ? String(args.description)
              : curSnippet.description || "",
          categoryId:
            args.category_id !== undefined
              ? String(args.category_id).trim()
              : curSnippet.categoryId || "22",
        };

        if (args.tags !== undefined) {
          updatedSnippet.tags = Array.isArray(args.tags)
            ? args.tags.map((t: any) => String(t))
            : [];
        } else if (Array.isArray(curSnippet.tags)) {
          updatedSnippet.tags = curSnippet.tags;
        }

        if (curSnippet.defaultLanguage) {
          updatedSnippet.defaultLanguage = curSnippet.defaultLanguage;
        }

        const parts = ["snippet"];
        const updatePayload: Record<string, any> = {
          id: videoId,
          snippet: updatedSnippet,
        };

        if (args.privacy_status !== undefined) {
          parts.push("status");
          updatePayload.status = {
            ...curStatus,
            privacyStatus: String(args.privacy_status)
              .trim()
              .toLowerCase(),
          };
        }

        const updated = await youtubeApiRequest("videos", {
          method: "PUT",
          params: {
            part: parts.join(","),
          },
          data: updatePayload,
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "update",
          videoId: updated.id,
          url: `https://www.youtube.com/watch?v=${updated.id}`,
          title: updated.snippet?.title,
          description: updated.snippet?.description,
          tags: updated.snippet?.tags || [],
          categoryId: updated.snippet?.categoryId,
          privacyStatus:
            updated.status?.privacyStatus || curStatus.privacyStatus,
        });
      }

      case "delete": {
        if (!args.video_id) {
          return formatToolResult(
            { error: "Parameter 'video_id' is required for action 'delete'." },
            true
          );
        }
        const videoId = extractVideoId(args.video_id);

        await youtubeApiRequest("videos", {
          method: "DELETE",
          params: { id: videoId },
          requireOAuth: true,
        });

        return formatToolResult({
          status: "ok",
          action: "delete",
          videoId,
          message: `Video '${videoId}' has been permanently deleted from your YouTube channel.`,
        });
      }

      default:
        return formatToolResult(
          {
            error: `Unsupported video management action '${action}'. Valid actions: list_my_videos, update, delete.`,
          },
          true
        );
    }
  },
};

export const tools: ToolDefinition[] = [
  youtubeSearchTool,
  youtubeGetVideoDetailsTool,
  youtubeGetTranscriptTool,
  youtubeGetChannelInfoTool,
  youtubeManagePlaylistTool,
  youtubeUploadVideoTool,
  youtubeManageVideoTool,
];

export default tools;

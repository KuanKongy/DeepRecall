import axios from "axios";

export const DEFAULT_API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:10000";

const SETTINGS_KEY = "deeprecall-settings";

export interface ApiSettings {
  apiUrl: string;
  password: string;
}

export function loadSettings(): ApiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        apiUrl: parsed.apiUrl || DEFAULT_API,
        password: parsed.password || "",
      };
    }
  } catch {
    /* storage unavailable or corrupt — fall through to defaults */
  }
  return { apiUrl: DEFAULT_API, password: "" };
}

export function saveSettings(settings: ApiSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private browsing etc. — settings just won't persist */
  }
}

// Base URL and password are read per request so the settings popover takes
// effect immediately. This also lets the hosted UI target a Mac backend at
// http://localhost:10000 (exempt from mixed-content blocking in Chrome/Firefox).
export function isUnauthorizedError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 401;
}

// Registered by the app shell; called on any 401 so the user learns the
// password in Settings is wrong or missing.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export const api = axios.create();
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (axios.isAxiosError(err) && err.response?.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    return Promise.reject(err);
  },
);
api.interceptors.request.use((config) => {
  const settings = loadSettings();
  config.baseURL = settings.apiUrl;
  if (settings.password) config.headers["X-App-Password"] = settings.password;
  return config;
});

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Summary {
  short: string;
  detailed: string;
}

export interface HealthInfo {
  ok: boolean;
  cache: string;
  redis: boolean;
  default_backend: string | null;
  available_backends: string[];
}

export interface JobProgress {
  current: number;
  total: number;
}

export interface JobRecord {
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: JobProgress | null;
  message: string;
  sha256: string | null;
  backend: string;
  video_hash: string | null;
  source_url?: string | null;
  youtube_id?: string | null;
  error: string | null;
}

// tsconfig has strict:false, so truthiness does not narrow this union;
// always compare with `lookup.cached === true`.
export interface CacheHit {
  cached: true;
  video_hash: string;
  transcript: TranscriptSegment[];
  summary: Summary;
}

export interface CacheMiss {
  cached: false;
  job_id: string | null;
}

export type CacheLookup = CacheHit | CacheMiss;

export interface SearchHit {
  text: string;
  start: number | null;
  end: number | null;
  score: number;
}

export interface SubmitResult {
  job_id: string;
  video_hash: string;
  deduplicated: boolean;
}

export async function getHealth(): Promise<HealthInfo> {
  try {
    return (await api.get<HealthInfo>("/health")).data;
  } catch {
    // A sleeping Railway container answers its first request with a 502.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return (await api.get<HealthInfo>("/health")).data;
  }
}

export async function lookupCache(sha256: string, backend: string): Promise<CacheLookup> {
  try {
    return (await api.get<CacheHit>(`/cache/${sha256}`, { params: { backend } })).data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return err.response.data as CacheMiss;
    }
    throw err;
  }
}

export async function submitMedia(
  file: Blob,
  filename: string,
  backend: string,
  videoHash: string | null,
  onUploadProgress: (fraction: number) => void,
): Promise<SubmitResult> {
  const form = new FormData();
  form.append("file", file, filename);
  form.append("backend", backend);
  if (videoHash) form.append("video_hash", videoHash);
  const res = await api.post<SubmitResult>("/process_video", form, {
    onUploadProgress: (e) => {
      if (e.total) onUploadProgress(e.loaded / e.total);
    },
  });
  return res.data;
}

export async function processUrl(url: string, backend: string): Promise<SubmitResult> {
  const res = await api.post<SubmitResult>("/process_url", { url, backend });
  return res.data;
}

export async function getJob(jobId: string): Promise<JobRecord> {
  return (await api.get<JobRecord>(`/jobs/${jobId}`)).data;
}

export async function searchTranscript(
  query: string,
  videoHash: string,
  k = 5,
): Promise<SearchHit[]> {
  const res = await api.post<{ results: SearchHit[] }>("/search", {
    query,
    video_hash: videoHash,
    k,
  });
  return res.data.results;
}

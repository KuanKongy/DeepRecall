import axios from "axios";

export const DEFAULT_API = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:10000";

export const api = axios.create({ baseURL: DEFAULT_API });

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
  sha256: string;
  backend: string;
  video_hash: string;
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

export interface SubmitResult {
  job_id: string;
  video_hash: string;
  deduplicated: boolean;
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

export async function getJob(jobId: string): Promise<JobRecord> {
  return (await api.get<JobRecord>(`/jobs/${jobId}`)).data;
}

export async function searchTranscript(query: string, videoHash: string) {
  return (await api.post("/search", { query, video_hash: videoHash })).data;
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { CheckCircle2, FileVideo, Link as LinkIcon, RefreshCw } from "lucide-react";
import type { HealthInfo } from "@/lib/api";

const BACKEND_LABELS: Record<string, string> = {
  api: "API — fast (OpenRouter)",
  mlx: "Local — MacBook GPU (MLX)",
  local: "Local — CPU (faster-whisper)",
};

export const DEMO_URL =
  "https://github.com/KuanKongy/DeepRecall/releases/download/demo-assets/dwada.mp4";

export interface StageInfo {
  label: string;
  fraction: number | null;
  detail: string | null;
}

interface UploadPanelProps {
  video: File | null;
  health: HealthInfo | null;
  backend: string;
  stage: StageInfo | null;
  loading: boolean;
  precached: boolean;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBackendChange: (backend: string) => void;
  onProcess: () => void;
  onProcessUrl: (url: string) => void;
  onRetryHealth: () => void;
}

const UploadPanel = ({
  video,
  health,
  backend,
  stage,
  loading,
  precached,
  onFileChange,
  onBackendChange,
  onProcess,
  onProcessUrl,
  onRetryHealth,
}: UploadPanelProps) => {
  const [mode, setMode] = useState<"file" | "link">("file");
  const [url, setUrl] = useState("");
  const backendChoices = health?.available_backends ?? [];
  const serverReady = health !== null && health.ok;

  const modeButton = (value: "file" | "link", icon: React.ReactNode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
        mode === value
          ? "bg-purple-600 text-white"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
      }`}
    >
      {icon} {label}
    </button>
  );

  return (
    <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl flex items-center gap-2">
          <FileVideo className="h-5 w-5" /> Add a Video
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex gap-2">
            {modeButton("file", <FileVideo className="h-4 w-4" />, "Upload file")}
            {modeButton("link", <LinkIcon className="h-4 w-4" />, "From link")}
          </div>

          {mode === "file" ? (
            <div className="grid w-full items-center gap-1.5">
              <Input
                id="video-upload"
                type="file"
                accept="video/*"
                onChange={onFileChange}
                className="cursor-pointer"
              />
              {video ? (
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {video.name} · {(video.size / 1e6).toFixed(1)} MB
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  MP4, MOV, WebM or MKV
                </p>
              )}
              {precached && (
                <p className="flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Already processed — results load instantly
                </p>
              )}
            </div>
          ) : (
            <div className="grid w-full items-center gap-1.5">
              <Input
                placeholder="YouTube, Google Drive, or direct video URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && url.trim() && serverReady && !loading) {
                    onProcessUrl(url.trim());
                  }
                }}
              />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                The server downloads it for you — nothing to upload.{" "}
                <button
                  type="button"
                  disabled={loading || !serverReady}
                  onClick={() => {
                    setUrl(DEMO_URL);
                    onProcessUrl(DEMO_URL);
                  }}
                  className="font-medium text-purple-600 underline-offset-2 hover:underline disabled:opacity-50 dark:text-purple-400"
                >
                  Try a demo video
                </button>
              </p>
            </div>
          )}

          {backendChoices.length > 1 && (
            <div className="grid w-full items-center gap-1.5">
              <label htmlFor="backend-select" className="text-sm text-gray-700 dark:text-gray-300">
                Processing mode
              </label>
              <select
                id="backend-select"
                value={backend}
                onChange={(e) => onBackendChange(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm cursor-pointer"
              >
                {backendChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {BACKEND_LABELS[choice] ?? choice}
                  </option>
                ))}
              </select>
            </div>
          )}

          {health === null && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
              <span>Server unreachable — check the API URL in settings.</span>
              <Button variant="outline" size="sm" onClick={onRetryHealth} className="shrink-0">
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          )}

          {stage && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-gray-600 dark:text-gray-300">
                <span>{stage.label}</span>
                {stage.detail && <span>{stage.detail}</span>}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-600">
                {stage.fraction === null ? (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-green-500" />
                ) : (
                  <div
                    className="h-full rounded-full bg-green-500 transition-all"
                    style={{ width: `${Math.round(stage.fraction * 100)}%` }}
                  />
                )}
              </div>
            </div>
          )}

          {mode === "file" && (
            <Button
              onClick={onProcess}
              disabled={loading || !serverReady || !video}
              className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
            >
              {loading ? (stage ? stage.label : "Processing...") : "Process Video"}
            </Button>
          )}
          {mode === "link" && (
            <Button
              onClick={() => url.trim() && onProcessUrl(url.trim())}
              disabled={loading || !serverReady || !url.trim()}
              className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
            >
              {loading ? (stage ? stage.label : "Processing...") : "Process from Link"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default UploadPanel;

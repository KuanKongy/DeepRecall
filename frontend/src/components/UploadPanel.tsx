import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FileVideo } from "lucide-react";
import type { HealthInfo } from "@/lib/api";

const BACKEND_LABELS: Record<string, string> = {
  groq: "API — fast (Groq)",
  mlx: "Local — MacBook GPU (MLX)",
  local: "Local — CPU (faster-whisper)",
};

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
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBackendChange: (backend: string) => void;
  onProcess: () => void;
}

const UploadPanel = ({
  video,
  health,
  backend,
  stage,
  loading,
  onFileChange,
  onBackendChange,
  onProcess,
}: UploadPanelProps) => {
  const backendChoices = health?.available_backends ?? [];
  const serverReady = health !== null && health.ok;

  return (
    <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl flex items-center gap-2">
          <FileVideo className="h-5 w-5" /> Video Upload (.mp4)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid w-full max-w-sm items-center gap-1.5">
            <Input
              id="video-upload"
              type="file"
              accept="video/mp4"
              onChange={onFileChange}
              className="cursor-pointer"
            />
            {video ? (
              <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span>Selected: {video.name}</span>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Select an MP4 video file
              </p>
            )}
          </div>
          {backendChoices.length > 1 && (
            <div className="grid w-full max-w-sm items-center gap-1.5">
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
            <p className="text-sm text-red-600 dark:text-red-400">
              Server unreachable — check the API URL in settings.
            </p>
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
          <Button
            onClick={onProcess}
            disabled={loading || !serverReady}
            className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
          >
            {loading ? (stage ? stage.label : "Processing...") : "Process Video"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default UploadPanel;

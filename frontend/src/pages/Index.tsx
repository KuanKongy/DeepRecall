
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Sun, Moon } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useTheme } from "@/components/ThemeProvider";
import UploadPanel, { type StageInfo } from "@/components/UploadPanel";
import SearchPanel from "@/components/SearchPanel";
import HighlightsPanel from "@/components/HighlightsPanel";
import TranscriptPanel from "@/components/TranscriptPanel";
import SummaryPanel from "@/components/SummaryPanel";
import SettingsPopover from "@/components/SettingsPopover";
import {
  getHealth,
  getJob,
  lookupCache,
  submitMedia,
  type CacheHit,
  type HealthInfo,
  type JobRecord,
  type Summary,
  type TranscriptSegment,
} from "@/lib/api";
import { hashFile } from "@/lib/hashFile";
import { extractAudio } from "@/lib/extractAudio";

// Railway closes request bodies that take longer than 5 minutes to upload.
const RAW_UPLOAD_WARN_BYTES = 300 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeJob(job: JobRecord): StageInfo {
  switch (job.stage) {
    case "queued":
      return { label: "Queued on server", fraction: null, detail: null };
    case "extracting":
      return { label: "Extracting audio (server)", fraction: null, detail: null };
    case "transcribing":
      if (job.progress && job.progress.total > 0) {
        return {
          label: "Transcribing",
          fraction: job.progress.current / job.progress.total,
          detail: `${job.progress.current}/${job.progress.total}`,
        };
      }
      return { label: "Transcribing", fraction: null, detail: null };
    case "summarizing":
      return { label: "Summarizing", fraction: null, detail: null };
    case "indexing":
      return { label: "Building search index", fraction: null, detail: null };
    default:
      return { label: job.message || job.stage, fraction: null, detail: null };
  }
}

const Index = () => {
  const [video, setVideo] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [videoHash, setVideoHash] = useState<string>("");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [backend, setBackend] = useState<string>("api");
  const [loading, setLoading] = useState<boolean>(false);
  const [stage, setStage] = useState<StageInfo | null>(null);
  const hashPromiseRef = useRef<Promise<string> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();

  const refreshHealth = useCallback(() => {
    getHealth()
      .then((info) => {
        setHealth(info);
        if (info.default_backend) setBackend(info.default_backend);
      })
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    if (!video) {
      setVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(video);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [video]);

  const seekTo = useCallback((seconds: number) => {
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = seconds;
    player.play().catch(() => undefined);
    player.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      const file = event.target.files[0];
      if (!file.name.toLowerCase().endsWith('.mp4')) {
        toast({
          title: "Invalid file format",
          description: "Please select an MP4 video file.",
          variant: "destructive",
        });
        return;
      }
      setVideo(file);
      // Start hashing immediately so it is usually done before Process is clicked.
      hashPromiseRef.current = hashFile(file);
      hashPromiseRef.current.catch(() => undefined);
      toast({
        title: "Video selected",
        description: `${file.name} is ready to be processed.`,
      });
    }
  };

  const applyResult = (hit: CacheHit) => {
    setSummary(hit.summary);
    setTranscript(hit.transcript);
    setVideoHash(hit.video_hash);
  };

  const pollJob = async (jobId: string): Promise<void> => {
    for (;;) {
      const job = await getJob(jobId);
      if (job.status === "error") {
        throw new Error(job.error ?? "Processing failed.");
      }
      if (job.status === "done") return;
      setStage(describeJob(job));
      await sleep(2000);
    }
  };

  const handleProcess = async () => {
    if (!video) {
      toast({
        title: "No video selected",
        description: "Please select an MP4 video file first.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      setStage({ label: "Hashing", fraction: null, detail: null });
      const sha = await (hashPromiseRef.current ?? hashFile(video));

      setStage({ label: "Checking cache", fraction: null, detail: null });
      const lookup = await lookupCache(sha, backend);

      if (lookup.cached === true) {
        applyResult(lookup);
        toast({
          title: "Already processed",
          description: "Loaded the cached results for this video — no upload needed.",
        });
        return;
      }

      let jobId = lookup.job_id;
      if (!jobId) {
        // Demux the audio track in the browser; fall back to the raw video.
        let payload: Blob = video;
        let filename = video.name;
        let clientHash: string | null = null;
        setStage({ label: "Extracting audio in browser", fraction: null, detail: null });
        try {
          payload = await extractAudio(video);
          filename = "audio.m4a";
          clientHash = sha;
        } catch (err) {
          console.warn("Browser audio extraction failed; uploading the raw video.", err);
          if (video.size > RAW_UPLOAD_WARN_BYTES) {
            toast({
              title: "Uploading the full video",
              description:
                "Audio extraction failed in this browser, and the video is large — the upload may time out.",
            });
          }
        }

        setStage({ label: "Uploading", fraction: 0, detail: null });
        const submitted = await submitMedia(payload, filename, backend, clientHash, (fraction) =>
          setStage({
            label: "Uploading",
            fraction,
            detail: `${Math.round(fraction * 100)}%`,
          }),
        );
        jobId = submitted.job_id;
      } else {
        toast({
          title: "Processing already in progress",
          description: "This video is being processed — attaching to the running job.",
        });
      }

      await pollJob(jobId);

      const finished = await lookupCache(sha, backend);
      if (finished.cached === true) {
        applyResult(finished);
      } else {
        throw new Error("Processing finished but the results are missing from the cache.");
      }
      toast({
        title: "Video processed successfully",
        description: "Your video has been analyzed and the results are ready.",
      });
    } catch (error) {
      console.error("Processing failed", error);
      toast({
        title: "Processing failed",
        description: error instanceof Error ? error.message : "There was an error processing your video.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
      setStage(null);
    }
  };

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-700 via-purple-600 to-purple-800 dark:from-purple-900 dark:via-purple-800 dark:to-purple-950 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-white text-center">
            DeepRecall
          </h1>
          <div className="flex items-center gap-2">
            <SettingsPopover onSaved={refreshHealth} />
            <Button 
              variant="outline" 
              size="icon" 
              onClick={toggleTheme} 
              className="rounded-full bg-white/10 hover:bg-white/20 text-white"
            >
              {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-7 gap-6">
          {/* Left column */}
          <div className="md:col-span-3 space-y-6">
            <UploadPanel
              video={video}
              health={health}
              backend={backend}
              stage={stage}
              loading={loading}
              onFileChange={handleFileChange}
              onBackendChange={setBackend}
              onProcess={handleProcess}
            />
            <SearchPanel
              videoHash={videoHash}
              enabled={transcript.length > 0 && videoHash !== ""}
              onSeek={seekTo}
            />
            <HighlightsPanel transcript={transcript} onSeek={seekTo} />
          </div>

          {/* Right column */}
          <div className="md:col-span-4 space-y-6">
            {videoUrl && (
              <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
                <CardContent className="p-3">
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    className="w-full rounded-md"
                  />
                </CardContent>
              </Card>
            )}
            <TranscriptPanel transcript={transcript} onSeek={seekTo} />
            <SummaryPanel summary={summary} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;

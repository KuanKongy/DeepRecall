
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
import YouTubePlayer, { type YouTubeHandle } from "@/components/YouTubePlayer";
import {
  getHealth,
  getJob,
  isUnauthorizedError,
  lookupCache,
  processUrl,
  setUnauthorizedHandler,
  submitMedia,
  type CacheHit,
  type HealthInfo,
  type JobRecord,
  type Summary,
  type TranscriptSegment,
} from "@/lib/api";
import { hashFile } from "@/lib/hashFile";
import { extractAudio } from "@/lib/extractAudio";

const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv"];

// Railway closes request bodies that take longer than 5 minutes to upload.
const RAW_UPLOAD_WARN_BYTES = 300 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type PlayerSource =
  | { kind: "file" | "url"; src: string }
  | { kind: "youtube"; id: string }
  | null;

function describeJob(job: JobRecord): StageInfo {
  switch (job.stage) {
    case "queued":
      return { label: "Queued on server", fraction: null, detail: null };
    case "downloading":
      if (job.progress && job.progress.total > 0) {
        return {
          label: "Downloading on server",
          fraction: job.progress.current / job.progress.total,
          detail: `${(job.progress.current / 1e6).toFixed(0)}/${(job.progress.total / 1e6).toFixed(0)} MB`,
        };
      }
      return { label: "Downloading on server", fraction: null, detail: null };
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
  const [playerSource, setPlayerSource] = useState<PlayerSource>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [videoHash, setVideoHash] = useState<string>("");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [backend, setBackend] = useState<string>("api");
  const [loading, setLoading] = useState<boolean>(false);
  const [stage, setStage] = useState<StageInfo | null>(null);
  const [precached, setPrecached] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const hashPromiseRef = useRef<Promise<string> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const youtubeRef = useRef<YouTubeHandle | null>(null);
  const lastAuthToastRef = useRef<number>(0);
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
    setUnauthorizedHandler(() => {
      const now = Date.now();
      if (now - lastAuthToastRef.current > 5000) {
        lastAuthToastRef.current = now;
        toast({
          title: "Password required",
          description: "The password is wrong or missing — set it in Settings ⚙.",
          variant: "destructive",
        });
      }
    });
    return () => setUnauthorizedHandler(() => undefined);
  }, [toast]);

  useEffect(() => {
    if (!video) return;
    const url = URL.createObjectURL(video);
    setPlayerSource({ kind: "file", src: url });
    return () => URL.revokeObjectURL(url);
  }, [video]);

  const seekTo = useCallback((seconds: number) => {
    if (youtubeRef.current) {
      youtubeRef.current.seekTo(seconds);
      return;
    }
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = seconds;
    player.play().catch(() => undefined);
  }, []);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) return;
    const file = event.target.files[0];
    const name = file.name.toLowerCase();
    if (!VIDEO_EXTS.some((ext) => name.endsWith(ext))) {
      toast({
        title: "Unsupported file format",
        description: "Please select an MP4, MOV, WebM or MKV video.",
        variant: "destructive",
      });
      return;
    }
    setVideo(file);
    setPrecached(false);
    // Start hashing immediately so it is usually done before Process is
    // clicked, and quietly pre-check the cache to show the instant-load badge.
    const hashing = hashFile(file);
    hashPromiseRef.current = hashing;
    hashing
      .then((sha) => lookupCache(sha, backend))
      .then((lookup) => setPrecached(lookup.cached === true))
      .catch(() => undefined);
  };

  const applyResult = (hit: CacheHit) => {
    setSummary(hit.summary);
    setTranscript(hit.transcript);
    setVideoHash(hit.video_hash);
    setCurrentTime(0);
  };

  const pollJob = async (jobId: string): Promise<JobRecord> => {
    for (;;) {
      const job = await getJob(jobId);
      if (job.status === "error") {
        throw new Error(job.error ?? "Processing failed.");
      }
      if (job.status === "done") return job;
      setStage(describeJob(job));
      await sleep(2000);
    }
  };

  const finishFromCache = async (sha: string) => {
    const finished = await lookupCache(sha, backend);
    if (finished.cached === true) {
      applyResult(finished);
    } else {
      throw new Error("Processing finished but the results are missing from the cache.");
    }
  };

  const handleProcess = async () => {
    if (!video) {
      toast({
        title: "No video selected",
        description: "Please select a video file first.",
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
          const extracted = await extractAudio(video);
          payload = extracted.blob;
          filename = extracted.filename;
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
      await finishFromCache(sha);
      toast({
        title: "Video processed successfully",
        description: "Your video has been analyzed and the results are ready.",
      });
    } catch (error) {
      console.error("Processing failed", error);
      // On a 401 the interceptor already raised the password toast.
      if (!isUnauthorizedError(error)) {
        toast({
          title: "Processing failed",
          description: error instanceof Error ? error.message : "There was an error processing your video.",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
      setStage(null);
    }
  };

  const handleProcessUrl = async (url: string) => {
    setLoading(true);
    try {
      setStage({ label: "Submitting link", fraction: null, detail: null });
      const submitted = await processUrl(url, backend);
      const job = await pollJob(submitted.job_id);
      if (!job.sha256) {
        throw new Error("The job finished without a file hash.");
      }
      await finishFromCache(job.sha256);
      setVideo(null);
      setPrecached(false);
      setPlayerSource(
        job.youtube_id ? { kind: "youtube", id: job.youtube_id } : { kind: "url", src: url },
      );
      toast({
        title: "Video processed successfully",
        description: "The link has been analyzed and the results are ready.",
      });
    } catch (error) {
      console.error("URL processing failed", error);
      if (!isUnauthorizedError(error)) {
        toast({
          title: "Processing failed",
          description: error instanceof Error ? error.message : "There was an error processing that link.",
          variant: "destructive",
        });
      }
    } finally {
      setLoading(false);
      setStage(null);
    }
  };

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-700 via-purple-600 to-purple-800 dark:from-purple-900 dark:via-purple-800 dark:to-purple-950 p-3 sm:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-4 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white">
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
        
        {/* On phones the wrappers dissolve (max-md:contents) and the cards
            reorder into: upload, player, transcript, summary, search, highlights. */}
        <div className="grid grid-cols-1 md:grid-cols-7 gap-4 md:gap-6">
          <div className="max-md:contents md:col-span-3 md:space-y-6">
            <div className="max-md:order-1">
              <UploadPanel
                video={video}
                health={health}
                backend={backend}
                stage={stage}
                loading={loading}
                precached={precached}
                onFileChange={handleFileChange}
                onBackendChange={setBackend}
                onProcess={handleProcess}
                onProcessUrl={handleProcessUrl}
                onRetryHealth={refreshHealth}
              />
            </div>
            <div className="max-md:order-5">
              <SearchPanel
                key={`search-${videoHash}`}
                videoHash={videoHash}
                enabled={transcript.length > 0 && videoHash !== ""}
                onSeek={seekTo}
              />
            </div>
            <div className="max-md:order-6">
              <HighlightsPanel
                key={`highlights-${videoHash}`}
                transcript={transcript}
                onSeek={seekTo}
              />
            </div>
          </div>

          <div className="max-md:contents md:col-span-4 md:space-y-6">
            {playerSource && (
              <div className="max-md:order-2 max-md:sticky max-md:top-2 max-md:z-30">
                <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
                  <CardContent className="p-2 sm:p-3">
                    {playerSource.kind === "youtube" ? (
                      <YouTubePlayer
                        ref={youtubeRef}
                        videoId={playerSource.id}
                        onTime={setCurrentTime}
                      />
                    ) : (
                      <video
                        ref={videoRef}
                        src={playerSource.src}
                        controls
                        playsInline
                        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                        className="w-full rounded-md bg-black max-h-[40vh] md:max-h-none"
                      />
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
            <div className="max-md:order-3">
              <TranscriptPanel
                transcript={transcript}
                currentTime={currentTime}
                onSeek={seekTo}
              />
            </div>
            <div className="max-md:order-4">
              <SummaryPanel summary={summary} onSeek={seekTo} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;

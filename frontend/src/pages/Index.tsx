
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, EyeOff, FlipHorizontal2, PlayCircle, Sun, Moon } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useTheme } from "@/components/ThemeProvider";
import BrandMark from "@/components/BrandMark";
import UploadPanel, { type StageInfo } from "@/components/UploadPanel";
import SearchPanel from "@/components/SearchPanel";
import HighlightsPanel from "@/components/HighlightsPanel";
import ResultsPanel from "@/components/ResultsPanel";
import YouTubePlayer, { type YouTubeHandle } from "@/components/YouTubePlayer";
import {
  errorMessage,
  getHealth,
  getJob,
  lookupCache,
  mediaProxyUrl,
  processUrl,
  resummarize,
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

function formatEta(seconds: number): string {
  if (seconds < 5) return "almost done";
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)}s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes}m left`;
  return `~${Math.floor(minutes / 60)}h ${minutes % 60}m left`;
}

function describeJob(job: JobRecord): StageInfo {
  const eta = job.eta != null ? ` · ${formatEta(job.eta)}` : "";
  switch (job.stage) {
    case "queued":
      return { label: "Queued on server", fraction: null, detail: null };
    case "downloading":
      if (job.progress && job.progress.total > 0) {
        return {
          label: "Downloading on server",
          fraction: job.progress.current / job.progress.total,
          detail: `${(job.progress.current / 1e6).toFixed(0)}/${(job.progress.total / 1e6).toFixed(0)} MB${eta}`,
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
          detail: `${job.progress.current}/${job.progress.total}${eta}`,
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
  const [regenerating, setRegenerating] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  // Direct playback first; on a media error retry through the server proxy
  // (hosts like GitHub serve videos as octet-stream, which browsers refuse).
  const [playback, setPlayback] = useState<"direct" | "proxy" | "failed">("direct");
  // Canonical layout: Add a Video left, player + summary right; "mirrored" swaps them.
  const [mirrored, setMirrored] = useState<boolean>(
    () => localStorage.getItem("deeprecall-columns") === "swapped",
  );
  const [videoHidden, setVideoHidden] = useState<boolean>(false);
  const hashPromiseRef = useRef<Promise<string> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const youtubeRef = useRef<YouTubeHandle | null>(null);
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
    if (!video) return;
    const url = URL.createObjectURL(video);
    setPlayerSource({ kind: "file", src: url });
    return () => URL.revokeObjectURL(url);
  }, [video]);

  useEffect(() => {
    setPlayback("direct");
  }, [playerSource]);

  // A bad host can stall forever without ever firing an error event (GitHub
  // serves videos as octet-stream + nosniff and Chrome just keeps loading).
  // If no data has arrived shortly after mount, retry through the proxy.
  useEffect(() => {
    if (playerSource?.kind !== "url" || playback !== "direct") return;
    const timer = window.setTimeout(() => {
      const el = videoRef.current;
      if (el && el.readyState === 0) setPlayback("proxy");
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [playerSource, playback]);

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
          description: "Loaded the cached results for this video, no upload needed.",
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
                "Audio extraction failed in this browser, and the video is large. The upload may time out.",
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
          description: "This video is being processed. Attaching to the running job.",
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
      toast({
        title: "Processing failed",
        description: errorMessage(error, "There was an error processing your video."),
        variant: "destructive",
      });
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
      toast({
        title: "Processing failed",
        description: errorMessage(error, "There was an error processing that link."),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
      setStage(null);
    }
  };

  const handleRegenerate = async () => {
    if (!videoHash || regenerating) return;
    setRegenerating(true);
    try {
      setSummary(await resummarize(videoHash));
      toast({ title: "Summary regenerated" });
    } catch (error) {
      console.error("Resummarize failed", error);
      toast({
        title: "Could not regenerate the summary",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setRegenerating(false);
    }
  };

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  const toggleMirror = () => {
    setMirrored((value) => {
      localStorage.setItem("deeprecall-columns", value ? "default" : "swapped");
      return !value;
    });
  };

  const videoSrc =
    playerSource && playerSource.kind !== "youtube"
      ? playerSource.kind === "url" && playback === "proxy"
        ? mediaProxyUrl(playerSource.src)
        : playerSource.src
      : null;

  const handleVideoError = () => {
    if (playerSource?.kind === "url" && playback === "direct") {
      setPlayback("proxy");
    } else {
      setPlayback("failed");
    }
  };

  return (
    <div className="min-h-screen md:h-dvh md:min-h-0 md:overflow-y-auto flex flex-col bg-gradient-to-br from-purple-700 via-purple-600 to-purple-800 dark:from-purple-900 dark:via-purple-800 dark:to-purple-950 p-3">
      <div className="w-full max-w-7xl mx-auto flex flex-col md:flex-1 md:min-h-0">
        <div className="shrink-0 flex justify-between items-center mb-3">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-10 w-10 text-white" />
            <h1 className="text-2xl font-bold text-white">DeepRecall</h1>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip delayDuration={50}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleMirror}
                  className="hidden md:inline-flex rounded-full border-white/40 bg-white/10 hover:bg-white/30 text-white hover:text-white dark:border-white/20 dark:bg-black dark:hover:bg-gray-700"
                >
                  <FlipHorizontal2 className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Swap the content and tool columns</TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={50}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={toggleTheme}
                  className="rounded-full border-white/40 bg-white/10 hover:bg-white/30 text-white hover:text-white dark:border-white/20 dark:bg-black dark:hover:bg-gray-700"
                >
                  {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Desktop is viewport-fit: the page never scrolls, panels scroll inside
            themselves. On phones the wrappers dissolve (max-md:contents) and the
            cards reorder into: upload, player, results, search, highlights. */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:flex-1 md:min-h-[430px]">
          <div
            className={`max-md:contents md:col-span-7 lg:col-span-8 md:flex md:flex-col md:gap-3 md:min-h-0 ${
              mirrored ? "md:order-1" : "md:order-2"
            }`}
          >
            {playerSource && (
              <div
                className={`md:shrink-0 max-md:order-2 ${
                  videoHidden ? "" : "max-md:sticky max-md:top-2 max-md:z-30"
                }`}
              >
                <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
                  <CardHeader className={videoHidden ? "p-3" : "p-3 pb-3"}>
                    <div className="flex items-center justify-between gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <CardTitle className="text-lg flex items-center gap-2 cursor-help">
                            <PlayCircle className="h-5 w-5" /> Video Player
                          </CardTitle>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          Watch the video. Transcript timestamps and search results jump
                          playback here.
                        </TooltipContent>
                      </Tooltip>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setVideoHidden((value) => !value)}
                        className="h-7 gap-1.5 px-2 text-gray-600 dark:text-gray-300"
                      >
                        {videoHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        {videoHidden ? "Show video" : "Hide video"}
                      </Button>
                    </div>
                  </CardHeader>
                  {/* Hidden via display, not unmount: audio, timeupdate and
                      seeking keep working while the video is out of the way. */}
                  <CardContent className={`p-3 pt-0 ${videoHidden ? "hidden" : ""}`}>
                    <div>
                      {playerSource.kind === "youtube" ? (
                        <div className="mx-auto w-full md:max-w-[80vh]">
                          <YouTubePlayer
                            ref={youtubeRef}
                            videoId={playerSource.id}
                            onTime={setCurrentTime}
                          />
                        </div>
                      ) : playback === "failed" ? (
                        <div className="flex min-h-[100px] items-center justify-center rounded-md border border-dashed border-gray-300 p-4 dark:border-gray-600">
                          <p className="text-center text-sm text-gray-500 dark:text-gray-400">
                            This source can't be played in the browser. Transcript,
                            summaries and search still work.
                          </p>
                        </div>
                      ) : (
                        <video
                          key={videoSrc ?? "video"}
                          ref={videoRef}
                          src={videoSrc ?? undefined}
                          controls
                          playsInline
                          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                          onError={handleVideoError}
                          className="w-full rounded-md bg-black object-contain max-h-[40vh] md:max-h-[45vh]"
                        />
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
            <div className="max-md:order-3 md:flex-1 md:min-h-0">
              <ResultsPanel
                transcript={transcript}
                summary={summary}
                currentTime={currentTime}
                onSeek={seekTo}
                onRegenerate={handleRegenerate}
                regenerating={regenerating}
              />
            </div>
          </div>

          <div
            className={`max-md:contents md:col-span-5 lg:col-span-4 md:flex md:flex-col md:gap-3 md:min-h-0 ${
              mirrored ? "md:order-2" : "md:order-1"
            }`}
          >
            <div className="max-md:order-1 md:shrink-0">
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
            <div className="max-md:order-5 md:flex-[2] md:min-h-0">
              <SearchPanel
                key={`search-${videoHash}`}
                videoHash={videoHash}
                enabled={transcript.length > 0 && videoHash !== ""}
                onSeek={seekTo}
              />
            </div>
            <div className="max-md:order-6 md:flex-[1] md:min-h-0">
              <HighlightsPanel
                key={`highlights-${videoHash}`}
                transcript={transcript}
                onSeek={seekTo}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;

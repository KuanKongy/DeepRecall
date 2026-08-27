
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Search, PlayCircle, ListFilter, Sun, Moon, FileVideo } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useTheme } from "@/components/ThemeProvider";
import {
  api,
  getHealth,
  getJob,
  lookupCache,
  searchTranscript,
  submitMedia,
  type CacheHit,
  type HealthInfo,
  type JobRecord,
  type Summary,
  type TranscriptSegment,
} from "@/lib/api";
import { hashFile } from "@/lib/hashFile";
import { extractAudio } from "@/lib/extractAudio";

const BACKEND_LABELS: Record<string, string> = {
  groq: "API — fast (Groq)",
  mlx: "Local — MacBook GPU (MLX)",
  local: "Local — CPU (faster-whisper)",
};

// Railway closes request bodies that take longer than 5 minutes to upload.
const RAW_UPLOAD_WARN_BYTES = 300 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StageInfo {
  label: string;
  fraction: number | null;
  detail: string | null;
}

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
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [videoHash, setVideoHash] = useState<string>("");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [backend, setBackend] = useState<string>("groq");
  const [query, setQuery] = useState<string>("");
  const [searchResult, setSearchResult] = useState<string>("");
  const [keywords, setKeywords] = useState<string>("");
  const [highlights, setHighlights] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [stage, setStage] = useState<StageInfo | null>(null);
  const hashPromiseRef = useRef<Promise<string> | null>(null);
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    getHealth()
      .then((info) => {
        setHealth(info);
        if (info.default_backend) setBackend(info.default_backend);
      })
      .catch(() => setHealth(null));
  }, []);

  const serverReady = health !== null && health.ok;
  const backendChoices = health?.available_backends ?? [];

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

  const handleUpload = async () => {
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

  const handleSearch = async () => {
    if (!query) {
      toast({
        title: "Empty search query",
        description: "Please enter a search term.",
        variant: "destructive",
      });
      return;
    }
    
    if (transcript.length === 0 || !videoHash) {
      toast({
        title: "No data available",
        description: "Please upload and process a video first.",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const data = await searchTranscript(query, videoHash);
      setSearchResult(data.result);
      toast({
        title: "Search completed",
        description: "Search results are now available.",
      });
    } catch (error) {
      console.error("Search failed", error);
      toast({
        title: "Search failed",
        description: "There was an error processing your search query.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleHighlightSearch = async () => {
    if (!keywords) {
      toast({
        title: "No keywords provided",
        description: "Please enter keywords to highlight.",
        variant: "destructive",
      });
      return;
    }
    
    if (transcript.length === 0) {
      toast({
        title: "No transcript available",
        description: "Please upload and process a video first.",
        variant: "destructive",
      });
      return;
    }
    
    setLoading(true);
    try {
      const response = await api.post("/highlights", {
        transcript,
        keywords: keywords.split(",").map((k) => k.trim()),
      });
      setHighlights(response.data.highlights);
      toast({
        title: "Highlights generated",
        description: "Keyword highlights are now available.",
      });
    } catch (error) {
      console.error("Highlight search failed", error);
      toast({
        title: "Highlight search failed",
        description: "There was an error processing your highlight request.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
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
          <Button 
            variant="outline" 
            size="icon" 
            onClick={toggleTheme} 
            className="rounded-full bg-white/10 hover:bg-white/20 text-white"
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-7 gap-6">
          {/* Left column - 3 panels */}
          <div className="md:col-span-3 space-y-6">
            {/* Video Upload Panel - Top Left */}
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
                      onChange={handleFileChange}
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
                        onChange={(e) => setBackend(e.target.value)}
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
                      Server unreachable — check that the API is running.
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
                    onClick={handleUpload}
                    disabled={loading || !serverReady}
                    className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
                  >
                    {loading ? (stage ? stage.label : "Processing...") : "Process Video"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Transcript Search Panel - Middle Left */}
            <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
              <CardHeader className="pb-2">
                <CardTitle className="text-xl flex items-center gap-2">
                  <Search className="h-5 w-5" /> Transcript Search
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <Input
                    placeholder="Search in video transcript..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={transcript.length === 0 && loading}
                  />
                  <Button
                    onClick={handleSearch}
                    disabled={loading || transcript.length === 0}
                    className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
                  >
                    Search Transcript
                  </Button>
                  {transcript.length === 0 ? (
                    <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
                      <p className="text-gray-500 dark:text-gray-400 text-center">
                        Upload and process a video first to enable search
                      </p>
                    </div>
                  ) : searchResult ? (
                    <div className="border rounded-md p-3 bg-gray-50 dark:bg-gray-700 max-h-[200px] overflow-y-auto">
                      <p className="text-gray-700 dark:text-gray-200 whitespace-pre-line">{searchResult}</p>
                    </div>
                  ) : (
                    <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
                      <p className="text-gray-500 dark:text-gray-400 text-center">
                        Enter a search term and click Search
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Highlights Panel - Bottom Left */}
            <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
              <CardHeader className="pb-2">
                <CardTitle className="text-xl flex items-center gap-2">
                  <ListFilter className="h-5 w-5" /> Keyword Highlights
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <Input
                    placeholder="Enter keywords (comma-separated)..."
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    disabled={transcript.length === 0 && loading}
                  />
                  <Button
                    onClick={handleHighlightSearch}
                    disabled={loading || transcript.length === 0}
                    className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
                  >
                    Find Highlights
                  </Button>
                  {transcript.length === 0 ? (
                    <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
                      <p className="text-gray-500 dark:text-gray-400 text-center">
                        Upload and process a video first to enable highlights
                      </p>
                    </div>
                  ) : highlights.length > 0 ? (
                    <div className="border rounded-md p-3 bg-gray-50 dark:bg-gray-700 max-h-[200px] overflow-y-auto">
                      {highlights.map((highlight, index) => (
                        <div key={index} className="mb-2 last:mb-0 pb-2 border-b border-gray-200 dark:border-gray-600 last:border-b-0">
                          <p className="text-gray-700 dark:text-gray-200">
                            <span className="text-sm font-medium text-purple-600 dark:text-purple-400">
                            {Math.floor(highlight.start / 60)}:{(highlight.start % 60).toFixed(2).padStart(5, '0')} - {Math.floor(highlight.end / 60)}:{(highlight.end % 60).toFixed(2).padStart(5, '0')}
                            </span>{" "}
                            {highlight.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
                      <p className="text-gray-500 dark:text-gray-400 text-center">
                        Enter keywords to find relevant segments
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right column - Summary Panel */}
          <Card className="md:col-span-4 shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90 h-full flex flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="text-xl flex items-center gap-2">
                <PlayCircle className="h-5 w-5" /> Video Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-grow flex flex-col">
              {summary ? (
                <Textarea
                value={`BRIEF SUMMARY:
${summary.short}

------------------------------------------------------------
DETAILED SUMMARY:

${summary.detailed}`}
                readOnly
                className="resize-none flex-grow bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200 p-2 border rounded-md"
              />
              ) : (
                <div className="flex flex-col items-center justify-center flex-grow border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
                  <p className="text-gray-500 dark:text-gray-400 text-center">
                    Upload and process a video to generate a summary
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Index;

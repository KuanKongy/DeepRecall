import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlignLeft, ChevronDown, Copy, Download, RotateCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import type { Summary, TranscriptSegment } from "@/lib/api";
import { fmtTime } from "@/lib/fmtTime";
import { downloadFile, transcriptToSrt, transcriptToTxt } from "@/lib/exportTranscript";

type ResultsTab = "brief" | "detailed" | "transcript";

interface ResultsPanelProps {
  transcript: TranscriptSegment[];
  summary: Summary | null;
  currentTime: number;
  onSeek: (seconds: number) => void;
  onRegenerate: () => void;
  regenerating: boolean;
}

const TS_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

// Turn [mm:ss] / [h:mm:ss] stamps into links a custom renderer intercepts,
// so Key moments in the detailed summary seek the player.
function linkifyTimestamps(markdown: string): string {
  return markdown.replace(TS_RE, (_match, stamp: string) => `[${stamp}](#seek-${stamp})`);
}

function parseSeek(href: string): number | null {
  const stamp = href.replace("#seek-", "");
  const parts = stamp.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function summaryToMd(summary: Summary): string {
  return `## Brief summary\n\n${summary.short}\n\n## Detailed summary\n\n${summary.detailed}\n`;
}

// The summaries are the headline result; the transcript is the sub-feature
// behind the third tab. All three share one card and its inner scroll window.
const ResultsPanel = ({
  transcript,
  summary,
  currentTime,
  onSeek,
  onRegenerate,
  regenerating,
}: ResultsPanelProps) => {
  const [tab, setTab] = useState<ResultsTab>("brief");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { toast } = useToast();
  const hasTranscript = transcript.length > 0;
  const summaryReady = Boolean(summary?.short || summary?.detailed);
  // Default to Brief, but never show an empty summary tab while only the
  // transcript exists (derived, so a later summary flips back to Brief).
  const effectiveTab: ResultsTab = !summaryReady && tab !== "transcript" && hasTranscript
    ? "transcript"
    : tab;

  const activeIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < transcript.length; i++) {
      if (transcript[i].start <= currentTime) index = i;
      else break;
    }
    return index;
  }, [transcript, currentTime]);

  const copyActive = async () => {
    try {
      const text =
        effectiveTab === "transcript"
          ? transcriptToTxt(transcript)
          : effectiveTab === "brief"
            ? summary?.short ?? ""
            : summary?.detailed ?? "";
      await navigator.clipboard.writeText(text);
      toast({ title: effectiveTab === "transcript" ? "Transcript copied" : "Summary copied" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const tabButton = (value: ResultsTab, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setTab(value)}
      className={`inline-flex h-8 items-center rounded-md px-2.5 text-sm transition-colors ${
        effectiveTab === value
          ? "bg-purple-600 text-white dark:bg-purple-800"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
      }`}
    >
      {label}
    </button>
  );

  const activeMarkdown = effectiveTab === "brief" ? summary?.short : summary?.detailed;
  const windowClass =
    "flex-1 min-h-0 max-h-[45vh] md:max-h-none overflow-y-auto rounded-md border bg-gray-50 p-3 dark:bg-gray-700";

  return (
    <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90 flex flex-col h-full">
      <CardHeader className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <CardTitle className="text-lg flex items-center gap-2 cursor-help">
                <AlignLeft className="h-5 w-5" /> Video Summary
              </CardTitle>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              AI summaries of the video, plus the full timestamped transcript.
              Click any timestamp to jump the video there.
            </TooltipContent>
          </Tooltip>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {tabButton("brief", "Brief")}
            {tabButton("detailed", "Detailed")}
            {tabButton("transcript", "Transcript")}
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5"
              onClick={copyActive}
              disabled={effectiveTab === "transcript" ? !hasTranscript : !summaryReady}
              title="Copy the current tab"
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2.5"
              onClick={onRegenerate}
              disabled={regenerating || !summaryReady}
              title="Regenerate the summaries (Brief and Detailed)"
            >
              <RotateCw className={`h-4 w-4 ${regenerating ? "animate-spin" : ""}`} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 px-2" title="Download">
                  <Download className="h-4 w-4" />
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!hasTranscript}
                  onSelect={() => downloadFile("transcript.txt", transcriptToTxt(transcript))}
                >
                  Transcript (.txt)
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasTranscript}
                  onSelect={() =>
                    downloadFile("transcript.srt", transcriptToSrt(transcript), "application/x-subrip")
                  }
                >
                  Subtitles (.srt)
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!summaryReady}
                  onSelect={() => summary && downloadFile("summary.md", summaryToMd(summary))}
                >
                  Summary (.md)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0 flex-1 flex flex-col min-h-0">
        {!hasTranscript && !summaryReady ? (
          <div className={`${windowClass} flex flex-col items-center justify-center border-dashed border-gray-300 dark:border-gray-600 bg-transparent dark:bg-transparent min-h-[120px]`}>
            <p className="text-gray-500 dark:text-gray-400 text-center">
              Process a video to see its summary and transcript
            </p>
          </div>
        ) : effectiveTab === "transcript" ? (
          <div ref={containerRef} className={`${windowClass} space-y-1`}>
            {transcript.map((seg, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onSeek(seg.start)}
                className={`flex w-full items-baseline gap-2 rounded-md p-1.5 text-left hover:bg-violet-50 dark:hover:bg-gray-600 ${
                  index === activeIndex ? "bg-violet-100 dark:bg-gray-600" : ""
                }`}
              >
                <span className="shrink-0 text-sm font-medium tabular-nums text-violet-600 dark:text-violet-400">
                  {fmtTime(seg.start)}
                </span>
                <span className="text-sm text-gray-700 dark:text-gray-200">{seg.text}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className={`${windowClass} prose prose-sm dark:prose-invert max-w-none`}>
            <ReactMarkdown
              components={{
                a: ({ href, children }) => {
                  const seconds = href?.startsWith("#seek-") ? parseSeek(href) : null;
                  if (seconds !== null) {
                    return (
                      <button
                        type="button"
                        onClick={() => onSeek(seconds)}
                        className="font-medium text-purple-600 no-underline underline-offset-2 hover:underline dark:text-purple-400"
                      >
                        {children}
                      </button>
                    );
                  }
                  return (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {linkifyTimestamps(activeMarkdown ?? "No summary yet.")}
            </ReactMarkdown>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ResultsPanel;

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlignLeft, Copy, Download, LocateFixed } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TranscriptSegment } from "@/lib/api";
import { fmtTime } from "@/lib/fmtTime";
import { downloadFile, transcriptToSrt, transcriptToTxt } from "@/lib/exportTranscript";

interface TranscriptPanelProps {
  transcript: TranscriptSegment[];
  currentTime: number;
  onSeek: (seconds: number) => void;
}

const TranscriptPanel = ({ transcript, currentTime, onSeek }: TranscriptPanelProps) => {
  const [follow, setFollow] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const { toast } = useToast();

  const activeIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < transcript.length; i++) {
      if (transcript[i].start <= currentTime) index = i;
      else break;
    }
    return index;
  }, [transcript, currentTime]);

  useEffect(() => {
    if (!follow || activeIndex < 0) return;
    const el = itemRefs.current[activeIndex];
    const box = containerRef.current;
    if (el && box) {
      box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 2), behavior: "smooth" });
    }
  }, [activeIndex, follow]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(transcriptToTxt(transcript));
      toast({ title: "Transcript copied" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  return (
    <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <CardTitle className="text-xl flex items-center gap-2 cursor-help">
                <AlignLeft className="h-5 w-5" /> Transcript
              </CardTitle>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Full timestamped transcript — click a line to jump the video there.
            </TooltipContent>
          </Tooltip>
          {transcript.length > 0 && (
            <div className="flex items-center gap-1">
              <Button
                variant={follow ? "default" : "outline"}
                size="sm"
                onClick={() => setFollow((value) => !value)}
                title="Follow playback"
              >
                <LocateFixed className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={copyAll} title="Copy transcript">
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Download .txt"
                onClick={() => downloadFile("transcript.txt", transcriptToTxt(transcript))}
              >
                <Download className="h-4 w-4" /> txt
              </Button>
              <Button
                variant="outline"
                size="sm"
                title="Download .srt subtitles"
                onClick={() =>
                  downloadFile("transcript.srt", transcriptToSrt(transcript), "application/x-subrip")
                }
              >
                <Download className="h-4 w-4" /> srt
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {transcript.length === 0 ? (
          <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
            <p className="text-gray-500 dark:text-gray-400 text-center">
              Process a video to see its transcript
            </p>
          </div>
        ) : (
          <div
            ref={containerRef}
            className="relative max-h-[280px] md:max-h-[320px] overflow-y-auto space-y-1 pr-1"
          >
            {transcript.map((seg, index) => (
              <button
                key={index}
                ref={(el) => { itemRefs.current[index] = el; }}
                type="button"
                onClick={() => onSeek(seg.start)}
                className={`flex w-full items-baseline gap-2 rounded-md p-1.5 text-left hover:bg-purple-50 dark:hover:bg-gray-700 ${
                  index === activeIndex ? "bg-purple-100 dark:bg-gray-600" : ""
                }`}
              >
                <span className="shrink-0 text-sm font-medium tabular-nums text-purple-600 dark:text-purple-400">
                  {fmtTime(seg.start)}
                </span>
                <span className="text-sm text-gray-700 dark:text-gray-200">{seg.text}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TranscriptPanel;

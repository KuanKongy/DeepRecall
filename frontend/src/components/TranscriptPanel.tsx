import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlignLeft } from "lucide-react";
import type { TranscriptSegment } from "@/lib/api";
import { fmtTime } from "@/lib/fmtTime";

interface TranscriptPanelProps {
  transcript: TranscriptSegment[];
  onSeek: (seconds: number) => void;
}

const TranscriptPanel = ({ transcript, onSeek }: TranscriptPanelProps) => (
  <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
    <CardHeader className="pb-2">
      <CardTitle className="text-xl flex items-center gap-2">
        <AlignLeft className="h-5 w-5" /> Transcript
      </CardTitle>
    </CardHeader>
    <CardContent>
      {transcript.length === 0 ? (
        <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
          <p className="text-gray-500 dark:text-gray-400 text-center">
            Process a video to see its transcript
          </p>
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto space-y-1 pr-1">
          {transcript.map((seg, index) => (
            <button
              key={index}
              type="button"
              onClick={() => onSeek(seg.start)}
              className="flex w-full items-baseline gap-2 rounded-md p-1.5 text-left hover:bg-purple-50 dark:hover:bg-gray-700"
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

export default TranscriptPanel;

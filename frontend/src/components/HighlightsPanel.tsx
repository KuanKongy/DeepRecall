import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListFilter } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import type { TranscriptSegment } from "@/lib/api";
import { fmtTime } from "@/lib/fmtTime";

interface HighlightsPanelProps {
  transcript: TranscriptSegment[];
  onSeek: (seconds: number) => void;
}

const HighlightsPanel = ({ transcript, onSeek }: HighlightsPanelProps) => {
  const [keywords, setKeywords] = useState("");
  const [highlights, setHighlights] = useState<TranscriptSegment[]>([]);
  const { toast } = useToast();
  const enabled = transcript.length > 0;

  // A plain substring filter — no server round-trip needed.
  const findHighlights = () => {
    const terms = keywords
      .split(",")
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) {
      toast({
        title: "No keywords provided",
        description: "Please enter keywords to highlight.",
        variant: "destructive",
      });
      return;
    }
    setHighlights(
      transcript.filter((seg) =>
        terms.some((term) => seg.text.toLowerCase().includes(term)),
      ),
    );
  };

  return (
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
            disabled={!enabled}
          />
          <Button
            onClick={findHighlights}
            disabled={!enabled}
            className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
          >
            Find Highlights
          </Button>
          {!enabled ? (
            <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
              <p className="text-gray-500 dark:text-gray-400 text-center">
                Upload and process a video first to enable highlights
              </p>
            </div>
          ) : highlights.length > 0 ? (
            <div className="border rounded-md p-3 bg-gray-50 dark:bg-gray-700 max-h-[240px] overflow-y-auto">
              {highlights.map((highlight, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => onSeek(highlight.start)}
                  className="block w-full text-left mb-2 last:mb-0 pb-2 border-b border-gray-200 dark:border-gray-600 last:border-b-0 hover:bg-purple-50 dark:hover:bg-gray-600 rounded-md p-1"
                >
                  <span className="text-sm font-medium text-purple-600 dark:text-purple-400 mr-2">
                    {fmtTime(highlight.start)} – {fmtTime(highlight.end)}
                  </span>
                  <span className="text-gray-700 dark:text-gray-200">{highlight.text}</span>
                </button>
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
  );
};

export default HighlightsPanel;

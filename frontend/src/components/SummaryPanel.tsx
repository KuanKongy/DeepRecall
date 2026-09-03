import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, PlayCircle } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import type { Summary } from "@/lib/api";

interface SummaryPanelProps {
  summary: Summary | null;
  onSeek: (seconds: number) => void;
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

const SummaryPanel = ({ summary, onSeek }: SummaryPanelProps) => {
  const [tab, setTab] = useState<"brief" | "detailed">("brief");
  const { toast } = useToast();

  const copyActive = async () => {
    if (!summary) return;
    try {
      await navigator.clipboard.writeText(tab === "brief" ? summary.short : summary.detailed);
      toast({ title: "Summary copied" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const tabButton = (value: "brief" | "detailed", label: string) => (
    <button
      type="button"
      onClick={() => setTab(value)}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        tab === value
          ? "bg-purple-600 text-white"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90 flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-xl flex items-center gap-2">
            <PlayCircle className="h-5 w-5" /> Summary
          </CardTitle>
          {summary && (
            <div className="flex items-center gap-1.5">
              {tabButton("brief", "Brief")}
              {tabButton("detailed", "Detailed")}
              <Button variant="outline" size="sm" onClick={copyActive} title="Copy summary">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-grow flex flex-col">
        {summary ? (
          <div className="prose prose-sm dark:prose-invert max-w-none overflow-y-auto max-h-[420px] md:max-h-[560px] pr-1">
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
              {linkifyTimestamps(tab === "brief" ? summary.short : summary.detailed)}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center flex-grow border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4 min-h-[120px]">
            <p className="text-gray-500 dark:text-gray-400 text-center">
              Upload and process a video to generate a summary
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default SummaryPanel;

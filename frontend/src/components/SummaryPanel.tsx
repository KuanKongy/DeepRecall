import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PlayCircle } from "lucide-react";
import type { Summary } from "@/lib/api";

interface SummaryPanelProps {
  summary: Summary | null;
}

const SummaryPanel = ({ summary }: SummaryPanelProps) => (
  <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90 flex flex-col">
    <CardHeader className="pb-2">
      <CardTitle className="text-xl flex items-center gap-2">
        <PlayCircle className="h-5 w-5" /> Video Summary
      </CardTitle>
    </CardHeader>
    <CardContent className="flex-grow flex flex-col">
      {summary ? (
        <div className="space-y-6 overflow-y-auto max-h-[560px] pr-1">
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Brief summary
            </h3>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{summary.short}</ReactMarkdown>
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Detailed summary
            </h3>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{summary.detailed}</ReactMarkdown>
            </div>
          </section>
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

export default SummaryPanel;

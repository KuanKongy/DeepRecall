import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { searchTranscript, type SearchHit } from "@/lib/api";
import { fmtTime } from "@/lib/fmtTime";

interface SearchPanelProps {
  videoHash: string;
  enabled: boolean;
  onSeek: (seconds: number) => void;
}

const SearchPanel = ({ videoHash, enabled, onSeek }: SearchPanelProps) => {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleSearch = async () => {
    if (!query) {
      toast({
        title: "Empty search query",
        description: "Please enter a search term.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      setHits(await searchTranscript(query, videoHash));
    } catch (error) {
      console.error("Search failed", error);
      toast({
        title: "Search failed",
        description: "There was an error processing your search query.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="shadow-lg backdrop-blur-sm bg-white/90 dark:bg-gray-800/90">
      <CardHeader className="pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <CardTitle className="text-xl flex items-center gap-2 cursor-help">
              <Search className="h-5 w-5" /> Transcript Search
            </CardTitle>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Semantic search over the transcript — finds moments by meaning, not just exact words.
          </TooltipContent>
        </Tooltip>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <Input
            placeholder="Search in video transcript..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && enabled && !busy) handleSearch();
            }}
            disabled={!enabled}
          />
          <Button
            onClick={handleSearch}
            disabled={!enabled || busy}
            className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
          >
            {busy ? "Searching..." : "Search Transcript"}
          </Button>
          {!enabled ? (
            <div className="border border-dashed rounded-md border-gray-300 dark:border-gray-600 p-4">
              <p className="text-gray-500 dark:text-gray-400 text-center">
                Upload and process a video first to enable search
              </p>
            </div>
          ) : hits.length > 0 ? (
            <div className="border rounded-md p-3 bg-gray-50 dark:bg-gray-700 max-h-[240px] overflow-y-auto space-y-2">
              {hits.map((hit, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => hit.start !== null && onSeek(hit.start)}
                  className="block w-full text-left rounded-md p-2 hover:bg-purple-50 dark:hover:bg-gray-600"
                >
                  {hit.start !== null && (
                    <span className="text-sm font-medium text-purple-600 dark:text-purple-400 mr-2">
                      {fmtTime(hit.start)}
                    </span>
                  )}
                  <span className="text-gray-700 dark:text-gray-200">{hit.text}</span>
                </button>
              ))}
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
  );
};

export default SearchPanel;

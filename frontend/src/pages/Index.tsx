
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Upload, Search, PlayCircle, ListFilter, Sun, Moon, FileVideo } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useTheme } from "@/components/ThemeProvider";
import axios from "axios";
const SERVER_URL = "https://deeprecall.onrender.com"; //http://127.0.0.1:5000 https://deeprecall.onrender.com

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

const Index = () => {
  const [video, setVideo] = useState<File | null>(null);
  const [summary, setSummary] = useState<any>("");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [embeddings, setEmbeddings] = useState<number[][]>([]);
  const [query, setQuery] = useState<string>("");
  const [searchResult, setSearchResult] = useState<string>("");
  const [keywords, setKeywords] = useState<string>("");
  const [highlights, setHighlights] = useState<TranscriptSegment[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();

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
      toast({
        title: "Video selected",
        description: `${file.name} is ready to be uploaded.`,
      });
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
    const formData = new FormData();
    formData.append("file", video);
    
    try {
      console.log("Uploading video...");
      const response = await axios.post(SERVER_URL+"/process_video", formData);
      console.log(response.data);
      setSummary(response.data.summary);
      setTranscript(response.data.transcript);
      setEmbeddings(response.data.embeddings);
      setLoading(false);
      toast({
        title: "Video processed successfully",
        description: "Your video has been analyzed and the results are ready.",
      });

    } catch (error) {
      console.error("Upload failed", error);
      setLoading(false);
      toast({
        title: "Upload failed",
        description: "There was an error processing your video.",
        variant: "destructive",
      });
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
    
    if (transcript.length === 0 || embeddings.length === 0) {
      toast({
        title: "No data available",
        description: "Please upload and process a video first.",
        variant: "destructive",
      });
      return;
    }
    
    setLoading(true);
    try {
      console.log("Requesting search...");
      const response = await axios.post(SERVER_URL+"/search", {
        query,
        search_index: transcript.map((seg) => seg.text),
        embeddings,
      });
      console.log(response.data.result);
      setSearchResult(response.data.result);
      setLoading(false);
      toast({
        title: "Search completed",
        description: "Search results are now available.",
      });

    } catch (error) {
      console.error("Search failed", error);
      setLoading(false);
      toast({
        title: "Search failed",
        description: "There was an error processing your search query.",
        variant: "destructive",
      });
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
      console.log("Requesting highlights...");
      const response = await axios.post(SERVER_URL+"/highlights", {
        transcript,
        keywords: keywords.split(",").map((k) => k.trim())
      });
      console.log(response.data.highlights);
      setHighlights(response.data.highlights);
      setLoading(false);
      toast({
        title: "Highlights generated",
        description: "Keyword highlights are now available.",
      });
    
    } catch (error) {
      console.error("Highlight search failed", error);
      setLoading(false);
      toast({
        title: "Highlight search failed",
        description: "There was an error processing your highlight request.",
        variant: "destructive",
      });
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
                  <Button 
                    onClick={handleUpload} 
                    disabled={loading}
                    className="w-full bg-gradient-to-r from-green-400 to-green-600 hover:from-green-500 hover:to-green-700 text-white"
                  >
                    {loading ? "Processing..." : "Process Video"}
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

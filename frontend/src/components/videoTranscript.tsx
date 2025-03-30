import { useState } from "react";
import { Box, Button, Input, VStack, Textarea, Text } from "@chakra-ui/react";
import axios from "axios";

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export default function VideoTranscriptionApp() {
  const [video, setVideo] = useState<File | null>(null);
  const [summary, setSummary] = useState<string>("");
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [query, setQuery] = useState<string>("");
  const [searchResult, setSearchResult] = useState<string>("");
  const [keywords, setKeywords] = useState<string>("");
  const [highlights, setHighlights] = useState<TranscriptSegment[]>([]);
  
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      setVideo(event.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!video) return;
    const formData = new FormData();
    formData.append("file", video);
    
    try {
      console.log("sending");
      const response = await axios.post("http://127.0.0.1:5000/process_video", formData);
      console.log(response);
      setSummary(response.data.summary);
      setTranscript(response.data.transcript);
    } catch (error) {
      console.error("Upload failed", error);
    }
  };
  
  const handleSearch = async () => {
    if (!query) return;
    try {
      console.log("sending");
      const response = await axios.post("http://127.0.0.1:5000/search", {
        query,
        search_index: transcript.map((seg) => seg.text),
        embeddings: [] // Assuming backend can generate this internally
      });
      console.log(response);
      setSearchResult(response.data.result);
    } catch (error) {
      console.error("Search failed", error);
    }
  };

  const handleHighlightSearch = async () => {
    if (!keywords) return;
    try {
      const response = await axios.post("http://127.0.0.1:5000/highlights", {
        transcript,
        keywords: keywords.split(",").map((k) => k.trim())
      });
      setHighlights(response.data.highlights);
    } catch (error) {
      console.error("Highlight search failed", error);
    }
  };

  return (
    <VStack p={5}>
      <Box w="100%">
        <Input type="file" onChange={handleFileChange} />
        <Button mt={2} colorScheme="blue" onClick={handleUpload}>
          Upload Video
        </Button>
      </Box>
  
      {summary && (
        <Box w="100%" p={4} borderWidth={1} borderRadius="lg">
          <Text fontSize="xl" fontWeight="bold">Summary</Text>
          <Textarea value={summary} readOnly />
        </Box>
      )}
  
      {transcript.length > 0 && (
        <Box w="100%" p={4} borderWidth={1} borderRadius="lg">
          <Text fontSize="xl" fontWeight="bold">Search Transcript</Text>
          <Input placeholder="Enter search term..." value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button mt={2} colorScheme="green" onClick={handleSearch}>
            Search
          </Button>
          <Text mt={2}>{searchResult}</Text>
        </Box>
      )}
  
      {highlights.length > 0 && (
        <Box w="100%" p={4} borderWidth={1} borderRadius="lg">
          <Text fontSize="xl" fontWeight="bold">Keyword Highlights</Text>
          <Input placeholder="Enter keywords (comma-separated)..." value={keywords} onChange={(e) => setKeywords(e.target.value)} />
          <Button mt={2} colorScheme="purple" onClick={handleHighlightSearch}>
            Highlight Keywords
          </Button>
          <VStack mt={2} align="start">
            {highlights.map((highlight, index) => (
              <Text key={index}>{`${highlight.start}s - ${highlight.end}s: ${highlight.text}`}</Text>
            ))}
          </VStack>
        </Box>
      )}
    </VStack>
  );  
}

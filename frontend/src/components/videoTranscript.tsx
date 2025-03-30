import { useState } from "react";
import { Box, Button, Input, VStack, Textarea, Text, Grid, GridItem, Heading } from "@chakra-ui/react";
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
  const [embeddings, setEmbeddings] = useState<number[][]>([]);
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
      console.log("Uploading video...");
      const response = await axios.post("http://127.0.0.1:5000/process_video", formData);
      
      console.log("Response received:", response);
      setSummary(response.data.summary);
      setTranscript(response.data.transcript);
      setEmbeddings(response.data.embeddings);
    } catch (error) {
      console.error("Upload failed", error);
    }
  };
  
  const handleSearch = async () => {
    if (!query) return;
    if (embeddings.length === 0) {
      console.error("Embeddings are missing! Make sure video is processed first.");
      return;
    }

    try {
      console.log("Sending search query...");
      const response = await axios.post("http://127.0.0.1:5000/search", {
        query,
        search_index: transcript.map((seg) => seg.text),
        embeddings,
      });

      console.log("Search response:", response);
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
    <Box p={5} bgGradient="linear(to-r, purple.400, purple.600)" minH="100vh" color="white">
      <Heading textAlign="center" mb={6}>Video Transcription & Search</Heading>
      <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={6}>
        <GridItem colSpan={2} p={5} bg="white" borderRadius="lg" color="black">
          <Input type="file" onChange={handleFileChange} />
          <Button mt={2} colorScheme="purple" onClick={handleUpload} width="full">
            Upload Video
          </Button>
        </GridItem>
        
        {summary && (
          <GridItem p={5} bg="white" borderRadius="lg" color="black">
            <Text fontSize="xl" fontWeight="bold">Summary</Text>
            <Textarea value={summary} readOnly size="lg" />
          </GridItem>
        )}

        {transcript.length > 0 && (
          <GridItem p={5} bg="white" borderRadius="lg" color="black">
            <Text fontSize="xl" fontWeight="bold">Search Transcript</Text>
            <Input placeholder="Enter search term..." value={query} onChange={(e) => setQuery(e.target.value)} />
            <Button mt={2} colorScheme="purple" onClick={handleSearch} width="full">
              Search
            </Button>
            <Text mt={2}>{searchResult}</Text>
          </GridItem>
        )}

        {transcript.length > 0 && (
          <GridItem p={5} bg="white" borderRadius="lg" color="black">
            <Text fontSize="xl" fontWeight="bold">Keyword Highlights</Text>
            <Input placeholder="Enter keywords (comma-separated)..." value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            <Button mt={2} colorScheme="purple" onClick={handleHighlightSearch} width="full">
              Highlight Keywords
            </Button>
            <VStack mt={2} align="start">
              {highlights.map((highlight, index) => (
                <Text key={index}>{`${highlight.start}s - ${highlight.end}s: ${highlight.text}`}</Text>
              ))}
            </VStack>
          </GridItem>
        )}
      </Grid>
    </Box>
  );  
}

import React from "react";
import ReactDOM from "react-dom/client";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import VideoTranscriptionApp from "./components/videoTranscript";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChakraProvider value={defaultSystem}>
      <VideoTranscriptionApp />
    </ChakraProvider>
  </React.StrictMode>
);

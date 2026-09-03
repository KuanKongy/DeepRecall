import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

export interface YouTubeHandle {
  seekTo: (seconds: number) => void;
}

interface YouTubePlayerProps {
  videoId: string;
  onTime?: (seconds: number) => void;
}

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;

function loadIframeApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve(window.YT);
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
  }
  return apiPromise;
}

// Embedded player for URL-processed YouTube videos, so transcript/search
// clicks can still seek even though there is no local file. The iframe is
// built by hand because playVideo() from the parent page only works when the
// frame carries allow="autoplay" — YT.Player's div replacement does not set it.
const YouTubePlayer = forwardRef<YouTubeHandle, YouTubePlayerProps>(
  ({ videoId, onTime }, ref) => {
    const mountRef = useRef<HTMLDivElement | null>(null);
    const playerRef = useRef<any>(null);
    const onTimeRef = useRef(onTime);
    onTimeRef.current = onTime;

    useImperativeHandle(ref, () => ({
      seekTo: (seconds: number) => {
        playerRef.current?.seekTo?.(seconds, true);
        playerRef.current?.playVideo?.();
      },
    }));

    useEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;
      let cancelled = false;
      let interval: number | undefined;

      const iframe = document.createElement("iframe");
      const params = new URLSearchParams({
        enablejsapi: "1",
        playsinline: "1",
        origin: window.location.origin,
      });
      iframe.src = `https://www.youtube.com/embed/${videoId}?${params}`;
      iframe.allow = "autoplay; encrypted-media; picture-in-picture";
      iframe.allowFullscreen = true;
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      iframe.style.border = "0";
      mount.appendChild(iframe);

      loadIframeApi().then((YT) => {
        if (cancelled) return;
        playerRef.current = new YT.Player(iframe);
        interval = window.setInterval(() => {
          const t = playerRef.current?.getCurrentTime?.();
          if (typeof t === "number") onTimeRef.current?.(t);
        }, 1000);
      });

      return () => {
        cancelled = true;
        if (interval) window.clearInterval(interval);
        try { playerRef.current?.destroy?.(); } catch { /* already gone */ }
        playerRef.current = null;
        mount.innerHTML = "";
      };
    }, [videoId]);

    return (
      <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
        <div ref={mountRef} className="h-full w-full" />
      </div>
    );
  },
);

YouTubePlayer.displayName = "YouTubePlayer";

export default YouTubePlayer;

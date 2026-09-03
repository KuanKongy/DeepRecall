import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Settings } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { DEFAULT_API, loadSettings, saveSettings } from "@/lib/api";

interface SettingsPopoverProps {
  onSaved: () => void;
}

// Lets the hosted UI target a different backend — e.g. http://localhost:10000
// for the Mac GPU mode — and stores the shared API password.
const SettingsPopover = ({ onSaved }: SettingsPopoverProps) => {
  const [open, setOpen] = useState(false);
  const [apiUrl, setApiUrl] = useState("");
  const [password, setPassword] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      const settings = loadSettings();
      setApiUrl(settings.apiUrl);
      setPassword(settings.password);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const handleSave = () => {
    saveSettings({ apiUrl: apiUrl.trim().replace(/\/+$/, "") || DEFAULT_API, password });
    setOpen(false);
    toast({ title: "Settings saved", description: "API settings updated." });
    onSaved();
  };

  return (
    <div className="relative" ref={panelRef}>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen((value) => !value)}
        className="rounded-full bg-white/10 hover:bg-white/20 text-white"
        aria-label="API settings"
      >
        <Settings className="h-5 w-5" />
      </Button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-white p-4 shadow-lg dark:border-gray-600 dark:bg-gray-800">
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm text-gray-700 dark:text-gray-300" htmlFor="api-url">
                Server URL
              </label>
              <Input
                id="api-url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={DEFAULT_API}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm text-gray-700 dark:text-gray-300" htmlFor="api-password">
                Password
              </label>
              <Input
                id="api-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="X-App-Password"
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSave} className="flex-1">
                Save
              </Button>
              <Button
                variant="outline"
                onClick={() => setApiUrl(DEFAULT_API)}
                className="flex-1"
              >
                Reset URL
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPopover;

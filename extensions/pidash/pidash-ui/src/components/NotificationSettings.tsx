import { Bell, BellOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { NotificationPreferences } from "@/types";

interface Props {
  permission: NotificationPermission;
  supported: boolean;
  preferences: NotificationPreferences;
  setPreference: <K extends keyof NotificationPreferences>(key: K, value: boolean) => void;
  requestPermission: () => void;
}

const PREF_LABELS: Record<keyof NotificationPreferences, string> = {
  turnComplete: "AI turn complete",
  agentComplete: "Agent complete",
  testResults: "Test results",
  sessionError: "Session errors",
  toolComplete: "Tool execution (noisy)",
  inputNeeded: "Input needed (ask_user)",
};

export function NotificationSettings({ permission, supported, preferences, setPreference, requestPermission }: Props) {
  if (!supported) return null;

  const active = permission === "granted";

  return (
    <div className="relative inline-block">
      <Popover>
        <PopoverTrigger className={cn(
          "cursor-pointer flex items-center gap-1 text-xs transition-colors",
          active ? "text-primary hover:text-primary/80" : "text-muted-foreground/50 hover:text-muted-foreground"
        )}>
          {active ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
        </PopoverTrigger>
        <PopoverContent className="w-56" side="bottom">
          <div className="text-xs space-y-2">
            <div className="font-bold text-foreground">Notifications</div>

            {permission === "default" && (
              <button
                onClick={requestPermission}
                className="w-full px-2 py-1.5 rounded text-sm bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Enable Notifications
              </button>
            )}

            {permission === "denied" && (
              <div className="text-muted-foreground py-1">
                Notifications blocked. Enable in browser settings.
              </div>
            )}

            {permission === "granted" && (
              <div className="space-y-1.5">
                {(Object.keys(PREF_LABELS) as Array<keyof NotificationPreferences>).map((key) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer hover:text-foreground transition-colors">
                    <input
                      type="checkbox"
                      checked={preferences[key]}
                      onChange={(e) => setPreference(key, e.target.checked)}
                      className="rounded border-border accent-primary"
                    />
                    <span>{PREF_LABELS[key]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

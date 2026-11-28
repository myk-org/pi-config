import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyTextInBrowser } from "@/lib/worktrees-panel-helpers";

interface CopyButtonProps {
  text: string;
  label?: string;
  title?: string;
  className?: string;
  onCopied?: () => void;
}

/** Visible one-click Copy button shared across PiDash parity panels (#1481). */
export function CopyButton({ text, label = "Copy", title, className, onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const ok = await copyTextInBrowser(text);
    if (!ok) return;
    setCopied(true);
    onCopied?.();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, 1500);
  };

  return (
    <button
      type="button"
      title={title ?? `Copy ${label.toLowerCase()}`}
      aria-label={title ?? label}
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0",
        copied && "text-green-600 dark:text-green-400 border-green-500/40",
        className,
      )}
    >
      {copied ? <Check className="h-2.5 w-2.5 shrink-0" /> : <Copy className="h-2.5 w-2.5 shrink-0" />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

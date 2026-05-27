import * as React from "react";
import * as ReactDOM from "react-dom";
import { cn } from "@/lib/utils";

interface PopoverProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const PopoverContext = React.createContext<{
  open: boolean;
  setOpen: (v: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}>({ open: false, setOpen: () => {}, triggerRef: { current: null } });

export function Popover({ children, open: controlledOpen, onOpenChange }: PopoverProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  return <PopoverContext.Provider value={{ open, setOpen, triggerRef }}>{children}</PopoverContext.Provider>;
}

export function PopoverTrigger({ children, className }: { children: React.ReactNode; className?: string; asChild?: boolean }) {
  const { open, setOpen, triggerRef } = React.useContext(PopoverContext);
  return (
    <button ref={triggerRef} className={className} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} type="button">
      {children}
    </button>
  );
}

export function PopoverContent({ children, className, side = "top" }: { children: React.ReactNode; className?: string; align?: string; side?: "top" | "bottom" }) {
  const { open, setOpen, triggerRef } = React.useContext(PopoverContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  const updatePosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    const popover = ref.current;
    if (!trigger || !popover) return;

    const rect = trigger.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();

    // Align right edge of popover with right edge of trigger
    let left = rect.right - popRect.width;
    // Clamp so it doesn't overflow left or right edge of viewport
    left = Math.max(4, Math.min(left, window.innerWidth - popRect.width - 4));

    let top: number;
    if (side === "top") {
      top = rect.top - popRect.height - 8;
      // If it would go above viewport, flip to bottom
      if (top < 4) top = rect.bottom + 8;
    } else {
      top = rect.bottom + 8;
      // If it would go below viewport, flip to top
      if (top + popRect.height > window.innerHeight - 4) top = rect.top - popRect.height - 8;
    }

    setPos({ top, left });
  }, [triggerRef, side]);

  // Position calculation: run after mount and on scroll/resize
  React.useEffect(() => {
    if (!open) return;
    // Initial position after the portal element mounts
    requestAnimationFrame(updatePosition);

    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  // Click-outside-to-close
  React.useEffect(() => {
    if (!open) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 10);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [open, setOpen, triggerRef]);

  if (!open) return null;

  const content = (
    <div
      ref={ref}
      style={pos ? { position: "fixed", top: pos.top, left: pos.left } : { position: "fixed", top: -9999, left: -9999 }}
      className={cn("z-[9999] rounded-md border border-border bg-popover p-2 shadow-lg", className)}
    >
      {children}
    </div>
  );

  return ReactDOM.createPortal(content, document.body);
}

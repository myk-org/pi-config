import * as React from "react";
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

  React.useEffect(() => {
    if (!open) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // Don't close if clicking inside popover or on trigger
      if (ref.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };

    // Delay adding listener to avoid catching the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 10);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [open, setOpen, triggerRef]);

  if (!open) return null;
  return (
    <div ref={ref} className={cn("absolute right-0 z-50 rounded-md border border-border bg-popover p-2 shadow-lg", side === "top" ? "bottom-full mb-2" : "top-full mt-2", className)}>
      {children}
    </div>
  );
}

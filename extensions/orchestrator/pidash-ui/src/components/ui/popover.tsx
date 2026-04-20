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
}>({ open: false, setOpen: () => {} });

export function Popover({ children, open: controlledOpen, onOpenChange }: PopoverProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  return <PopoverContext.Provider value={{ open, setOpen }}>{children}</PopoverContext.Provider>;
}

export function PopoverTrigger({ children, className, asChild }: { children: React.ReactNode; className?: string; asChild?: boolean }) {
  const { open, setOpen } = React.useContext(PopoverContext);
  return (
    <button className={className} onClick={() => setOpen(!open)} type="button">
      {children}
    </button>
  );
}

export function PopoverContent({ children, className, align }: { children: React.ReactNode; className?: string; align?: string }) {
  const { open, setOpen } = React.useContext(PopoverContext);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    // Delay to avoid catching the trigger click
    const timer = setTimeout(() => {
      const handler = (e: MouseEvent) => {
        if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, 50);
    return () => clearTimeout(timer);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div ref={ref} className={cn("absolute bottom-full mb-2 right-0 z-50 rounded-md border border-border bg-popover p-2 shadow-lg", className)}>
      {children}
    </div>
  );
}

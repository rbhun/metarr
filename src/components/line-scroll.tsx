import { cn } from "@/lib/utils";

export function LineScroll({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("max-h-16 space-y-0.5 overflow-y-auto overscroll-contain [scrollbar-width:thin]", className)}>
      {children}
    </div>
  );
}

/** Fixed-height scroller for table cells. Absolute fill stops the row from growing with the list. */
export function CellScroll({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative h-16 w-full", className)}>
      <div className="absolute inset-0 space-y-0.5 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
        {children}
      </div>
    </div>
  );
}

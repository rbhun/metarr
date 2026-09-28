"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReactElement } from "react";

export function SourceHover({ text, children }: { text?: string | null; children: ReactElement }) {
  if (!text) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="block max-w-xs whitespace-pre-line text-left">{text}</TooltipContent>
    </Tooltip>
  );
}

const unknownClass = "text-red-700 dark:text-red-400";

export function MarkedText({ text }: { text: string }) {
  const parts = text.split(/(Unknown)/g);
  return parts.map((part, index) =>
    part === "Unknown" ? (
      <span key={index} className={unknownClass}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export function UnknownLabel() {
  return <span className={unknownClass}>Unknown</span>;
}

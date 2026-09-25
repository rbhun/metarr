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

export function UnknownLabel({ onClick }: { onClick?: () => void }) {
  if (!onClick) return <span className={unknownClass}>Unknown</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Detect this language now"
      className={`${unknownClass} cursor-pointer border-0 bg-transparent p-0 font-inherit underline decoration-dotted underline-offset-2 hover:decoration-solid`}
    >
      Unknown
    </button>
  );
}

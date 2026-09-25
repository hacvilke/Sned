"use client";

import { useCallback, useRef, useState } from "react";
import { collectDroppedFiles, entriesFromInput, type DroppedFile } from "@/lib/dropfiles";
import { formatBytes } from "@/lib/format";

export function DropZone({
  onFiles,
  effectiveMaxFileBytes,
}: {
  onFiles: (files: DroppedFile[]) => void;
  effectiveMaxFileBytes: number;
}) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!event.dataTransfer) return;
      const collected = await collectDroppedFiles(event.dataTransfer);
      if (collected.length > 0) onFiles(collected);
    },
    [onFiles],
  );

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={handleDrop}
      className={`rounded border-2 border-dashed bg-surface px-6 py-10 text-center transition-colors sm:py-14 ${
        dragging ? "border-brand bg-brand-soft" : "border-line-strong"
      }`}
    >
      <svg
        width="30"
        height="30"
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="mx-auto mb-3 text-faint"
      >
        <path
          d="M12 3.5 6.6 8.9l1.4 1.4 3-3V17h2V7.3l3 3 1.4-1.4L12 3.5Z"
          fill="currentColor"
        />
        <path d="M4 18.5v2h16v-2H4Z" fill="currentColor" />
      </svg>

      <p className="text-[15px] font-medium text-ink">Drag files or folders here</p>
      <p className="mt-1 text-[13px] text-muted">
        Up to {formatBytes(effectiveMaxFileBytes, 0)} per file. Anything a file system allows.
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className="rounded bg-brand px-4 py-2 text-[13px] font-medium text-white hover:bg-brand-dark"
        >
          Choose files
        </button>
        <button
          type="button"
          onClick={() => folderInput.current?.click()}
          className="rounded border border-line-strong bg-surface px-4 py-2 text-[13px] font-medium text-ink hover:bg-surface-alt"
        >
          Choose folder
        </button>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          const collected = entriesFromInput(event.currentTarget);
          if (collected.length > 0) onFiles(collected);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        // @ts-expect-error non-standard attribute, ignored by browsers that lack it
        webkitdirectory=""
        directory=""
        className="sr-only"
        onChange={(event) => {
          const collected = entriesFromInput(event.currentTarget);
          if (collected.length > 0) onFiles(collected);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}

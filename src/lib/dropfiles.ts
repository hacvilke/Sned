/**
 * Flatten a drop event into a list of files with relative paths, walking into
 * dropped folders when the browser exposes the FileSystem entry API.
 */

export type DroppedFile = { file: File; path: string };

export async function collectDroppedFiles(transfer: DataTransfer): Promise<DroppedFile[]> {
  const items = transfer.items;
  if (!items || typeof items[0]?.webkitGetAsEntry !== "function") {
    return Array.from(transfer.files).map((file) => ({ file, path: file.name }));
  }

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i].webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    return Array.from(transfer.files).map((file) => ({ file, path: file.name }));
  }

  const out: DroppedFile[] = [];
  for (const entry of entries) await walk(entry, "", out);
  return out;
}

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedFile[],
  depth = 0,
): Promise<void> {
  // Guard against symlink loops / pathological trees.
  if (depth > 12) return;

  if (entry.isFile) {
    const file = await toFile(entry as FileSystemFileEntry);
    if (file) out.push({ file, path: prefix + file.name });
    return;
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for await (const child of readAll(reader)) {
      await walk(child, `${prefix}${entry.name}/`, out, depth + 1);
    }
  }
}

/** DirectoryReader returns entries in pages; keep reading until it is empty. */
async function* readAll(reader: FileSystemDirectoryReader): AsyncGenerator<FileSystemEntry> {
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return;
    for (const entry of batch) yield entry;
  }
}

function toFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file((file) => resolve(file), () => resolve(null));
  });
}

export function entriesFromInput(input: HTMLInputElement): DroppedFile[] {
  const files = Array.from(input.files ?? []);
  return files.map((file) => ({
    file,
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

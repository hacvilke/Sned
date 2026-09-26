/**
 * File System Access API bits that TypeScript's lib.dom does not declare yet.
 * Chromium browsers expose `showSaveFilePicker`; everything else falls back to
 * buffering in memory and triggering a normal download.
 */

interface SaveFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  excludeAcceptAllOption?: boolean;
  types?: SaveFilePickerAcceptType[];
  id?: string;
  startIn?: string;
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
}

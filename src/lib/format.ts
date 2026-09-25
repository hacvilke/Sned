/** Human-friendly formatting helpers shared by server and client. */

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  const digits = i === 0 ? 0 : value >= 100 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "any moment";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Collapse a path to a single safe path segment-ish value for Blob storage.
 * Keeps the extension, strips anything that could escape the prefix.
 */
export function sanitizeName(name: string, fallback = "file"): string {
  const base = (name || "").replace(/[\u0000-\u001f\u007f]/g, "");
  const last = base.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const cleaned = last
    .replace(/[^\w.\-+() [\]{}=@#$%&',;~]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 180) || fallback;
}

export function extensionOf(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

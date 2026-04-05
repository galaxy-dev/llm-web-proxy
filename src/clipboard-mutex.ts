// Shared clipboard mutex for Playwright page interactions.
//
// Prevents concurrent long-text pastes across all providers from overwriting
// each other's clipboard content. Without this, parallel sessions using
// different providers would silently corrupt clipboard data.
// Includes a safety timeout to prevent indefinite queue stalls.

const CLIPBOARD_TIMEOUT_MS = 30_000;

let clipboardLocked = false;
const clipboardQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

export async function acquireClipboard(): Promise<void> {
  if (!clipboardLocked) {
    clipboardLocked = true;
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const entry = { resolve, reject };
    const timer = setTimeout(() => {
      const idx = clipboardQueue.indexOf(entry);
      if (idx >= 0) clipboardQueue.splice(idx, 1);
      reject(new Error("Clipboard lock timeout — another paste may be stuck"));
    }, CLIPBOARD_TIMEOUT_MS);

    entry.resolve = () => {
      clearTimeout(timer);
      resolve();
    };
    clipboardQueue.push(entry);
  });
}

export function releaseClipboard(): void {
  const next = clipboardQueue.shift();
  if (next) {
    next.resolve();
  } else {
    clipboardLocked = false;
  }
}

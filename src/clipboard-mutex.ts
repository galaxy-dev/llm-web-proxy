// Shared clipboard mutex for Playwright page interactions.
//
// Prevents concurrent long-text pastes across all providers from overwriting
// each other's clipboard content. Without this, parallel sessions using
// different providers would silently corrupt clipboard data.

let clipboardLocked = false;
const clipboardQueue: Array<() => void> = [];

export async function acquireClipboard(): Promise<void> {
  if (!clipboardLocked) {
    clipboardLocked = true;
    return;
  }
  return new Promise<void>((resolve) => {
    clipboardQueue.push(resolve);
  });
}

export function releaseClipboard(): void {
  const next = clipboardQueue.shift();
  if (next) {
    next();
  } else {
    clipboardLocked = false;
  }
}

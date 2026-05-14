/**
 * Utility to lock/unlock the document body based on a set of keys.
 * Each key can "lock" the body (e.g., prevent scrolling), and the lock is only released when all keys are removed.
 *
 * @param {string} key - Unique identifier for the lock (e.g., component name or id)
 * @param {'lock'|'unlock'} action - Whether to lock or unlock
 * @param {(locked: boolean) => void} [onLockChange] - Optional callback when lock state changes
 */
const activeLocks = new Set<string>();

export function lockBody(
  key: string,
  action: boolean,
  onLockChange?: (locked: boolean) => void,
) {
  if (action) {
    activeLocks.add(key);
  } else {
    activeLocks.delete(key);
  }

  const shouldLock = activeLocks.size > 0;
  document.body.classList.toggle("overflow-hidden", shouldLock);
  if (onLockChange) onLockChange(shouldLock);
}

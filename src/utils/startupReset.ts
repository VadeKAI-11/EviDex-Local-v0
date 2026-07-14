import { resetBackendData } from "../api/backend-api";

const STARTUP_RESET_VERSION = "evidex-startup-reset-v1";

const PRESERVE_LOCAL_KEYS = new Set<string>([
  "evidex-theme",
]);

function clearPrefixedStorage(storage: Storage, preserveKeys: Set<string>) {
  const keysToRemove: string[] = [];

  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key) {
      continue;
    }

    if (key.startsWith("evidex-") && !preserveKeys.has(key)) {
      keysToRemove.push(key);
    }
  }

  for (const key of keysToRemove) {
    storage.removeItem(key);
  }
}

export function runStartupReset() {
  try {
    if (localStorage.getItem(STARTUP_RESET_VERSION) === "done") {
      return;
    }

    clearPrefixedStorage(localStorage, PRESERVE_LOCAL_KEYS);
    clearPrefixedStorage(sessionStorage, new Set<string>());

    localStorage.setItem(STARTUP_RESET_VERSION, "done");
  } catch {
    // Keep app boot resilient if storage access is blocked.
  }
}

export async function forceResetAppData() {
  try {
    // 1. Reset backend
    try {
      await resetBackendData();
    } catch (err) {
      console.warn("Backend reset failed during forced cleanup:", err);
      // Continue with local cleanup anyway
    }

    // 2. Clear local storage
    clearPrefixedStorage(localStorage, PRESERVE_LOCAL_KEYS);
    clearPrefixedStorage(sessionStorage, new Set<string>());
    
    // Mark as done so startup sync doesn't loop (though reload handles it)
    localStorage.setItem(STARTUP_RESET_VERSION, "done");
    
    // 3. Reload
    window.location.reload();
  } catch {
    // Fallback if storage or reload fails.
  }
}

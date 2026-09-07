import type { AppSettings, PersistMode } from "../types";

const SETTINGS_KEY = "failure-analyzer:settings";

const DEFAULT_SETTINGS: AppSettings = {
  amplifyBaseUrl: "https://amplify.planittesting.com/openai",
  amplifyApiKey: "",
  amplifyModel: "gpt-5.4-opencode",
  githubToken: "",
  storageMode: "session",
};

function getStorage(mode: PersistMode): Storage {
  return mode === "local" ? localStorage : sessionStorage;
}

export function loadSettings(): AppSettings {
  const localValue = localStorage.getItem(SETTINGS_KEY);
  const sessionValue = sessionStorage.getItem(SETTINGS_KEY);
  const raw = localValue ?? sessionValue;
  if (!raw) {
    return DEFAULT_SETTINGS;
  }

  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as AppSettings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.removeItem(SETTINGS_KEY);
  sessionStorage.removeItem(SETTINGS_KEY);
  getStorage(settings.storageMode).setItem(SETTINGS_KEY, JSON.stringify(settings));
}

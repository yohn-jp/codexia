export const CONSOLE_NAVIGATION_REQUEST = "codexia:console-navigation-request";

/** Requests guarded navigation from the persistence entry's registered editor protector. */
export function requestConsoleNavigation(): void {
  window.dispatchEvent(new Event(CONSOLE_NAVIGATION_REQUEST));
}

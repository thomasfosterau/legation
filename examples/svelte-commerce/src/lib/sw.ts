/** Register the service worker (progressive enhancement — optional). */
export const registerServiceWorker = (): void => {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/service-worker.js").catch(() => undefined);
  }
};

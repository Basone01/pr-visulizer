// Replaces @openuidev/devtools (Vite alias in vite.config.ts). react-lang auto-mounts the devtools
// in development, and the real package then imports
// https://cdn.jsdelivr.net/npm/@openuidev/devtools@0/dist/devtools.browser.js into the webview.
// The stub renders nothing, so no remote JavaScript is ever loaded.
export function OpenUIDevtools(): null {
  return null
}

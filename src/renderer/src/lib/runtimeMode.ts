export const isBrowserHeadlessMode = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as any).__CHAT2API_BROWSER_MODE)
}

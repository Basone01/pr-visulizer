// Shared defaults for ReviewTray's submit-feedback and sync props, so a test that is about
// something else (the Approve guard, the deep-mode rows) states only what it actually cares
// about. Every value here is the "nothing happening yet" state.
export const IDLE_SUBMIT_PROPS = {
  commentCount: 0,
  isSubmitting: false,
  isSubmitted: false,
  submitError: null,
  onResetSubmit: () => {},
  viewedSyncError: null,
  // No commit range selected — every row renders normally (§10).
  rangeTouchedPaths: null,
} as const

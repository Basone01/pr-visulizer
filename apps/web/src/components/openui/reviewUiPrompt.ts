import { reviewLibrary, reviewPromptOptions } from "./reviewLibrary"

// The system-prompt text that teaches the agent the review component library.
// Dynamic-import target: importing it pulls the OpenUI library, so keep it off the eager path.
export function buildReviewUiPrompt(): string {
  return reviewLibrary.prompt(reviewPromptOptions)
}

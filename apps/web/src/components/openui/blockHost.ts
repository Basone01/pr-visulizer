import { createContext } from "react"

// What a block's components may ask the host to do. OpenUiBlock provides it,
// FileRef, links and action controls consume it. The components only report the click.
export type BlockHost = {
  // Whether openFile can open this path (a file of the PR). Paths are normalized first.
  canOpenFile: (path: string) => boolean
  openFile: (path: string, line: number | undefined) => void
  // A markdown link was clicked: open the URL it shows (https only).
  openShownLink: (url: string) => void
  // A Button or ListItem is about to dispatch its action: the one URL it shows may open.
  armActionLink: (url: string | null) => void
}

export const BlockHostContext = createContext<BlockHost>({
  canOpenFile: () => false,
  openFile: () => {},
  openShownLink: () => {},
  armActionLink: () => {},
})

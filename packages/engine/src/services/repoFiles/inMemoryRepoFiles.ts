import type { RepoFiles } from "./repoFiles.js"

// An in-memory RepoFiles backed by a path → content map (docs/architecture.md §6). Used
// by the deep-engine tests as the checkout stand-in, and handy for desktop dev. Mirrors
// the fake GithubGateway: the same interface the real (git-checkout) provider implements,
// so nothing upstream knows which one it holds. `readFile` rejects on an unknown path so
// the reader's defensive skip path is exercisable.
export function createInMemoryRepoFiles(files: Record<string, string>): RepoFiles {
  const store = new Map(Object.entries(files))

  return {
    async listFiles(): Promise<string[]> {
      return [...store.keys()]
    },

    async readFile(path: string): Promise<string> {
      const content = store.get(path)
      if (content === undefined) throw new Error(`no in-memory file at ${path}`)

      return content
    },
  }
}

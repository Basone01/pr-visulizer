import type { PrTarget } from "@/entity/pr"

// GitHub anchors every file in a PR's "Files changed" tab as `#diff-<sha256hex(path)>` — the
// SHA-256 of the exact repo path string, with NO trailing newline. Verified against GitHub
// community discussion #43908 and reproduced locally: sha256("src/index.js") ===
// "bfe9874d239014961b1ae4e89875a6155667db834a410aaaa2ebe3cf89820556". So we jump the reviewer
// straight to the file's diff, not just the PR.
async function fileDiffAnchor(path: string): Promise<string> {
  const bytes = new TextEncoder().encode(path)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

  return `diff-${hex}`
}

export function githubPrUrl(target: PrTarget): string {
  return `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`
}

export async function githubPrFileUrl(target: PrTarget, path: string): Promise<string> {
  const anchor = await fileDiffAnchor(path)

  return `${githubPrUrl(target)}/files#${anchor}`
}

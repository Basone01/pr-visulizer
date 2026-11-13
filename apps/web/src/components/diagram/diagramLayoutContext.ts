import { createContext } from "react"

import type { ElkRunner } from "@/utils/diagram/layeredLayout"

import { runElkGraphInWorker } from "@/workers/runElkGraphInWorker"

// How a flow diagram gets laid out. The app default runs elk in its web worker (never on the
// main thread). Tests provide elk in-process, or a runner that fails, through this context.
export const DiagramLayoutContext = createContext<ElkRunner>(runElkGraphInWorker)

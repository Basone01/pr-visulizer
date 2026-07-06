import { env } from "@/config/env"

import { createFixturePrClient } from "./fixture/fixturePrClient"
import { createHttpPrClient } from "./http/httpPrClient"
import type { PrClient } from "./prClient"

// One composition root for the data boundary. Fixture mode swaps the whole client
// in one place — no call site changes (docs/architecture.md verify note).
let client: PrClient | null = null

export function getPrClient(): PrClient {
  if (client) return client

  client = env.fixtureMode ? createFixturePrClient() : createHttpPrClient()
  return client
}

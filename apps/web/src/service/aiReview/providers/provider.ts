import type { AiReviewProvider } from "@pr-visulizer/shared"

// Test-only adapters exercise the provider-neutral lifecycle without becoming selectable production
// providers or gaining any process authority. Real adapters remain broker-backed in later slices.
export type ProviderAvailability = "production" | "test-only" | "unavailable"

export interface AppAiReviewProvider extends AiReviewProvider {
  readonly availability: ProviderAvailability
}

export function isProductionProvider(provider: AppAiReviewProvider): boolean {
  return provider.availability === "production"
}

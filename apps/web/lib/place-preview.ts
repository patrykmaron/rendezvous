// Shared shape for a Google Places (New) preview (ADR 0018). Dependency-free
// and framework-agnostic so it's safe to import from both the client card
// (apps/web/components/map/place-preview-card.tsx) and the server route
// (apps/web/app/api/places/preview/route.ts) without pulling in any server
// module.

export type PlacePreview = {
  name: string
  rating: number | null
  userRatingCount: number | null
  // 0 (PRICE_LEVEL_FREE) .. 4 (PRICE_LEVEL_VERY_EXPENSIVE); null when Google
  // has no price data for the place.
  priceLevel: number | null
  address: string | null
  openNow: boolean | null
  photoUrl: string | null
  googleMapsUri: string | null
}

export type PlacePreviewResponse =
  | { ok: true; place: PlacePreview }
  | { ok: false; reason: "not_found" | "unavailable" }

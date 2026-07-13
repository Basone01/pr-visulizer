// The precision tier's controllable core (AGENTS.architecture.md). Every knob that
// legitimately varies is a setting with a sane default; presets are named bundles on top,
// and explicit settings beat the preset.

export type PrecisionPolicy = {
  // Off by default: the tier costs a ~9 MB lazy chunk and a program build.
  enabled: boolean
  // Query at most this many changed symbols. A 1000-symbol PR would otherwise spend minutes
  // in reference queries for a graph nobody can read anyway.
  maxSymbols: number
  // Give up building the program after this long and keep the AST result (never fail).
  programTimeoutMs: number
  // Total budget for reference queries, checked between symbols — one pathological symbol
  // cannot eat the whole run.
  queryBudgetMs: number
  // The HARD ceiling on the whole precise phase: asset preload + program + every query.
  // Whatever else overruns, the phase loses the race and the AST result stands.
  //
  // Honest limit: a single synchronous compiler call (`getProgram`, one
  // `getReferencesAtPosition`) cannot be interrupted from JS. The cap bounds every awaitable
  // boundary, and the query loop yields between bounded chunks so the deadline is reachable.
  phaseTimeoutMs: number
}

export const DEFAULT_PRECISION_POLICY: PrecisionPolicy = {
  enabled: false,
  maxSymbols: 500,
  programTimeoutMs: 20_000,
  queryBudgetMs: 15_000,
  phaseTimeoutMs: 45_000,
}

// Named bundles for the common cases. `off` is the zero-config path.
export const PRECISION_PRESETS = {
  off: { enabled: false },
  balanced: { enabled: true, maxSymbols: 500, queryBudgetMs: 15_000, phaseTimeoutMs: 45_000 },
  thorough: {
    enabled: true,
    maxSymbols: 2000,
    programTimeoutMs: 60_000,
    queryBudgetMs: 60_000,
    phaseTimeoutMs: 150_000,
  },
} as const satisfies Record<string, Partial<PrecisionPolicy>>

export type PrecisionPresetName = keyof typeof PRECISION_PRESETS

// resolved = defaults <- preset <- overrides. Later wins, exactly like resolveRankingPolicy.
export function resolvePrecisionPolicy(
  preset: PrecisionPresetName = "off",
  overrides: Partial<PrecisionPolicy> = {}
): PrecisionPolicy {
  return { ...DEFAULT_PRECISION_POLICY, ...PRECISION_PRESETS[preset], ...overrides }
}

// The entry type-library. Lives HERE, not next to the LanguageService, because the browser
// asset seam and its coverage test must name it WITHOUT importing `typescript` — a value
// exported from `tsLanguageService.ts` would drag the ~9 MB compiler into the entry chunk.
export const DEFAULT_LIB = "lib.es2020.full.d.ts"

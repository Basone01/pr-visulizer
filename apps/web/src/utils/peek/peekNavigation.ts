import type { NavAction, NavLocation, NavState } from "@/entity/navigation"

// The pure peek -> expand -> jump state machine (docs/architecture.md §10).
// Framework-free so it can be unit-tested in isolation; the React hook just wraps
// it in useReducer.

export type NavConfig = {
  // Definitions longer than this truncate in the peek (§10, default 15).
  peekMaxLines: number
}

export function initialNavState(path: string): NavState {
  return {
    current: { path, line: 1 },
    peek: null,
    jumpStack: [],
    flash: null,
  }
}

// A jump pushes the location we leave onto the stack and flash-highlights the
// destination. Shared by "Jump ⏎", ⌘-click, and usage-list jumps.
function jump(state: NavState, destination: NavLocation): NavState {
  return {
    current: destination,
    peek: null,
    jumpStack: [...state.jumpStack, state.current],
    flash: destination,
  }
}

function back(state: NavState): NavState {
  if (state.jumpStack.length === 0) return { ...state, peek: null }

  const destination = state.jumpStack[state.jumpStack.length - 1]!
  return {
    current: destination,
    peek: null,
    jumpStack: state.jumpStack.slice(0, -1),
    flash: destination,
  }
}

// Reducer factory: config (peekMaxLines) is a controllable-core setting, curried
// in so useReducer gets a plain (state, action) reducer.
export function makeNavReducer(config: NavConfig) {
  return function navReducer(state: NavState, action: NavAction): NavState {
    switch (action.type) {
      case "selectFile":
        // Opening a file is a deliberate move, not a detour — reset the detour stack.
        return {
          current: { path: action.path, line: 1 },
          peek: null,
          jumpStack: [],
          flash: null,
        }

      case "peekUsage": {
        // No definition counterpart -> nothing to peek (the anchor wouldn't underline).
        if (!action.anchor.definition) return state

        return {
          ...state,
          peek: {
            anchor: action.anchor,
            target: action.anchor.definition,
            truncated: action.definitionLineCount > config.peekMaxLines,
            expanded: false,
          },
        }
      }

      case "expandPeek": {
        if (!state.peek) return state

        return { ...state, peek: { ...state.peek, expanded: true } }
      }

      case "closePeek":
        return { ...state, peek: null }

      case "jumpToDefinition": {
        if (!action.anchor.definition) return state

        return jump(state, {
          path: action.anchor.definition.path,
          line: action.anchor.definition.line,
        })
      }

      case "jumpTo":
        return jump(state, { path: action.target.path, line: action.target.line })

      case "back":
        return back(state)

      case "escape":
        // Esc closes an open peek first; with no peek, it pops the jump stack.
        return state.peek ? { ...state, peek: null } : back(state)

      case "clearFlash":
        return state.flash ? { ...state, flash: null } : state
    }
  }
}

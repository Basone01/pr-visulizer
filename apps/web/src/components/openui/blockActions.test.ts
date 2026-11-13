import { describe, expect, it } from "vitest"

import {
  type BlockActionEvent,
  type BlockActionRoute,
  actionLinkUrl,
  createArmedLinkOpener,
  normalizeFileRefPath,
  routeBlockAction,
  toHttpsUrl,
} from "./blockActions"

describe("toHttpsUrl lets only https leave the app", () => {
  it("keeps an https URL", () => {
    // Arrange
    const raw = "https://example.com/docs?x=1"

    // Act
    const url = toHttpsUrl(raw)

    // Assert
    const expected = "https://example.com/docs?x=1"
    expect(url).toBe(expected)
  })

  it("rejects every other scheme and anything that is not a URL", () => {
    // Arrange
    const rejected = [
      "http://example.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,x",
      "not a url",
      42,
    ]

    // Act
    const results = rejected.map((raw) => toHttpsUrl(raw))

    // Assert
    expect(results).toEqual(rejected.map(() => null))
  })
})

describe("routeBlockAction maps an OpenUI action to what the host does", () => {
  it("routes continue_conversation to a follow-up with its message", () => {
    // Arrange
    const event: BlockActionEvent = {
      type: "continue_conversation",
      params: { context: { file: "src/auth.ts" } },
      humanFriendlyMessage: "Explain the auth change",
    }

    // Act
    const route = routeBlockAction(event)

    // Assert
    const expected: BlockActionRoute = { kind: "follow-up", text: "Explain the auth change" }
    expect(route).toEqual(expected)
  })

  it("routes open_url with an https url to open-url", () => {
    // Arrange
    const event: BlockActionEvent = {
      type: "open_url",
      params: { url: "https://example.com/docs" },
      humanFriendlyMessage: "",
    }

    // Act
    const route = routeBlockAction(event)

    // Assert
    const expected: BlockActionRoute = { kind: "open-url", url: "https://example.com/docs" }
    expect(route).toEqual(expected)
  })

  it("ignores open_url with a non-https url, an empty follow-up, and unknown actions", () => {
    // Arrange
    const events: BlockActionEvent[] = [
      { type: "open_url", params: { url: "http://example.com" } },
      { type: "continue_conversation", humanFriendlyMessage: "  " },
      { type: "submit_form", params: {} },
    ]

    // Act
    const routes = events.map((event) => routeBlockAction(event))

    // Assert
    const expected: BlockActionRoute[] = [
      { kind: "ignore" },
      { kind: "ignore" },
      { kind: "ignore" },
    ]
    expect(routes).toEqual(expected)
  })
})

describe("actionLinkUrl decides the one URL an action may open", () => {
  it("reads an object-literal action's params.url, the shape OpenUI opens", () => {
    // Arrange
    const action = { type: "open_url", params: { url: "https://hidden.example/a" } }

    // Act
    const url = actionLinkUrl(action)

    // Assert
    const expected = "https://hidden.example/a"
    expect(url).toBe(expected)
  })

  it("lets an object-literal action's top-level url win over params.url, as OpenUI does", () => {
    // Arrange
    const action = {
      type: "open_url",
      url: "https://top.example/",
      params: { url: "https://param.example/" },
    }

    // Act
    const url = actionLinkUrl(action)

    // Assert
    const expected = "https://top.example/"
    expect(url).toBe(expected)
  })

  it("returns the first https @OpenUrl step of an action plan", () => {
    // Arrange
    const action = {
      steps: [
        { type: "continue_conversation", message: "Explain" },
        { type: "open_url", url: "http://plain.example" },
        { type: "open_url", url: "https://first.example/a" },
        { type: "open_url", url: "https://second.example/b" },
      ],
    }

    // Act
    const url = actionLinkUrl(action)

    // Assert
    const expected = "https://first.example/a"
    expect(url).toBe(expected)
  })
})

describe("createArmedLinkOpener opens only the URL a control showed, once", () => {
  it("allows the armed URL once and refuses any other URL", () => {
    // Arrange
    const opener = createArmedLinkOpener()
    const shownUrl = "https://shown.example/"
    const otherUrl = "https://other.example/"

    // Act
    opener.arm(shownUrl)
    const otherAllowed = opener.takeArmed(otherUrl)
    opener.arm(shownUrl)
    const shownAllowed = opener.takeArmed(shownUrl)
    const shownAgainAllowed = opener.takeArmed(shownUrl)

    // Assert
    expect([otherAllowed, shownAllowed, shownAgainAllowed]).toEqual([false, true, false])
  })
})

describe("normalizeFileRefPath gives a FileRef path one form", () => {
  it("trims, turns backslashes into slashes and drops every leading ./", () => {
    // Arrange
    const paths = [" ./src/auth.ts ", "././src/auth.ts", "src\\auth.ts", "src/auth.ts"]

    // Act
    const normalized = paths.map((path) => normalizeFileRefPath(path))

    // Assert
    expect(normalized).toEqual(["src/auth.ts", "src/auth.ts", "src/auth.ts", "src/auth.ts"])
  })
})

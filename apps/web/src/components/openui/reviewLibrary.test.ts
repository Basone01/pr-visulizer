import { describe, expect, it } from "vitest"

import { reviewLibrary } from "./reviewLibrary"

// Security promise: nothing a model writes in a block can make the webview load a URL.
// Image/media components and image-URL props are the direct way to do that.
const IMAGE_COMPONENT_PATTERN = /image|gallery|carousel|video|audio|media|embed|iframe/i
const URL_PROP_NAMES = new Set(["image", "src", "imageUrl", "url", "href", "poster"])

describe("reviewLibrary exposes no way to load a remote resource", () => {
  it("has no image or media component", () => {
    // Arrange
    const componentNames = Object.keys(reviewLibrary.components)

    // Act
    const imageComponents = componentNames.filter((name) => IMAGE_COMPONENT_PATTERN.test(name))

    // Assert
    expect(imageComponents).toEqual([])
  })

  it("has no component prop that takes an image or resource URL", () => {
    // Arrange
    const components = Object.values(reviewLibrary.components)

    // Act
    const urlProps = components.flatMap((component) =>
      Object.keys(component.props.shape)
        .filter((prop) => URL_PROP_NAMES.has(prop))
        .map((prop) => `${component.name}.${prop}`)
    )

    // Assert
    expect(urlProps).toEqual([])
  })
})

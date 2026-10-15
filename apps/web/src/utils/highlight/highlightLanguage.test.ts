import { describe, expect, it } from "vitest"

import { highlightLanguageForPath } from "./highlightLanguage"

describe("highlightLanguageForPath", () => {
  it("shell_scripts_get_the_shell_grammar", () => {
    // Arrange
    const path = "scripts/deploy.sh"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "shellscript"
    expect(language).toBe(expected)
  })

  it("docker_compose_files_get_the_yaml_grammar", () => {
    // Arrange
    const path = "docker-compose.yml"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "yaml"
    expect(language).toBe(expected)
  })

  it("yaml_extension_gets_the_yaml_grammar", () => {
    // Arrange
    const path = "config.yaml"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "yaml"
    expect(language).toBe(expected)
  })

  it("json_files_get_the_json_grammar", () => {
    // Arrange
    const path = "package.json"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "json"
    expect(language).toBe(expected)
  })

  it("dockerfile_gets_the_docker_grammar", () => {
    // Arrange
    const path = "Dockerfile"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "docker"
    expect(language).toBe(expected)
  })

  it("dockerfile_variants_get_the_docker_grammar", () => {
    // Arrange
    const path = "deploy/Dockerfile.dev"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "docker"
    expect(language).toBe(expected)
  })

  it("bruno_requests_get_the_bruno_grammar", () => {
    // Arrange
    const path = "docs/api/Readiness.bru"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "bruno"
    expect(language).toBe(expected)
  })

  it("extensions_match_case_insensitively", () => {
    // Arrange
    const path = "CONFIG.YML"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "yaml"
    expect(language).toBe(expected)
  })

  it("tsx_files_keep_the_tsx_grammar", () => {
    // Arrange
    const path = "src/x.tsx"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    const expected = "tsx"
    expect(language).toBe(expected)
  })

  it("languages_without_a_highlight_grammar_return_null", () => {
    // Arrange
    const path = "main.go"

    // Act
    const language = highlightLanguageForPath(path)

    // Assert
    expect(language).toBeNull()
  })
})

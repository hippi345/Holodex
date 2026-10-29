import assert from "node:assert/strict"
import test from "node:test"

import { derivePalette } from "../src/lib/theme/palette.ts"
import {
  isThemeColor,
  normalizeThemeColor,
  resolvePalette,
  themeColorToHex,
} from "../src/lib/theme/overrides.ts"

test("existing themes retain their computed defaults without overrides", () => {
  for (const primary of ["#f06292", "#000000", "#ffffff", "#0088ff"]) {
    for (const mode of ["light", "dark"]) {
      assert.deepEqual(
        resolvePalette(primary, mode),
        derivePalette(primary, mode)
      )
    }
  }
})

test("every theme color can be overridden and reset without affecting other tokens", () => {
  const primary = "#f06292"
  const defaults = derivePalette(primary, "dark")
  for (const token of Object.keys(defaults.vars)) {
    if (token === "--primary") continue
    const overrides = { dark: { [token]: "#123abc80" } }
    const custom = resolvePalette(primary, "dark", overrides)
    assert.deepEqual(custom.vars, { ...defaults.vars, [token]: "#123abc80" })
    assert.deepEqual(
      resolvePalette(primary, "light", overrides),
      derivePalette(primary, "light")
    )
    delete overrides.dark[token]
    assert.deepEqual(resolvePalette(primary, "dark", overrides), defaults)
  }
})

test("overrides persist through primary changes while automatic colors recompute", () => {
  const overrides = {
    dark: { "--complement": "#123456", "--background": "#102030" },
    light: { "--complement": "#abcdef" },
  }
  const saved = JSON.parse(JSON.stringify(overrides))
  const custom = resolvePalette("#00ff00", "dark", saved)
  assert.equal(custom.vars["--complement"], "#123456")
  assert.equal(custom.complement, "#123456")
  assert.equal(custom.background, "#102030")
  assert.equal(
    custom.vars["--card"],
    derivePalette("#00ff00", "dark").vars["--card"]
  )
  delete saved.dark
  assert.deepEqual(
    resolvePalette("#00ff00", "dark", saved),
    derivePalette("#00ff00", "dark")
  )
  assert.equal(resolvePalette("#00ff00", "light", saved).complement, "#abcdef")
})

test("invalid and unknown stored colors cannot override theme tokens or the primary seed", () => {
  const defaults = derivePalette("#f06292", "dark")
  assert.deepEqual(
    resolvePalette("#f06292", "dark", {
      dark: {
        "--background": "broken",
        "--complement": null,
        "--primary": "#123456",
        "--unknown": "#abcdef",
      },
    }),
    defaults
  )
  assert.equal(
    resolvePalette("#f06292", "dark", { dark: { "--complement": "#ABC" } })
      .complement,
    "#aabbcc"
  )
})

test("editing generated colors preserves transparency and accepts valid hex values", () => {
  assert.equal(themeColorToHex("oklch(0.93 0.03 241.96 / 11%)").slice(7), "1c")
  assert.equal(themeColorToHex("oklch(0.74 0.1797 1.96 / 55%)").slice(7), "8c")
  assert.equal(themeColorToHex("#AbC"), "#aabbcc")
  assert.equal(themeColorToHex("oklch(0.5 0 0 / 50%)").slice(7), "80")
  assert.equal(normalizeThemeColor(" #ABCDEF80 "), "#abcdef80")
  for (const value of ["#abc", "abcdef", "#abcdef", "#abcdef00", "#abcdef80"])
    assert.ok(isThemeColor(value))
  for (const value of ["", "#ab", "#abcde", "#abcdefgh", "red", "url(example)"])
    assert.ok(!isThemeColor(value))
})

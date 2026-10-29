import { isHexColor, normalizeHex, oklchToHex } from "./color.ts"
import {
  derivePalette,
  type ResolvedMode,
  type ThemeColor,
  type ThemeColorOverrides,
} from "./palette.ts"

/** Overrides are hex colours, optionally including an alpha byte. */
export function isThemeColor(value: string): boolean {
  return isHexColor(value) || /^#[0-9a-f]{8}$/i.test(value.trim())
}

export function normalizeThemeColor(value: string): string {
  const color = value.trim().toLowerCase()
  return /^#[0-9a-f]{8}$/.test(color) ? color : normalizeHex(color)
}

/** Converts our generated OKLCH tokens to editable hex, preserving opacity. */
export function themeColorToHex(value: string): string {
  if (isThemeColor(value)) return normalizeThemeColor(value)
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+)%)?\)$/.exec(
    value
  )
  if (!match) throw new Error(`Unsupported theme color: ${value}`)
  const hex = oklchToHex({
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
  })
  const alpha =
    match[4] === undefined ? 255 : Math.round((Number(match[4]) / 100) * 255)
  return alpha === 255 ? hex : `${hex}${alpha.toString(16).padStart(2, "0")}`
}

/** Always start from fresh defaults so removing an override restores it exactly. */
export function resolvePalette(
  primary: string,
  mode: ResolvedMode,
  overrides: ThemeColorOverrides = {}
) {
  const palette = derivePalette(primary, mode)
  const custom = overrides[mode]
  for (const name of Object.keys(palette.vars) as ThemeColor[]) {
    if (name === "--primary") continue
    const value = custom?.[name]
    if (typeof value === "string" && isThemeColor(value)) {
      palette.vars[name] = normalizeThemeColor(value)
      if (name === "--background") palette.background = palette.vars[name]
      if (name === "--complement") palette.complement = palette.vars[name]
    }
  }
  return palette
}

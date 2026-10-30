import { compileTheme, type CompiledTheme, type PlatformThemeDefinition, type ThemeTokens } from "./theme-compiler.js";

const lightColors = {
  bg: "#ffffff", surface: "#ffffff", ink: "#18202c", muted: "#526173", line: "#778496",
  accent: "#2457a7", "accent-ink": "#17447f", "on-accent": "#ffffff", ok: "#176b45", warn: "#795100",
  crit: "#a42323", focus: "#8b3d00", c1: "#155da8", c2: "#8c3d79", c3: "#267246", c4: "#8a4b15",
  c5: "#58489b", c6: "#087679",
} as const;
const darkColors = {
  bg: "#141923", surface: "#202938", ink: "#f3f5f8", muted: "#bac4d1", line: "#8390a1",
  accent: "#566b8d", "accent-ink": "#d1deff", "on-accent": "#ffffff", ok: "#8cddb0", warn: "#ffd078",
  crit: "#ffaaa3", focus: "#ffe08a", c1: "#7890ac", c2: "#987a95", c3: "#70987e", c4: "#a07d56",
  c5: "#8379ac", c6: "#5f9697",
} as const;
function tokens(lightBg: string, darkBg: string, heading: string, body: string, radius: string, shadow: string): { light: ThemeTokens; dark: ThemeTokens } {
  const common = { "font-heading": heading, "font-body": body, "font-mono": "ui-monospace, monospace", radius, space: "1.15rem", density: "1", shadow };
  return {
    light: { ...lightColors, bg: lightBg, surface: lightBg, ...common },
    dark: { ...darkColors, bg: darkBg, surface: darkBg === "#141923" ? "#202938" : darkBg, ...common },
  };
}
const source: PlatformThemeDefinition[] = [
  {
    slug: "report", name: "Report", description: "Clear, familiar reports with a cool neutral palette.", logo: null,
    tokens: tokens("#ffffff", "#141923", "system-ui, sans-serif", "system-ui, sans-serif", "1rem", "0 12px 36px #1729441c"),
    recipes: {
      aurora: { colors: ["accent", "c1", "c5"], intensity: 0.58, angle: 136, positions: ["80% 16%", "93% 68%", "65% 90%"] },
      glow: { color: "accent", intensity: 0.24 },
    },
  },
  {
    slug: "editorial", name: "Editorial", description: "Warm, text-led reports with a quiet serif voice.", logo: null,
    tokens: tokens("#fbf7f0", "#1a1917", "Georgia, serif", "system-ui, sans-serif", ".75rem", "0 12px 36px #1729441c"),
    recipes: {
      aurora: { colors: ["accent", "c2", "c5"], intensity: 0.52, angle: 142, positions: ["78% 18%", "91% 65%", "62% 88%"] },
      glow: { color: "c4", intensity: 0.18 },
    },
  },
  {
    slug: "launch", name: "Launch", description: "A crisp, energetic palette for launches and announcements.", logo: null,
    tokens: tokens("#f4f8ff", "#101b2e", "Arial, sans-serif", "system-ui, sans-serif", "1.25rem", "0 16px 40px #1729441c"),
    recipes: {
      aurora: { colors: ["accent", "c3", "c6"], intensity: 0.48, angle: 128, positions: ["82% 14%", "92% 66%", "66% 91%"] },
      glow: { color: "c1", intensity: 0.3 },
    },
  },
];

// Definitions remain private; readers receive only themes that completed every compiler gate.
export const PLATFORM_THEMES: readonly CompiledTheme[] = Object.freeze(source.map(compileTheme));
export function getPlatformTheme(slug: string): CompiledTheme | null {
  return PLATFORM_THEMES.find(theme => theme.slug === slug) ?? null;
}

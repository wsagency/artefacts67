import type { CompiledTheme } from "../../frontend/src/theme-compiler.js";
import { hostedPageDocumentLength, PAGE_DOCUMENT_MAX_LENGTH } from "../../frontend/src/page-composition.js";
import { PAGE_FRAME_NONCE_HEX_LENGTH } from "../../frontend/src/page-frame-bridge.js";

const MODES = ["light", "dark"] as const;
const TEXT_SIZES = ["s", "m", "l"] as const;
const SIZING_NONCE = "0".repeat(PAGE_FRAME_NONCE_HEX_LENGTH);

/** Worst `.length` across every selectable theme and every reader composition setting. */
export function worstPageDocumentLength(
  fragment: string,
  selectableThemes: readonly CompiledTheme[],
  origin: string,
  lang: string,
  compiledOverride?: CompiledTheme,
  projectTheme?: { compiledTheme: CompiledTheme; fontsCss: string },
): number {
  let worst = 0;
  const measure = (theme: CompiledTheme, fontsCss = "", themeScope: "platform" | "project" = "platform") => {
    for (const mode of MODES) {
      for (const size of TEXT_SIZES) {
        const length = hostedPageDocumentLength(fragment, theme, mode, origin, size, lang, SIZING_NONCE, false, fontsCss, themeScope);
        if (length > worst) worst = length;
      }
    }
  };
  for (const theme of selectableThemes) measure(theme, projectTheme?.fontsCss ?? "");
  if (projectTheme) measure(projectTheme.compiledTheme, projectTheme.fontsCss, "project");
  if (compiledOverride) measure(compiledOverride, projectTheme?.fontsCss ?? "", projectTheme ? "project" : "platform");
  return worst;
}

export { PAGE_DOCUMENT_MAX_LENGTH };

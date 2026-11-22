import { library as intelligentUiLibrary } from "@openuidev/intelligent-ui-library";
import { actions } from "./actions";
import "./components/theme.css";
import "./components/components.css";
import "./components/map/map.css";
import { MapMarker, MapView } from "./components/map/map";
import { MATH_TEXT_COMPONENTS, withInlineMath, withNormalizedTex } from "./components/math";
import { SearchImage } from "./components/search-image";
import { safeActionOverrides } from "./safe-action";

/**
 * The library's prose components, wrapped so `$...$` in a text prop renders as
 * KaTeX. The library's own `inline()` helper only knows bold/italic/code/links,
 * so without this a tutor reply's inline maths printed as source (only display
 * maths rendered, because the model emits `Math(...)` for those).
 */
const mathTextOverrides = MATH_TEXT_COMPONENTS.flatMap((name) => {
  const definition = intelligentUiLibrary.components[name];
  return definition ? [withInlineMath(definition)] : [];
});

/**
 * The library's own `Math` component, wrapped so `Math("$x^2$")` renders the
 * formula instead of the delimiters.
 *
 * The component renders its `tex` prop through KaTeX directly. Models write
 * formulas in prose form everywhere in this app, so they routinely hand it
 * `"$V_{bi}=\\dfrac{kT}{q}\\ln...$"`; KaTeX then fails on the leading `$` and its
 * `throwOnError: false` fallback paints the raw source red — the formula reached
 * the reader as an error box rather than maths.
 */
const mathTexOverrides = (["Math"] as const).flatMap((name) => {
  const definition = intelligentUiLibrary.components[name];
  return definition ? [withNormalizedTex(definition)] : [];
});

/**
 * @openuidev/intelligent-ui-library (the components and @functions a model
 * composes) plus what only this app can do: photos it finds for a query, a
 * street map, copying to the clipboard, and inline LaTeX in prose.
 */
export const library = intelligentUiLibrary.extend({
  components: {
    add: [SearchImage, MapView, MapMarker],
    override: [...mathTextOverrides, ...mathTexOverrides, ...safeActionOverrides],
  },
  actions: { add: actions },
});

// The CLI (npm run prompt) picks up these exports by name.
export { dashboardPromptOptions, promptOptions } from "./prompt-options";

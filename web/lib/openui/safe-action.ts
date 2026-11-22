import {
  ACTION_STEPS,
  type ComponentRenderProps,
  type DefinedComponent,
} from "@openuidev/react-lang";
import { library as intelligentUiLibrary } from "@openuidev/intelligent-ui-library";
import type { ReactNode } from "react";

/** The library components whose prop schema accepts an action. */
const ACTION_COMPONENTS = ["Button", "IconButton", "Pressable"] as const;

type ActionProps = Record<string, unknown> & { action?: unknown };

/**
 * A string in an action prop means "send this to the assistant".
 *
 * The prompt asks for `Button("Ask", @ToAssistant("Tell me more"))`, but a
 * model sometimes writes the follow-up as a bare string instead. The renderer
 * stores it as-is and its action runner then tests `"steps" in action`, which
 * throws on a string. Turning it into the equivalent single-step action keeps
 * the click working and preserves the message the model intended.
 */
export function normalizeAction(action: unknown): unknown {
  if (typeof action === "string" && action.trim()) {
    return { steps: [{ type: ACTION_STEPS.ToAssistant, message: action }] };
  }
  if (action !== null && typeof action === "object") return action;
  return undefined;
}

/** Wrap a component so a non-object action prop can never reach the runner. */
function withSafeAction<T extends DefinedComponent>(definition: T): T {
  const component = (context: ComponentRenderProps<ActionProps>) => {
    const props = context.props ?? {};
    const action = normalizeAction(props.action);
    const render = definition.component as (
      context: ComponentRenderProps<ActionProps>,
    ) => ReactNode;
    return render(action === props.action ? context : { ...context, props: { ...props, action } });
  };
  return { ...definition, component } as T;
}

export const safeActionOverrides = ACTION_COMPONENTS.flatMap((name) => {
  const definition = intelligentUiLibrary.components[name];
  return definition ? [withSafeAction(definition)] : [];
});

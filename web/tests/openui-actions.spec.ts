import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_STEPS,
  BuiltinActionType,
  type ActionEvent,
} from "@openuidev/react-lang";
import { handleOpenUIAction } from "@/lib/openui/actions";
import { normalizeAction } from "@/lib/openui/safe-action";

function event(
  type: string,
  overrides: Partial<ActionEvent> = {},
): ActionEvent {
  return {
    type,
    params: {},
    humanFriendlyMessage: "Plan my trip",
    ...overrides,
  };
}

describe("handleOpenUIAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends continue_conversation as a follow-up with form values", () => {
    const send = vi.fn();
    handleOpenUIAction(
      event(BuiltinActionType.ContinueConversation, {
        humanFriendlyMessage: "Plan my trip",
        formState: { pace: "Relaxed", days: 4 },
      }),
      send,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'Plan my trip\nForm values: {"pace":"Relaxed","days":4}',
    );
  });

  it("opens only http(s) urls from open_url actions in a new tab", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    handleOpenUIAction(
      event(BuiltinActionType.OpenUrl, { params: { url: "https://example.com/a" } }),
    );
    expect(open).toHaveBeenCalledWith(
      "https://example.com/a",
      "_blank",
      "noopener,noreferrer",
    );

    handleOpenUIAction(
      event(BuiltinActionType.OpenUrl, { params: { url: "javascript:alert(1)" } }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated actions", () => {
    const send = vi.fn();
    handleOpenUIAction(event("SomeLibraryAction"), send);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("normalizeAction", () => {
  it("turns a bare string action into a to-assistant step", () => {
    expect(normalizeAction("Save a note on doping")).toEqual({
      steps: [
        {
          type: ACTION_STEPS.ToAssistant,
          message: "Save a note on doping",
        },
      ],
    });
  });

  it("leaves object actions and absent actions untouched", () => {
    const action = { type: BuiltinActionType.OpenUrl, params: { url: "https://example.com" } };
    expect(normalizeAction(action)).toBe(action);
    expect(normalizeAction(undefined)).toBeUndefined();
  });

  it("drops other primitives instead of passing them to the runner", () => {
    expect(normalizeAction(42)).toBeUndefined();
    expect(normalizeAction(true)).toBeUndefined();
    expect(normalizeAction("")).toBeUndefined();
  });
});

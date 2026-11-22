"use client";



/**
 * What kind of turn a message is, in one word.
 *
 * Shared by the transcript seat and the reasoning panel so the same message is
 * never named two different things — in a debate the panel otherwise shows
 * five identical-looking cards ("John, Frank, John, Frank, John") with no way
 * to tell an opening from a clash.
 */
export function useSeatKindLabel() {
  
  return (kind?: string): string => {
    switch (kind) {
      case "debate_rebuttal":
        return "Rebuttal";
      case "round_summary":
        return "Summary";
      case "invocation_question":
      case "invocation_reply":
        return "Follow-up";
      default:
        return "";
    }
  };
}

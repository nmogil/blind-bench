import { describe, expect, it } from "vitest";
import { comparisonChoiceForKey, comparisonChoiceForSwipe } from "./comparisonControls";

describe("blind comparison controls", () => {
  it.each([
    ["ArrowLeft", "first"],
    ["ArrowRight", "second"],
    ["=", "same"],
    ["n", "neither"],
    ["N", "neither"],
    ["s", "cannot_judge"],
    ["S", "cannot_judge"],
    ["Enter", null],
  ])("maps %s to %s", (key, expected) => {
    expect(comparisonChoiceForKey(key)).toBe(expected);
  });

  it("maps directional swipes without triggering near the threshold", () => {
    expect(comparisonChoiceForSwipe(-91)).toBe("first");
    expect(comparisonChoiceForSwipe(91)).toBe("second");
    expect(comparisonChoiceForSwipe(-90)).toBeNull();
    expect(comparisonChoiceForSwipe(90)).toBeNull();
    expect(comparisonChoiceForSwipe(0)).toBeNull();
  });
});

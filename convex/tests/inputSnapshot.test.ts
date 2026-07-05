/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  buildInputSnapshot,
  isStorageIdReferencedBySnapshots,
  type InputSnapshot,
} from "../lib/inputSnapshot";

// Storage ids are opaque strings at runtime; cast to satisfy the Id<> types
// without pulling in the Convex runtime.
const sid = (s: string) => s as Id<"_storage">;

describe("buildInputSnapshot", () => {
  test("quick run snapshots inline variables as text, no images", () => {
    const snap = buildInputSnapshot({
      inlineVariables: { name: "Ada", topic: "compilers" },
    });
    expect(snap).toEqual({ text: { name: "Ada", topic: "compilers" } });
    expect(snap.images).toBeUndefined();
  });

  test("inline variables win even when a test case is also passed", () => {
    const snap = buildInputSnapshot({
      inlineVariables: { name: "Ada" },
      testCase: { variableValues: { name: "Grace" } },
    });
    expect(snap).toEqual({ text: { name: "Ada" } });
  });

  test("test-case run snapshots variableValues as text", () => {
    const snap = buildInputSnapshot({
      testCase: { variableValues: { greeting: "hi", tone: "warm" } },
    });
    expect(snap).toEqual({ text: { greeting: "hi", tone: "warm" } });
  });

  test("test-case run with image variables snapshots images", () => {
    const snap = buildInputSnapshot({
      testCase: {
        variableValues: { caption: "a cat" },
        variableAttachments: { photo: sid("blob_1") },
      },
    });
    expect(snap).toEqual({
      text: { caption: "a cat" },
      images: { photo: sid("blob_1") },
    });
  });

  test("empty variableAttachments produces no images key", () => {
    const snap = buildInputSnapshot({
      testCase: { variableValues: {}, variableAttachments: {} },
    });
    expect(snap).toEqual({ text: {} });
    expect("images" in snap).toBe(false);
  });

  test("snapshot is a copy — mutating the source does not change it", () => {
    const values: Record<string, string> = { a: "1" };
    const attachments: Record<string, Id<"_storage">> = { img: sid("b1") };
    const snap = buildInputSnapshot({
      testCase: { variableValues: values, variableAttachments: attachments },
    });
    values.a = "mutated";
    attachments.img = sid("b2");
    expect(snap.text).toEqual({ a: "1" });
    expect(snap.images).toEqual({ img: sid("b1") });
  });

  test("no inline vars and no test case yields empty text", () => {
    expect(buildInputSnapshot({})).toEqual({ text: {} });
    expect(buildInputSnapshot({ testCase: null })).toEqual({ text: {} });
  });
});

describe("isStorageIdReferencedBySnapshots", () => {
  const withImages = (images: Record<string, string>) => ({
    inputSnapshot: {
      text: {},
      images: images as Record<string, Id<"_storage">>,
    } as InputSnapshot,
  });

  test("finds a referenced blob", () => {
    const runs = [withImages({ photo: "blob_1" }), withImages({ x: "blob_2" })];
    expect(isStorageIdReferencedBySnapshots(runs, sid("blob_2"))).toBe(true);
  });

  test("returns false when no snapshot references the blob", () => {
    const runs = [withImages({ photo: "blob_1" })];
    expect(isStorageIdReferencedBySnapshots(runs, sid("blob_9"))).toBe(false);
  });

  test("ignores runs with no snapshot or no images", () => {
    const runs = [
      { inputSnapshot: null },
      { inputSnapshot: { text: { a: "1" } } as InputSnapshot },
      {},
    ];
    expect(isStorageIdReferencedBySnapshots(runs, sid("blob_1"))).toBe(false);
  });

  test("empty run list is not a reference", () => {
    expect(isStorageIdReferencedBySnapshots([], sid("blob_1"))).toBe(false);
  });

  test("matches a blob shared across multiple runs", () => {
    const runs = [
      withImages({ a: "shared" }),
      withImages({ b: "shared" }),
    ];
    expect(isStorageIdReferencedBySnapshots(runs, sid("shared"))).toBe(true);
  });
});

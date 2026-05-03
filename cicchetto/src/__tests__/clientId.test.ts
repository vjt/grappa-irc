import { beforeEach, describe, expect, test } from "vitest";
import { getOrCreateClientId } from "../lib/clientId";

describe("getOrCreateClientId", () => {
  beforeEach(() => localStorage.clear());

  test("generates UUID v4 on first call", () => {
    const id = getOrCreateClientId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("returns same value on subsequent calls", () => {
    const id1 = getOrCreateClientId();
    const id2 = getOrCreateClientId();
    expect(id1).toBe(id2);
  });

  test("regenerates if localStorage cleared", () => {
    const id1 = getOrCreateClientId();
    localStorage.clear();
    const id2 = getOrCreateClientId();
    expect(id1).not.toBe(id2);
  });
});

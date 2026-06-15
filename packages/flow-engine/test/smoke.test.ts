import { expect, test } from "bun:test";
import { FLOW_ENGINE_VERSION } from "../src/index.ts";

test("flow-engine exposes a version", () => {
  expect(FLOW_ENGINE_VERSION).toBe("0.0.0");
});

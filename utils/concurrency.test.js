const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mapWithConcurrency } = require("./concurrency");

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("returns results in input order", async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    assert.deepEqual(out, [30, 10, 20]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    assert.equal(peak, 3);
  });

  it("treats a limit below 1 as 1", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    assert.equal(peak, 1);
  });

  it("resolves empty for an empty or missing list", async () => {
    assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
    assert.deepEqual(await mapWithConcurrency(null, 3, async () => 1), []);
  });

  it("rejects with the first error", async () => {
    await assert.rejects(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
      /boom/
    );
  });
});

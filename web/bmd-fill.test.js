// node web/bmd-fill.test.js
const assert = require("assert");
const { plan } = require("./bmd-fill.js");
const h = 36e5;
const blocks = (hours) => plan([{ day: "d", duration_ms: hours * h }], "08:00")[0].blocks;

assert.deepStrictEqual(blocks(6), [{ begin: "08:00", end: "14:00" }]); // 6h or less: no break
assert.deepStrictEqual(blocks(8.5), [{ begin: "08:00", end: "14:00" }, { begin: "14:00", end: "14:30", pause: true }, { begin: "14:30", end: "17:00" }]);
assert.deepStrictEqual(plan([{ day: "a", duration_ms: 3 * h }, { day: "a", duration_ms: 1 * h }, { day: "b", duration_ms: 0 }], "08:00").map((r) => [r.day, r.minutes]), [["a", 240]]);
assert.throws(() => blocks(16));
console.log("bmd-fill ok");

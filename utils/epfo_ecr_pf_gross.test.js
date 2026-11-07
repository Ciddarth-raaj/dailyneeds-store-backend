const test = require("node:test");
const assert = require("node:assert/strict");
const { pfGrossWages } = require("./epfo_ecr");

test("PF gross excludes Bonus, Incentive, OT and Extra Days", () => {
  const calc = {
    total_earnings: "30000.00", salary_earnings: "22000.00", arrears: "500.00",
    bonus: "2000.00", incentive: "1500.00", ot_amount: "2500.00", prior_month_ot_amount: "300.00", extra_day_amount: "1200.00",
  };
  assert.equal(pfGrossWages(calc), 22500);
});

test("missing components count as zero; unknown gross stays unknown", () => {
  assert.equal(pfGrossWages({ total_earnings: 15000 }), 15000);
  assert.equal(pfGrossWages({ total_earnings: null }), null);
});

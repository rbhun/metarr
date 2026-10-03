import assert from "node:assert/strict";
import test from "node:test";
import { rulesWhere } from "@/lib/filters";

test("the library filter can require a movie or a series and a length in minutes", () => {
  assert.deepEqual(rulesWhere([{ id: "kind", field: "kind", op: "eq", value: "series" }]), {
    clauses: ["kind = ?"],
    params: ["series"],
  });
  assert.deepEqual(rulesWhere([{ id: "other", field: "kind", op: "neq", value: "movie" }]), {
    clauses: ["kind != ?"],
    params: ["movie"],
  });
  assert.deepEqual(rulesWhere([{ id: "long", field: "length", op: "gte", value: "90" }]), {
    clauses: ["runtime_minutes >= ?"],
    params: [90],
  });
  assert.deepEqual(rulesWhere([{ id: "blank", field: "length", op: "eq", value: "unknown" }]), {
    clauses: ["runtime_minutes IS NULL"],
    params: [],
  });
});

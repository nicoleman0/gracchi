import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonical } from "../lib/canonical";
import realPublication from "../data/state-publication.json";
import { readStatePublication, stateSeatLabel, termStatus } from "../lib/state-offices";
import { STATES } from "../lib/states";

function fixture() {
  const source = { id: "source", label: "Test source", url: "https://example.org/", checked_at: "2026-11-08" };
  return {
    version: "test", batch: { reviewed_at: "2026-11-08" },
    people: [{ id: "synthetic", name: "Test Person", portrait_url: null, portrait_credit: null, portrait_source_id: null }],
    seats: [{ id: "seat", state: "NE", office: "unicameral", chamber: "Legislature", district: "A", seat_label: "Seat 2", capacity: 2 }],
    sources: [source], elections: [{ id: "election", seat_id: "seat", year: 2026, stage: "general", cycle_election_id: null as string | null }],
    issuers: [{ id: "issuer", name: "Test Chapter", group_code: "dsa", parent_id: "parent", affiliation_source_id: "source" }],
    endorsements: [{ id: "endorsement", person_id: "synthetic", issuer_id: "issuer", election_id: "election", source_id: "source", withdrawn: false }],
    reconciliations: [{ id: "decision", endorsement_id: "endorsement", outcome: "included", reason: "Test", term_id: "term" }],
    terms: [{ id: "term", person_id: "synthetic", seat_id: "seat", election_id: "election", starts_on: "2026-01-01", ends_on: "2030-01-01", status: "serving", service_source_id: "source", result_source_id: "source", contact_url: "https://example.org/", contact_source_id: "source", campaign_url: null, campaign_source_id: null }],
    coverage: STATES.filter((s) => s.code !== "DC").flatMap((s) => ["wfp", "or", "dsa", "rfs", "pccc", "sunrise"].map((group_code) => ({ state: s.code, group_code, status: s.code === "NE" && group_code === "dsa" ? "complete_with_entries" : "complete_no_entries", note: "Checked.", checked_at: "2026-11-08" }))),
  };
}
function envelope(snapshot: ReturnType<typeof fixture>) {
  return { version: snapshot.version, sha256: createHash("sha256").update(canonical(snapshot)).digest("hex"), snapshot };
}

test("only a reviewed, unmodified snapshot with every coverage row loads", () => {
  assert.deepEqual(readStatePublication(null).members, []);
  const data = fixture();
  const result = readStatePublication(envelope(data), new Date("2026-11-08"));
  assert.equal(result.members[0].endorsers[0].issuer.name, "Test Chapter");
  assert.equal(stateSeatLabel(result.members[0]), "NE Legislature · District A · Seat 2");
  data.coverage[0].status = "blocked";
  assert.equal(readStatePublication(envelope(data), new Date("2026-11-08")).coverage[0].status, "blocked");
  data.coverage[0].note = " ";
  assert.throws(() => readStatePublication(envelope(data)), /missing coverage rows/);
  data.coverage.shift();
  assert.throws(() => readStatePublication(envelope(data)), /missing coverage rows/);
  const invalid = envelope(fixture());
  invalid.snapshot.people[0].name = "Changed";
  assert.throws(() => readStatePublication(invalid), /hash mismatch/);
});

test("missing evidence and contradictory terms fail closed", () => {
  const missing = fixture(); missing.endorsements[0].withdrawn = true;
  assert.throws(() => readStatePublication(envelope(missing), new Date("2026-11-08")), /missing evidence/);
  const future = fixture(); future.terms[0].starts_on = "2027-01-01";
  assert.throws(() => readStatePublication(envelope(future), new Date("2026-11-08")), /invalid term/);
  const unsourced = fixture(); unsourced.terms[0].service_source_id = null as unknown as string;
  assert.throws(() => readStatePublication(envelope(unsourced), new Date("2026-11-08")), /invalid term/);
});

test("terms age with the calendar instead of failing the read", () => {
  const data = fixture(); data.terms[0].ends_on = "2026-12-01";
  assert.equal(readStatePublication(envelope(data), new Date("2026-11-30T12:00:00Z")).members[0].term.status, "serving");
  assert.throws(() => readStatePublication(envelope(data), new Date("2026-12-01T12:00:00Z")), /no serving members/);
  const incoming = fixture();
  incoming.people.push({ ...incoming.people[0], id: "next" });
  incoming.endorsements.push({ ...incoming.endorsements[0], id: "e2", person_id: "next" });
  incoming.reconciliations.push({ ...incoming.reconciliations[0], id: "r2", endorsement_id: "e2", term_id: "t2" });
  incoming.terms.push({ ...incoming.terms[0], id: "t2", person_id: "next", status: "incoming", starts_on: "2027-01-01", ends_on: null as unknown as string, service_source_id: null as unknown as string });
  const before = readStatePublication(envelope(incoming), new Date("2026-12-31T12:00:00Z")).members;
  assert.deepEqual(before.map((m) => m.term.status), ["serving", "incoming"]);
  const after = readStatePublication(envelope(incoming), new Date("2027-01-01T12:00:00Z")).members;
  assert.deepEqual(after.map((m) => [m.id, m.term.status, m.service === undefined]), [["synthetic", "serving", false], ["next", "serving", true]]);
});

test("termStatus derives the effective status from stored status and dates", () => {
  const today = new Date("2026-12-01T12:00:00Z");
  const term = (status: "serving" | "incoming" | "ended" | "unresolved", starts_on: string, ends_on: string | null) => ({ status, starts_on, ends_on });
  assert.equal(termStatus(term("serving", "2026-01-01", "2026-12-01"), today), "ended");
  assert.equal(termStatus(term("incoming", "2026-01-01", "2026-11-30"), today), "ended");
  assert.equal(termStatus(term("serving", "2026-01-01", "2026-12-02"), today), "serving");
  assert.equal(termStatus(term("serving", "2026-01-01", null), today), "serving");
  assert.equal(termStatus(term("incoming", "2026-12-01", null), today), "serving");
  assert.equal(termStatus(term("incoming", "2026-12-02", null), today), "incoming");
  assert.equal(termStatus(term("ended", "2026-01-01", null), today), "ended");
  assert.equal(termStatus(term("unresolved", "2026-01-01", null), today), "unresolved");
});

const realCounts = (day: string) => {
  const counts = { serving: 0, incoming: 0 };
  for (const m of readStatePublication(realPublication, new Date(`${day}T12:00:00Z`)).members) counts[m.term.status as "serving" | "incoming"]++;
  return counts;
};

test("the committed publication reads on every date around term changes", () => {
  for (const day of ["2026-11-16", "2026-11-29", "2026-11-30", "2026-12-01", "2027-01-01", "2027-01-11", "2027-01-12"]) {
    assert.doesNotThrow(() => readStatePublication(realPublication, new Date(`${day}T12:00:00Z`)), day);
  }
});

test("the committed publication keeps its 2026-11-16 listing", () => {
  assert.deepEqual(realCounts("2026-11-16"), { serving: 227, incoming: 144 });
});

test("terms ending 2026-11-30 drop out and terms starting 2026-12-01 begin serving", () => {
  const ids = (day: string) => new Set(readStatePublication(realPublication, new Date(`${day}T12:00:00Z`)).members.map((m) => m.term.id));
  const terms = realPublication.snapshot.terms;
  const ending = terms.filter((t) => t.ends_on?.startsWith("2026-11-30")).map((t) => t.id);
  const starting = terms.filter((t) => t.starts_on.startsWith("2026-12-01")).map((t) => t.id);
  assert.equal(ending.length, 14);
  assert.equal(starting.length, 12);
  assert.ok(ending.every((id) => ids("2026-11-29").has(id) && !ids("2026-11-30").has(id)));
  const dec = readStatePublication(realPublication, new Date("2026-12-01T12:00:00Z")).members;
  assert.ok(starting.every((id) => dec.find((m) => m.term.id === id)?.term.status === "serving"));
});

test("after the last start date no member is still incoming", () => {
  assert.equal(realCounts("2027-01-12").incoming, 0);
});

test("a seat cannot list more incoming winners than it holds", () => {
  const data = fixture();
  for (const n of [1, 2, 3]) {
    data.people.push({ ...data.people[0], id: `p${n}` });
    data.endorsements.push({ ...data.endorsements[0], id: `e${n}`, person_id: `p${n}` });
    data.terms.push({ ...data.terms[0], id: `t${n}`, person_id: `p${n}`, status: "incoming", starts_on: "2027-01-01" });
    data.reconciliations.push({ ...data.reconciliations[0], id: `r${n}`, endorsement_id: `e${n}`, term_id: `t${n}` });
  }
  assert.throws(() => readStatePublication(envelope(data), new Date("2026-11-08")), /seat capacity exceeded/);
  data.terms.pop();
  assert.equal(readStatePublication(envelope(data), new Date("2026-11-08")).members.length, 3);
});

test("uncalled races are not listed", () => {
  const data = fixture();
  data.terms.push({ ...data.terms[0], id: "race", status: "unresolved", starts_on: "2027-01-01", ends_on: null as unknown as string, service_source_id: null as unknown as string });
  data.reconciliations.push({ ...data.reconciliations[0], id: "race-decision", endorsement_id: "race-endorsement", term_id: "race" });
  data.endorsements.push({ ...data.endorsements[0], id: "race-endorsement" });
  const members = readStatePublication(envelope(data), new Date("2026-11-08")).members;
  assert.deepEqual(members.map((m) => m.term.id), ["term"]);
});

test("primary endorsement qualifies only for its linked election", () => {
  const data = fixture();
  data.elections.push({ id: "primary", seat_id: "seat", year: 2026, stage: "primary", cycle_election_id: "election" });
  data.endorsements[0].election_id = "primary";
  assert.equal(readStatePublication(envelope(data), new Date("2026-11-08")).members.length, 1);
  data.elections[1].cycle_election_id = "different-election";
  assert.throws(() => readStatePublication(envelope(data), new Date("2026-11-08")), /missing evidence/);
});

/**
 * A JSON deep copy, used at exactly one boundary: what a provider hands back.
 *
 * The reason is not hygiene, it is determinism. A fixture is a module level object
 * and the response cache holds the object it served, so a caller that edits the
 * result (a UI merging a human correction into a description, say) would edit the
 * fixture and every later call would return the edited version. The suite that
 * asserts byte identical output across runs would still pass, because it never
 * mutates, and the demo would drift anyway.
 *
 * `JSON.parse(JSON.stringify(...))` rather than `structuredClone` deliberately:
 * every AI output is plain JSON by construction (the schemas allow nothing else),
 * `structuredClone` is missing from some of the runtimes this has to work in
 * including parts of the test environment, and the round trip preserves key
 * insertion order, which matters because canonical hashing is asserted elsewhere.
 */

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

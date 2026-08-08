/**
 * Authored phrasing for the computed coverage cells.
 *
 * The model's whole job in the gap scan is two things code cannot do: phrase a
 * cell as a shot a creator can read, and notice when several cells are one
 * editorial idea. Demand, supply, deficit and severity were all computed before
 * this call, so nothing here scores anything, and there is no field in the schema
 * to put a score into even if a fixture wanted to.
 *
 * Keyed by `cell_signature`, which is echoed back byte for byte rather than
 * regenerated. A signature this file altered would not rejoin the computed cell,
 * and the phrasing would attach to the wrong gap.
 *
 * ## Deliberate imperfection
 *
 * Two cells share a `cluster_label`, because the arrival shot and the greeting shot
 * are one story and a gaps list that reads as two separate needs gets two separate
 * brief items for the same footage. One cell's rationale argues against its own
 * gap, which is allowed and useful: the scan computed it, and the model is entitled
 * to say it is a bad idea rather than dress it up.
 */

import type { AuthoredFixture } from './types'

export interface GapCellBody {
  title: string
  shot_instruction: string
  rationale: string
  cluster_label: string | null
}

export type GapScanFixture = AuthoredFixture<GapCellBody> & {
  /** The computed cell signature this phrasing belongs to. */
  cell_signature: string
}

/** Signatures are `key=value` pairs joined by `|` with keys sorted. See seed `signatureOf`. */
const ARRIVAL_CLUSTER = 'The arrival sequence'

export const GAP_SCAN_FIXTURES: readonly GapScanFixture[] = [
  {
    id: 'gap_scan.exterior-wide',
    cell_signature: 'room=exterior|shot_type=wide',
    provenance: { artefact: 'src/data/seed.ts gap-exterior-arrival', sha256: null },
    latency_ms: 480,
    imperfection: null,
    output: {
      title: 'Arriving at the building',
      shot_instruction:
        'From across the street, film the entrance in one steady vertical shot while somebody walks in. Waist height, no zoom.',
      rationale:
        'Seven zero result searches in thirty days for arrival and exterior, against no approved exterior footage at all.',
      cluster_label: ARRIVAL_CLUSTER,
    },
  },
  {
    id: 'gap_scan.reception-medium',
    cell_signature: 'room=reception|shot_type=medium',
    provenance: { artefact: 'src/data/seed.ts gap-reception-greeting', sha256: null },
    latency_ms: 460,
    imperfection:
      'Shares a cluster with the exterior cell. Two computed cells, one editorial need, and the manager should see that before it becomes two brief items.',
    output: {
      title: 'The welcome at the desk',
      shot_instruction:
        'Stand in the doorway and film the front desk as a guest is welcomed. Hands, counter and the greeting; no faces needed.',
      rationale:
        'Repeated searches for greeting and welcome return the empty lobby wide, which is the only reception clip approved.',
      cluster_label: ARRIVAL_CLUSTER,
    },
  },
  {
    id: 'gap_scan.wet-room-macro',
    cell_signature: 'room=wet_room|shot_type=macro',
    provenance: { artefact: 'src/data/seed.ts gap-steam-detail', sha256: null },
    latency_ms: 500,
    imperfection: null,
    output: {
      title: 'Steam and running water',
      shot_instruction:
        'Close on water running into the wet room tub, framed so steam shows against the darker wall. Expect several attempts.',
      rationale: 'Steam room detail is a recurring zero result, and the two wet room clips held are both empty and still.',
      cluster_label: null,
    },
  },
  {
    id: 'gap_scan.treatment-room-warm',
    cell_signature: 'light=warm_light|room=treatment_room',
    provenance: { artefact: 'src/data/seed.ts gap-golden-hour', sha256: null },
    latency_ms: 520,
    imperfection: null,
    output: {
      title: 'The treatment room late in the day',
      shot_instruction: 'Film the treatment room when the light through the curtain has gone warm, one held wide and one closer.',
      rationale:
        'Searches for golden hour and warm light land on daylight footage, so the cell has demand and the wrong kind of supply.',
      cluster_label: null,
    },
  },
  {
    id: 'gap_scan.palo-alto-treatment',
    cell_signature: 'branch=branch-palo-alto|room=treatment_room',
    provenance: { artefact: 'src/data/seed.ts gap-pa-treatment', sha256: null },
    latency_ms: 470,
    imperfection:
      'The rationale says out loud that this cell has no demand signal behind it, only a coverage target. That is the cold start case and it should read differently from a gap editors actually asked for.',
    output: {
      title: 'Palo Alto has almost nothing',
      shot_instruction: 'Film the Palo Alto treatment room twice: one wide from the door, one closer on the table dressed.',
      rationale:
        'No search demand at this branch yet, only an unmet coverage target. Worth one visit, not a priority over San Jose.',
      cluster_label: null,
    },
  },
  {
    id: 'gap_scan.lounge-wide',
    cell_signature: 'room=lounge|shot_type=wide',
    provenance: { artefact: 'src/data/seed.ts gap-lounge-wide', sha256: null },
    latency_ms: 440,
    imperfection: null,
    output: {
      title: 'The lounge, more than one angle',
      shot_instruction: 'One wide of the lounge with the chairs empty, from the low corner so the ceiling shows.',
      rationale:
        'One approved lounge clip is used across three campaigns, so the cell looks covered and is effectively depth one.',
      cluster_label: null,
    },
  },
  {
    id: 'gap_scan.sauna-medium',
    cell_signature: 'room=sauna|shot_type=medium',
    provenance: { artefact: 'src/data/seed.ts gap-sauna-medium', sha256: null },
    latency_ms: 430,
    imperfection: null,
    output: {
      title: 'Inside the sauna, not the door',
      shot_instruction: 'Film inside the sauna from the bench, taking in the stove and the wood, one steady shot.',
      rationale: 'Every approved sauna clip is shot from the corridor, so the room itself has no coverage.',
      cluster_label: null,
    },
  },
  {
    id: 'gap_scan.moody-macro',
    cell_signature: 'shot_type=macro|vibe=moody',
    provenance: { artefact: 'src/data/seed.ts gap-product-dark', sha256: null },
    latency_ms: 455,
    imperfection: null,
    output: {
      title: 'Product, but dark',
      shot_instruction: 'Overhead flatlay of two bottles and a sprig on dark cloth, hard side light, labels away from camera.',
      rationale: 'Product footage is all high key, and the darker campaign brief has nothing in the library to cut with.',
      cluster_label: null,
    },
  },
  {
    id: 'gap_scan.towels-macro',
    cell_signature: 'shot_type=macro|subject=towels',
    provenance: { artefact: 'src/data/seed.ts gap-towels-macro', sha256: null },
    latency_ms: 425,
    imperfection:
      'The rationale argues against the gap it was given. The scan computed the cell and the phrasing is entitled to say it is thin, which is more useful to a manager than a tidy sentence.',
    output: {
      title: 'Towel texture, close',
      shot_instruction: 'Macro on folded towels with side light, close enough that the weave reads.',
      rationale:
        'Only two searches behind this, both from one session. Cheap to shoot alongside anything else, but not worth a slot of its own.',
      cluster_label: null,
    },
  },
]

export const GAP_SCAN_BY_SIGNATURE: ReadonlyMap<string, GapScanFixture> = new Map(
  GAP_SCAN_FIXTURES.map((fixture) => [fixture.cell_signature, fixture] as const),
)

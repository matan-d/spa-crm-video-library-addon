/**
 * THE SELECTOR CONTRACT.
 *
 * Every `data-testid` the three role runs and the loop run need, in one place.
 * The UI is being built against this file, so a change here is a change to an
 * interface two workstreams depend on: add ids freely, rename one only with the
 * UI in the same commit.
 *
 * Four rules the names follow.
 *
 * 1. Names describe behaviour or the thing itself, never appearance and never a
 *    CSS class. `review-approve` survives a redesign, `green-button-2` does not.
 * 2. A repeated row gets ONE constant id plus an entity id in a data attribute:
 *    `data-testid="result-tile" data-asset-id="..."`. So "any tile" is one
 *    selector and "that tile" is `sel(RESULT_TILE, { [ATTR_ASSET_ID]: id })`.
 *    Interpolating the id into the testid itself makes "any tile" unwritable.
 * 3. State that a test asserts lives in a data attribute, not in the class list
 *    and not in visible text. Text is translated and restyled, `data-status` is
 *    not. Four valued pre-flight states in particular must be readable as data:
 *    `pass`, `fail`, `unknown`, `skipped`.
 * 4. The loop run asserts ids, never screenshots. So every row that carries a
 *    link in the chain (gap, gap scan, brief, brief item, asset, review action,
 *    usage event) exposes that id as a data attribute. Without these the flagship
 *    test cannot exist.
 *
 * Layout: one group per surface, with a comment saying what the run does with it.
 */

// ---------------------------------------------------------------------------
// Selector builders
// ---------------------------------------------------------------------------

/** `testid('app-root')` -> `[data-testid="app-root"]` */
export const testid = (id) => `[data-testid="${id}"]`

/**
 * `sel(RESULT_TILE, { 'data-asset-id': id })`
 * -> `[data-testid="result-tile"][data-asset-id="..."]`
 */
export function sel(id, attrs = {}) {
  return (
    testid(id) +
    Object.entries(attrs)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `[${k}="${String(v)}"]`)
      .join('')
  )
}

// ---------------------------------------------------------------------------
// DATA ATTRIBUTES: the id chain and the machine readable state.
// The loop run reads these off the DOM to prove gap -> brief item -> asset ->
// review action -> published -> usage -> gap closed, hop by hop.
// ---------------------------------------------------------------------------

export const ATTR_ASSET_ID = 'data-asset-id'
export const ATTR_DELIVERY_ID = 'data-delivery-id'
export const ATTR_COLLAB_ID = 'data-collab-id'
export const ATTR_CREATOR_ID = 'data-creator-id'
export const ATTR_BRIEF_ID = 'data-brief-id'
export const ATTR_BRIEF_ITEM_ID = 'data-brief-item-id'
export const ATTR_ORIGIN_GAP_ID = 'data-origin-gap-id'
export const ATTR_GAP_ID = 'data-gap-id'
export const ATTR_GAP_SCAN_ID = 'data-gap-scan-id'
export const ATTR_CELL_SIGNATURE = 'data-cell-signature'
export const ATTR_REVIEW_ACTION_ID = 'data-review-action-id'
export const ATTR_REVIEW_SESSION_ID = 'data-review-session-id'
export const ATTR_USAGE_EVENT_ID = 'data-usage-event-id'
export const ATTR_SEARCH_QUERY_LOG_ID = 'data-search-query-log-id'
export const ATTR_AI_RUN_ID = 'data-ai-run-id'
export const ATTR_CONSENT_ID = 'data-consent-id'
export const ATTR_TOKEN = 'data-token'

/** State, four valued or enumerated, always as data rather than as styling. */
export const ATTR_STATUS = 'data-status'
export const ATTR_RULE = 'data-rule'
export const ATTR_VERDICT = 'data-verdict'
export const ATTR_BLOCKING = 'data-blocking'
export const ATTR_REASON = 'data-reason'
export const ATTR_SOURCE = 'data-source'
export const ATTR_PROVENANCE = 'data-provenance'
export const ATTR_ROLE = 'data-role'
export const ATTR_BUCKET = 'data-bucket'
export const ATTR_FACET = 'data-facet'
export const ATTR_FACET_VALUE = 'data-value'
export const ATTR_TERM = 'data-term'
export const ATTR_MAPPED_TO = 'data-mapped-to'
export const ATTR_RANK = 'data-rank'
export const ATTR_RANK_AT_EVENT = 'data-rank-at-event'
export const ATTR_COUNT = 'data-count'
export const ATTR_SEQ = 'data-seq'
export const ATTR_TIER = 'data-tier'
export const ATTR_BYTES = 'data-bytes'
export const ATTR_UPLOAD_STATE = 'data-upload-state'
export const ATTR_MEDIA_STATE = 'data-media-state'
export const ATTR_DERIVATIVE_STATE = 'data-derivative-state'
export const ATTR_FILE_NAME = 'data-file-name'
export const ATTR_DECISION = 'data-decision'
export const ATTR_CAPTURED_AT_SOURCE = 'data-captured-at-source'
export const ATTR_DURATION_S = 'data-duration-s'
export const ATTR_DISTANCE_M = 'data-distance-m'
export const ATTR_SEED_VERSION = 'data-seed-version'
export const ATTR_PROVIDER = 'data-provider'
export const ATTR_CAPABILITY = 'data-capability'
export const ATTR_IS_CURRENT = 'data-is-current'
export const ATTR_CONSENT_VERSION = 'data-consent-version'
export const ATTR_ACCEPTED_AT = 'data-accepted-at'
export const ATTR_TOTAL = 'data-total'
export const ATTR_CURSOR_INDEX = 'data-cursor-index'
export const ATTR_COVERAGE_PCT = 'data-coverage-pct'
export const ATTR_DELIVERED_COUNT = 'data-delivered-count'
export const ATTR_SEVERITY = 'data-severity'
export const ATTR_OFFSET_BYTES = 'data-offset-bytes'
export const ATTR_ROTATION_SOURCE = 'data-rotation-source'
export const ATTR_EXTRACTOR_PATH = 'data-extractor-path'
export const ATTR_POLICY_TIER = 'data-policy-tier'
/** Sync: which table a row is about, and how a queued write is doing. */
export const ATTR_STORE = 'data-store'
export const ATTR_OP = 'data-op'
export const ATTR_STATE = 'data-state'
/** Which merge primitive refused a value: write_once, ordinal, sticky, coupled, implies. */
export const ATTR_POLICY = 'data-policy'
export const ATTR_DIRECTION = 'data-direction'
export const ATTR_ADAPTER = 'data-adapter'

/** Enumerated values the runs compare against, so a typo is a lint error here. */
export const ROLE_MANAGER = 'manager'
export const ROLE_EDITOR = 'editor'
export const ROLE_CREATOR = 'creator'

export const RULE_STATUS_PASS = 'pass'
export const RULE_STATUS_FAIL = 'fail'
export const RULE_STATUS_UNKNOWN = 'unknown'
export const RULE_STATUS_SKIPPED = 'skipped'

export const PREFLIGHT_RULES = [
  'orientation',
  'min_duration',
  'min_resolution',
  'capture_date',
  'near_branch',
  'duplicate',
  'codec_playable',
]

/** Diff and checklist buckets, per `docs/01-architecture-review.md` A.18. */
export const BUCKET_MATCHED = 'matched'
export const BUCKET_EXTRAS = 'extras'
export const BUCKET_AWAITING_DERIVATIVES = 'awaiting_derivatives'
export const ITEM_STATUS_MET = 'met'
export const ITEM_STATUS_MISSING = 'missing'
export const ITEM_STATUS_INDETERMINATE = 'indeterminate'

// ---------------------------------------------------------------------------
// GROUP 1: app shell and role switcher.
// Every run starts here: it proves the app mounted, switches to the role under
// test, and reads the seeded state marker so a run never races hydration. The
// tenancy assertion "no role bleed through a cached view" is also driven from
// here, by switching roles and re-reading the surfaces.
// ---------------------------------------------------------------------------

export const APP_ROOT = 'app-root'
export const APP_NAV = 'app-nav'
export const APP_MAIN = 'app-main'
export const APP_LOADING = 'app-loading'
export const APP_ERROR_BANNER = 'app-error-banner'
export const APP_VERSION = 'app-version'

/** Hydration finished. Carries ATTR_SEED_VERSION and ATTR_COUNT (assets seeded). */
export const SEED_READY = 'seed-ready'
export const SEED_SUMMARY = 'seed-summary'

export const ROLE_SWITCHER = 'role-switcher'
/** One per role, carrying ATTR_ROLE. `sel(ROLE_OPTION, { [ATTR_ROLE]: ROLE_EDITOR })` */
export const ROLE_OPTION = 'role-option'
/** The current role, carrying ATTR_ROLE. Read after a switch, never assumed. */
export const ACTIVE_ROLE = 'active-role'

export const PROFILE_SWITCHER = 'profile-switcher'
export const ACTIVE_PROFILE = 'active-profile'
export const AI_PROVIDER_SWITCHER = 'ai-provider-switcher'
export const ACTIVE_AI_PROVIDER = 'active-ai-provider'
/** Simulated output badge. Driven by asset.ai_provenance, never by current mode. */
export const SIMULATED_BADGE = 'simulated-badge'
export const THEME_TOGGLE = 'theme-toggle'

export const NAV_LIBRARY = 'nav-library'
export const NAV_TRIAGE = 'nav-triage'
export const NAV_DEALS = 'nav-deals'
export const NAV_BRIEFS = 'nav-briefs'
export const NAV_GAPS = 'nav-gaps'
export const NAV_CREATORS = 'nav-creators'
export const NAV_DATA_HEALTH = 'nav-data-health'
export const NAV_STORAGE = 'nav-storage'
export const NAV_SYNC = 'nav-sync'

export const SYNC_STATUS = 'sync-status'
export const OUTBOX_PENDING_COUNT = 'outbox-pending-count'
export const OFFLINE_BANNER = 'offline-banner'

// The sync panel, GROUP 14 below. SYNC_STATUS and OUTBOX_PENDING_COUNT stay
// here because the shell may surface them outside the panel later.

// ---------------------------------------------------------------------------
// GROUP 2: editor library, search and results.
// The editor run types plain language, checks the query was parsed and that the
// taxonomy mapping is visible and removable, refines with facets, and reads the
// rank off a tile so the usage signal can be checked against it later.
// ---------------------------------------------------------------------------

export const LIBRARY_ROOT = 'library'
export const LIBRARY_SEARCH_INPUT = 'library-search-input'
export const LIBRARY_SEARCH_SUBMIT = 'library-search-submit'
export const LIBRARY_SEARCH_CLEAR = 'library-search-clear'

/** "Here is what we understood", carrying ATTR_SEARCH_QUERY_LOG_ID. */
export const SEARCH_PARSED_QUERY = 'search-parsed-query'
/** One chip per mapped term: ATTR_TERM ("golden hour"), ATTR_MAPPED_TO ("warm_light"). */
export const SEARCH_TERM_CHIP = 'search-term-chip'
export const SEARCH_TERM_CHIP_REMOVE = 'search-term-chip-remove'
/** A term the taxonomy could not map. Surfaced, never silently dropped. */
export const SEARCH_UNMAPPED_TERM = 'search-unmapped-term'
/**
 * Offered only when the vocabulary could not place a word, because a model has
 * nothing to add to a query the floor already understood.
 */
export const SEARCH_ASK_MODEL = 'search-ask-model'
/** Present when the parse came from a model, so provenance stays visible. */
export const SEARCH_PARSE_PROVENANCE = 'search-parse-provenance'

export const RESULT_GRID = 'library-result-grid'
/** Carries ATTR_COUNT. The editor run compares it against the tile count. */
export const RESULT_COUNT = 'library-result-count'
/** One per result: ATTR_ASSET_ID, ATTR_RANK (1 based), ATTR_PROVENANCE. */
export const RESULT_TILE = 'result-tile'
/** The poster `<img>`. Boot and editor runs assert it actually decoded. */
export const RESULT_TILE_POSTER = 'result-tile-poster'
export const RESULT_TILE_DURATION = 'result-tile-duration'
export const RESULT_TILE_AI_SCORE = 'result-tile-ai-score'
export const RESULT_TILE_CREATOR_CREDIT = 'result-tile-creator-credit'
export const RESULT_TILE_ADD_TO_BIN = 'result-tile-add-to-bin'
export const RESULT_GRID_LOAD_MORE = 'library-load-more'

/** Facet groups are derived from the results, so the group id is data driven. */
export const FACET_PANEL = 'facet-panel'
export const FACET_GROUP = 'facet-group'
/** ATTR_FACET ('orientation'), ATTR_FACET_VALUE ('vertical'), aria-pressed. */
export const FACET_CHIP = 'facet-chip'
export const FACET_CHIP_COUNT = 'facet-chip-count'
export const FACET_CLEAR_ALL = 'facet-clear-all'
export const FACET_ACTIVE_SUMMARY = 'facet-active-summary'

// ---------------------------------------------------------------------------
// GROUP 3: the zero result ladder and the request a shot action.
// This is the product thesis compressed into one surface, so the editor run
// asserts the ladder is never a bare empty state: the parse is shown, the
// relaxed term is named, near matches appear, and one action writes a gap.
// ---------------------------------------------------------------------------

export const ZERO_RESULT = 'zero-result-state'
/** Names the facet that was dropped to produce near matches ("ignoring: morning"). */
export const ZERO_RESULT_RELAXED_NOTE = 'zero-result-relaxed-note'
export const ZERO_RESULT_NEAR_MATCHES = 'zero-result-near-matches'
export const ZERO_RESULT_NEAR_MATCH_COUNT = 'zero-result-near-match-count'
/** The one tap "add this to the next brief". Prominent by requirement. */
export const REQUEST_SHOT = 'request-shot'
export const REQUEST_SHOT_FORM = 'request-shot-form'
export const REQUEST_SHOT_NOTE = 'request-shot-note'
export const REQUEST_SHOT_SUBMIT = 'request-shot-submit'
/** Carries ATTR_GAP_ID and ATTR_CELL_SIGNATURE: hop one of the loop chain. */
export const REQUEST_SHOT_CONFIRMATION = 'request-shot-confirmation'

// ---------------------------------------------------------------------------
// GROUP 4: the bin, the download, and the usage signal.
// The editor run adds clips to a bin, downloads, and then proves a usage_event
// was written with the rank the clip actually held at the moment of the event.
// ---------------------------------------------------------------------------

export const BIN_TOGGLE = 'bin-toggle'
export const BIN_PANEL = 'bin-panel'
export const BIN_COUNT = 'bin-count'
/** One per binned clip, carrying ATTR_ASSET_ID. */
export const BIN_ITEM = 'bin-item'
export const BIN_ITEM_REMOVE = 'bin-item-remove'
export const BIN_DOWNLOAD = 'bin-download'
export const BIN_HANDOFF = 'bin-handoff'
export const BIN_CLEAR = 'bin-clear'
/** ATTR_USAGE_EVENT_ID, ATTR_ASSET_ID, ATTR_RANK_AT_EVENT: the usage hop. */
export const USAGE_CONFIRMATION = 'usage-confirmation'
export const USAGE_EVENT_ROW = 'usage-event-row'

// ---------------------------------------------------------------------------
// GROUP 5: the clip sheet.
// Opened from a tile. The editor run reads the credit line and the AI versus
// human tag split here, and the tenancy run asserts no creator or collab field
// is present on this surface at all.
// ---------------------------------------------------------------------------

export const CLIP_SHEET = 'clip-sheet'
export const CLIP_SHEET_CLOSE = 'clip-sheet-close'
export const CLIP_SHEET_POSTER = 'clip-sheet-poster'
export const CLIP_SHEET_CONTACT_SHEET = 'clip-sheet-contact-sheet'
/** One tile per extracted frame: ATTR_SEQ, and the reached time as data. */
export const CONTACT_SHEET_FRAME = 'contact-sheet-frame'
export const CLIP_SHEET_TAGS_AI = 'clip-sheet-tags-ai'
export const CLIP_SHEET_TAGS_HUMAN = 'clip-sheet-tags-human'
export const CLIP_SHEET_TAG = 'clip-sheet-tag'
/** "Why did the AI say this": the ai_run behind the field, ATTR_AI_RUN_ID. */
export const CLIP_SHEET_AI_RATIONALE = 'clip-sheet-ai-rationale'
export const CLIP_SHEET_FACTS = 'clip-sheet-facts'
export const CLIP_SHEET_CREATOR_CREDIT = 'clip-sheet-creator-credit'
export const CLIP_SHEET_USED_IN = 'clip-sheet-used-in'
export const CLIP_SHEET_DOWNLOAD = 'clip-sheet-download'
export const CLIP_SHEET_ADD_TO_BIN = 'clip-sheet-add-to-bin'

// ---------------------------------------------------------------------------
// GROUP 6: manager triage inbox.
// The manager run opens the inbox, which is the real product surface, and
// asserts the delivery is grouped by brief item and bucketed by what is
// actionable rather than by arrival order.
// ---------------------------------------------------------------------------

export const TRIAGE_ROOT = 'triage-inbox'
/** ATTR_BUCKET: needs_review | awaiting_derivatives | blocked | done. */
export const TRIAGE_BUCKET = 'triage-bucket'
export const TRIAGE_BUCKET_COUNT = 'triage-bucket-count'
/** ATTR_DELIVERY_ID, ATTR_COLLAB_ID, ATTR_COUNT (clips awaiting a decision). */
export const TRIAGE_DELIVERY_ROW = 'triage-delivery-row'
export const TRIAGE_DELIVERY_CREATOR = 'triage-delivery-creator'
export const TRIAGE_DELIVERY_BRANCH = 'triage-delivery-branch'
export const TRIAGE_OPEN_DELIVERY = 'triage-open-delivery'
export const TRIAGE_START_REVIEW = 'triage-start-review'
export const TRIAGE_EMPTY = 'triage-empty'

// ---------------------------------------------------------------------------
// GROUP 7: the deal drawer and the promise versus delivered diff.
// Three buckets, not two: matched, extras, and awaiting derivatives. The manager
// run asserts the extras bucket is real and that an item with no sheet reads as
// indeterminate rather than as a miss.
// ---------------------------------------------------------------------------

export const DEAL_DRAWER = 'deal-drawer'
export const DIFF_ROOT = 'promised-vs-delivered'
export const DIFF_COVERAGE_PCT = 'diff-coverage-pct'
/** ATTR_BRIEF_ITEM_ID, ATTR_SEQ, ATTR_STATUS (met|missing|indeterminate). */
export const DIFF_ITEM_ROW = 'diff-item-row'
export const DIFF_ITEM_PROMISED = 'diff-item-promised'
export const DIFF_ITEM_DELIVERED = 'diff-item-delivered'
/** Present when the item came from a gap: ATTR_GAP_ID. Loop chain hop. */
export const DIFF_ITEM_ORIGIN_GAP = 'diff-item-origin-gap'
export const DIFF_BUCKET_MATCHED = 'diff-bucket-matched'
export const DIFF_BUCKET_EXTRAS = 'diff-bucket-extras'
export const DIFF_BUCKET_AWAITING_DERIVATIVES = 'diff-bucket-awaiting-derivatives'
export const DIFF_EXTRA_ASSET = 'diff-extra-asset'

// ---------------------------------------------------------------------------
// GROUP 8: the review queue.
// Keyboard driven on desktop over a frozen ordered list. The manager run drives
// next / approve / reject, asserts a decided row is dimmed in place rather than
// removed, and asserts a stale row is refused instead of silently acted on.
// ---------------------------------------------------------------------------

export const REVIEW_ROOT = 'review-queue'
/** ATTR_REVIEW_SESSION_ID, ATTR_CURSOR_INDEX, ATTR_TOTAL. */
export const REVIEW_PROGRESS = 'review-progress'
export const REVIEW_ORDERED_LIST = 'review-ordered-list'
/** One row per asset in the frozen order: ATTR_ASSET_ID, ATTR_SEQ, ATTR_DECISION. */
export const REVIEW_ROW = 'review-row'
export const REVIEW_CURRENT_ASSET = 'review-current-asset'
export const REVIEW_NEXT = 'review-next'
export const REVIEW_PREV = 'review-prev'
export const REVIEW_SKIP = 'review-skip'
export const REVIEW_APPROVE = 'review-approve'
export const REVIEW_REJECT = 'review-reject'
export const REVIEW_UNDO = 'review-undo'
/** ATTR_ASSET_ID, ATTR_DECISION, ATTR_REVIEW_ACTION_ID. Dimmed, never removed. */
export const REVIEW_DECIDED_BADGE = 'review-decided-badge'
export const REVIEW_KEYBOARD_HINT = 'review-keyboard-hint'
/** Mid session arrivals are offered, never spliced in: ATTR_COUNT. */
export const REVIEW_PENDING_ADDITIONS = 'review-pending-additions'
export const REVIEW_ACCEPT_ADDITIONS = 'review-accept-additions'
/** Shown when the row under the cursor changed underneath the reviewer. */
export const REVIEW_STALE_REFUSAL = 'review-stale-refusal'

export const REVIEW_REJECT_DIALOG = 'review-reject-dialog'
/** Manager only. The creator run must never find this text anywhere. */
export const REJECT_INTERNAL_NOTE = 'reject-internal-note'
/** The redacted note the creator actually sees. Different field, on purpose. */
export const REJECT_CREATOR_NOTE = 'reject-creator-note'
export const REJECT_REASON_SELECT = 'reject-reason-select'
export const REJECT_CONFIRM = 'reject-confirm'
export const REJECT_CANCEL = 'reject-cancel'

export const PUBLISH_TO_LIBRARY = 'publish-to-library'
/** ATTR_ASSET_ID: the published hop of the loop chain. */
export const PUBLISH_CONFIRMATION = 'publish-confirmation'
export const PUBLISH_BLOCKED_REASON = 'publish-blocked-reason'

// ---------------------------------------------------------------------------
// GROUP 9: the pre-flight verdict panel, shared by two surfaces.
// The same component renders on the creator upload page (per file) and in the
// manager review (per asset), so both runs assert against one set of ids. Four
// valued status is read from ATTR_STATUS, never from colour.
// ---------------------------------------------------------------------------

export const PREFLIGHT_PANEL = 'preflight-panel'
export const PREFLIGHT_ROLLUP = 'preflight-rollup'
/** ATTR_RULE, ATTR_STATUS, ATTR_BLOCKING, and ATTR_REASON when not a pass. */
export const PREFLIGHT_RULE = 'preflight-rule'
export const PREFLIGHT_RULE_VALUE = 'preflight-rule-value'
export const PREFLIGHT_RULE_REASON = 'preflight-rule-reason'
/** Grey dash for unknown. Must be distinguishable from pass and from fail. */
export const PREFLIGHT_UNKNOWN_MARK = 'preflight-unknown-mark'
/** Capture date, labelled with ATTR_CAPTURED_AT_SOURCE. Never "verified". */
export const CAPTURE_DATE_SOURCE = 'capture-date-source'
/** "no preview: HEVC, this browser has no decoder", plus what would fix it. */
export const NO_PREVIEW_CHIP = 'no-preview-chip'
/** A grey tile, not a broken video element and not an endless spinner. */
export const PLACEHOLDER_TILE = 'placeholder-tile'
export const REQUEST_H264_VERSION = 'request-h264-version'

// ---------------------------------------------------------------------------
// GROUP 10: manager gaps, briefs, and the invite link.
// The loop run turns an editor request into a brief item here, then reads the
// invite token to hand the run over to the creator surface.
// ---------------------------------------------------------------------------

export const GAPS_ROOT = 'gaps-panel'
export const GAP_SCAN_HEADER = 'gap-scan-header'
export const GAP_SCAN_RUN = 'gap-scan-run'
/** ATTR_GAP_ID, ATTR_CELL_SIGNATURE, ATTR_SEVERITY, ATTR_SOURCE, ATTR_STATUS. */
export const GAP_ROW = 'gap-row'
export const GAP_DEFICIT = 'gap-deficit'
export const GAP_EVIDENCE = 'gap-evidence'
export const GAP_FEED_TO_BRIEF = 'gap-feed-to-brief'
export const GAP_DISMISS = 'gap-dismiss'
export const GAP_CLOSED_BADGE = 'gap-closed-badge'
export const GAP_COVERAGE_BEFORE = 'gap-coverage-before'
export const GAP_COVERAGE_AFTER = 'gap-coverage-after'

export const BRIEF_ROOT = 'brief'
/** ATTR_BRIEF_ID, ATTR_GAP_SCAN_ID, ATTR_STATUS (draft|locked|superseded). */
export const BRIEF_HEADER = 'brief-header'
/** ATTR_BRIEF_ITEM_ID, ATTR_SEQ, ATTR_ORIGIN_GAP_ID. The brief hop. */
export const BRIEF_ITEM_ROW = 'brief-item-row'
export const BRIEF_ITEM_ADD = 'brief-item-add'
export const BRIEF_GENERATE_FROM_GAPS = 'brief-generate-from-gaps'
export const BRIEF_LOCK = 'brief-lock'
export const BRIEF_LOCKED_BADGE = 'brief-locked-badge'
/** ATTR_TOKEN: the creator link the creator run then opens. */
export const BRIEF_INVITE_LINK = 'brief-invite-link'
export const BRIEF_INVITE_COPY = 'brief-invite-copy'

// ---------------------------------------------------------------------------
// GROUP 10b: the creator roster, where the guess and the measurement sit side
// by side. The manager run asserts that the score's colour and its
// ATTR_PROVENANCE agree about who decided it, that an unmeasurable rate reads
// `unknown` rather than zero, and that the model refuses to re-score a creator
// a human blocked.
// ---------------------------------------------------------------------------

export const CREATORS_ROOT = 'creators'
export const CREATORS_SUMMARY = 'creators-summary'
/** ATTR_CREATOR_ID, `data-lifecycle`, `data-score-source` (human|model|none). */
export const CREATOR_ROW = 'creator-row'
/** ATTR_PROVENANCE is human, ai or none. Never the current mode. */
export const CREATOR_FIT_SCORE = 'creator-fit-score'
export const CREATOR_OVERRIDE_NOTE = 'creator-override-note'
export const CREATOR_RISK_FLAGS = 'creator-risk-flags'
export const CREATOR_SCORECARD = 'creator-scorecard'
export const SCORECARD_COMPLETED = 'scorecard-completed'
/** ATTR_STATUS is `known` or `unknown`. A rate with no denominator is unknown. */
export const SCORECARD_APPROVAL_RATE = 'scorecard-approval-rate'
export const SCORECARD_PROMISE_KEPT = 'scorecard-promise-kept'
export const SCORECARD_GHOSTED = 'scorecard-ghosted'
export const SCORECARD_DRIFT = 'scorecard-drift'
export const CREATOR_VET = 'creator-vet'
export const CREATOR_VET_RECEIPT = 'creator-vet-receipt'
export const CREATOR_VET_REFUSAL = 'creator-vet-refusal'
export const CREATOR_OVERRIDE = 'creator-override'
export const CREATOR_OVERRIDE_FORM = 'creator-override-form'
export const OVERRIDE_SCORE = 'override-score'
export const OVERRIDE_REASON = 'override-reason'
export const OVERRIDE_SAVE = 'override-save'
export const OVERRIDE_ERROR = 'override-error'

// ---------------------------------------------------------------------------
// GROUP 11: creator invite page.
// The creator run opens a token link, reads the locked brief, accepts consent,
// and continues. The tenancy run asserts no internal field (fit score, risk
// flags, comp value, gap reasoning) appears on this page at all.
// ---------------------------------------------------------------------------

export const INVITE_ROOT = 'creator-invite'
export const INVITE_BRANCH = 'invite-branch'
export const INVITE_VISIT_DATE = 'invite-visit-date'
export const INVITE_BRIEF_LIST = 'invite-brief-list'
/** ATTR_BRIEF_ITEM_ID, ATTR_SEQ. The creator sees the promise, nothing else. */
export const INVITE_BRIEF_ITEM = 'invite-brief-item'
/** Switch the iPhone camera to Most Compatible. Required, not a nicety (QC-MEDIA-049). */
export const INVITE_MOST_COMPATIBLE_INSTRUCTION = 'invite-most-compatible-instruction'
export const INVITE_HOW_TO_SHOOT = 'invite-how-to-shoot'
export const INVITE_TOKEN_INVALID = 'invite-token-invalid'
export const INVITE_TOKEN_EXPIRED = 'invite-token-expired'
export const INVITE_CONTINUE = 'invite-continue'

export const CONSENT_PANEL = 'consent-panel'
/** ATTR_CONSENT_VERSION: the record is immutable and versioned. */
export const CONSENT_TEXT = 'consent-text'
export const CONSENT_ACCEPT = 'consent-accept'
export const CONSENT_DECLINE = 'consent-decline'
/** ATTR_CONSENT_ID, ATTR_CONSENT_VERSION, ATTR_ACCEPTED_AT after accepting. */
export const CONSENT_RECORDED = 'consent-recorded'

// ---------------------------------------------------------------------------
// GROUP 12: creator upload page.
// The heart of the creator run: files go in through the real ingestFile() entry
// point, each row shows its own four valued verdict, the checklist tracks the
// locked brief, and reopening the same link resumes rather than restarting.
// ---------------------------------------------------------------------------

export const UPLOAD_ROOT = 'creator-upload'
/** ATTR_DELIVERY_ID: the delivery is one to many, so resume is possible. */
export const UPLOAD_DELIVERY = 'upload-delivery'
export const UPLOAD_FILE_INPUT = 'upload-file-input'
export const UPLOAD_DROPZONE = 'upload-dropzone'
export const UPLOAD_FILE_LIST = 'upload-file-list'
/** ATTR_FILE_NAME, ATTR_ASSET_ID, ATTR_UPLOAD_STATE, ATTR_MEDIA_STATE. */
export const UPLOAD_FILE_ROW = 'upload-file-row'
/** ATTR_VERDICT: ok | advisory | blocked | unknown, plus ATTR_COUNT of blocking fails. */
export const UPLOAD_FILE_VERDICT = 'upload-file-verdict'
export const UPLOAD_FILE_THUMB = 'upload-file-thumb'
/** ATTR_OFFSET_BYTES, so a resumed upload can be asserted rather than assumed. */
export const UPLOAD_FILE_PROGRESS = 'upload-file-progress'
export const UPLOAD_FILE_RETRY = 'upload-file-retry'
export const UPLOAD_FILE_REMOVE = 'upload-file-remove'
export const UPLOAD_FILE_MANUAL_ROTATE = 'upload-file-manual-rotate'
/** ATTR_COUNT: sidecars, proxies, RAW stills and system files are filtered, not failed. */
export const UPLOAD_FILTERED_NOTICE = 'upload-filtered-notice'
export const UPLOAD_BLOCKED_EXPLANATION = 'upload-blocked-explanation'

export const CHECKLIST_ROOT = 'creator-checklist'
/** ATTR_BRIEF_ITEM_ID, ATTR_STATUS, ATTR_DELIVERED_COUNT. Live against the lock. */
export const CHECKLIST_ITEM = 'checklist-item'
export const CHECKLIST_PROGRESS = 'checklist-progress'

/** Only for capture_date unknown. Writes captured_at_source='creator_stated'. */
export const CAPTURE_DATE_PROMPT = 'capture-date-prompt'
export const CAPTURE_DATE_INPUT = 'capture-date-input'
export const CAPTURE_DATE_CONFIRM = 'capture-date-confirm'
/**
 * Declared so a run can assert it is ABSENT. An unknown the creator cannot act on
 * must produce nothing at all, because surfacing it reads as a problem they
 * caused (QC-MEDIA-065). If this id ever appears in the DOM, that is the bug.
 */
export const NEAR_BRANCH_PROMPT_MUST_NOT_EXIST = 'near-branch-prompt'

export const UPLOAD_SUBMIT = 'upload-submit'
/** ATTR_DELIVERY_ID, ATTR_COUNT: what the creator was told was received. */
export const UPLOAD_SUBMIT_CONFIRMATION = 'upload-submit-confirmation'
/** ATTR_DELIVERY_ID, ATTR_COUNT: "you already sent 3 clips", on reopening the link. */
export const UPLOAD_RESUME_BANNER = 'upload-resume-banner'
export const UPLOAD_ALREADY_DELIVERED = 'upload-already-delivered'
/** The creator facing note after a rejection: ATTR_ASSET_ID. Redacted by design. */
export const CREATOR_FACING_REJECT_NOTE = 'creator-facing-reject-note'
/** The thin exemplar set a manager flagged. The only other creator visible data. */
export const CREATOR_EXEMPLARS = 'creator-exemplars'

// ---------------------------------------------------------------------------
// GROUP 13: storage and data health panels.
// Every run ends here in the loop test: the panels are where a claim about what
// is stored, what is queued and what the AI produced can be read as data rather
// than inferred. Also where an export or a reset is driven.
// ---------------------------------------------------------------------------

export const STORAGE_PANEL = 'storage-panel'
/** ATTR_BYTES on each, so the numbers are assertable without parsing prose. */
export const STORAGE_QUOTA_USED = 'storage-quota-used'
export const STORAGE_QUOTA_TOTAL = 'storage-quota-total'
export const STORAGE_BREAKDOWN_ROW = 'storage-breakdown-row'
/** ATTR_TIER: ample | standard | constrained, as probed on this machine. */
export const STORAGE_POLICY_TIER = 'storage-policy-tier'
export const STORAGE_EVICT_DERIVATIVES = 'storage-evict-derivatives'
export const STORAGE_PERSISTED_FLAG = 'storage-persisted-flag'

export const DATA_HEALTH_PANEL = 'data-health-panel'
/** One row per invariant: ATTR_STATUS, ATTR_COUNT, ATTR_REASON. */
export const DATA_HEALTH_ROW = 'data-health-row'
export const DATA_HEALTH_COUNTS = 'data-health-counts'
export const REINDEX_QUEUE_DEPTH = 'reindex-queue-depth'
/** ATTR_AI_RUN_ID, ATTR_PROVIDER, ATTR_CAPABILITY, ATTR_IS_CURRENT. */
export const AI_RUN_ROW = 'ai-run-row'
/**
 * Snapshot export and restore, on the storage panel rather than data health:
 * durability sits beside the eviction verdict it answers.
 * STORAGE_VERDICT is `first_run`, `intact` or `evicted`, never a bare count.
 */
export const STORAGE_VERDICT = 'storage-verdict'
export const EXPORT_SNAPSHOT = 'storage-export'
export const IMPORT_SNAPSHOT = 'storage-import'
export const EXPORT_SNAPSHOT_RECEIPT = 'storage-export-receipt'
export const IMPORT_SNAPSHOT_RECEIPT = 'storage-import-receipt'
export const RESET_DEMO_PROFILE = 'reset-demo-profile'
export const SEED_VERSION_LABEL = 'seed-version-label'

// ---------------------------------------------------------------------------
// GROUP 14: the sync panel.
// The honesty surface. A run reads the adapter label as data (it must say
// "loopback" and never "supabase"), drains the outbox, and asserts that a
// refused merge is listed as a conflict row rather than announced and lost.
// ---------------------------------------------------------------------------

export const SYNC_PANEL = 'sync-panel'
/** ATTR_ADAPTER. Plain text, and the one claim this panel is allowed to make. */
export const SYNC_ADAPTER = 'sync-adapter'
export const SYNC_PUSH = 'sync-push'
export const SYNC_PULL = 'sync-pull'
export const SYNC_LAST_RUN = 'sync-last-run'
/** ATTR_COUNT: rows the loopback server holds, so "it drained" is checkable. */
export const SYNC_SERVER_ROWS = 'sync-server-rows'
export const OUTBOX_SENT_COUNT = 'outbox-sent-count'
export const OUTBOX_FAILED_COUNT = 'outbox-failed-count'
/** Per table: ATTR_STORE, ATTR_COUNT (pending), plus sent and failed as data. */
export const OUTBOX_STORE_ROW = 'outbox-store-row'
/** One queued write: ATTR_SEQ, ATTR_STORE, ATTR_OP, ATTR_STATE. */
export const OUTBOX_ENTRY_ROW = 'outbox-entry-row'
/** The actual patch payload, verbatim JSON. Nothing here is summarised. */
export const OUTBOX_ENTRY_PATCH = 'outbox-entry-patch'
/** Per table cursor: ATTR_STORE, and the (server_updated_at, id) pair as data. */
export const SYNC_CURSOR_ROW = 'sync-cursor-row'
/** ATTR_STORE, ATTR_POLICY, ATTR_DIRECTION. A conflict is a record, not a toast. */
export const SYNC_CONFLICT_ROW = 'sync-conflict-row'
export const SYNC_CONFLICT_EMPTY = 'sync-conflict-empty'

// ---------------------------------------------------------------------------
// Contract self check: a duplicate id would make two surfaces indistinguishable
// to every test that uses it, so importing this file fails loudly instead.
// ---------------------------------------------------------------------------

const ALL = {
  APP_ROOT, APP_NAV, APP_MAIN, APP_LOADING, APP_ERROR_BANNER, APP_VERSION,
  SEED_READY, SEED_SUMMARY,
  ROLE_SWITCHER, ROLE_OPTION, ACTIVE_ROLE,
  PROFILE_SWITCHER, ACTIVE_PROFILE, AI_PROVIDER_SWITCHER, ACTIVE_AI_PROVIDER,
  SIMULATED_BADGE, THEME_TOGGLE,
  NAV_LIBRARY, NAV_TRIAGE, NAV_DEALS, NAV_BRIEFS, NAV_GAPS, NAV_CREATORS,
  NAV_DATA_HEALTH, NAV_STORAGE, NAV_SYNC,
  SYNC_STATUS, OUTBOX_PENDING_COUNT, OFFLINE_BANNER,
  SYNC_PANEL, SYNC_ADAPTER, SYNC_PUSH, SYNC_PULL, SYNC_LAST_RUN, SYNC_SERVER_ROWS,
  OUTBOX_SENT_COUNT, OUTBOX_FAILED_COUNT, OUTBOX_STORE_ROW, OUTBOX_ENTRY_ROW,
  OUTBOX_ENTRY_PATCH, SYNC_CURSOR_ROW, SYNC_CONFLICT_ROW, SYNC_CONFLICT_EMPTY,
  LIBRARY_ROOT, LIBRARY_SEARCH_INPUT, LIBRARY_SEARCH_SUBMIT, LIBRARY_SEARCH_CLEAR,
  SEARCH_PARSED_QUERY, SEARCH_TERM_CHIP, SEARCH_TERM_CHIP_REMOVE,
  SEARCH_UNMAPPED_TERM, SEARCH_ASK_MODEL, SEARCH_PARSE_PROVENANCE,
  RESULT_GRID, RESULT_COUNT, RESULT_TILE, RESULT_TILE_POSTER, RESULT_TILE_DURATION,
  RESULT_TILE_AI_SCORE, RESULT_TILE_CREATOR_CREDIT, RESULT_TILE_ADD_TO_BIN,
  RESULT_GRID_LOAD_MORE,
  FACET_PANEL, FACET_GROUP, FACET_CHIP, FACET_CHIP_COUNT, FACET_CLEAR_ALL,
  FACET_ACTIVE_SUMMARY,
  ZERO_RESULT, ZERO_RESULT_RELAXED_NOTE, ZERO_RESULT_NEAR_MATCHES,
  ZERO_RESULT_NEAR_MATCH_COUNT, REQUEST_SHOT, REQUEST_SHOT_FORM, REQUEST_SHOT_NOTE,
  REQUEST_SHOT_SUBMIT, REQUEST_SHOT_CONFIRMATION,
  BIN_TOGGLE, BIN_PANEL, BIN_COUNT, BIN_ITEM, BIN_ITEM_REMOVE, BIN_DOWNLOAD,
  BIN_HANDOFF, BIN_CLEAR, USAGE_CONFIRMATION, USAGE_EVENT_ROW,
  CLIP_SHEET, CLIP_SHEET_CLOSE, CLIP_SHEET_POSTER, CLIP_SHEET_CONTACT_SHEET,
  CONTACT_SHEET_FRAME, CLIP_SHEET_TAGS_AI, CLIP_SHEET_TAGS_HUMAN, CLIP_SHEET_TAG,
  CLIP_SHEET_AI_RATIONALE, CLIP_SHEET_FACTS, CLIP_SHEET_CREATOR_CREDIT,
  CLIP_SHEET_USED_IN, CLIP_SHEET_DOWNLOAD, CLIP_SHEET_ADD_TO_BIN,
  TRIAGE_ROOT, TRIAGE_BUCKET, TRIAGE_BUCKET_COUNT, TRIAGE_DELIVERY_ROW,
  TRIAGE_DELIVERY_CREATOR, TRIAGE_DELIVERY_BRANCH, TRIAGE_OPEN_DELIVERY,
  TRIAGE_START_REVIEW, TRIAGE_EMPTY,
  DEAL_DRAWER, DIFF_ROOT, DIFF_COVERAGE_PCT, DIFF_ITEM_ROW, DIFF_ITEM_PROMISED,
  DIFF_ITEM_DELIVERED, DIFF_ITEM_ORIGIN_GAP, DIFF_BUCKET_MATCHED,
  DIFF_BUCKET_EXTRAS, DIFF_BUCKET_AWAITING_DERIVATIVES, DIFF_EXTRA_ASSET,
  REVIEW_ROOT, REVIEW_PROGRESS, REVIEW_ORDERED_LIST, REVIEW_ROW,
  REVIEW_CURRENT_ASSET, REVIEW_NEXT, REVIEW_PREV, REVIEW_SKIP, REVIEW_APPROVE,
  REVIEW_REJECT, REVIEW_UNDO, REVIEW_DECIDED_BADGE, REVIEW_KEYBOARD_HINT,
  REVIEW_PENDING_ADDITIONS, REVIEW_ACCEPT_ADDITIONS, REVIEW_STALE_REFUSAL,
  REVIEW_REJECT_DIALOG, REJECT_INTERNAL_NOTE, REJECT_CREATOR_NOTE,
  REJECT_REASON_SELECT, REJECT_CONFIRM, REJECT_CANCEL,
  PUBLISH_TO_LIBRARY, PUBLISH_CONFIRMATION, PUBLISH_BLOCKED_REASON,
  PREFLIGHT_PANEL, PREFLIGHT_ROLLUP, PREFLIGHT_RULE, PREFLIGHT_RULE_VALUE,
  PREFLIGHT_RULE_REASON, PREFLIGHT_UNKNOWN_MARK, CAPTURE_DATE_SOURCE,
  NO_PREVIEW_CHIP, PLACEHOLDER_TILE, REQUEST_H264_VERSION,
  CREATORS_ROOT, CREATORS_SUMMARY, CREATOR_ROW, CREATOR_FIT_SCORE,
  CREATOR_OVERRIDE_NOTE, CREATOR_RISK_FLAGS, CREATOR_SCORECARD,
  SCORECARD_COMPLETED, SCORECARD_APPROVAL_RATE, SCORECARD_PROMISE_KEPT,
  SCORECARD_GHOSTED, SCORECARD_DRIFT, CREATOR_VET, CREATOR_VET_RECEIPT,
  CREATOR_VET_REFUSAL, CREATOR_OVERRIDE, CREATOR_OVERRIDE_FORM,
  OVERRIDE_SCORE, OVERRIDE_REASON, OVERRIDE_SAVE, OVERRIDE_ERROR,
  GAPS_ROOT, GAP_SCAN_HEADER, GAP_SCAN_RUN, GAP_ROW, GAP_DEFICIT, GAP_EVIDENCE,
  GAP_FEED_TO_BRIEF, GAP_DISMISS, GAP_CLOSED_BADGE, GAP_COVERAGE_BEFORE,
  GAP_COVERAGE_AFTER,
  BRIEF_ROOT, BRIEF_HEADER, BRIEF_ITEM_ROW, BRIEF_ITEM_ADD,
  BRIEF_GENERATE_FROM_GAPS, BRIEF_LOCK, BRIEF_LOCKED_BADGE, BRIEF_INVITE_LINK,
  BRIEF_INVITE_COPY,
  INVITE_ROOT, INVITE_BRANCH, INVITE_VISIT_DATE, INVITE_BRIEF_LIST,
  INVITE_BRIEF_ITEM, INVITE_MOST_COMPATIBLE_INSTRUCTION, INVITE_HOW_TO_SHOOT,
  INVITE_TOKEN_INVALID, INVITE_TOKEN_EXPIRED, INVITE_CONTINUE,
  CONSENT_PANEL, CONSENT_TEXT, CONSENT_ACCEPT, CONSENT_DECLINE, CONSENT_RECORDED,
  UPLOAD_ROOT, UPLOAD_DELIVERY, UPLOAD_FILE_INPUT, UPLOAD_DROPZONE,
  UPLOAD_FILE_LIST, UPLOAD_FILE_ROW, UPLOAD_FILE_VERDICT, UPLOAD_FILE_THUMB,
  UPLOAD_FILE_PROGRESS, UPLOAD_FILE_RETRY, UPLOAD_FILE_REMOVE,
  UPLOAD_FILE_MANUAL_ROTATE, UPLOAD_FILTERED_NOTICE, UPLOAD_BLOCKED_EXPLANATION,
  CHECKLIST_ROOT, CHECKLIST_ITEM, CHECKLIST_PROGRESS,
  CAPTURE_DATE_PROMPT, CAPTURE_DATE_INPUT, CAPTURE_DATE_CONFIRM,
  NEAR_BRANCH_PROMPT_MUST_NOT_EXIST,
  UPLOAD_SUBMIT, UPLOAD_SUBMIT_CONFIRMATION, UPLOAD_RESUME_BANNER,
  UPLOAD_ALREADY_DELIVERED, CREATOR_FACING_REJECT_NOTE, CREATOR_EXEMPLARS,
  STORAGE_PANEL, STORAGE_QUOTA_USED, STORAGE_QUOTA_TOTAL, STORAGE_BREAKDOWN_ROW,
  STORAGE_POLICY_TIER, STORAGE_EVICT_DERIVATIVES, STORAGE_PERSISTED_FLAG,
  DATA_HEALTH_PANEL, DATA_HEALTH_ROW, DATA_HEALTH_COUNTS, REINDEX_QUEUE_DEPTH,
  AI_RUN_ROW, RESET_DEMO_PROFILE,
  STORAGE_VERDICT, EXPORT_SNAPSHOT, IMPORT_SNAPSHOT,
  EXPORT_SNAPSHOT_RECEIPT, IMPORT_SNAPSHOT_RECEIPT,
  SEED_VERSION_LABEL,
}

const seen = new Map()
for (const [name, value] of Object.entries(ALL)) {
  if (seen.has(value)) {
    throw new Error(`testids.mjs: duplicate data-testid "${value}" on ${seen.get(value)} and ${name}`)
  }
  seen.set(value, name)
}

/** Frozen map of every id in the contract, for coverage reporting. */
export const ALL_TESTIDS = Object.freeze(ALL)

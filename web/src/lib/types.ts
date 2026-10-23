// Shapes the admin API returns (only the fields the website reads).
import type { ConditionGroup } from './conditions';

export type Game = {
  id: string;
  name: string;
  bundle_id: string;
  platform: string;
  notes?: string | null;
  archived_at?: string | null;
  created_at: string;
  icon_updated_at?: string | null;
  workspace_id?: string;
  events?: number;
  last_event?: string | null;
  today?: number;
  dau_today?: number;
  dau_yesterday?: number;
  anonymous_today?: number;
};

export type WorkspaceMembership = { id: string; name: string; role: 'admin' | 'lead' | 'member' | string; /** Whether this person may use NutBot here (admins always; leads and members by the workspace's access setting). */ nutbot?: boolean; nutbot_access?: 'admins' | 'leads' | 'everyone' | string };

export type Me = {
  is_admin: boolean;
  can_manage_team: boolean;
  workspaces: WorkspaceMembership[];
  email: string;
  name: string;
  source: 'local' | 'lan' | string;
};

export type AnalyticsThresholds = { levels_min_players: number; funnels_min_players: number; retention_min_users: number };

export type Overview = {
  games: Game[];
  events: number;
  today: number;
  dau_today: number;
  anonymous_today: number;
  timezone_offset_minutes: number;
  active_keys: number;
  ingest_url: string;
  analytics_thresholds: AnalyticsThresholds;
};

export type GameDetail = Game & {
  event_names: number;
  keys_active: number;
  keys_total: number;
  storage_bytes: number;
  first_event: string | null;
  definitions: number;
  analytics_thresholds: AnalyticsThresholds & { levels_override?: number | null; funnels_override?: number | null; retention_override?: number | null };
};

export type DayCount = { day: string; events: number };
export type Health = { total: number; days: DayCount[] };

/* ─── Game management (API keys, environment fixes, per-game access) ─── */
export type ApiKey = { id: string; label: string; prefix: string; api_key?: string | null; created_at: string; revoked_at?: string | null };
export type EnvironmentSeen = { environment: string; app_version: string | null; build: string | null; players: number; events: number; fix?: string | null };
export type EnvironmentFix = { id: string; from_environment: string; to_environment: string; app_version: string | null; build: string | null };
export type EnvironmentFixes = { seen: EnvironmentSeen[]; fixes: EnvironmentFix[] };
export type AccessPerson = { email: string; name?: string | null; role: string; has_access: boolean };

/* ─── Team, workspaces, server status and settings ─── */
export type TeamPerson = {
  email: string;
  name?: string | null;
  admin: boolean;
  /** workspace id → role in it */
  memberships: Record<string, string>;
  game_ids: string[];
  last_seen_at?: string | null;
};

export type AuditEntry = { at: string; actor: string; action: string; detail: string; game_id?: string | null };

export type WorkspaceItem = { id: string; name: string; games: number; members: number; nutbot_access: 'admins' | 'leads' | 'everyone' | string };

export type SdkInfo = { filename: string; size: number; sha256: string };

export type ProcessingPending = { facts_remaining?: number; views_waiting?: number; lag_seconds?: number };
export type ProcessingFacts = { ready: boolean; phase?: string; done?: number; total?: number };
export type ProcessingGame = { name: string; facts: ProcessingFacts; views?: number };
export type ProcessingStatus = {
  state: 'running' | 'catching_up' | 'starting' | 'stopping' | 'stopped' | 'unavailable' | string;
  desired: 'running' | 'stopped' | string;
  changed_by: string;
  changed_at: string;
  worker?: { heartbeat_at?: string | null; heartbeat_age_seconds?: number; job?: string | null; game?: string | null } | null;
  pending?: ProcessingPending;
  last_success_at?: string | null;
  error?: string | null;
  errors: Array<{ game?: string | null; at: string; message: string }>;
  games: ProcessingGame[];
};

/* ─── Game overview (/insights/summary) ─── */
export type OverviewDay = { day: string; players: number; sessions: number; events: number };
export type OverviewMeasure = 'players' | 'sessions' | 'events';
export type OverviewBreakdownRow = { value: string; events: number; players: number };
export type OverviewTopEvent = { name: string; events: number; players: number };
export type OverviewAnomaly = { metric: string; label: string; current: number; previous: number; change_percent: number; direction: 'up' | 'down' };
export type OverviewContext = { anonymous_events?: number; excluded_events?: number; low_sample?: boolean; minimum_players?: number; identified_players?: number; raw_events?: number };
export type OverviewActive = {
  last_day: string; dau: number; dau_previous: number; avg_dau: number; avg_dau_7: number; avg_dau_30?: number;
  wau: number; mau: number; stickiness: number | null; peak_dau: { players: number; day: string } | null;
};
export type OverviewSummary = {
  events: number; players: number; sessions: number; new_players: number;
  context: OverviewContext; active: OverviewActive; days: OverviewDay[];
  breakdowns: Partial<Record<'environment' | 'app_version' | 'build' | 'country' | 'platform', OverviewBreakdownRow[]>>;
  top_events: OverviewTopEvent[]; anomalies: OverviewAnomaly[];
};

/* ─── NutBot (the assistant; see src/pages/nutbot) ─── */
export type NutBotHarness = { id: string; label: string; available: boolean; reason: string; default_model: string | null; models: string[] };
/** GET /v1/nutbot */
export type NutBotInfo = { enabled: boolean; default: string | null; harnesses: NutBotHarness[] };
export type NutBotFunnelStep = { event: string; param?: string; op?: string; value?: string; label?: string };
export type NutBotFunnel = { steps: NutBotFunnelStep[]; scope?: string; window_hours?: number | null };
/** A "show_in_dashboard" shortcut the assistant adds to its answer. */
export type NutBotAction = { type: 'action'; action: 'open'; page: string; title: string; game_id: string; player?: string; start?: string; end?: string; show_journeys?: boolean; funnel?: NutBotFunnel };
export type NutBotUsage = { type: 'usage'; input_tokens?: number | null; output_tokens?: number | null; cost_usd?: number | null };
/** One line of the newline-delimited JSON the chat endpoint streams back. */
export type NutBotEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'tool_result'; ok?: boolean }
  | NutBotAction
  | NutBotUsage
  | { type: 'error'; message: string }
  | { type: 'done'; seconds: number };
export type NutBotTool = { name: string; label: string; done: boolean; /** 0.2.0: the call chip's state and how long it took; older chats have only `done`. */ status?: 'running' | 'done' | 'error'; ms?: number; started?: number };
/** What the browser remembers per game (localStorage avn-nutbot-<game>): the old shape, so older chats still open. */
export type NutBotStoredMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: NutBotTool[]; actions: NutBotAction[]; scope?: string; usage?: NutBotUsage; seconds?: number; error?: string };
export type NutBotConversation = { session: string | null; harness: string | null; messages: NutBotStoredMessage[] };
export type NutBotPrefs = { harness?: string; models?: Record<string, string> };
/** The page context sent with every message (what the "Looking at" chips say). */
export type NutBotContext = { page?: string; range?: { from: string; to: string }; hide_test: boolean; filters: { environments: string[]; app_versions: string[]; builds: string[]; countries: string[]; platforms: string[] }; player?: string; funnel?: NutBotFunnel };

/* ─── Players: the event catalog, event rules and the player list ─── */
export type CatalogParam = { key: string; count: number; values: string[] };
export type CatalogEvent = { name: string; count: number; params: CatalogParam[] };
export type Catalog = { events: CatalogEvent[] };

export type MetricAgg = 'count' | 'max' | 'min' | 'sum' | 'first' | 'last';
/** "An event, optionally with a parameter test", plus whatever a page adds (`does`, `min_times`, `agg`, `of`…). */
export type EventRule = {
  event: string; param: string; op: string; value: string;
  does?: 'did' | 'didnt'; min_times?: number; agg?: MetricAgg; of?: string; label?: string;
};
export type PlayerCondition = EventRule & { does: 'did' | 'didnt'; min_times: number };
export type PlayerMetric = EventRule & { agg: MetricAgg };
export type PlayerRulesBody = { conditions: PlayerCondition[]; metrics: PlayerMetric[] };

export type PlayerRow = {
  player: string; events: number; sessions: number;
  avg_session_seconds: number | null; total_play_seconds: number | null;
  first_seen: string; last_seen: string;
  platform: string | null; app_version: string | null; country: string | null; environment: string | null;
  has_user_id: number | boolean; metrics: Array<number | string | null>;
};
export type PlayersResult = { total: number; players: PlayerRow[]; context?: { anonymous_events?: number } };

/* ─── Levels (/insights/levels and /insights/levels/players) ─── */
export type LevelTransition = {
  available: boolean; next_level: number; drop_percent: number | null; total_drop: number; net_change: number | null;
  left: number; finished_stopped: number; kept_going: number; unknown_progress: number;
};
export type LevelRow = {
  level: number; started: number; completed: number; completion: number | null; tries_per_player: number | null;
  fails: number; restarts: number; median_seconds: number | null; low_sample: boolean; transition: LevelTransition | null;
};
export type LevelsResult = { levels: LevelRow[]; context: { anonymous_events: number; minimum_players: number; scope?: string } };
export type LevelLastEvent = { text: string; gap: number | null; after: string | null; after_level: number | null };
export type LevelPlayer = {
  player: string; tries: number; fails: number; completed: boolean; exit_at: string; exit_event: string;
  last_action: string | null; next_action: string | null; last_event: LevelLastEvent | null;
  session_seconds: number; last_seen: string; came_back: boolean; app_version: string | null;
};
export type LevelLastAction = { text: string; players: number };
export type LevelPlayersResult = {
  level: number; group: string; counts: Record<string, number>; last_actions: LevelLastAction[];
  total: number; offset: number; players: LevelPlayer[];
};

/* ─── One player: the story summary, the raw timeline pages, device lookup, saved highlight rules ─── */
export type PlayerProfile = { session_number?: number; device_model?: string; device_type?: string; os_version?: string; language?: string; timezone_offset_minutes?: number | string; screen_width?: number; screen_height?: number; [key: string]: unknown };
export type PlayerInfo = { user_id?: string | null; device_id?: string | null; platform?: string | null; country?: string | null; app_version?: string | null; build?: string | null; environment?: string | null; updated_at?: string | null; properties?: PlayerProfile | null };
export type PlayerStory = { sessions: number; events: number; first_seen?: string | null; last_seen?: string | null; total_play_seconds?: number | null; average_session_seconds?: number | null; highest_level?: number | null; info?: PlayerInfo | null };
export type JourneyEvent = { event_id: string; name: string; session_id: string; client_ts: string; level?: number | null; params: Record<string, unknown> };
export type JourneyPage = { events: JourneyEvent[]; truncated: boolean; snapshot: number | string | null };
export type DeviceSpecs = { requested_model: string; matched_device?: string | null; note?: string | null; source_url: string; specs?: Record<string, string> | null };
export type SavedHighlight = { id: string; name: string; color: string; conditions: ConditionGroup };

/* ─── Funnels and journeys (insights/funnel, insights/funnels, insights/journeys) ─── */
export type FunnelOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';
export type FunnelStep = { event: string; param: string; op: string; value: string; label: string; naming?: boolean };
export type FunnelScope = 'player' | 'session';
export type FunnelDefinition = { steps: FunnelStep[]; scope: FunnelScope; window_hours: number | null };
export type SavedFunnel = FunnelDefinition & { id: string; name: string; updated_at?: string };
/** The funnel being edited: a saved one (id) or a new one; remembered per game in this browser. */
export type FunnelDraft = FunnelDefinition & { id: string | null; name: string };
export type Times = { count: number; median: number; average: number; min: number; max: number; p90: number } | null;
export type FunnelResultRow = FunnelStep & {
  players: number; of_first: number; of_previous: number; time_from_previous: Times;
  dropped: number; dropped_sample: Array<{ player: string; last_seen: string }>;
};
export type FunnelContext = { identified_players: number; anonymous_events: number; minimum_players: number; low_sample: boolean };
export type FunnelResult = {
  steps: FunnelResultRow[]; time_to_complete: Times;
  breakdown: 'environment' | 'app_version' | 'build' | 'country' | 'platform' | null;
  segments: Array<{ value: string; players: number[] }>; segments_total: number; context: FunnelContext;
};
export type JourneyStatus = 'reached' | 'stopped' | 'continued';
export type JourneyItem = { steps: string[]; status: JourneyStatus; players: number; percent: number };
export type JourneyExit = { label: string; players: number; percent: number; percent_of_stopped: number };
export type JourneysResult = { started: number; reached: number; stopped: number; continued: number; distinct: number; journeys: JourneyItem[]; exits: JourneyExit[] };
export type JourneyPlayer = { player: string; status: JourneyStatus; last_seen: string; line: string };
export type JourneyPlayersResult = { total: number; players: JourneyPlayer[] };

/* ─── Event dictionary (/insights/events, /dictionary) ─── */
/** One mapping rule: the event counts as `action` (a concept) when the rule matches. */
export type MappingRule = { action: string; param: string; op: string; value: string; number_param: string; app_version: string };
export type EventDefinition = { description: string; params: Record<string, string>; labels: string; hidden: boolean; canonical: MappingRule[] };
export type EventEver = { events: number; players: number; first_seen: string; last_seen: string };
export type DictionaryEvent = {
  name: string;
  definition: EventDefinition;
  described: boolean;
  defined: boolean;
  sdk: boolean;
  status: 'active' | 'stale' | 'never' | string;
  ever: EventEver | null;
  range: { events: number; players: number };
  series: number[];
  params_seen: number;
  params_missing: string[];
  type_conflicts: string[];
  similar: string[];
};
export type DictionarySummary = {
  received_total: number; event_types: number; database_bytes: number; stale: number; never_received: number;
  described: number; events: number; needs_description: number; with_missing_params: number; mapped: number; hidden: number;
};
export type DictionaryData = { events: DictionaryEvent[]; summary: DictionarySummary; stale_days: number };
export type EventParamValue = { value: string; count: number };
export type EventParamSeen = { key: string; types: string[]; count: number; values: EventParamValue[]; distinct: number };
export type EventDetail = {
  params: EventParamSeen[];
  days: DayCount[];
  missing_in_newest: boolean;
  newest_version: string | null;
  versions: Array<{ version: string; events: number; players: number; last_seen: string }>;
  environments: Array<{ value: string; events: number; players: number }>;
  countries: Array<{ value: string; events: number; players: number }>;
  samples: Array<{ client_ts: string; version: string | null; environment: string | null; params: Record<string, unknown> }>;
};
export type EventActivityResult = {
  events: number; players: number; per_matching_player: number; per_active_player: number;
  identified_events: number; active_players: number; anonymous_events: number; days: DayCount[];
};

/* ─── Mappings (/mappings) ─── */
export type LevelSpan = { min: number; max: number };
export type MappingSource = { event: string; via: 'mapped' | 'auto' | string; rule: MappingRule; events: number; players: number; levels: LevelSpan | null };
export type MappingConcept = { key: string; label: string; status: 'mapped' | 'auto' | 'missing' | string; used_by: string[]; needs: boolean; sources: MappingSource[]; silent_rules: Array<{ event: string; rule: MappingRule }> };
export type MappingEvent = { name: string; events: number; defined: boolean; params: Array<{ key: string; examples: string[] }>; suggestions: MappingRule[] };
export type MappingsData = { concepts: MappingConcept[]; events: MappingEvent[]; definitions: Record<string, MappingRule[]>; versions: string[]; conflicts: Array<{ event: string; events: number }>; other: Array<{ event: string; rule: MappingRule }> };
export type MappingPreview = { events: number; scanned: number; players: number; with_level_number: number; levels: LevelSpan; conflicting_events: number; sample: unknown };

/* ─── Dictionary import (/dictionary/import) ─── */
export type ImportOptions = {
  mode: string; fields: string[];
  scope: { events: string; names: string[]; prefixes: string[]; seen_within_days: number | null; include_not_yet_received: boolean; include_hidden: boolean };
  style: { language: string; tone: string; max_description_chars: number; game_context: string; param_values: boolean };
  code: { include_paths: string[]; exclude_paths: string[]; call_patterns: string[] };
  min_confidence: string; require_source: boolean; status: string; max_overwrites: number; near_duplicates: string; type_conflicts: string;
};
export type ImportPrepared = { file: { events: Record<string, unknown> } & Record<string, unknown>; prompt: string };
export type ImportChange = { name: string; field: string; before: string; after: string; kind: 'fill' | 'overwrite_draft' | 'overwrite' | string };
export type ImportFlag = { flag: string; similar?: string[]; field?: string; types?: string[]; code?: string; observed?: string[] };
export type ImportEntry = { name: string; origin?: string; status?: string; changes: ImportChange[]; rejected: Array<{ field: string; reason: string }>; skipped: Array<{ field: string; reason: string }>; flags: ImportFlag[] };
export type ImportPreview = {
  events: ImportEntry[]; options: ImportOptions; blocked?: string | null; unresolved: Array<{ source: string; note: string }>; not_found_in_code: string[];
  summary: { skipped: number; flags: number; fields_changed?: number };
  /** The dry run with an `exclude` list also returns the flat list it would apply and a token to apply exactly that. */
  changes?: ImportChange[]; preview?: unknown;
};
export type ImportResult = { summary: { fields_changed: number } };
export type ImportHistoryItem = { id: string; created_at: string; actor: string; summary: { fields_changed: number }; options: { mode: string; status: string }; undone_at?: string | null };
export type ImportUndoResult = { reverted: number; kept: string[] };

/* ─── The AVN events standard and custom events ─── */
export type CustomParam = { key: string; type: string; required: boolean; note: string; values: string[] };
export type CustomState = { name: string; trigger: string; params: CustomParam[] };
export type CustomEvent = { name: string; purpose: string; tier: 'core' | 'custom' | string; states: CustomState[] };
export type StandardVersion = { version: string; players: number; last_seen: string };
export type UnlistedEvent = { name: string; events: number; last_seen: string; versions: string[]; valid_name: boolean; states: Array<{ name: string; params: Array<{ key: string; type: string; required: boolean }> }> };
export type StandardStatus = { sent: Record<string, { events: number }>; versions: StandardVersion[]; unlisted: UnlistedEvent[]; total_unlisted: number; ignored: Array<{ name: string; events: number }>; older_only: Array<{ name: string; events: number }> };
export type StandardSummary = { events: Array<{ name: string; tier: string; states: string[] }>; prompt: string };
/** Which app versions the standard counts are for: '' = all, '@latest' = the newest with players, or one version. */
export type VersionChoice = { version: string; newer: boolean };

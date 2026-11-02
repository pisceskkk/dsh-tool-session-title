/**
 * Let the agent name its own session.
 *
 * Contributes two model-facing tools (`set_session_title`,
 * `get_session_title`) plus one system-prompt section that teaches the
 * `<type>(<scope>): <subject>` convention. The prompts live in a section
 * rather than the tool descriptions so they consume system-prompt tokens once
 * and only where the tool is actually visible.
 *
 * Design baseline: ../design/DESIGN.md. Where that file and
 * ../design/LEAD-NOTES.md / ../design/SCHEMA-RULES.md disagree, those win.
 *
 * @module @deepseek-ai/dsh-tool-session-title
 */
import { Buffer } from 'node:buffer';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** Plugin name, the identity Cordis uses for this plugin. */
export const name = 'tool-session-title';

/** Services this plugin hard-depends on; a missing one blocks plugin load. */
export const inject = ['tools', 'systemPrompt', 'sessionTitle'];

/** Tool name contributed by this plugin. */
const SET_TOOL = 'set_session_title';

/** Read-only companion tool name. */
const GET_TOOL = 'get_session_title';

/**
 * Prompt-section placement.
 *
 * `SECTION_ORDERS.TOOL_SESSION_QUERY` already occupies 2300, and equal orders
 * fall back to name ordering, so this section takes 2305: still inside the
 * tool-guidance band, ahead of TOOL_GOAL (2400).
 */
const SECTION_NAME = 'tool:set_session_title';
const SECTION_ORDER = 2305;

/**
 * Byte budget used when `ctx.sessionTitle.config.maxTitleBytes` is unreadable.
 * The live profile configures 80; runtime config wins whenever it is present.
 * Keep in step with the PROMPT_TEXT wording below if that default ever moves.
 */
const DEFAULT_MAX_TITLE_BYTES = 80;

/** Title sources the `get_session_title` schema may report. */
const TITLE_SOURCES = ['fallback', 'provider', 'user'];

/**
 * Prompt section text: the Chinese localization of the user's naming rule.
 * Kept under 400 characters of guidance to bound token cost.
 */
const PROMPT_TEXT = [
  '主要目标明确后，尽早用 set_session_title 设置会话标题。',
  '格式：<type>(<scope>): <简短中文主题>',
  'type：feat | bugfix | docs | style | refactor | perf | test | chore | review | spike | misc',
  'scope：1–2 个模块/功能关键词；主题用中文，技术术语保留英文（如 SSO、PCP）。',
  '示例：feat(auth): 支持 SSO',
  '约束：≤80 字节且 ≤50 字符，不以句号结尾；设置后自动标题停止更新（pin），请一次设好；',
  '每个主题只设一次，仅在用户明确要求或主要目标实质转变时更新，忽略次要偏移；子会话不设标题；',
  '工具不存在则静默跳过；不确定当前标题可先调用 get_session_title',
].join('\n');

/**
 * Read the effective UTF-8 byte budget for session titles.
 * @param ctx - plugin context.
 * @returns the configured `maxTitleBytes`, else {@link DEFAULT_MAX_TITLE_BYTES}.
 */
function sessionTitleConfigMaxBytes(ctx) {
  const configured = ctx.sessionTitle?.config?.maxTitleBytes;
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_TITLE_BYTES;
}

/**
 * Fail the tool call with a stable, model-readable error code.
 * The runtime turns this into an `isError` tool result.
 * @param code - stable uppercase error code, without brackets.
 * @param message - english one-liner the model can act on.
 * @returns never; always throws.
 */
function fail(code, message) {
  throw new Error(`[${code}] ${message}`);
}

/**
 * Resolve the calling agent's session, rejecting non-agent calls.
 * @param ctx - plugin context.
 * @param exec - tool execution context supplied by the runtime.
 * @returns the calling session.
 */
function requireSession(ctx, exec) {
  // A missing service is a broken composition, not a user error; say so before
  // touching anything that would throw a bare TypeError.
  if (!ctx.sessionTitle) {
    fail('E_SERVICE_UNAVAILABLE', 'Session title service is unavailable. The tool cannot function without it.');
  }
  const session = exec?.agent?.session;
  if (session === undefined || session === null) {
    fail('E_NO_AGENT', 'This tool requires an owning agent session.');
  }
  return session;
}

/**
 * Resolve one title snapshot, tolerating a service that throws on odd input.
 * @param ctx - plugin context.
 * @param session - live session.
 * @returns the snapshot or undefined when no title exists yet.
 */
function snapshotOf(ctx, session) {
  return ctx.sessionTitle.get(session);
}

/**
 * Build the `set_session_title` tool definition.
 * @param ctx - plugin context.
 * @returns a defineTool-ready definition.
 */
function createSetTool(ctx) {
  return defineTool({
    name: SET_TOOL,
    description:
      'Set the title of the current session. The title is pinned after setting, '
      + 'so automatic title updates stop and only an explicit later call changes it. '
      + 'Returns the previous and current title. Rejects child sessions, empty '
      + 'titles, and titles that exceed the session title byte limit.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description:
          'New session title, non-empty and within the session title byte limit. '
          + 'Format: <type>(<scope>): <subject>. Example: "feat(auth): 支持 SSO"',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          unchanged: { type: 'boolean', required: true },
          previous: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          current: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.unchanged === true
          ? `Title unchanged: ${value.current}`
          : `Title set: ${value.previous ?? '(none)'} -> ${value.current}`,
      }],
    },
    execute(args, exec) {
      const session = requireSession(ctx, exec);
      // Child sessions (subagents) keep their generated titles: a subagent
      // renaming itself would fight "set once per main theme" and is invisible
      // in the UI anyway. Reported, never done silently, so the model stops.
      const parent = session?.header?.parentSession;
      if (parent !== undefined && parent !== null) {
        fail('E_CHILD_SESSION', 'Cannot set title on a child session. Only the root session title can be changed.');
      }
      // `title` is schema-required, but a malformed call must not surface as a
      // bare TypeError from String(); require a real string.
      if (typeof args?.title !== 'string') {
        fail('E_EMPTY_TITLE', 'Title must not be empty.');
      }
      const title = args.title.trim();
      if (title.length === 0) {
        fail('E_EMPTY_TITLE', 'Title must not be empty.');
      }
      // rename() silently truncates on byte overflow, which would cut a title
      // mid-character and break the convention. Reject and let the model shrink.
      const maxBytes = sessionTitleConfigMaxBytes(ctx);
      const actualBytes = Buffer.byteLength(title, 'utf8');
      if (actualBytes > maxBytes) {
        fail(
          'E_TITLE_TOO_LONG',
          `Title exceeds the byte limit: ${actualBytes} UTF-8 bytes given, max ${maxBytes}. `
          + 'Shorten the title and retry.',
        );
      }
      const current = snapshotOf(ctx, session);
      const previousTitle = current?.title ?? null;
      // Idempotent on an exact match: no event, no re-pin, no source change.
      if (previousTitle === title) {
        return { unchanged: true, current: title };
      }
      let renamed;
      try {
        renamed = ctx.sessionTitle.rename(session, title);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // rename() blames the input only for text that sanitizes to nothing.
        if (error?.name === 'SessionTitleInvalidError') {
          fail('E_EMPTY_TITLE', 'Title must not be empty.');
        }
        fail('E_SESSION_NOT_LIVE', `Session is not live; title cannot be changed. (${detail})`);
      }
      return { unchanged: false, previous: previousTitle, current: renamed?.title ?? title };
    },
  });
}

/**
 * Build the `get_session_title` tool definition.
 * @param ctx - plugin context.
 * @returns a defineTool-ready definition.
 */
function createGetTool(ctx) {
  return defineTool({
    name: GET_TOOL,
    description:
      'Get the current title and source of this session. '
      + 'Source is "fallback", "provider" (auto-generated), or "user" (set by this tool and pinned).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          source: {
            oneOf: [
              { type: 'string', enum: [...TITLE_SOURCES] },
              { type: 'null' },
            ],
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.title === null
          ? 'No title set.'
          : `Current title (${value.source ?? 'unknown'}): ${value.title}`,
      }],
    },
    execute(_args, exec) {
      const session = requireSession(ctx, exec);
      const snapshot = snapshotOf(ctx, session);
      const title = typeof snapshot?.title === 'string' && snapshot.title.length > 0 ? snapshot.title : null;
      if (title === null) {
        return { title: null, source: null };
      }
      // `source` is a `{ kind }` record on the wire; the enum exposes the kind.
      const kind = snapshot?.source?.kind;
      const source = TITLE_SOURCES.includes(kind) ? kind : null;
      return { title, source };
    },
  });
}

/**
 * Register the session-title tools and their prompt section.
 *
 * Synchronous: the tools package is a static import, exactly as Cordis
 * resolves it in a profile. The test harness redirects that specifier with
 * `module.registerHooks` instead of asking production code to load lazily.
 * @param ctx - Cordis context with `tools`, `systemPrompt`, and `sessionTitle`.
 * @param _config - unused; this plugin has no configuration.
 */
export function apply(ctx, _config) {
  // Define before registering: defineTool compiles the author schemas and
  // throws on any DSL violation, so a bad schema fails here, not at dispatch.
  ctx.tools.register(createSetTool(ctx));
  ctx.tools.register(createGetTool(ctx));

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // Returned as an empty string where the tool is not visible, so a
    // restricted agent pays nothing for guidance it cannot act on.
    text: ({ scope }) => (ctx.tools.get(SET_TOOL, scope) === undefined ? '' : PROMPT_TEXT),
  });
}

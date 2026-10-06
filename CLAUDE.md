# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

Claude HUD is a Claude Code plugin that displays a real-time multi-line statusline. It shows context health, tool activity, agent status, and todo progress.

## Build Commands

```bash
npm ci               # Install dependencies
npm run build        # Build TypeScript to dist/

# Test with sample stdin data
echo '{"model":{"display_name":"Opus"},"context_window":{"current_usage":{"input_tokens":45000},"context_window_size":200000}}' | node dist/index.js
```

## Architecture

### Data Flow

```
Claude Code → stdin JSON → parse → render lines → stdout → Claude Code displays
           ↘ transcript_path → parse JSONL → tools/agents/todos
```

**Key insight**: The statusline is invoked by Claude Code after each interaction (new assistant message, `/compact` finishing, permission-mode changes, vim-mode toggles), debounced at 300ms — not on a fixed polling loop. Each invocation:
1. Receives JSON via stdin (model, context, tokens - native accurate data)
2. Parses the transcript JSONL file for tools, agents, and todos
3. Renders multi-line output to stdout
4. Claude Code displays all lines

### Data Sources

**Native from stdin JSON** (accurate, no estimation):
- `model.display_name` - Current model
- `context_window.current_usage` - Token counts
- `context_window.context_window_size` - Max context
- `transcript_path` - Path to session transcript

**From transcript JSONL parsing**:
- `tool_use` blocks → tool name, input, start time
- `tool_result` blocks → completion, duration
- Running tools = `tool_use` without matching `tool_result`
- `TodoWrite` calls → todo list
- `Task` calls → agent info

**From config files**:
- MCP count from `~/.claude/settings.json` (mcpServers)
- Hooks count from `~/.claude/settings.json` (hooks)
- Rules count from CLAUDE.md files

**From the headroom daemon (opt-in, `showHeadroom`)**: per-session savings from `GET /stats/sessions/<id>`, spoken over the unix socket published in agent-shim's headroom state file (`AGENT_SHIM_HOME` or `~/.agent-shim`/`~/.claude-use`, `headroom/state.v2.json`, field `socketPath`). `HEADROOM_PROXY_URL` overrides discovery and names a standalone http proxy. A session the daemon does not know renders nothing (no data yet); an unreachable daemon renders `down`.

**From Claude Code stdin rate limits**:
- `rate_limits.five_hour.used_percentage` - 5-hour subscriber usage percentage
- `rate_limits.five_hour.resets_at` - 5-hour reset timestamp
- `rate_limits.seven_day.used_percentage` - 7-day subscriber usage percentage
- `rate_limits.seven_day.resets_at` - 7-day reset timestamp

### File Structure

```
src/
├── index.ts             # Entry point
├── stdin.ts             # Parse Claude's JSON input
├── transcript.ts        # Parse transcript JSONL
├── config-reader.ts     # Read MCP/rules configs
├── config.ts            # Load/validate user config
├── git.ts               # Git status (branch, dirty, ahead/behind)
├── cost.ts              # Cost estimation (native stdin cost preferred)
├── effort.ts            # Thinking effort parsing
├── external-usage.ts    # External usage snapshot fallback / balance_label
├── speed-tracker.ts     # Output speed tracking
├── context-cache.ts     # Context/usage caching across invocations
├── memory.ts            # System memory stats
├── claude-config-dir.ts # Resolve the Claude config directory
├── constants.ts         # Shared constants
├── debug.ts             # Debug logging
├── extra-cmd.ts         # Run an optional user command for a custom label
├── version.ts           # Plugin version handling
├── i18n/                # HUD label translations (en, zh-Hans)
├── utils/               # Shared helpers
├── types.ts             # TypeScript interfaces
└── render/
    ├── index.ts             # Main render coordinator
    ├── session-line.ts      # Compact mode: single line with all info
    ├── tools-line.ts        # Tool activity (opt-in)
    ├── skills-mcp-line.ts   # Skills & MCP activity (opt-in)
    ├── agents-line.ts       # Agent status (opt-in)
    ├── todos-line.ts        # Todo progress (opt-in)
    ├── colors.ts            # ANSI color helpers
    ├── width.ts             # Terminal width / CJK-aware measurement
    ├── format-reset-time.ts # Usage reset time formatting
    └── lines/
        ├── index.ts         # Barrel export
        ├── project.ts       # Model bracket + project + git (+ advisor)
        ├── identity.ts      # Context bar
        ├── usage.ts         # Usage bar (merged with context by default)
        ├── environment.ts   # Config counts (opt-in)
        ├── advisor.ts       # Advisor model label (opt-in)
        ├── cost.ts          # Session cost display
        ├── prompt-cache.ts  # Prompt cache countdown
        ├── memory.ts        # Memory usage display
        ├── session-time.ts  # Session duration / timestamps
        ├── session-tokens.ts # Session token totals
        ├── added-dirs.ts    # /add-dir workspace directories
        └── label-align.ts   # Label column alignment
```

### Output Format (default expanded layout)

```
[Opus] │ my-project git:(main*)
Context █████░░░░░ 45% │ Usage ██░░░░░░░░ 25% (1h 30m / 5h)
```

Lines 1-2 always shown. Additional lines are opt-in via config:
- Tools line (`showTools`): ◐ Edit: auth.ts | ✓ Read ×3
- Skills/MCP lines (`showSkills` / `showMcp`): active Skill invocations and MCP servers; when the Skills line is enabled, Skill-tool entries are suppressed from the tools line
- Agents line (`showAgents`): ◐ explore [haiku]: Finding auth code
- Todos line (`showTodos`): ▸ Fix authentication bug (2/5)
- Environment line (`showConfigCounts`): 2 CLAUDE.md | 4 rules
- Advisor label (`showAdvisor`): inlined on the project line, e.g. `Advisor: Opus 4.7`

### Context Thresholds

| Threshold | Color | Action |
|-----------|-------|--------|
| <70% | Green | Normal |
| 70-85% | Yellow | Warning |
| >85% | Red | Show token breakdown |

## Plugin Configuration

The plugin manifest is in `.claude-plugin/plugin.json` (metadata only - name, description, version, author).

**StatusLine configuration** must be added to the user's `~/.claude/settings.json` via `/claude-hud:setup`.

The setup command adds an auto-updating command that finds the latest installed version at runtime.

Note: `statusLine` is NOT a valid plugin.json field. It must be configured in settings.json after plugin installation. Updates are automatic - no need to re-run setup.

**Diagnosing a segment against the code that actually runs**: the statusline command version-sorts every `${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache/*/claude-hud/*/` copy and executes the newest, so with both this fork and the upstream installed the executing code is whichever release sorts higher, not whichever this checkout is. When a segment misbehaves, grep that cache copy's `dist/` (the per-module compiled files, e.g. `dist/headroom.js`) before concluding anything from the source tree, and check `git log --all` for unmerged fix branches before declaring a fix absent.

## Dependencies

- **Runtime**: Node.js 18+ or Bun
- **Build**: TypeScript 5, ES2022 target, NodeNext modules

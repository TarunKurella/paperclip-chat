# paperclip-chat · Design System & UI Principles

> Reference doc for coding agents building paperclip-chat UI.
> Goal: chat UI must feel native to the Paperclip product — same visual language, same component library, same interaction patterns.

---

## 1. Stack — match Paperclip exactly

| Layer | Paperclip uses | paperclip-chat must use |
|-------|----------------|------------------------|
| Framework | React (Vite build) | React (Vite build) |
| Component library | shadcn/ui (components.json at `ui/components.json`) | shadcn/ui — same config |
| Styling | Tailwind CSS (utility-first) | Tailwind CSS — extend Paperclip's config |
| State / data fetching | TanStack React Query (`@tanstack/react-query`) | TanStack React Query — same patterns |
| Icons | Lucide React (`lucide-react`) | Lucide React — same icon set |
| Type safety | TypeScript strict, Zod validators in `@paperclipai/shared` | TypeScript strict, Zod validators |
| Build | Vite, output to `ui/dist/`, served statically by Express | Vite, same pattern |
| Testing | Vitest (`vitest.config.ts` at ui root) | Vitest |
| PWA | Service worker + enhanced manifest (since v0.3.0) | Not required for chat, but don't break PWA |

**Do not introduce**: Material UI, Chakra, Ant Design, CSS Modules, styled-components, Emotion, or any other styling system. Paperclip is Tailwind + shadcn/ui exclusively.

---

## 2. shadcn/ui configuration

Paperclip has a `ui/components.json` file that configures shadcn/ui. Chat must share this config so components look identical.

Key conventions observed in the codebase:
- Components live in `ui/src/components/ui/` (shadcn primitives — do not modify directly)
- Custom/composed components live in `ui/src/components/` (e.g., `IssueRow.tsx`, `AgentConfigForm.tsx`, `LiveRunWidget.tsx`)
- The `cn()` utility from `@/lib/utils` is used for all class merging — never concatenate Tailwind classes manually
- Import pattern: `import { Button } from "@/components/ui/button"`

### Adding new shadcn components for chat

```bash
# From the ui/ directory (or chat-ui/ if separate):
npx shadcn@latest add dialog
npx shadcn@latest add popover
npx shadcn@latest add scroll-area
npx shadcn@latest add avatar
npx shadcn@latest add badge
npx shadcn@latest add tooltip
```

Chat will likely need these shadcn primitives that Paperclip already uses: Button, Dialog, Popover, Command (palette), ScrollArea, Badge, Tooltip, DropdownMenu, Input, Textarea.

---

## 3. Visual language — what Paperclip looks like

### Color philosophy

Paperclip uses a **muted, professional palette** — think GitHub / Linear, not Slack / Discord. The UI is information-dense (dashboards, issue lists, transcript views) with minimal decorative color.

- **Background**: White/light gray canvas. Dark mode support via Tailwind's `dark:` variants and CSS variables in shadcn theme.
- **Primary actions**: Blue tones (shadcn `primary` variable).
- **Status indicators**: Semantic colors — green for available/success, amber for warnings/busy, red for errors, blue for info. Consistent with agent status dots.
- **Text**: High-contrast. `text-foreground` for primary, `text-muted-foreground` for secondary.
- **Borders**: Subtle. `border` class (maps to shadcn's border color variable). Never heavy borders.

### Agent status colors (reuse these exactly)

Paperclip shows agent presence with colored dots. Chat presence must use the same visual vocabulary:

| Status | Color | Tailwind class | Used in |
|--------|-------|---------------|---------|
| available / idle | Green | `bg-green-500` | `ActiveAgentsPanel.tsx` |
| running / busy_task | Amber/pulsing | `bg-amber-500 animate-pulse` | `LiveRunWidget.tsx` |
| error / terminated | Red | `bg-red-500` | Agent status indicators |
| offline | Gray | `bg-gray-400` | Agent list |

For chat, map these to:
- `available` → green dot
- `busy_task` → amber pulsing dot + "Working on TASK-XXX"
- `busy_dm` → amber dot + "In another conversation"
- `offline` → gray dot

### Typography

- Default font: System font stack (Tailwind's `font-sans`) — Paperclip does not import custom web fonts
- Monospace for code/technical content: `font-mono` (system monospace stack)
- Size hierarchy: Tailwind's standard scale. Paperclip doesn't use custom font sizes — stick to `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`

### Spacing

- Tailwind's spacing scale throughout: `p-2`, `p-4`, `gap-2`, `gap-4`, `space-y-2`
- Consistent padding on cards/panels: `p-4` or `p-6`
- Sidebar width in Paperclip: typically `w-64` to `w-80`
- Dense information: `text-sm` with `gap-1` or `gap-2` spacing (see `IssueRow.tsx` pattern)

---

## 4. Component patterns — what Paperclip already does

### Page layout pattern

Paperclip pages follow this structure (see `Dashboard.tsx`, `Inbox.tsx`):

```
┌──────────────────────────────────────────────┐
│  Top bar (company switcher, navigation)       │
├──────────┬───────────────────────────────────┤
│ Sidebar  │  Main content area                │
│ (nav,    │  ┌─────────────────────────────┐  │
│  lists)  │  │ Page header                 │  │
│          │  │ Content (table/list/detail)  │  │
│          │  └─────────────────────────────┘  │
└──────────┴───────────────────────────────────┘
```

Chat should slot into this as a new top-level route or sidebar panel. The sidebar pattern is already established — chat's channel list would be a natural extension.

### List/row pattern (IssueRow.tsx, IssuesList.tsx)

Paperclip renders issues as **GitHub-style rows** — compact, scannable, with status indicators on the left and metadata on the right. Use this same pattern for channel list and message list:

```
┌─[status dot]─[title/name]──────────[metadata]─[timestamp]─┐
│  ●  #general                         3 unread    2m ago    │
│  ●  CTO (DM)                        "Need auth..." 5m ago  │
│  ○  #project-alpha                                 1h ago  │
└────────────────────────────────────────────────────────────┘
```

Key visual rules:
- Status/type indicator on left
- Primary text (bold for unread)
- Secondary/preview text in `text-muted-foreground`
- Timestamp right-aligned, `text-xs text-muted-foreground`
- Hover state: `hover:bg-muted` (subtle background highlight)
- Selected state: `bg-muted` or `bg-accent`
- Unread indicator: blue dot or bold text (Paperclip uses blue dot in inbox since v0.3.0)

### Live streaming pattern (RunTranscriptView.tsx, LiveRunWidget.tsx)

Paperclip streams agent run transcripts in real-time via WebSocket. The transcript view parses structured `TranscriptEntry` objects (kinds: `init`, `user`, `assistant`, `thinking`, `tool_call`, `tool_result`, `result`, `stdout`, `stderr`, `system`).

Chat streaming must follow the same visual pattern:
- Agent messages stream token-by-token (same as `assistant` transcript entries)
- Typing indicator uses the same pulsing dot pattern as `LiveRunWidget`
- Message bubbles should NOT look like a consumer chat app (no rounded colored bubbles). Instead, use the transcript-style flat layout with subtle separators — closer to Slack/Linear than iMessage
- Markdown rendering in messages — Paperclip already renders markdown in transcripts

### Form patterns (AgentConfigForm.tsx, OnboardingWizard.tsx)

- Form inputs use shadcn `Input`, `Textarea`, `Select` components
- Labels use `Label` component from shadcn
- Validation: Zod schemas on the shared types, client-side validation before API calls
- Command palette (⌘K) pattern available — consider for channel switching
- Wizards use step-by-step cards (OnboardingWizard has this pattern)

### Dialog/modal pattern

- shadcn `Dialog` for confirmations (e.g., crystallize confirm)
- shadcn `Popover` for quick actions
- Never use browser `alert()` or `confirm()`
- Dialogs have consistent padding, title in `DialogHeader`, actions in `DialogFooter`

---

## 5. Unread state and notification UI

Paperclip established unread patterns in v0.3.0 (inbox + issue read states):

- **Blue dot** for unread items in lists (sidebar, inbox)
- **Badge count** on navigation items (numeric, small, `bg-primary text-primary-foreground rounded-full`)
- Browser tab title updates with unread count
- `issue_read_states` table pattern → chat uses `notifications` table (same concept)
- Mark-as-read on open: when user navigates to a channel, all turns in that channel are marked read

Chat's unread UI must match:
- Channel list: blue dot or bold text for channels with unread messages
- Separate "Pending agent requests" section with amber/warning treatment
- Badge count on the Chat nav item in Paperclip's top-level navigation
- On mobile: same responsive patterns Paperclip uses (popover scrolling, command palette centering)

---

## 6. Chat-specific UI components to build

Map each chat component to its closest Paperclip ancestor:

| Chat component | Closest Paperclip pattern | Notes |
|---------------|--------------------------|-------|
| `Sidebar.tsx` (channel list) | Sidebar nav + `IssuesList.tsx` | Same list-item density. Group by type (channels, DMs, threads). |
| `ChatThread.tsx` | `RunTranscriptView.tsx` | Flat message layout, not bubbles. Markdown rendering. Streaming support. |
| `MessageInput.tsx` | Issue comment textarea | `Textarea` with @-mention autocomplete. Send on Enter, newline on Shift+Enter. |
| `CrystallizeCard.tsx` | Approval/confirmation dialogs | `Dialog` with summary preview, confirm/cancel. |
| `SummaryBar.tsx` | Collapsible info panel | Sits at top of thread. Shows global_summary when scrolled up. Token count badge. |
| `NotificationPanel.tsx` | `Inbox.tsx` | Same row pattern. Agent avatar + message preview + timestamp. |
| `PresenceDot.tsx` | `ActiveAgentsPanel.tsx` status dots | Tiny colored circle. Same green/amber/red/gray scheme. |
| `TokenCostIndicator.tsx` | Cost dashboard pattern | Small, inline. `text-xs text-muted-foreground`. E.g., "~1.2k tok" |

---

## 7. Responsive behavior

Paperclip is mobile-aware (v0.3.0 added mobile layout polish). Chat should follow:

- Sidebar collapses on mobile (hamburger menu or swipe)
- Thread takes full width on mobile
- Input stays fixed at bottom
- Dialogs use `sheet` (bottom drawer) on mobile instead of centered modal
- Touch targets minimum 44px (per Apple HIG)
- Command palette centers properly on mobile (Paperclip had a bug with this, now fixed)

---

## 8. Anti-patterns — do NOT do these

- **No consumer chat bubbles**: No colored rounded message bubbles. Messages are flat rows with subtle borders/separators, like Slack or Linear.
- **No custom CSS files**: Everything is Tailwind utilities via `className`. The only CSS file is the global one with CSS variables for shadcn theming.
- **No inline styles**: Use Tailwind classes. `style={{}}` is a code smell.
- **No emoji-heavy UI**: Paperclip is professional/minimal. Use Lucide icons, not emoji, for UI chrome.
- **No loading spinners everywhere**: Use skeleton loading (shadcn `Skeleton` component) for content areas. Small inline spinners only for action buttons.
- **No toast overload**: Use shadcn `toast` sparingly — for errors and important confirmations, not for every message sent.
- **No sound effects or browser notifications without user opt-in**.

---

## 9. Quick reference — file locations in Paperclip to study

These files demonstrate the patterns your code should match:

| File | What to learn from it |
|------|----------------------|
| `ui/src/pages/Dashboard.tsx` | Page layout, data fetching with React Query, list rendering |
| `ui/src/pages/Inbox.tsx` | Unread state, read/unread styling, notification list |
| `ui/src/components/IssueRow.tsx` | Compact row component pattern, status indicators |
| `ui/src/components/IssuesList.tsx` | List with filtering, sorting, empty states |
| `ui/src/components/ActiveAgentsPanel.tsx` | Agent presence dots, status display |
| `ui/src/components/LiveRunWidget.tsx` | Live streaming UI, WebSocket consumption |
| `ui/src/components/transcript/RunTranscriptView.tsx` | Transcript rendering, markdown, streaming chunks |
| `ui/src/components/transcript/useLiveRunTranscripts.ts` | WebSocket hook pattern for live data |
| `ui/src/components/AgentConfigForm.tsx` | Form pattern with shadcn components |
| `ui/src/components/OnboardingWizard.tsx` | Multi-step wizard, card-based UI |
| `ui/src/lib/queryKeys.ts` | React Query key factory pattern |
| `ui/src/lib/inbox.ts` | Unread computation logic |
| `ui/src/api/heartbeats.ts` | API client pattern |
| `ui/components.json` | shadcn/ui configuration — copy this exactly |

---

*paperclip-chat design system reference · derived from paperclipai/paperclip codebase (v0.3.0+)*

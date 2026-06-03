# Shared UI Components

shadcn/ui components shared between pidash-ui and pidiff-ui.
Both UIs import these via the `@ui` Vite alias.

To add a new shared component, place it here and it's automatically
available in both UIs via `import { X } from "@ui/component-name"`.

Components unique to one UI (e.g. pidiff's `switch.tsx`) stay in that UI's
local `components/ui/` directory.

---
name: BitBench
description: Compression algorithm benchmarking platform for researchers
colors:
  background: "oklch(100% 0 0)"
  foreground: "oklch(12% 0.03 260)"
  card: "oklch(100% 0 0)"
  card-foreground: "oklch(12% 0.03 260)"
  primary: "oklch(15% 0.04 260)"
  primary-foreground: "oklch(96% 0.01 260)"
  secondary: "oklch(95% 0.01 260)"
  secondary-foreground: "oklch(12% 0.03 260)"
  muted: "oklch(95% 0.01 260)"
  muted-foreground: "oklch(53% 0.02 260)"
  accent: "oklch(95% 0.01 260)"
  accent-foreground: "oklch(12% 0.03 260)"
  destructive: "oklch(55% 0.2 20)"
  destructive-foreground: "oklch(96% 0.01 260)"
  border: "oklch(88% 0.01 260)"
  input: "oklch(88% 0.01 260)"
  ring: "oklch(12% 0.03 260)"
typography:
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
rounded:
  md: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    typography: "{typography.label}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    border: "1px solid {colors.input}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.md}"
    border: "1px solid {colors.border}"
    padding: "24px"
---

# Design System: BitBench

## 1. Overview

**Creative North Star: "The Lab Bench"**

BitBench is a research instrument. Like a precision oscilloscope or a calibrated spectrometer, every control and display is purposeful. The interface recedes; the data commands attention.

The design is restrained and analytical — white surfaces, dark gray ink, exact borders. Color is reserved for measurement (chart series, status indicators, Pareto-optimal badges). There is no decoration, no illustration, no gradient. The density of information increases as the user moves from upload (sparse, guided) to results (dense, explorable).

This system explicitly rejects: SaaS dashboard clichés (hero metrics, rounded gradient cards, decorative illustration), consumer playfulness (micro-animations, emoji, gamification), and enterprise gray-on-gray aesthetic.

**Key Characteristics:**
- High data density on results pages; clean whitespace on task pages
- Chromatic restraint — color encodes data, never decoration
- Tonal depth via layered surfaces, not shadows
- Exact borders as the primary structural device

## 2. Colors

A restrained, technical palette anchored by a very dark blue-black ink on pure white. Neutrals carry a subtle blue undertone (0.01 chroma toward 260°) that reads as precision, not warmth.

### Primary
- **Ink** (`oklch(12% 0.03 260)`): Primary text, interactive element backgrounds. The single dark anchor of the system. Used for body text, active nav, button backgrounds.
- **Paper** (`oklch(100% 0 0)`): Primary surface. Used for page backgrounds, card backgrounds, modal surfaces. Pure white for maximum contrast with Ink.
- **Private Watermark** (`oklch(96% 0.01 260)`): Secondary surface and interactive backgrounds. Used on button hover, nav hover, table row hover, section headers.
- **Edge** (`oklch(88% 0.01 260)`): Borders, dividers, input strokes. The light structural line of the system.
- **Dim Ink** (`oklch(53% 0.02 260)`): Secondary text, placeholders, disabled labels. Meets WCAG AA 4.5:1 against Paper (verified).

### Signal
- **Alert** (`oklch(55% 0.2 20)`): Destructive actions, error states, deletion. Slightly desaturated red for technical precision, not alarm.
- **Alert Surface** (`oklch(96% 0.01 260)` x Alert background overlay): Error message backgrounds.

### The Ink Rule
The foreground color (`oklch(12% 0.03 260)`) is never lightened for "visual hierarchy." Hierarchy is produced through spacing, weight (600 vs 400), and size — never through fading Ink toward Dim Ink for body text. Body text is always full Ink at `oklch(12% 0.03 260)`. Dim Ink is reserved for secondary metadata, placeholders, and disabled content.

## 3. Typography

**Body / UI Font:** system-ui, -apple-system, sans-serif
**Mono Font:** ui-monospace, SFMono-Regular, Menlo, monospace

The system draws from the native OS font stack for maximum rendering reliability and zero load cost. The sans-serif is crisp and neutral — no distinct personality needed because the tool's voice comes from its data, not its typeface.

**Character:** Clean, legible, fast. The native UI font stack ensures every researcher sees the interface in whatever typeface their OS optimizes for reading.

### Hierarchy
- **Headline** (600, `1.5rem`/`1.1`)/`2xl`: Page titles and section headings.
- **Title** (500, `1rem`/`1.2`): Card titles, modal headings, section labels.
- **Body** (400, `0.875rem`/`1.5`): All running text, table cells, form labels. Capped at 75ch max-width where applicable.
- **Label** (500, `0.875rem`/`1`): Form labels, button text, table headers.
- **Caption** (400, `0.75rem`/`1.4`): Secondary metadata, timestamps, file sizes, status badges.
- **Mono** (400, `0.8125rem`/`1.4`): Compressor names, code-like identifiers, benchmark values in tables.

## 4. Elevation

BitBench uses **tonal layering**, not shadows. Depth is conveyed through subtle background color shifts, never through box-shadows.

Surfaces at the Paper level (`oklch(100% 0 0)`) are the base. Overlays, dropdowns, and modals step up via background contrast, not drop shadows.

- **Page surface:** Paper (`oklch(100% 0 0)`)
- **Card surface:** Paper (`oklch(100% 0 0)`), separated from page by a 1px Edge border
- **Interactive hover:** Private Watermark (`oklch(96% 0.01 260)`)
- **Dropdown / Modal backdrop:** A scrim layer at `oklch(0% 0 0 / 0.3)`
- **Focus ring:** A 2px ring at Ink

**The Flat Rule.** No box-shadows anywhere in the system. Depth is expressed through tonal layering and borders. A shadow on any surface is an error.

## 5. Components

### Buttons
A single small set of variations — the system doesn't need more.

- **Primary Button:** Ink background, Paper text, 8px radius. Hover: tint the Ink toward lighter. Focus: 2px Ink ring. Active: shift Ink darker.
- **Outline Button:** Transparent background, Ink text, 1px solid Edge border. Hover: Private Watermark background. Focus: 2px Ink ring.
- **Ghost Button:** Transparent background, Ink text. Hover: Private Watermark background. Focus: 2px Ink ring.

### Inputs / Fields
Standard text input with a 1px Edge stroke. Focus transitions to a 2px Ink ring outline (no glow, no shadow). Error state swaps the stroke to Alert.

- **Resting:** 1px solid Edge border, transparent background, Ink text.
- **Focus:** 2px Ink ring, no border color change.
- **Error:** 1px solid Alert border (or combined with focus).
- **Disabled:** Dim Ink text, Private Watermark background.

### Badges / Pills
Used for status indicators (queued, in_progress, ready, failed) and compressor tags.

- **Shape:** 6px radius (`rounded-md` with vertical padding).
- **Inline treatment:** bordered (`1px solid` tinted to match the status), not filled. A colored border + gray background + colored text. Status determines the border/text hue: blue for queued, yellow for in_progress, green for ready, red for failed, orange for timed_out, gray for cancelled.
- Status badges include a small colored dot (round div, 6px) before the text label for quick scanning.

### Cards
Used as benchmark result containers on the results list page, and as section containers on the detail page.

- **Structure:** Paper background, 1px Edge border, 8px radius, 24px internal padding.
- **States:** No hover effect on container cards (they're link wrappers, so the link text carries the hover).
- **Nesting:** Never nested. A card inside a card is structurally forbidden.

### Navigation (Header)
The top navigation uses ghost-style text links, no active background pill. The active page is indicated by the nav text weight (600) and the presence of the current page's icon in full opacity. Inactive items use Dim Ink. Hover items get Private Watermark background.

### Tables
The primary data display on results and detail pages.

- **Structure:** Full-width, no alternating row colors. Row separator: 1px Edge divider between rows.
- **Header:** Private Watermark background, Label weight.
- **Row hover:** Private Watermark background (same as header).
- **Focusable rows:** Keyboard navigation via tabindex + visible focus ring.

### Accordion
Used on the upload page for compressor selection, and on the detail page for per-metric sections.

- **Trigger:** Full-width button, Ink text, Private Watermark background on hover. Chevron icon (Lucide `ChevronDown`) rotates on open.
- **Content:** Padding on all sides, no extra border (the accordion item's Edge border acts as the section separator).

## 6. Do's and Don'ts

### Do:
- **Do** use Ink for body text at all sizes. WCAG AA requires 4.5:1; full Ink delivers it.
- **Do** reserve color for data encoding: chart series, status badges, Pareto-optimal flags.
- **Do** use tonal layering for depth — Private Watermark on hover, Edge borders on containers.
- **Do** keep the upload flow sparse (one name field, one file area, one compressor accordion). The density ramps as the user commits to analysis.
- **Do** show exact values in ranked tables with unit annotations.
- **Do** use mono type for compressor names and numeric benchmark values.

### Don't:
- **Don't** use box-shadows anywhere. The Flat Rule. No exceptions.
- **Don't** use gradient text, gradient backgrounds, or glassmorphism.
- **Don't** use side-stripe borders (`border-left` / `border-right` as a colored accent). Use full borders, background tints, or nothing.
- **Don't** display hero metrics (big number + small label + sparkline) — that is SaaS dashboard grammar, not an analysis instrument.
- **Don't** fade body text for "visual hierarchy." Hierarchy comes from spacing, weight, and size — never from chroma.
- **Don't** decorate with illustrations or icons that don't carry function.
- **Don't** gate content visibility on CSS transitions (animation pause on hidden tabs leads to blank sections).
- **Don't** use `z-index` values above 100. Build a semantic scale: dropdown(10), sticky header(20), modal backdrop(30), modal(40), toast(50), tooltip(60).

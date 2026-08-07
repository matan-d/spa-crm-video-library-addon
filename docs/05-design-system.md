# Design system

The palette from the visual maps is the product's palette, confirmed by the user.
It is already validated in both light and dark in that page, so this file is the transcription rather than a fresh proposal.

## The rule that makes it a system rather than a colour scheme

**Colour encodes who is responsible for a thing.**

| meaning | token family | used for |
|---|---|---|
| a model produced this | `--ai` (amber) | AI scores, AI tags, generated brief items, search parsing, gap findings, the simulated badge |
| a human decided this | `--human` (deep green) | approvals, rejections, locked briefs, human tags, overrides, consent records, confirmed usage |
| a measured fact or system state | neutral (`--ink`, `--muted`, `--line`) | durations, dimensions, dates, counts, pre-flight measurements, everything deterministic |

This maps exactly onto the product's central distinction, which is the split between what AI proposed and what a person decided.
So the palette is doing product work, not decoration.

**The corollary is a bug rule:** amber on something a human decided is a defect, and neutral on something a model produced is a defect. `tenancy-guard` and `ai-contract` should both treat a mis-coloured provenance state as a finding, because the whole point is that a manager can see at a glance which parts of a screen nobody has checked.

## Tokens, light

```css
--bg:         #EEF1EB;  /* pale sage grey, the page ground */
--surface:    #FFFFFF;
--surface-2:  #F6F8F4;  /* recessed panels, table fills */
--ink:        #16211C;  /* deep green-black, body text */
--muted:      #64736B;  /* secondary text, mono labels */
--line:       #D3DBD1;  /* hairlines, borders */
--ai:         #9C6210;  /* amber, AI accent */
--ai-soft:    #F7E9CC;  /* amber fill */
--ai-line:    #DDBE85;  /* amber border */
--human:      #2F4A3E;  /* deep green, human accent */
--human-soft: #E2EAE3;  /* green fill */
```

## Tokens, dark

```css
--bg:         #0F1512;
--surface:    #161E1A;
--surface-2:  #1B241F;
--ink:        #E4EAE2;
--muted:      #93A29A;
--line:       #27332D;
--ai:         #E7B45F;
--ai-soft:    rgba(53, 41, 20, 0.58);
--ai-line:    #6B5426;
--human:      #BFD6C7;
--human-soft: #202C25;
```

The neutrals are deliberately hue-biased toward the greens rather than being pure grey, which is what stops the interface reading as a default admin panel.

## Theme mechanics

Define the palette as custom properties on `:root`, redefine only the tokens under `@media (prefers-color-scheme: dark)`, then redefine them again under `:root[data-theme="dark"]` and `:root[data-theme="light"]` so an explicit user toggle wins in both directions.
Style every component through the tokens, never inside the media query.

## Type

Two roles, no webfont, so there is no CDN dependency and no silent fallback:

- **Display and body**: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Display sizes get weight 620 to 660 and tight negative tracking (about `-0.02em`), with `text-wrap: balance` on headings.
- **Labels, data, identifiers, and anything technical**: `ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace`, small, uppercase for labels with about `0.1em` letter-spacing.

`font-variant-numeric: tabular-nums` anywhere digits line up in a column, which in this product is most places: counts, durations, scores, sizes, dates.

Running prose stays near 65 characters wide.

## Structure

- Hairline borders in `--line`, 1px. No drop shadows beyond a 1px hairline lift.
- Corner radius stays small on technical surfaces, 2 to 4px, so tables and cards read as instruments. Full pills (999px) are reserved for state chips and facet chips, which is what makes them read as toggles.
- Layout uses flex or grid with `gap`, never per-element margins that collapse or double.
- Wide content (tables, the kanban, diagrams) scrolls inside its own `overflow-x: auto` container. The page body never scrolls sideways.
- Every interactive element has a visible keyboard focus state, and `prefers-reduced-motion` is respected.

## Density, per form factor

Desktop is an instrument and mobile is a decision surface, so density differs by intent rather than by scaling one down.
Desktop review and library views run tight rows and small mono metadata.
Mobile runs larger touch targets, one decision per screen, and drops secondary metadata rather than shrinking it.

## What not to do

Do not spend the amber. It is the highest-information colour in the interface and it means one specific thing.
Do not add a third accent hue. Semantic status (good, warning, critical) is separate from both accents and stays desaturated so it never competes with the AI amber.
Do not introduce a webfont.

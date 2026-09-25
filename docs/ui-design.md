# UI design direction

Stated preference: **modern, sleek, clean, easy to look at. Dark, but not
extremely dark.** Substance over decoration -- the monitoring and optimization
intelligence matter more than the chrome.

## Interpretation

"Dark but not insanely dark" means an elevated-surface dark theme rather than
pure black: a base around `#14161A` with cards a step lighter, generous
whitespace, restrained borders, one accent colour. Not OLED black, not
mid-grey, no heavy gradients, no glassmorphism.

## Tokens (draft -- accent comes from `config/branding.toml`)

```
--bg          #14161A   page background (not #000)
--surface     #1B1E24   cards, panels
--surface-2   #22262E   raised / hover
--border      #2C313A   hairlines, 1px
--text        #E6E9EF   primary
--text-dim    #9AA3B2   secondary, axis labels
--text-faint  #6B7484   tertiary, metadata
--accent      from branding.accentColor (default #6C8CFF)
--ok          #4ADE80
--warn        #FBBF24
--bad         #F87171
```

## Rules

- One accent colour. Status colours (ok/warn/bad) are the only other hues, and
  are always paired with a label or shape -- never colour alone.
- Numbers are the interface. Tabular figures, right-aligned, consistent
  precision (ms/tick to 3 dp, MSPT to 2).
- Charts: thin lines, no fills unless comparing, no 3D, no drop shadows.
  Threshold bands drawn from `[thresholds]` in config, not hardcoded.
- Density over sprawl: this is a tool that gets scanned, not a landing page.
- Confidence is always visible. A figure backed by few samples is rendered
  visibly weaker than one backed by millions -- the UI must never make a thin
  finding look solid.
- No SPA build chain. Server-rendered HTML, one small chart library.

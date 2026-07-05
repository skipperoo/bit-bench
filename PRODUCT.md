# Product

## Register

product

## Users

Compression researchers — academics and industry engineers evaluating lossless compression algorithms on integer sequence data. They bring their own data files (.bin, .csv, .zip, .tar), select which compressors to test, and need clear, precise results to make informed decisions.

Their context: a research workflow. They upload a file, configure compressors, submit the benchmark, and return later to study the results. The results page is where they spend most of their time — ranked tables, Pareto charts, scatter plots comparing ratio vs throughput. They need to compare multiple benchmarks side by side.

They are technical users comfortable with dense information displays. They value precision over hand-holding, and they will run many benchmarks to narrow down the right compressor for their data shape.

## Product Purpose

BitBench lets researchers quickly compare compression algorithms on their own data. Upload a file, select compressors, and get a ranked analysis of which compressor compresses best, fastest, and most efficiently.

Success looks like: a researcher uploads a dataset, selects 10+ compressors, comes back to a clear ranked overview with Pareto-optimal compressors highlighted, and confidently picks the right one for their use case.

## Brand Personality

Precise. Technical. Confident.

- **Voice:** Direct, factual, no hype. Like a well-written research paper.
- **Tone:** Neutral and professional. The results speak for themselves — the interface doesn't editorialize.
- **Energy:** Calm and deliberate. Not urgent, not playful. The user is analyzing, not shopping.

## Anti-references

What BitBench should NOT look like:

- **SaaS dashboard** — No rounded cards with gradients, no "hero metrics" (big number + small label + sparkline), no decorative illustration. This is a research tool, not a growth-stage product.
- **Consumer fintech** — Not an app that tries to be "delightful" with micro-animations and emoji. No gamification.
- **Over-designed landing page** — No full-bleed hero sections, no "About" / "Process" / "Pricing" layout. The interface is the product.
- **Database admin tool gray** — Not the beige-on-gray-on-white enterprise aesthetic either. Color is used for data encoding (chart series, status indicators, Pareto badges), not for decoration.

## Design Principles

1. **Data first, chrome second.** Every pixel either IS data or helps the user read data. Navigation, controls, and chrome recede. Charts, tables, and rankings take precedence.
2. **Progressive density.** The upload flow is sparse and guided (name +file + compressors). The results pages are dense — the user came here to compare numbers, so we show them. Start simple, scale up.
3. **Respect the expert.** No tooltips explaining what "compression ratio" means. No onboarding tours. The user knows their domain; we provide a precise instrument.
4. **Consistency over cleverness.** Same patterns everywhere: same table styling, same chart axis treatment, same status badge system. Predictability builds trust in the data.
5. **Confidence through precision.** Ranked tables show exact values, not ordinal bars. Pareto-optimal compressors are flagged explicitly. Every metric has its unit and direction (lower/higher is better) visible.

## Accessibility & Inclusion

Target: WCAG 2.1 AA.

- Text contrast ≥4.5:1 for body, ≥3:1 for large text
- All interactive elements keyboard-navigable
- Reduced motion respected; no content gated on animation
- Charts use distinguishable colors and can be read through their data tables as a fallback
- Status indicators combine color + text (not color alone)

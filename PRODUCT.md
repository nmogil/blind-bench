## Design Context

### Users
Prompt engineers, ML researchers, and product teams evaluating LLM outputs. Primary users are technical (developers writing prompts), but secondary users are domain experts invited as blind evaluators — they may arrive on mobile via email link with zero context. The landing page must convert both: technical users who understand prompt engineering pain, and curious visitors who need the concept explained in under 10 seconds.

### Brand Personality
**Rigorous. Direct. Precise.**

Blind Bench is a clinical trial for prompts — it removes bias from evaluation by blinding reviewers to which version produced each output. The brand communicates scientific credibility without academic stuffiness. Every word earns its place. The tool is serious but not intimidating.

### Emotional Goals
The primary emotion within 5 seconds of landing: **"I need this."** Visitors should feel the pain of biased prompt evaluation and immediately see the solution. Recognition, then urgency, then relief that someone built this.

### Aesthetic Direction
**Scientific elegance** — clean, precise, restrained. White space, sharp typography, subtle purposeful motion. Let the product concept speak.

**Primary reference:** Linear.app — minimal, fast, sharp animations, dark-mode-first, developer-focused. The landing page should feel like a well-designed research paper: confident, structured, with clear visual hierarchy that guides the eye.

**Anti-references:**
- Playful/bouncy SaaS pages with cartoon illustrations
- Gradient-heavy "Web3" aesthetic
- Cluttered enterprise dashboards marketed as features
- Generic AI landing pages with abstract particle effects

### Color System
OKLch color space. Blue-purple primary (`oklch(0.546 0.245 262.881)`). Monochromatic gray scale for structure. The palette is intentionally restrained — color is used for emphasis, not decoration. Dark mode must retain a tinted primary (the current dark mode loses brand color by going achromatic — this needs fixing).

Color-blind safe: no red/green for semantic meaning. Use blue/amber or blue/purple pairs.

### Typography
Geist Variable (100-900 weight range). Single font family for everything. Hierarchy through weight and size, not font variety. Tighter tracking for display sizes, normal tracking for body.

### Design Principles
1. **Restraint is credibility** — Every visual element must earn its place. No decoration for decoration's sake. White space communicates confidence.
2. **The concept sells itself** — The blind evaluation idea is inherently compelling. Show it, don't just describe it. A visual demonstration of A/B/C blinding is worth more than any paragraph.
3. **Motion with purpose** — Animations should reveal information or guide attention, never distract. Think Linear's scroll-triggered reveals: sharp, fast, intentional.
4. **Pain before solution** — Lead with the recognition moment ("you've been doing this wrong") before showing the fix. Urgency drives conversion more than feature lists.
5. **One action per screen** — Every section should have a clear singular purpose. The page is a funnel, not a brochure.

### Technical Constraints
- Astro 6 static site (no React hydration on core page)
- Tailwind CSS 4 with @theme inline tokens
- Page weight budget: < 100KB
- Lighthouse targets: Performance > 90, Accessibility > 95
- Must respect `prefers-reduced-motion`
- WCAG 2.1 AA minimum

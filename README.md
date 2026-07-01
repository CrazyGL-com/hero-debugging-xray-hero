<sub>*Hero made by [@ybouane](https://x.com/ybouane).*</sub>
<p align="center">
  <img src="https://crazygl.com/heroes/hero-debugging-xray-hero/banner-full.png" alt="Debugging X-Ray" width="640">
</p>

# @crazygl/hero-debugging-xray-hero

A polished product screenshot scanned by an animated x-ray band that reveals the underlying component structure as glowing devtools-style bboxes and accessibility outlines. Drag the pointer, or let it auto-sweep — exactly the feeling of opening the inspector on production.

## Demo
[Debugging X-Ray](https://crazygl.com/hero/debugging-xray-hero)

## Install

```bash
npm install @crazygl/hero-debugging-xray-hero
```

## Usage

```tsx
import DebuggingXray from '@crazygl/hero-debugging-xray-hero';

export default function Hero() {
	return (
		<DebuggingXray
			heading="See every render, every leak, every layout shift."
			screenshot="https://crazygl.com/samples/screenshot-dashboard-dark.avif"
			scanMode="both"
			accentColor="#5cd5ff"
		/>
	);
}
```

## Customise

- **Content** — `heading` + `subheading` + `ctaLabel`/`onCTAClick`, two columns, or a custom node.
- **Screenshot** — `screenshot` (PNG/JPG/WebP/AVIF) plus `screenshotScale`, `screenshotX/Y`, `screenshotTilt` to place it as a product card.
- **X-Ray scan** — `scanMode` (pointer / auto / both), `scanSpeed`, `bandWidth`, `accentColor`.
- **X-ray source** — `xrayMode` procedural overlay or a custom `xrayImage` (wireframe / blueprint, cover-fit aligned).
- **Overlay** — `overlayStyle` (bboxes / heatmap / both) and `overlayDensity`.
- **Stage** — `parallaxStrength`, `bgTop`/`bgBottom`, `transparentBackground`.

The screenshot reads best with visible structure — dashboards, IDEs and admin UIs, whose cards, sidebars and tables give the bounding boxes real structure to discover.

## Best for

- Observability and monitoring platforms (paint timing, Core Web Vitals, RUM).
- Devtools, inspector and frontend-performance products.
- Accessibility testing suites and engineering dashboards.
- AI-for-engineers pages where "see inside your app" is the pitch.



This hero is part of [CrazyGL](https://crazygl.com), a collection of production-ready WebGL, canvas, 3D, and typography effects. Every CrazyGL hero ships with an agent-ready `SKILL.md` file that helps developers and coding agents adapt the effect into custom landing pages and interactive experiences.

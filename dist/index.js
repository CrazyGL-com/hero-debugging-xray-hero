import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import * as React from 'react';
import CrazyGLWrapper, { useContent, useHeroAnimationFrame, useHeroReady, } from '@crazygl/core';
import metadata from './metadata.json';
import './style.css';
/* ─────────────────────────────────────────────────────────────────────────
   Debugging X-Ray — a polished product screenshot scanned by an animated
   x-ray band that reveals the underlying component structure as glowing
   devtools-style bboxes + accessibility outlines + render-cost heatmap.

   TECHNIQUE
   ─────────
   A single Three.js plane displays the screenshot. A custom fragment
   shader does two passes per fragment:

     1. POLISHED PASS — the screenshot is sampled (cover-fit on the
        plane's UV) and rendered close to its source colour, with a
        tiny scanline + chromatic-edge fringe for the "this is a screen"
        cue.

     2. X-RAY PASS — procedural devtools overlay assembled in-shader:
          a. Hash-grid → deterministic-per-cell box bounds. Each cell
             rolls a 2D hash to decide whether to draw a box, what
             size to draw it (inset from cell bounds), and at what
             nesting depth (one inset child + grandchild). Boxes
             have anti-aliased borders (analytic distance-to-rect).
          b. Heatmap → luminance of the screenshot mapped through a
             cool→hot ramp. Brighter UI regions (text, buttons) glow
             hotter, conveying "render cost / paint count."
          c. Accent-tinted scanline raster (thin horizontal lines).

   The two passes are blended by a "reveal weight" derived from the
   scan position:

       d = abs(uv.x - scanX)                          // distance to band
       reveal = 1 - smoothstep(W*0.4, W, d)           // soft mask

   Where W is the band width in UV units. We also accumulate a sharp
   scan-line glow at d ≈ 0 (additive on top).

   The scan position `scanX` is driven by JS each frame:

       - "pointer"  → input.x clamped to the screenshot's UV X range
       - "auto"     → ping-pong sweep at scanSpeed widths/sec
       - "both"     → auto sweep when pointer is idle; pointer override
                      when pointer has moved within the last 0.6s

   COORDINATE SPACES
   ─────────────────
     world         — three.js world; screenshot group sits at
                     (screenshotX * worldWidth*0.5, screenshotY * worldHeight*0.5, 0)
     uv            — plane local UV [0..1] × [0..1]; (0,0) bottom-left
     coverUv       — cover-fit UV in image space (so non-aspect-matching
                     screenshots render with the right aspect on the plane)
     u_scanX       — scan position in plane-UV X, [0..1]
     u_input       — wrapper pointer in [0..1] (top-left origin). For Y
                     we flip to UV by `1 - input.y`.
   ─────────────────────────────────────────────────────────────────────── */
const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

/*
   Coordinate spaces in this shader:
     vUv          — plane local UV, [0..1] x [0..1]
     coverUv      — cover-fit screenshot UV (preserves image aspect inside plane)
     u_scanX      — scan band centre in vUv.x space, [0..1]
     u_input      — pointer, [0..1] top-left origin (we don't use directly here;
                    scanX is precomputed CPU-side)
     u_planeAspect = plane W/H
     u_imgAspect   = image W/H
   The overlay (bboxes + heat + scanlines) is drawn in vUv space so it
   tiles cleanly across the plane regardless of image aspect.
*/

varying vec2 vUv;

uniform sampler2D u_screenshot;
uniform float u_hasScreenshot;
uniform vec2 u_imgSize;       // intrinsic image size in pixels (for cover-fit)
uniform vec2 u_planeSize;     // plane size in world units (for cover-fit)
uniform float u_time;
uniform float u_scanX;        // 0..1 along plane uv.x
uniform float u_bandWidth;    // 0..1 uv-x extent
uniform vec3  u_accent;
uniform float u_overlayDensity;
uniform float u_overlayStyle; // 0=bboxes only, 1=heat only, 2=both
uniform float u_pulse;        // 0..1 slow ambient pulse on scanline glow
uniform float u_transparent;  // 0/1
uniform float u_opacity;      // 0..1 master opacity (for fade-in)

// X-ray image mode: when u_xrayMode == 1 and u_hasXrayMap == 1, the
// revealed pass samples u_xrayMap (cover-fit on the screenshot's aspect)
// instead of building the procedural devtools overlay.
uniform sampler2D u_xrayMap;
uniform float u_hasXrayMap;   // 0/1
uniform int   u_xrayMode;     // 0=procedural, 1=image

/* ─── Utilities ────────────────────────────────────────────────────── */

// Multi-step non-linear hash. Avoids fract(sin(...)) banding.
float hash21(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
	float a = hash21(p);
	float b = hash21(p + vec2(17.13, 31.71));
	return vec2(a, b);
}

float luma(vec3 c) {
	return dot(c, vec3(0.299, 0.587, 0.114));
}

// Cover-fit UV — preserves the screenshot's native aspect on the plane.
// SKILL.md catalog "Image-backed background (cover-fit sampling)".
vec2 coverUv(vec2 uv) {
	float imgA = u_imgSize.x / max(u_imgSize.y, 1.0);
	float plnA = u_planeSize.x / max(u_planeSize.y, 1.0);
	vec2 scale = vec2(1.0);
	if (imgA > plnA) scale.x = plnA / imgA;
	else             scale.y = imgA / plnA;
	return (uv - 0.5) * scale + 0.5;
}

// Analytic anti-aliased rectangle border. Returns 1.0 on the border,
// 0.0 elsewhere. p is fragment in [0..1]², centre = c, half-extent = he,
// border thickness = th (in uv units).
float rectBorder(vec2 p, vec2 c, vec2 he, float th) {
	vec2 d = abs(p - c) - he;
	float outside = max(d.x, d.y);            // signed distance to rect edge
	float inner = max(d.x + th, d.y + th);    // inner edge
	// edge band: between (outside <= 0) and (inner >= -th).
	float aa = fwidth(outside) * 1.5 + 1e-4;
	float onEdge =
		(1.0 - smoothstep(0.0, aa, outside)) *
		(1.0 - smoothstep(0.0, aa, -inner));
	return clamp(onEdge, 0.0, 1.0);
}

// Filled rect mask (1.0 inside, 0.0 outside). For corner ticks / labels.
float rectMask(vec2 p, vec2 c, vec2 he) {
	vec2 d = abs(p - c) - he;
	float outside = max(d.x, d.y);
	float aa = fwidth(outside) * 1.5 + 1e-4;
	return 1.0 - smoothstep(0.0, aa, outside);
}

/* ─── Heat ramp (luminance → cool→warm) ────────────────────────────── */
vec3 heatRamp(float t) {
	t = clamp(t, 0.0, 1.0);
	// 4-stop cool→warm. Tuned for "profiler" look: deep blue → cyan →
	// yellow → red. Mixed in linear-ish space so the gradient reads soft.
	vec3 c0 = vec3(0.04, 0.07, 0.22);
	vec3 c1 = vec3(0.10, 0.50, 0.90);
	vec3 c2 = vec3(0.95, 0.85, 0.20);
	vec3 c3 = vec3(0.95, 0.30, 0.20);
	if (t < 0.4)      return mix(c0, c1, t / 0.4);
	else if (t < 0.7) return mix(c1, c2, (t - 0.4) / 0.3);
	else              return mix(c2, c3, (t - 0.7) / 0.3);
}

/* ─── Devtools bbox overlay ───────────────────────────────────────────
   Procedural hash-grid bboxes. We tile vUv into cells of size 1/N,
   each cell rolls one hash to decide whether to draw a primary box,
   and one hash to decide whether to nest a child + grandchild.
   This is "devtools when you hover a region": you see the parent
   element bound + a couple of children inset.

   The grid resolution scales with u_overlayDensity. At 0.5 the grid is
   coarse (a handful of boxes per row); at 1.4 it gets tight nested
   structure.
   ──────────────────────────────────────────────────────────────────── */
vec3 bboxLayer(vec2 uv, float density, vec3 accent) {
	// Two octaves of cells: coarse parent + finer children.
	// Anchor on the screenshot's intrinsic aspect so cells stay roughly
	// square instead of stretching with the plane.
	float imgA = u_imgSize.x / max(u_imgSize.y, 1.0);

	// Octave 1: parents.
	float Nx = max(2.0, floor(4.0 * density + 0.5));
	float Ny = max(2.0, floor(Nx / max(imgA, 0.2) + 0.5));
	vec2 cells = vec2(Nx, Ny);
	vec2 cell = floor(uv * cells);
	vec2 local = fract(uv * cells);
	vec2 h = hash22(cell + vec2(0.13, 0.71));

	// Decide if THIS cell hosts a parent bbox. Keep about 65% of cells.
	float showParent = step(0.35, h.x);
	// Parent bbox: insets by 0.08..0.18 from cell bounds.
	vec2 inset = mix(vec2(0.08), vec2(0.20), hash22(cell + 7.31));
	vec2 pHE = vec2(0.5) - inset;
	float parentBorder = rectBorder(local, vec2(0.5), pHE, 0.012) * showParent;

	// Child bbox INSIDE the parent. Random sub-rectangle.
	vec2 cCentre = mix(vec2(0.25, 0.30), vec2(0.75, 0.70), hash22(cell + 19.7));
	vec2 cHE = mix(vec2(0.08, 0.06), vec2(0.30, 0.22), hash22(cell + 53.1));
	// Clamp so child fits inside parent inset.
	cHE = min(cHE, pHE - vec2(0.03));
	cCentre = clamp(cCentre, vec2(0.5) - pHE + cHE + 0.01, vec2(0.5) + pHE - cHE - 0.01);
	float showChild = step(0.30, hash21(cell + 91.3));
	float childBorder = rectBorder(local, cCentre, cHE, 0.008) * showParent * showChild;

	// Grandchild — only sometimes, when density is high.
	float showGrand = step(0.50, hash21(cell + 127.7)) * step(0.6, density);
	vec2 gCentre = mix(cCentre - cHE * 0.5, cCentre + cHE * 0.5, hash22(cell + 161.1));
	vec2 gHE = cHE * mix(vec2(0.20), vec2(0.45), hash22(cell + 211.7));
	float grandBorder = rectBorder(local, gCentre, gHE, 0.006) * showParent * showChild * showGrand;

	// Corner tick markers — tiny filled squares at the parent corners.
	// Reads as "devtools selected element with handles."
	float tick = 0.0;
	if (showParent > 0.5) {
		float ts = 0.018;
		tick += rectMask(local, vec2(0.5) - pHE, vec2(ts));
		tick += rectMask(local, vec2(0.5) + vec2(pHE.x, -pHE.y), vec2(ts));
		tick += rectMask(local, vec2(0.5) + vec2(-pHE.x, pHE.y), vec2(ts));
		tick += rectMask(local, vec2(0.5) + pHE, vec2(ts));
	}

	float strength = parentBorder * 1.0 + childBorder * 0.85 + grandBorder * 0.7 + tick * 0.9;
	// Subtle per-cell variation so they don't all glow identically.
	float jitter = 0.7 + 0.3 * h.y;
	vec3 col = accent * strength * jitter;

	// Faint "selection fill" inside the parent rect for some cells.
	float selFill = (1.0 - smoothstep(0.0, 0.001, max(abs(local.x - 0.5) - pHE.x, abs(local.y - 0.5) - pHE.y)));
	float fillEnable = step(0.78, h.x) * showParent;
	col += accent * selFill * fillEnable * 0.08;

	return col;
}

/* ─── Heat overlay ───────────────────────────────────────────────────── */
vec3 heatLayer(vec2 uv, vec3 imgCol, vec3 accent) {
	float L = luma(imgCol);
	// Map luminance to "render cost": brighter UI = hotter. Bias to
	// emphasise mid-bright text + buttons.
	float cost = smoothstep(0.20, 0.92, L);
	// Add a slow boil from the noise hash for life.
	float boil = hash21(floor(uv * 200.0) + floor(u_time * 1.5));
	cost = clamp(cost + (boil - 0.5) * 0.08, 0.0, 1.0);
	vec3 heat = heatRamp(cost);
	// Tint slightly toward the accent so the overall band reads "one tool".
	heat = mix(heat, heat * (0.6 + accent * 0.6), 0.25);
	return heat;
}

void main() {
	vec2 uv = vUv;

	/* ─── Screenshot sample (cover-fit) ─────────────────────────────── */
	vec3 polished;
	if (u_hasScreenshot > 0.5) {
		vec2 sUv = coverUv(uv);
		// Clamp so we don't read outside the texture (would wrap-tile on edges).
		vec2 sClamped = clamp(sUv, vec2(0.0), vec2(1.0));
		vec3 col = texture2D(u_screenshot, sClamped).rgb;
		// Outside the cover area: fade to a deep tone (screen frame).
		float inside = step(0.0, sUv.x) * step(sUv.x, 1.0) * step(0.0, sUv.y) * step(sUv.y, 1.0);
		col = mix(vec3(0.04, 0.06, 0.11), col, inside);

		// Subtle scanline (every 2 pixels of a high-resolution screen ~720 lines).
		// Very faint — just enough to read "this is a display."
		float scan = 0.95 + 0.05 * sin(uv.y * 1400.0);
		col *= scan;

		polished = col;
	} else {
		// No screenshot loaded → render a flat fallback so the layout reads.
		polished = vec3(0.04, 0.06, 0.11);
	}

	/* ─── Reveal mask ────────────────────────────────────────────────── */
	float d = abs(uv.x - u_scanX);
	float W = max(0.001, u_bandWidth);
	// Soft falloff from the band centre. The 0.4*W "core" stays fully
	// revealed; falls to 0 by W. Reads as a thick scanning band.
	float reveal = 1.0 - smoothstep(W * 0.45, W, d);
	// At the very centre (d < 1px or so) we add a bright scan line.
	float aaScan = fwidth(d) * 2.5 + 1e-4;
	float scanLine = (1.0 - smoothstep(0.0, aaScan + 0.002, d)) * (0.75 + 0.25 * u_pulse);
	// A slightly broader soft glow halo on either side of the line —
	// reads as the band's leading edge.
	float scanHalo = exp(-pow(d / max(W * 0.18, 0.005), 2.0)) * 0.55;

	/* ─── Overlay assembly (only computed where revealed > 0) ──────── */
	vec3 overlay = vec3(0.0);
	// Track whether we used an image overlay this frame; the composite
	// below dampens the additive polished bleed-through so the user's
	// x-ray image reads cleanly (otherwise the polished screenshot
	// shines through it under the band).
	float imageOverlayActive = 0.0;
	if (reveal > 0.01) {
		if (u_xrayMode == 1 && u_hasXrayMap > 0.5) {
			// Image x-ray: sample the user-provided map with the SAME
			// cover-fit math as the screenshot. This keeps the wireframe /
			// schematic / blueprint aligned with the polished UI underneath.
			vec2 xUv = coverUv(uv);
			vec2 xClamped = clamp(xUv, vec2(0.0), vec2(1.0));
			vec3 xCol = texture2D(u_xrayMap, xClamped).rgb;
			float inside = step(0.0, xUv.x) * step(xUv.x, 1.0) * step(0.0, xUv.y) * step(xUv.y, 1.0);
			// Outside the image's cover area, fall back to the deep
			// "screen-removed" tone so the band edges read consistently.
			xCol = mix(vec3(0.04, 0.06, 0.11), xCol, inside);
			overlay = xCol;
			imageOverlayActive = 1.0;
			// Stronger darkening of the polished pass under the band so
			// the schematic / wireframe is the dominant read.
			polished = mix(polished, polished * vec3(0.12, 0.15, 0.20), reveal * 0.70);
		} else {
			// Procedural devtools overlay.
			// Bbox layer.
			vec3 boxCol = bboxLayer(uv, u_overlayDensity, u_accent);
			// Heat layer.
			vec3 heatCol = heatLayer(uv, polished, u_accent);
			// Style switching:
			//   0 = bboxes only, 1 = heat only, 2 = both
			float wBoxes = (u_overlayStyle < 0.5) ? 1.0
				: (u_overlayStyle < 1.5 ? 0.0 : 1.0);
			float wHeat  = (u_overlayStyle < 0.5) ? 0.0
				: (u_overlayStyle < 1.5 ? 1.0 : 0.75);
			// Heat is the base "tinted view of the UI"; boxes additive on top.
			overlay = heatCol * wHeat * 0.85 + boxCol * wBoxes;
			// A faint darkening of the polished image under the band so the
			// overlay reads against a "removed paint" look (devtools dimmed
			// the original page).
			polished = mix(polished, polished * vec3(0.18, 0.22, 0.28), reveal * (wHeat * 0.55 + 0.30));
		}
	}

	/* ─── Composite ──────────────────────────────────────────────────── */
	// When using an image x-ray we suppress the polished bleed-through so
	// the schematic reads crisp; the procedural overlay benefits from a
	// little bleed (it's mostly thin lines + glow).
	float bleed = mix(0.18, 0.04, imageOverlayActive);
	vec3 col = mix(polished, overlay + polished * bleed, reveal * 0.95);

	// Scan line + halo, additive in accent colour.
	col += u_accent * (scanLine * 1.4 + scanHalo * 0.9);

	// Tiny per-fragment chromatic fringe on the band edges (reads as
	// "devtools selection rectangle ghost").
	float edge = smoothstep(W * 0.6, W, d) - smoothstep(W, W * 1.18, d);
	col += vec3(0.05, 0.18, 0.30) * edge * 0.6;

	// Master opacity (used for fade-in / transparency).
	float alpha = u_opacity;

	if (u_transparent > 0.5) {
		// Foreground-residue alpha: derive alpha from luminance so the
		// hero composes onto whatever's behind it.
		float a = clamp(luma(col) * 1.6, 0.0, 1.0);
		gl_FragColor = vec4(col, a * alpha);
	} else {
		gl_FragColor = vec4(col, alpha);
	}
}
`;
function DebuggingXrayInner(props) {
    const { size, input, reducedMotion, rootRef, 
    // Screenshot
    screenshot = 'https://crazygl.com/samples/screenshot-dashboard-dark.avif', screenshotScale = 1.28, screenshotX = 1.5, screenshotY = 0.0, screenshotTilt = 6.5, 
    // X-Ray scan
    scanMode = 'pointer', scanSpeed = 0.35, bandWidth = 0.32, accentColor = '#5cd5ff', 
    // Overlay
    overlayStyle = 'both', overlayDensity = 0.6, 
    // X-ray mode: "procedural" uses the in-shader devtools overlay,
    // "image" reveals a user-supplied wireframe / schematic / blueprint.
    xrayMode = 'procedural', xrayImage = '', 
    // Stage
    parallaxStrength = 0.45, bgTop = '#0a1320', bgBottom = '#03050b', transparentBackground = false, 
    // CTA
    ctaLabel = 'Open the inspector →', onCTAClick = '', } = props;
    const content = useContent(props);
    const canvasRef = React.useRef(null);
    const ctaRef = React.useRef(null);
    const [threeReady, setThreeReady] = React.useState(false);
    const [assetsReady, setAssetsReady] = React.useState(false);
    useHeroReady(props, { until: assetsReady });
    const stateRef = React.useRef({
        THREE: null,
        ready: false,
        renderer: null,
        scene: null,
        camera: null,
        planeMesh: null,
        planeMat: null,
        bgMesh: null,
        bgMat: null,
        tex: null,
        xrayTex: null,
        loadedAspect: 16 / 10,
        loadedImgW: 1600,
        loadedImgH: 1000,
        startMs: 0,
        camOffset: { x: 0, y: 0 },
        camOffsetTarget: { x: 0, y: 0 },
        scanXSmoothed: 0.5,
        scanXTarget: 0.5,
        autoPhase: 0,
        lastPointerActiveAt: -1e9,
        lastInputX: 0.5,
        lastInputY: 0.5,
        lastSize: { w: 0, h: 0 },
    });
    const handleCTAClick = (e) => {
        if (typeof onCTAClick === 'function') {
            e.preventDefault();
            onCTAClick(e);
            return;
        }
        if (typeof onCTAClick === 'string' && onCTAClick.length > 0) {
            e.preventDefault();
            window.location.href = onCTAClick;
        }
    };
    /* ── Warm the browser cache for image assets as early as possible ───
       Kicks off the network fetch for the screenshot (and x-ray image, when
       used) at mount, concurrent with `import('three')` + renderer init.
       Three's TextureLoader requests the same URLs and hits the warm HTTP
       cache, so the download overlaps module evaluation instead of starting
       only after init completes. Purely a prefetch — no behavioural change. */
    React.useEffect(() => {
        if (typeof Image === 'undefined')
            return;
        const urls = [];
        if (screenshot)
            urls.push(screenshot);
        if (xrayMode === 'image' && typeof xrayImage === 'string' && xrayImage.length > 0) {
            urls.push(xrayImage);
        }
        const imgs = urls.map((url) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.decoding = 'async';
            img.src = url;
            return img;
        });
        return () => {
            for (const img of imgs)
                img.src = '';
        };
    }, [screenshot, xrayImage, xrayMode]);
    /* ── One-shot Three.js init ───────────────────────────────────────── */
    React.useEffect(() => {
        let cancelled = false;
        const canvas = canvasRef.current;
        if (!canvas)
            return;
        (async () => {
            let THREE;
            try {
                THREE = await import('three');
            }
            catch (err) {
                console.error('[debugging-xray-hero] failed to load three:', err);
                return;
            }
            if (cancelled)
                return;
            const state = stateRef.current;
            state.THREE = THREE;
            state.startMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const renderer = new THREE.WebGLRenderer({
                canvas,
                antialias: true,
                alpha: true,
                premultipliedAlpha: false,
                powerPreference: 'high-performance',
            });
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
            renderer.setClearColor(0x000000, 0);
            state.renderer = renderer;
            const scene = new THREE.Scene();
            scene.background = null;
            state.scene = scene;
            const camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 50);
            camera.position.set(0, 0, 5.0);
            camera.lookAt(0, 0, 0);
            state.camera = camera;
            /* ─── Background plane (radial gradient) ─────────────────── */
            const bgMat = new THREE.ShaderMaterial({
                uniforms: {
                    u_top: { value: new THREE.Color(bgTop) },
                    u_bottom: { value: new THREE.Color(bgBottom) },
                    u_transparent: { value: transparentBackground ? 1 : 0 },
                },
                vertexShader: 'varying vec2 vUv;\n' +
                    'void main(){\n' +
                    '  vUv = uv;\n' +
                    '  gl_Position = vec4(position.xy, 0.999, 1.0);\n' +
                    '}',
                fragmentShader: '/* Coordinate spaces: vUv [0..1]² for a fullscreen quad. */\n' +
                    'precision highp float;\n' +
                    'varying vec2 vUv;\n' +
                    'uniform vec3 u_top;\n' +
                    'uniform vec3 u_bottom;\n' +
                    'uniform float u_transparent;\n' +
                    'void main(){\n' +
                    '  vec2 c = vUv - 0.5;\n' +
                    '  float r = length(c * vec2(1.0, 1.2));\n' +
                    '  vec3 col = mix(u_top, u_bottom, smoothstep(0.0, 0.85, r));\n' +
                    '  // Subtle vignette darkening at the corners.\n' +
                    '  col *= mix(1.0, 0.55, smoothstep(0.35, 0.95, r));\n' +
                    '  float a = u_transparent > 0.5 ? 0.0 : 1.0;\n' +
                    '  gl_FragColor = vec4(col, a);\n' +
                    '}',
                depthWrite: false,
                depthTest: false,
                transparent: true,
            });
            const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
            bgMesh.frustumCulled = false;
            bgMesh.renderOrder = -1000;
            scene.add(bgMesh);
            state.bgMat = bgMat;
            state.bgMesh = bgMesh;
            /* ─── Screenshot plane (custom shader) ──────────────────── */
            const planeMat = new THREE.ShaderMaterial({
                uniforms: {
                    u_screenshot: { value: null },
                    u_hasScreenshot: { value: 0 },
                    u_imgSize: { value: new THREE.Vector2(1600, 1000) },
                    u_planeSize: { value: new THREE.Vector2(3.2, 2.0) },
                    u_time: { value: 0 },
                    u_scanX: { value: 0.5 },
                    u_bandWidth: { value: bandWidth },
                    u_accent: { value: new THREE.Color(accentColor) },
                    u_overlayDensity: { value: overlayDensity },
                    u_overlayStyle: { value: overlayStyleToFloat(overlayStyle) },
                    u_pulse: { value: 0 },
                    u_transparent: { value: transparentBackground ? 1 : 0 },
                    u_opacity: { value: 0.0 },
                    u_xrayMap: { value: null },
                    u_hasXrayMap: { value: 0 },
                    u_xrayMode: { value: 0 },
                },
                vertexShader: VERTEX_SHADER,
                fragmentShader: FRAGMENT_SHADER,
                transparent: true,
                depthWrite: false,
                extensions: { derivatives: true },
            });
            // Defensive log: if compile fails, console will show the error.
            const planeGeom = new THREE.PlaneGeometry(3.2, 2.0, 1, 1);
            const planeMesh = new THREE.Mesh(planeGeom, planeMat);
            scene.add(planeMesh);
            state.planeMat = planeMat;
            state.planeMesh = planeMesh;
            state.ready = true;
            setThreeReady(true);
        })();
        return () => {
            cancelled = true;
            const state = stateRef.current;
            try {
                if (state.planeMesh)
                    state.scene?.remove(state.planeMesh);
                state.planeMesh?.geometry?.dispose?.();
                state.planeMat?.dispose?.();
                state.tex?.dispose?.();
                state.xrayTex?.dispose?.();
                state.bgMesh?.geometry?.dispose?.();
                state.bgMat?.dispose?.();
                state.renderer?.dispose?.();
            }
            catch (_e) {
                /* cleanup best-effort */
            }
            state.ready = false;
        };
        // One-shot init.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    /* ── Load screenshot texture ──────────────────────────────────────── */
    React.useEffect(() => {
        const state = stateRef.current;
        if (!state.ready || !state.planeMat || !screenshot) {
            if (state.ready && !screenshot)
                setAssetsReady(true);
            return;
        }
        const THREE = state.THREE;
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin?.('anonymous');
        let cancelled = false;
        loader.load(screenshot, (tex) => {
            if (cancelled)
                return;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.wrapS = THREE.ClampToEdgeWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.anisotropy = state.renderer.capabilities.getMaxAnisotropy?.() ?? 1;
            if (state.tex)
                state.tex.dispose?.();
            state.tex = tex;
            const w = tex.image?.naturalWidth ?? tex.image?.width ?? 1600;
            const h = tex.image?.naturalHeight ?? tex.image?.height ?? 1000;
            state.loadedImgW = w;
            state.loadedImgH = h;
            state.loadedAspect = w / Math.max(1, h);
            state.planeMat.uniforms.u_screenshot.value = tex;
            state.planeMat.uniforms.u_hasScreenshot.value = 1;
            state.planeMat.uniforms.u_imgSize.value.set(w, h);
            state.planeMat.needsUpdate = true;
            setAssetsReady(true);
        }, undefined, (err) => {
            console.warn('[debugging-xray-hero] screenshot load failed:', err);
            setAssetsReady(true);
        });
        return () => {
            cancelled = true;
        };
    }, [screenshot, threeReady]);
    /* ── Load x-ray image texture (only when xrayMode === "image") ──── */
    React.useEffect(() => {
        const state = stateRef.current;
        if (!state.ready || !state.planeMat)
            return;
        const THREE = state.THREE;
        // Resolve mode + URL: when mode is "image" and a URL exists, we load
        // it and set u_xrayMode = 1. Otherwise we fall back to the procedural
        // overlay (mode = 0), which is the original behaviour.
        const wantsImage = xrayMode === 'image' && typeof xrayImage === 'string' && xrayImage.length > 0;
        if (!wantsImage) {
            // Clean up any previously loaded x-ray texture and revert to
            // procedural mode. We keep the texture slot null so the shader's
            // hasXrayMap guard prevents stale reads.
            if (state.xrayTex) {
                state.xrayTex.dispose?.();
                state.xrayTex = null;
            }
            state.planeMat.uniforms.u_xrayMap.value = null;
            state.planeMat.uniforms.u_hasXrayMap.value = 0;
            state.planeMat.uniforms.u_xrayMode.value = 0;
            return;
        }
        const loader = new THREE.TextureLoader();
        loader.setCrossOrigin?.('anonymous');
        let cancelled = false;
        loader.load(xrayImage, (tex) => {
            if (cancelled)
                return;
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.wrapS = THREE.ClampToEdgeWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.anisotropy = state.renderer.capabilities.getMaxAnisotropy?.() ?? 1;
            if (state.xrayTex)
                state.xrayTex.dispose?.();
            state.xrayTex = tex;
            state.planeMat.uniforms.u_xrayMap.value = tex;
            state.planeMat.uniforms.u_hasXrayMap.value = 1;
            state.planeMat.uniforms.u_xrayMode.value = 1;
            state.planeMat.needsUpdate = true;
        }, undefined, (err) => {
            console.warn('[debugging-xray-hero] x-ray image load failed:', err);
            // Soft fallback to procedural if the URL is broken.
            if (state.planeMat) {
                state.planeMat.uniforms.u_hasXrayMap.value = 0;
                state.planeMat.uniforms.u_xrayMode.value = 0;
            }
        });
        return () => {
            cancelled = true;
        };
    }, [xrayMode, xrayImage, threeReady]);
    /* ── Push uniform updates on style sliders ──────────────────────── */
    React.useEffect(() => {
        const state = stateRef.current;
        if (!state.planeMat)
            return;
        state.planeMat.uniforms.u_bandWidth.value = bandWidth;
        state.planeMat.uniforms.u_accent.value.set(accentColor);
        state.planeMat.uniforms.u_overlayDensity.value = overlayDensity;
        state.planeMat.uniforms.u_overlayStyle.value = overlayStyleToFloat(overlayStyle);
        state.planeMat.uniforms.u_transparent.value = transparentBackground ? 1 : 0;
        if (state.bgMat) {
            state.bgMat.uniforms.u_top.value.set(bgTop);
            state.bgMat.uniforms.u_bottom.value.set(bgBottom);
            state.bgMat.uniforms.u_transparent.value = transparentBackground ? 1 : 0;
        }
    }, [bandWidth, accentColor, overlayDensity, overlayStyle, transparentBackground, bgTop, bgBottom]);
    /* ── Resize ───────────────────────────────────────────────────────── */
    React.useEffect(() => {
        const state = stateRef.current;
        if (!state.ready || !state.renderer || !state.camera)
            return;
        const w = Math.max(1, size.width);
        const h = Math.max(1, size.height);
        state.renderer.setSize(w, h, false);
        state.camera.aspect = w / h;
        state.camera.updateProjectionMatrix();
        state.lastSize.w = w;
        state.lastSize.h = h;
    }, [size.width, size.height, threeReady]);
    /* ── Track pointer activity (for "both" mode resolution) ───────── */
    React.useEffect(() => {
        const state = stateRef.current;
        // Detect pointer movement: if input.x/y changed meaningfully since
        // last frame, mark active. (Wrapper-managed pointer is sampled
        // every frame, so we approximate "active" by recent change.)
        const dx = Math.abs(input.x - state.lastInputX);
        const dy = Math.abs(input.y - state.lastInputY);
        if (dx > 0.001 || dy > 0.001) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            state.lastPointerActiveAt = now;
        }
        state.lastInputX = input.x;
        state.lastInputY = input.y;
    }, [input.x, input.y]);
    /* ── Render loop ─────────────────────────────────────────────────── */
    useHeroAnimationFrame(props.rootRef, ({ delta, elapsed }) => {
        const state = stateRef.current;
        if (!state.ready)
            return;
        const THREE = state.THREE;
        const dt = Math.max(0, Math.min(0.1, delta));
        // Layout — compute plane size & position based on visible world units
        // at the camera.
        const camera = state.camera;
        const fovY = (camera.fov * Math.PI) / 180;
        const worldHeight = 2 * Math.tan(fovY * 0.5) * Math.abs(camera.position.z);
        const aspect = Math.max(0.0001, size.width / Math.max(1, size.height));
        const worldWidth = worldHeight * aspect;
        const smaller = Math.min(worldWidth, worldHeight);
        // Plane sits centered on the screenshot's aspect; the SMALLER world
        // axis defines the "fit size". screenshotScale grows it.
        const targetLong = smaller * 0.92 * screenshotScale; // long side world units
        const imgAspect = Math.max(0.1, state.loadedAspect);
        // Decide which axis is "long" based on imgAspect (always use width
        // for landscape screenshots — common case).
        let planeW, planeH;
        if (imgAspect >= 1) {
            planeW = targetLong;
            planeH = targetLong / imgAspect;
        }
        else {
            planeH = targetLong;
            planeW = targetLong * imgAspect;
        }
        // Apply geometry resize (cheap — just sets the underlying buffer scale).
        const mesh = state.planeMesh;
        if (mesh) {
            mesh.scale.set(planeW / 3.2, planeH / 2.0, 1);
            mesh.position.set(screenshotX, screenshotY, 0);
            mesh.rotation.x = (screenshotTilt * Math.PI) / 180;
        }
        // Push the plane size into the shader so cover-fit math knows it.
        if (state.planeMat) {
            state.planeMat.uniforms.u_planeSize.value.set(planeW, planeH);
        }
        /* ─── Resolve scan position ─────────────────────────────────── */
        // "auto" / "both" → ping-pong sweep across [0..1].
        // Pointer-derived scanX must be expressed in the SCREENSHOT's local
        // UV X — not the hero's normalised X — otherwise the band drifts out
        // of sync when the screenshot is offset (large screenshotX) or
        // scaled. We project the hero-relative pointer into world space
        // (accounting for camera parallax), then into plane-local UV by
        // subtracting the plane centre and dividing by planeW.
        // screenshotTilt rotates the plane around the X-axis (horizontal
        // hinge), so it leaves the local X axis unchanged → no inverse
        // needed for the scan-band axis.
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const pointerActive = now - state.lastPointerActiveAt < 600;
        if (!reducedMotion) {
            state.autoPhase += dt * Math.max(0.001, scanSpeed);
        }
        const tri = 2 * Math.abs(((state.autoPhase * 0.5) % 1) - 0.5); // 0..1..0 ping-pong
        // Map to slightly inset from edges so the band fully exits the
        // visible plane rather than half-clipping.
        const inset = 0.08;
        const autoX = inset + tri * (1 - 2 * inset);
        // Pointer → screenshot-local UV X.
        // input.x is [0..1] across the hero. Convert to world X at the
        // camera plane, including the current camera offset (parallax),
        // then express relative to the plane centre and divide by planeW.
        const pointerWorldX = (input.x - 0.5) * worldWidth + state.camOffset.x;
        const pointerLocalUVX = 0.5 + (pointerWorldX - screenshotX) / Math.max(0.0001, planeW);
        let targetX = autoX;
        if (scanMode === 'pointer') {
            targetX = clamp01(pointerLocalUVX);
        }
        else if (scanMode === 'auto') {
            targetX = autoX;
        }
        else if (scanMode === 'both') {
            targetX = pointerActive ? clamp01(pointerLocalUVX) : autoX;
        }
        // Smooth scanX over a ~120ms time constant so big jumps look
        // purposeful, not snappy.
        const tau = 0.12;
        const k = 1 - Math.exp(-dt / tau);
        state.scanXSmoothed += (targetX - state.scanXSmoothed) * k;
        if (state.planeMat) {
            state.planeMat.uniforms.u_scanX.value = state.scanXSmoothed;
            state.planeMat.uniforms.u_time.value = reducedMotion ? 0 : elapsed;
            // Slow ambient pulse on the scanline glow (life when idle).
            state.planeMat.uniforms.u_pulse.value = reducedMotion
                ? 0.5
                : 0.5 + 0.5 * Math.sin(elapsed * 1.8);
            // Fade-in over the first ~0.6s.
            const fadeIn = Math.min(1, elapsed / 0.6);
            state.planeMat.uniforms.u_opacity.value = fadeIn;
        }
        /* ─── Camera parallax ───────────────────────────────────────── */
        const px = (input.x - 0.5) * 2;
        const py = (input.y - 0.5) * 2;
        const pmax = 0.35 * parallaxStrength;
        state.camOffsetTarget.x = px * pmax;
        state.camOffsetTarget.y = -py * pmax * 0.5;
        const camTau = 0.22;
        const kCam = 1 - Math.exp(-dt / camTau);
        state.camOffset.x += (state.camOffsetTarget.x - state.camOffset.x) * kCam;
        state.camOffset.y += (state.camOffsetTarget.y - state.camOffset.y) * kCam;
        camera.position.x = state.camOffset.x;
        camera.position.y = state.camOffset.y;
        camera.position.z = 5.0;
        camera.lookAt(screenshotX * 0.25, screenshotY * 0.25, 0);
        state.renderer.render(state.scene, state.camera);
    });
    return (_jsxs(_Fragment, { children: [_jsx("crazygl-stage", { style: {
                    position: 'absolute',
                    inset: 0,
                    zIndex: 0,
                    overflow: 'hidden',
                    background: transparentBackground ? 'transparent' : undefined,
                }, children: _jsx("canvas", { ref: canvasRef, className: "crazygl-debugging-xray-canvas", "aria-hidden": "true" }) }), _jsx("crazygl-content", { children: _jsxs("div", { className: "crazygl-debugging-xray-content", "data-content-side": screenshotX >= 0 ? 'left' : 'right', children: [content.node, props.contentType !== 'custom' && ctaLabel ? (_jsx("div", { className: "crazygl-debugging-xray-cta-row", children: _jsx("button", { ref: ctaRef, type: "button", onClick: handleCTAClick, className: "crazygl-debugging-xray-cta", style: {
                                    boxShadow: `0 0 0 1px ${accentColor}44, 0 6px 28px ${accentColor}44, 0 0 60px ${accentColor}33`,
                                    borderColor: accentColor,
                                }, children: ctaLabel }) })) : null] }) })] }));
}
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
function overlayStyleToFloat(v) {
    if (v === 'bboxes')
        return 0;
    if (v === 'heatmap')
        return 1;
    return 2; // both
}
export { metadata };
export default function DebuggingXrayHero(props) {
    return _jsx(CrazyGLWrapper, { hero: DebuggingXrayInner, metadata: metadata, ...props });
}
